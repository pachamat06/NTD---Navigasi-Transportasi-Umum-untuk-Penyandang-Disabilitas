// Data pelengkap TransJakarta dari GTFS resmi Transjakarta, khusus koridor BRT yang tercantum di NTD
// (koridor 1 sampai 14 pada Peta Integrasi FDTJ dan lin BRT turunannya: 2A, 3F, 3H, 4D, 5C, 6A, 6B, 6V,
// 7F, 9A, 9C, 9N, 10H, 13B, 13E, L13E). Dipakai bila Commute Data API tidak memberi datanya:
// - waktu tempuh ruas naik TransJakarta (/fares TJ tidak memuat jam berangkat/tiba), dari stop_times;
// - halte yang dilewati lin di /lines tetapi tidak ada di /stations (nama dan koordinat).
// Waktu dari GTFS adalah waktu JADWAL (perkiraan), bukan waktu nyata, sehingga selalu ditandai perkiraan.
// Data dibuat oleh scripts/build-tj-gtfs.py ke tj-brt-data.ts.

import { TJ_BRT_GTFS } from "./tj-brt-data";

export interface TjGtfsPattern {
  trip: string;
  service: string;
  headsign: string;
  /** Kode halte induk berurutan (= kode TJ di Commute). */
  stops: string[];
  /** Detik sejak keberangkatan pertama: tiba dan berangkat di tiap halte. */
  arr: number[];
  dep: number[];
  /** Jendela frekuensi [mulai, selesai, headway detik]. */
  freq: [string, string, number][];
  /** Pola sambungan (lihat `TjGtfs.ridePatterns`): trip lanjutan di halte ujung putaran, bukan pola GTFS asli. */
  through?: true;
}

export interface TjGtfsData {
  meta: { agency: string; routes: string[]; stops: number; patterns: number };
  /** Kode halte -> [nama, lintang, bujur]. */
  stops: Record<string, [string, number, number]>;
  routes: Record<string, { name: string; color: string; patterns: TjGtfsPattern[] }>;
}

export interface TjRideTime {
  minutes: number;
  /** Koridor yang datanya dipakai. */
  line: string;
  trip: string;
}

export interface TjGtfsStop {
  code: string;
  name: string;
  lat: number;
  lng: number;
}

export class TjGtfs {
  private byStop = new Map<string, string[]>();
  private throughCache = new Map<string, TjGtfsPattern[]>();

  constructor(private data: TjGtfsData = TJ_BRT_GTFS) {
    for (const [line, r] of Object.entries(data.routes))
      for (const code of new Set(r.patterns.flatMap((p) => p.stops))) this.byStop.set(code, [...(this.byStop.get(code) ?? []), line]);
  }

  /** Koridor BRT NTD yang berhenti di halte `code` menurut GTFS. */
  routesAt(code: string): string[] {
    return this.byStop.get(code.toUpperCase()) ?? [];
  }

  get routes(): string[] {
    return Object.keys(this.data.routes);
  }

  /** Pola trip koridor `line` (urutan halte dan waktu jadwal), untuk pengaturan rute bawaan di admin. */
  patterns(line: string): TjGtfsPattern[] {
    return this.data.routes[line.toUpperCase()]?.patterns ?? [];
  }

  /**
   * Pola trip yang bisa dinaiki tanpa turun: pola GTFS ditambah pola sambungan di halte ujung yang berupa
   * putaran. GTFS Transjakarta memotong trip di halte ujung putaran, mis. koridor 1 arah utara berakhir di
   * Kali Besar dan trip berikutnya mulai dari Kali Besar > Museum Sejarah Jakarta > Kota, padahal busnya sama
   * dan penumpang tetap di dalam bus sampai Kota. Trip lanjutan disambung bila halte setelah ujung tidak
   * dilewati trip sebelumnya (putaran, bukan berbalik arah di jalur yang sama seperti 3H di Kota).
   */
  private ridePatterns(line: string): TjGtfsPattern[] {
    const key = line.toUpperCase();
    const base = this.data.routes[key]?.patterns ?? [];
    let through = this.throughCache.get(key);
    if (!through) {
      through = [];
      for (const p of base) {
        const end = p.stops[p.stops.length - 1];
        const seen = new Set(p.stops);
        for (const q of base) {
          if (q === p || q.stops[0] !== end || q.stops.length < 2 || seen.has(q.stops[1])) continue;
          const off = p.dep[p.dep.length - 1] - q.dep[0];
          through.push({
            trip: `${p.trip}+${q.trip}`,
            service: p.service,
            headsign: q.headsign,
            stops: [...p.stops, ...q.stops.slice(1)],
            arr: [...p.arr, ...q.arr.slice(1).map((t) => t + off)],
            dep: [...p.dep, ...q.dep.slice(1).map((t) => t + off)],
            freq: p.freq,
            through: true,
          });
        }
      }
      this.throughCache.set(key, through);
    }
    return [...base, ...through];
  }

