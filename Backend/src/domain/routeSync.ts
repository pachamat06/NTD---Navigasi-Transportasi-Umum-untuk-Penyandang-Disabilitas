// Sinkron pengaturan rute (admin) dari dataset: urutan pemberhentian kedua arah beserta waktu tempuh
// antarpemberhentian, frekuensi rata-rata, dan jam layanan.
// - GTFS Transjakarta (koridor BRT): urutan, waktu jadwal, serta frekuensi dan jam layanan dari jendela frekuensi.
// - Commute Data API: urutan dari /lines; untuk moda rel waktu tempuh dari jadwal keberangkatan
//   (/stations/{op}/{code}/timetable, nomor perjalanan sama di dua stasiun berurutan), frekuensi rata-rata dan jam
//   layanan dari keberangkatan di stasiun awal. Untuk TransJakarta waktu dari GTFS bila koridornya ada, frekuensi
//   dan jam layanan dari /headway di pemberhentian awal.

import type { RequestContext } from "../context";
import type { CommuteApiClient } from "../data/commute/CommuteApiClient";
import { lineRefOf } from "../data/commute/station-index";
import type { TjGtfs } from "../data/gtfs/TjGtfs";
import { averageHeadway, isoAt, medianMinutes, serviceHours } from "./railTimetable";
import { attachBranches, defaultsFromGtfs, defaultsFromSequences, type DefaultPattern } from "./routePatterns";
import type { RoutePlannerService } from "./RoutePlannerService";

export type SyncSource = "gtfs" | "commute";

export interface SyncDefaults {
  source: SyncSource;
  patterns: DefaultPattern[];
  branches: string[][];
  /** Ringkasan apa yang terisi dan yang belum, untuk ditampilkan di admin. */
  notes: string[];
}

/** Jalankan `fn` untuk tiap item dengan paling banyak `limit` sekaligus. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const norm = (x: string) =>
  x
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export class RouteSyncService {
  constructor(
    private commute: CommuteApiClient,
    private planner: RoutePlannerService,
    private gtfs: TjGtfs,
  ) {}

  /** Sumber yang dipakai sinkron otomatis: GTFS untuk koridor BRT TransJakarta yang ada di data GTFS, selain itu Commute. */
  autoSource(lineId: string): SyncSource {
    const ref = lineRefOf(lineId);
    return ref?.operator === "TJ" && this.gtfs.hasRoute(ref.code) ? "gtfs" : "commute";
  }

  /**
   * Rute bawaan dua arah lini `lineId` dari `source`, lengkap dengan waktu, frekuensi, dan jam layanan sejauh tersedia.
   * Pemberhentian yang tidak dikenal NTD (mis. stasiun perpanjangan yang belum beroperasi) dibuang; waktunya digabung
   * ke ruas berikutnya.
   */
  async defaults(lineId: string, source: SyncSource, ctx: RequestContext): Promise<SyncDefaults> {
    const raw = await this.rawDefaults(lineId, source, ctx);
    if (!raw.patterns.length) return raw;
    const known = new Set((await this.commute.getStations(ctx)).map((s) => s.id));
    const dropped = new Set<string>();
    const cleaned = raw.patterns.flatMap((p) => {
      const stops = dropUnknown(p.stops, known, dropped);
      return stops.length >= 2 ? [{ ...p, stops }] : [];
    });
    // Ruas cabang/putaran dataset ikut disimpan agar tidak hilang dari peta dan pencarian rute setelah sinkron.
    const branches = raw.branches.flatMap((b) => {
      const ids = dropUnknown(b.map((stationId) => ({ stationId, minutes: null })), known, dropped).map((x) => x.stationId);
      return ids.length >= 2 ? [ids] : [];
    });
    const patterns = attachBranches(cleaned, branches);
    const kept = patterns[0]?.branches ?? [];
    const notes = summarize(patterns);
    if (kept.length) notes.push(`${kept.length} ruas cabang dari dataset disertakan`);
    if (dropped.size) notes.push(`${dropped.size} pemberhentian dilewati karena belum dikenal NTD: ${[...dropped].join(", ")}`);
    return { ...raw, patterns, branches: kept, notes };
  }

  private async rawDefaults(lineId: string, source: SyncSource, ctx: RequestContext): Promise<SyncDefaults> {
    const ref = lineRefOf(lineId);
    if (source === "gtfs") {
      if (ref?.operator !== "TJ" || !this.gtfs.hasRoute(ref.code)) return { source, patterns: [], branches: [], notes: ["Data GTFS hanya tersedia untuk koridor BRT TransJakarta yang tercantum di NTD."] };
      const idx = await this.commute.index(ctx);
      const patterns = defaultsFromGtfs(this.gtfs, ref.code, (code) => idx.idOf({ operator: "TJ", code }));
      // Cabang/ramp dari urutan Commute (GTFS hanya memberi pola utama tiap arah).
      const seq = (await this.commute.getLineSequences(ctx)).find((x) => x.lineId === lineId);
      return { source, patterns, branches: seq?.sequences.slice(1) ?? [], notes: [] };
    }
    const seq = (await this.commute.getLineSequences(ctx)).find((x) => x.lineId === lineId);
    const base = defaultsFromSequences(seq);
    if (!base.patterns.length || !ref) return { source, ...base, notes: base.patterns.length ? [] : ["Urutan stasiun lini ini tidak ada di Commute."] };
    const patterns = ref.operator === "TJ" ? await this.fillBus(base.patterns, ref.code, lineId, ctx) : await this.fillRail(base.patterns, ref, ctx);
    return { source, patterns, branches: base.branches, notes: [] };
  }

  /** Moda rel: waktu antarstasiun berurutan, frekuensi rata-rata, dan jam layanan dari jadwal hari kerja. */
  private async fillRail(patterns: DefaultPattern[], line: { operator: string; code: string }, ctx: RequestContext): Promise<DefaultPattern[]> {
    return Promise.all(
      patterns.map(async (p) => {
        const pairs = p.stops.slice(1).map((s, i) => [p.stops[i].stationId, s.stationId] as const);
        const trips = await mapLimit(pairs, 4, ([a, b]) => this.planner.tripsBetween(a, b, "WD", ctx, line).catch(() => []));
        const stops = p.stops.map((s, i) => (i === 0 ? { ...s, minutes: null } : { ...s, minutes: medianMinutes(trips[i - 1]) ?? null }));
        // Stasiun awal yang belum beroperasi/tidak punya jadwal: frekuensi dari ruas pertama yang punya jadwal.
        const first = trips.find((t) => t.length) ?? [];
        const headway = averageHeadway(first);
        const hours = serviceHours(first);
        return { ...p, stops, ...(headway ? { headwayMinutes: Math.min(240, headway) } : {}), ...(hours ? { serviceHours: hours } : {}) };
      }),
    );
  }

  /**
   * TransJakarta lewat Commute: waktu antarhalte dari GTFS bila koridornya ada di data GTFS; frekuensi dan jam
   * layanan dari /headway di halte awal tiap arah (pukul 08.00 WIB hari ini), arah dicocokkan dengan tujuan akhir.
   */
  private async fillBus(patterns: DefaultPattern[], code: string, lineId: string, ctx: RequestContext): Promise<DefaultPattern[]> {
    const idx = await this.commute.index(ctx);
    const stations = await this.commute.getStations(ctx);
    const nameOf = new Map(stations.map((s) => [s.id, s.name]));
    const tjOf = (id: string) => idx.refsOf(id).flatMap((r) => (r.operator.toUpperCase() === "TJ" ? [r.code.toUpperCase()] : []));
    const gtfs = this.gtfs.hasRoute(code) ? this.gtfs : undefined;
    const at = isoAt(ctx.now, 8 * 60);
    return Promise.all(
      patterns.map(async (p) => {
        const stops = p.stops.map((s, i) => {
          if (i === 0 || !gtfs) return { ...s, minutes: null };
          const a = tjOf(p.stops[i - 1].stationId);
          const b = tjOf(s.stationId);
          const t = a.length && b.length ? gtfs.rideTime(code, [a, b]) : null;
          return { ...s, minutes: t ? t.minutes : null };
        });
        const rows = (await this.commute.getHeadways(p.stops[0].stationId, ctx, at).catch(() => [])).filter((r) => r.lineId === lineId && r.headwayMinutes !== null);
        const last = norm(nameOf.get(p.stops[p.stops.length - 1].stationId) ?? "");
        const row = rows.find((r) => r.boundFor && last && (norm(r.boundFor) === last || norm(r.boundFor).includes(last) || last.includes(norm(r.boundFor)))) ?? rows.find((r) => !r.boundFor) ?? rows[0];
        return {
          ...p,
          stops,
          ...(row?.headwayMinutes ? { headwayMinutes: Math.min(240, row.headwayMinutes) } : {}),
          ...(row?.serviceHours ? { serviceHours: row.serviceHours } : {}),
        };
      }),
    );
  }
}

