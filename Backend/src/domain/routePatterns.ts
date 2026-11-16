// Pengaturan rute per lini dan arah dari admin (jenis konten route_pattern): urutan pemberhentian dan waktu
// tempuh antarpemberhentian. Diterapkan di atas data bawaan (Commute Data API / GTFS) untuk daftar lini,
// urutan stasiun lini (peta, pencarian rute topologi, lin paralel), dan waktu tempuh ruas yang tidak punya jadwal.

import type { TjGtfs, TjGtfsPattern } from "../data/gtfs/TjGtfs";
import type { RequestContext } from "../context";
import type { RoutePattern } from "./content";
import type { Line } from "./models";

/** Urutan stasiun satu lini per ruas. `directed` = tiap urutan hanya berlaku searah (arah 0 dan arah 1 dari admin). */
export interface LineSequences {
  lineId: string;
  sequences: string[][];
  directed?: boolean;
}

/** Sumber pengaturan rute (published, atau draft untuk pratinjau admin). */
export type PatternProvider = (ctx: RequestContext) => Promise<RoutePattern[]>;

/** Satu arah rute bawaan, dalam bentuk yang sama dengan isian pengaturan rute di admin. */
export interface DefaultPattern {
  direction: 0 | 1;
  headsign?: string;
  stops: { stationId: string; minutes: number | null }[];
  /** Frekuensi rata-rata (menit) dan jam layanan dari sumber data, bila ada. */
  headwayMinutes?: number;
  serviceHours?: string;
  /** Ruas cabang/ramp lini yang tidak tersambung ke urutan arah ini (urutan stasiun searah arah ini). */
  branches?: string[][];
}

const dedupe = <T>(xs: T[]) => [...new Set(xs)];

function byLine(patterns: RoutePattern[]): Map<string, RoutePattern[]> {
  const m = new Map<string, RoutePattern[]>();
  for (const p of patterns) m.set(p.lineId, [...(m.get(p.lineId) ?? []), p].sort((a, b) => a.direction - b.direction));
  return m;
}

/** Stasiun lini mengikuti pengaturan admin: urutan arah 0, lalu pemberhentian yang hanya dilewati arah 1. */
export function applyPatternsToLines(lines: Line[], patterns: RoutePattern[]): Line[] {
  if (!patterns.length) return lines;
  const set = byLine(patterns);
  return lines.map((l) => {
    const ps = set.get(l.id);
    return ps ? { ...l, stationIds: dedupe(ps.flatMap((p) => [...p.stops.map((s) => s.stationId), ...(p.branches ?? []).flat()])) } : l;
  });
}

/** Urutan tiap arah beserta ruas cabangnya (cabang mengikuti arah pengaturannya). */
function patternSequences(ps: RoutePattern[]): string[][] {
  return ps.flatMap((p) => [p.stops.map((x) => x.stationId), ...(p.branches ?? []).filter((b) => b.length >= 2)]);
}

/**
 * Urutan stasiun lini dengan pengaturan admin. Bila kedua arah diatur, tiap arah searah saja (`directed`), sehingga
 * lin satu arah (mis. putaran Kota Tua dan Blok M) tidak dianggap bisa dinaiki ke arah sebaliknya. Bila hanya
 * satu arah diatur, urutan itu berlaku dua arah.
 */
export function applyPatternsToSequences(sequences: LineSequences[], patterns: RoutePattern[]): LineSequences[] {
  if (!patterns.length) return sequences;
  const set = byLine(patterns);
  const out = sequences.map((s) => {
    const ps = set.get(s.lineId);
    if (!ps) return s;
    set.delete(s.lineId);
    return { lineId: s.lineId, sequences: patternSequences(ps), directed: ps.length > 1 };
  });
  // Lini yang tidak punya urutan bawaan tetapi diatur admin.
  for (const [lineId, ps] of set) out.push({ lineId, sequences: patternSequences(ps), directed: ps.length > 1 });
  return out;
}

/**
 * Waktu tempuh (menit) naik salah satu `lineIds` melewati `stops` berurutan menurut pengaturan admin: jumlah
 * waktu antarpemberhentian dari pemberhentian naik sampai turun. null bila tidak ada pengaturan yang memuat
 * semua pemberhentian berurutan atau ada ruas yang waktunya belum diisi.
 */