  hasRoute(line: string): boolean {
    return !!this.data.routes[line.toUpperCase()];
  }

  stop(code: string): TjGtfsStop | undefined {
    const s = this.data.stops[code.toUpperCase()];
    return s ? { code: code.toUpperCase(), name: s[0], lat: s[1], lng: s[2] } : undefined;
  }

  /**
   * Waktu tempuh jadwal untuk naik koridor `line` melewati halte `stops` (kode TJ berurutan; satu pemberhentian
   * boleh berisi beberapa kode, mis. halte gabungan dua arah). Dipilih pola trip yang memuat semua halte ruas
   * secara berurutan dengan halte tambahan paling sedikit (pola reguler lebih dulu); bila tidak ada, pola yang
   * memuat halte naik lalu halte turun. null = koridor/halte tidak ada di GTFS.
   */
  rideTime(line: string, stops: Stop[]): TjRideTime | null {
    const route = this.data.routes[line.toUpperCase()];
    if (!route || stops.length < 2) return null;
    const want = sets(stops);
    const from = want[0];
    const to = want[want.length - 1];
    let best: { full: boolean; extra: number; regular: boolean; direct: boolean; secs: number; trip: string } | null = null;
    for (const p of this.ridePatterns(line)) {
      for (let i = 0; i < p.stops.length; i++) {
        if (!from.has(p.stops[i])) continue;
        let j = i + 1;
        while (j < p.stops.length && !to.has(p.stops[j])) j++;
        if (j >= p.stops.length) continue;
        // Halte ruas yang ditemukan berurutan di antara i dan j.
        let k = 1;
        for (let x = i + 1; x < j && k < want.length - 1; x++) if (want[k].has(p.stops[x])) k++;
        const cand = { full: k === want.length - 1, extra: j - i + 1 - want.length, regular: p.trip.includes("-R"), direct: !p.through, secs: p.arr[j] - p.dep[i], trip: p.trip };
        if (cand.secs <= 0) continue;
        if (!best || better(cand, best)) best = cand;
      }
    }
    return best ? { minutes: Math.max(1, Math.round(best.secs / 60)), line: line.toUpperCase(), trip: best.trip } : null;
  }

  /**
   * Pola trip salah satu `lines` (kosong = semua rute di data) yang berhenti di semua `stops` berurutan dengan
   * paling banyak `maxExtra` halte tambahan di antaranya. null = tidak ada bus yang melayani urutan itu, mis.
   * Kampung Melayu > Matraman Baru > Bali Mester (Bali Mester hanya dilayani arah Kampung Melayu).
   */
  match(lines: string[], stops: Stop[], maxExtra = 2): TjMatch | null {
    const want = sets(stops);
    if (want.length < 2) return null;
    const routes = (lines.length ? lines.map((l) => l.toUpperCase()) : this.routes).filter((l) => this.data.routes[l]);
    let best: TjMatch | null = null;
    for (const line of routes)
      for (const p of this.ridePatterns(line))
        for (let i = 0; i < p.stops.length; i++) {
          if (!want[0].has(p.stops[i])) continue;
          const codes = [p.stops[i]];
          let x = i + 1;
          for (; x < p.stops.length && codes.length < want.length && x - i - codes.length <= maxExtra; x++)
            if (want[codes.length].has(p.stops[x])) codes.push(p.stops[x]);
          if (codes.length < want.length) continue;
          const m: TjMatch = { line, pattern: p, from: i, to: x - 1, codes, extra: x - i - want.length };
          if (m.extra > maxExtra) continue;
          if (!best || matchBetter(m, best)) best = m;
        }
    return best;
  }

  /**
   * Ruas yang tidak dilayani satu bus (lihat `match`) dipecah di halte tempat penumpang bisa berbalik arah:
   * turun, pindah ke bus arah sebaliknya, lalu lanjut. Halte pemecah dipilih yang paling awal; halte satu arah
   * (kode berakhiran S) hanya dipakai bila tidak ada pilihan lain (`crossing`: harus keluar dan menyeberang).
   */
  split(lines: string[], stops: Stop[], maxExtra = 2): TjSplit | null {
    const want = sets(stops);
    for (const crossing of [false, true])
      for (let k = 1; k < want.length - 1; k++)
        for (const code of want[k]) {
          if (canTurn(code) === crossing) continue;
          const first = this.match(lines, [...stops.slice(0, k), code], maxExtra);
          if (!first) continue;
          const rest = [code, ...stops.slice(k + 1)];
          const second = this.match(lines, rest, maxExtra) ?? this.match([], rest, maxExtra);
          if (second) return { at: k, code, first, second, crossing };
        }
    return null;
  }

