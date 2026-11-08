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
    return ps ? { ...l, stationIds: dedupe(ps.flatMap((p) => p.stops.map((s) => s.stationId))) } : l;
  });
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
    return { lineId: s.lineId, sequences: ps.map((p) => p.stops.map((x) => x.stationId)), directed: ps.length > 1 };
  });
  // Lini yang tidak punya urutan bawaan tetapi diatur admin.
  for (const [lineId, ps] of set) out.push({ lineId, sequences: ps.map((p) => p.stops.map((x) => x.stationId)), directed: ps.length > 1 });
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

/**
 * Rute bawaan dua arah dari GTFS Transjakarta untuk koridor `code`: pola reguler terpanjang sebagai arah 0, dan
 * pola terpanjang yang berjalan berlawanan sebagai arah 1. Waktu tempuh = selisih jadwal tiba dan berangkat
 * antarhalte (menit, satu desimal).
 */
export function defaultsFromGtfs(gtfs: TjGtfs, code: string, idOf: (code: string) => string): DefaultPattern[] {
  const all = gtfs.patterns(code);
  if (!all.length) return [];
  const toPattern = (p: TjGtfsPattern, direction: 0 | 1): DefaultPattern => ({
    direction,
    headsign: p.headsign,
    stops: collapse(p.stops.map((c, i) => ({ stationId: idOf(c), minutes: i ? tenth(p.arr[i] - p.dep[i - 1]) : null }))),
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
 * Rute bawaan dua arah dari Commute Data API: batang utama lin sebagai arah 0 dan kebalikannya sebagai arah 1.
 * Commute tidak memuat waktu tempuh antarstasiun, jadi waktunya kosong. Ruas cabang/ramp satu arah
 * dikembalikan terpisah agar admin bisa menambahkannya ke arah yang benar.
 */
export function defaultsFromSequences(seq: LineSequences | undefined): { patterns: DefaultPattern[]; branches: string[][] } {
  if (!seq?.sequences.length) return { patterns: [], branches: [] };
  const [trunk, ...branches] = seq.sequences;
  const stops = (ids: string[]) => ids.map((stationId) => ({ stationId, minutes: null }));
  return {
    patterns: [
      { direction: 0, stops: stops(trunk) },
      { direction: 1, stops: stops([...trunk].reverse()) },
    ],
    branches,
  };
}