export function patternMinutes(patterns: RoutePattern[], lineIds: string[], stops: string[]): { minutes: number; lineId: string } | null {
  if (stops.length < 2) return null;
  for (const lineId of lineIds)
    for (const p of patterns) {
      if (p.lineId !== lineId) continue;
      const ids = p.stops.map((s) => s.stationId);
      for (let i = ids.indexOf(stops[0]); i >= 0; i = ids.indexOf(stops[0], i + 1)) {
        // Pemberhentian ruas harus muncul berurutan (boleh melewati pemberhentian lain di antaranya).
        let j = i;
        let ok = true;
        for (const s of stops.slice(1)) {
          const k = ids.indexOf(s, j + 1);
          if (k < 0) {
            ok = false;
            break;
          }
          j = k;
        }
        if (!ok) continue;
        const parts = p.stops.slice(i + 1, j + 1).map((s) => s.minutes);
        if (parts.some((m) => m === null || m === undefined)) continue;
        const sum = parts.reduce<number>((a, m) => a + (m ?? 0), 0);
        return { minutes: Math.max(1, Math.round(sum)), lineId };
      }
    }
  return null;
}

/** Collapse pemberhentian berurutan yang sama (dua kode halte satu arah yang dipetakan ke satu stasiun NTD). */
function collapse(stops: { stationId: string; minutes: number | null }[]) {
  const out: typeof stops = [];
  for (const s of stops) {
    const last = out[out.length - 1];
    if (last?.stationId === s.stationId) {
      if (s.minutes !== null) last.minutes = (last.minutes ?? 0) + s.minutes;
      continue;
    }
    out.push({ ...s });
  }
  if (out[0]) out[0].minutes = null;
  return out;
}

const tenth = (secs: number) => Math.round(secs / 6) / 10;

const clockMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

/**
 * Frekuensi rata-rata (menit, ditimbang lama tiap jendela) dan jam layanan dari jendela frekuensi GTFS
 * ([mulai, selesai, headway detik]). Jendela 00:00–23:59 berarti layanan 24 jam.
 */
export function gtfsFrequency(freq: [string, string, number][]): { headwayMinutes?: number; serviceHours?: string } {
  const wins = freq.filter(([a, b, h]) => h > 0 && clockMin(b) > clockMin(a));
  if (!wins.length) return {};
  let span = 0;
  let sum = 0;
  for (const [a, b, h] of wins) {
    const len = clockMin(b) - clockMin(a);
    span += len;
    sum += len * (h / 60);
  }
  const start = Math.min(...wins.map(([a]) => clockMin(a)));
  const end = Math.max(...wins.map(([, b]) => clockMin(b)));
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return {
    headwayMinutes: Math.min(240, Math.max(1, Math.round(sum / span))),
    serviceHours: start === 0 && end >= 23 * 60 + 59 ? "24 jam" : `${fmt(start)}–${fmt(end)}`,
  };
}

/**
 * Rute bawaan dua arah dari GTFS Transjakarta untuk koridor `code`: pola reguler terpanjang sebagai arah 0, dan
 * pola terpanjang yang berjalan berlawanan sebagai arah 1. Waktu tempuh = selisih jadwal tiba dan berangkat
 * antarhalte (menit, satu desimal); frekuensi dan jam layanan dari jendela frekuensi pola itu.
 */