  /** Halte berikutnya pada pola `m` setelah halte terakhir ruas, tempat penumpang bisa berbalik arah. */
  nextTurnaround(m: TjMatch): { index: number; code: string } | undefined {
    for (let x = m.to + 1; x < m.pattern.stops.length; x++) if (canTurn(m.pattern.stops[x])) return { index: x, code: m.pattern.stops[x] };
    return undefined;
  }

  /** Halte berikutnya setelah `code` tempat bisa berbalik arah, beserta halte yang dilewati (termasuk `code`). */
  turnaroundAfter(code: string, lines: string[] = []): { line: string; stops: string[]; headsign: string } | null {
    const c = code.toUpperCase();
    for (const pool of [lines.map((l) => l.toUpperCase()), this.routes])
      for (const line of pool.filter((l) => this.data.routes[l]))
        for (const p of regularFirst(this.data.routes[line].patterns)) {
          const i = p.stops.indexOf(c);
          if (i < 0) continue;
          for (let x = i + 1; x < p.stops.length; x++) if (canTurn(p.stops[x])) return { line, stops: p.stops.slice(i, x + 1), headsign: p.headsign };
        }
    return null;
  }

  /** Halte yang dilewati bus dari `from` ke `to` (termasuk keduanya), dari pola trip mana pun. */
  path(from: string, to: string, lines: string[] = [], maxExtra = 12): { line: string; stops: string[]; headsign: string } | null {
    const m = this.match(lines, [from, to], maxExtra) ?? (lines.length ? this.match([], [from, to], maxExtra) : null);
    return m ? { line: m.line, stops: m.pattern.stops.slice(m.from, m.to + 1), headsign: m.pattern.headsign } : null;
  }

  /** Jarak garis lurus berurutan antarhalte (meter). */
  distance(codes: string[]): number {
    let d = 0;
    for (let i = 1; i < codes.length; i++) {
      const a = this.stop(codes[i - 1]);
      const b = this.stop(codes[i]);
      if (a && b) d += haversine(a, b);
    }
    return Math.round(d);
  }
}

/** Satu pemberhentian: satu kode, atau beberapa kode untuk halte gabungan dua arah. */
export type Stop = string | string[];

export interface TjMatch {
  line: string;
  pattern: TjGtfsPattern;
  from: number;
  to: number;
  /** Kode halte yang benar-benar dilewati (untuk halte gabungan: arah yang dipakai). */
  codes: string[];
  extra: number;
}

export interface TjSplit {
  /** Indeks pemberhentian tempat berbalik arah. */
  at: number;
  code: string;
  first: TjMatch;
  second: TjMatch;
  crossing: boolean;
}

/** Halte satu arah (kode GTFS berakhiran S, mis. "Kebon Sirih Arah Utara") tidak bisa dipakai berbalik arah di dalam halte. */
export const canTurn = (code: string) => !/S$/i.test(code);

/** Pola reguler (trip id "-R..") lebih dulu daripada pola putaran pendek. */
const regularFirst = (ps: TjGtfsPattern[]) => [...ps].sort((a, b) => Number(b.trip.includes("-R")) - Number(a.trip.includes("-R")));

const sets = (stops: Stop[]) => stops.map((s) => new Set((Array.isArray(s) ? s : [s]).map((c) => c.toUpperCase())));

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Halte tambahan paling sedikit, lalu pola GTFS asli sebelum pola sambungan, lalu pola reguler. */
function matchBetter(a: TjMatch, b: TjMatch): boolean {
  if (a.extra !== b.extra) return a.extra < b.extra;
  if (!a.pattern.through !== !b.pattern.through) return !a.pattern.through;
  return a.pattern.trip.includes("-R") && !b.pattern.trip.includes("-R");
}

type Cand = { full: boolean; extra: number; regular: boolean; direct: boolean; secs: number };
function better(a: Cand, b: Cand): boolean {
  if (a.full !== b.full) return a.full;
  if (Math.abs(a.extra) !== Math.abs(b.extra)) return Math.abs(a.extra) < Math.abs(b.extra);
  if (a.direct !== b.direct) return a.direct;
  if (a.regular !== b.regular) return a.regular;
  return a.secs < b.secs;
}