/** Buang pemberhentian yang tidak dikenal; waktu ruas yang dibuang ditambahkan ke ruas berikutnya. */
export function dropUnknown(stops: { stationId: string; minutes: number | null }[], known: Set<string>, dropped: Set<string> = new Set()): { stationId: string; minutes: number | null }[] {
  const out: { stationId: string; minutes: number | null }[] = [];
  let carry: number | null = 0;
  for (const s of stops) {
    if (!known.has(s.stationId)) {
      dropped.add(s.stationId);
      // Waktu menuju pemberhentian yang dibuang ikut dibawa (hanya bila sudah ada pemberhentian sebelumnya).
      if (out.length) carry = carry === null || s.minutes === null ? null : carry + s.minutes;
      continue;
    }
    if (!out.length) out.push({ stationId: s.stationId, minutes: null });
    else if (out[out.length - 1].stationId !== s.stationId) out.push({ stationId: s.stationId, minutes: carry === null || s.minutes === null ? null : Math.round((carry + s.minutes) * 10) / 10 });
    carry = 0;
  }
  return out;
}

/** Ringkasan isi hasil sinkron per arah, mis. "Arah 1: waktu 12/14 ruas, frekuensi 8 mnt, jam layanan 04:30–23:00". */
export function summarize(patterns: DefaultPattern[]): string[] {
  return patterns.map((p) => {
    const legs = p.stops.length - 1;
    const timed = p.stops.slice(1).filter((s) => typeof s.minutes === "number").length;
    const parts = [
      `waktu ${timed}/${legs} ruas`,
      p.headwayMinutes ? `frekuensi ${p.headwayMinutes} mnt` : "frekuensi tidak tersedia",
      p.serviceHours ? `jam layanan ${p.serviceHours}` : "jam layanan tidak tersedia",
    ];
    return `Arah ${p.direction + 1}: ${parts.join(", ")}`;
  });
}