export function defaultsFromGtfs(gtfs: TjGtfs, code: string, idOf: (code: string) => string): DefaultPattern[] {
  const all = gtfs.patterns(code);
  if (!all.length) return [];
  const toPattern = (p: TjGtfsPattern, direction: 0 | 1): DefaultPattern => ({
    direction,
    headsign: p.headsign,
    stops: collapse(p.stops.map((c, i) => ({ stationId: idOf(c), minutes: i ? tenth(p.arr[i] - p.dep[i - 1]) : null }))),
    ...gtfsFrequency(p.freq),
  });
  const rank = (a: TjGtfsPattern, b: TjGtfsPattern) => Number(b.trip.includes("-R")) - Number(a.trip.includes("-R")) || b.stops.length - a.stops.length;
  const sorted = [...all].sort(rank);
  const first = sorted[0];
  const ids0 = first.stops.map(idOf);
  const [head, tail] = [ids0[0], ids0[ids0.length - 1]];
  // Arah sebaliknya: memuat kedua ujung arah 0 dengan ujung akhir lebih dulu, atau dimulai di ujung akhir arah 0.
  const reverse = sorted.find((p) => {
    if (p === first) return false;
    const ids = p.stops.map(idOf);
    const h = ids.indexOf(head);
    const t = ids.indexOf(tail);
    return (h >= 0 && t >= 0 && t < h) || ids[0] === tail || ids[ids.length - 1] === head;
  });
  return [toPattern(first, 0), ...(reverse ? [toPattern(reverse, 1)] : [])];
}

/**
 * Sambungkan ruas cabang yang berawal di ujung akhir (atau berakhir di ujung awal) urutan ke urutan itu, berulang.
 * Mis. Lin Cikarang: Cikarang → Jatinegara, lalu putaran Jatinegara → Kampung Bandan → Manggarai → Jatinegara menjadi
 * satu urutan, karena keretanya memang berjalan terus. Cabang lain dikembalikan apa adanya.
 */
export function chainBranches(trunk: string[], branches: string[][]): { trunk: string[]; branches: string[][] } {
  let main = [...trunk];
  const rest = branches.filter((b) => b.length >= 2).map((b) => [...b]);
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < rest.length; i++) {
      const b = rest[i];
      if (b[0] === main[main.length - 1]) main = [...main, ...b.slice(1)];
      else if (b[b.length - 1] === main[0]) main = [...b.slice(0, -1), ...main];
      else continue;
      rest.splice(i, 1);
      changed = true;
      break;
    }
  }
  return { trunk: main, branches: rest };
}

/** Pasangan stasiun bersebelahan (tanpa arah) pada urutan-urutan. */
function pairsOf(seqs: string[][]): Set<string> {
  const out = new Set<string>();
  for (const q of seqs) for (let i = 1; i < q.length; i++) out.add([q[i - 1], q[i]].sort().join("|"));
  return out;
}

/**
 * Lampirkan ruas cabang dataset ke pola dua arah: arah 0 memakai urutan cabang apa adanya, arah 1 kebalikannya,
 * sehingga cabang tetap bisa dilalui dua arah seperti pada data bawaan. Cabang yang semua ruasnya sudah ada di
 * urutan pola tidak dilampirkan.
 */
export function attachBranches(patterns: DefaultPattern[], branches: string[][]): DefaultPattern[] {
  const covered = pairsOf(patterns.map((p) => p.stops.map((s) => s.stationId)));
  const extra = branches.filter((b) => b.length >= 2 && [...pairsOf([b])].some((k) => !covered.has(k)));
  if (!extra.length) return patterns;
  return patterns.map((p) => ({ ...p, branches: p.direction === 0 ? extra.map((b) => [...b]) : extra.map((b) => [...b].reverse()) }));
}

/**
 * Urutan bawaan dua arah dari Commute Data API: batang utama lin (disambung dengan cabang yang berawal di ujungnya,
 * mis. putaran Lin Cikarang) sebagai arah 0 dan kebalikannya sebagai arah 1. /lines tidak memuat waktu tempuh; waktu,
 * frekuensi, dan jam layanan dilengkapi RouteSyncService. Cabang/ramp lain dikembalikan terpisah sebagai `branches`.
 */
export function defaultsFromSequences(seq: LineSequences | undefined): { patterns: DefaultPattern[]; branches: string[][] } {
  if (!seq?.sequences.length) return { patterns: [], branches: [] };
  const { trunk, branches } = chainBranches(seq.sequences[0], seq.sequences.slice(1));
  const stops = (ids: string[]) => ids.map((stationId) => ({ stationId, minutes: null }));
  return {
    patterns: [
      { direction: 0, stops: stops(trunk) },
      { direction: 1, stops: stops([...trunk].reverse()) },
    ],
    branches,
  };
}
