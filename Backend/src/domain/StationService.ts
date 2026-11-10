// Modul Pencarian Stasiun (UC-02). Dipanggil langsung oleh controller untuk autocomplete
// tanpa melewati agen (Tabel 3.4 no. 11).

import type { RequestContext } from "../context";
import type { CommuteApiClient } from "../data/commute/CommuteApiClient";
import type { ContentSnapshot } from "./content";
import { applyPlatformExits, mergeGates, type FacilityAnalysisService } from "./FacilityAnalysisService";
import type { Entrance, Hub, Line, Platform, Station, StationDetail } from "./models";
import { applyPatternsToLines, type PatternProvider } from "./routePatterns";
import { applyHubs, hubOfStation, type HubProvider } from "./hubs";
import { inactiveStations, type StationStatusProvider } from "./stationStatus";

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export class StationService {
  constructor(
    private commute: CommuteApiClient,
    private facilities: FacilityAnalysisService,
    /** Pengaturan rute dari admin: urutan stasiun lini mengikuti pengaturan itu. */
    private patterns?: PatternProvider,
    /** Hub transfer dari admin (dibuat, diubah, atau dinonaktifkan). */
    private hubOverrides?: HubProvider,
    /** Status operasional stasiun dari admin; stasiun nonaktif ditandai `inactive`. */
    private statuses?: StationStatusProvider,
  ) {}

  /**
   * Stasiun dataset; hub tiap stasiun mengikuti daftar hub yang berlaku (termasuk hub bawaan NTD dan isian admin).
   * Stasiun yang sudah tidak beroperasi tetap tercantum dengan `inactive` agar pengguna mendapat pesan yang jelas.
   */
  async list(ctx: RequestContext): Promise<Station[]> {
    const [stations, hubs, overrides] = await Promise.all([this.commute.getStations(ctx), this.hubsFor(ctx), this.statuses ? this.statuses(ctx) : Promise.resolve([])]);
    const of = hubOfStation(hubs);
    const inactive = inactiveStations(overrides);
    return stations.map((s) => {
      const hubId = of.get(s.id);
      const off = inactive.get(s.id);
      const status = off ? { inactive: true, ...(off.note ? { inactiveNote: off.note } : {}) } : {};
      if (hubId === s.hubId) return off ? { ...s, ...status } : s;
      const { hubId: _, ...rest } = s;
      return { ...rest, ...(hubId ? { hubId } : {}), ...status };
    });
  }

  async get(id: string, ctx: RequestContext): Promise<Station | undefined> {
    return (await this.list(ctx)).find((s) => s.id === id);
  }

  /** Pencarian nama atau kode stasiun; awalan kata diutamakan. Minimal 2 karakter. */
  async search(query: string, ctx: RequestContext, limit = 6): Promise<Station[]> {
    const q = normalize(query);
    if (q.length < 2) return [];
    const all = await this.list(ctx);
    const scored = all
      .map((s) => {
        const name = normalize(s.name);
        const codes = s.codes.map((c) => c.toLowerCase());
        let rank = -1;
        if (codes.includes(q)) rank = 0;
        else if (name.startsWith(q)) rank = 1;
        else if (name.split(" ").some((w) => w.startsWith(q))) rank = 2;
        else if (name.includes(q)) rank = 3;
        return { s, rank };
      })
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.s.name.localeCompare(b.s.name, "id"));
    return scored.slice(0, limit).map((x) => x.s);
  }

  async lines(ctx: RequestContext): Promise<Line[]> {
    const [lines, patterns] = await Promise.all([this.commute.getLines(ctx), this.patterns ? this.patterns(ctx) : Promise.resolve([])]);
    return applyPatternsToLines(lines, patterns);
  }

  /** Hub transfer yang berlaku: Commute, hub bawaan NTD, lalu isian admin. */
  hubs(ctx: RequestContext): Promise<Hub[]> {
    return this.hubsFor(ctx);
  }

  private async hubsFor(ctx: RequestContext): Promise<Hub[]> {
    const [base, overrides, stations] = await Promise.all([this.commute.getHubs(ctx), this.hubOverrides ? this.hubOverrides(ctx) : Promise.resolve([]), this.commute.getStations(ctx)]);
    return applyHubs(base, overrides, new Set(stations.map((s) => s.id)));
  }

  /** Detail stasiun: fasilitas (dataset + tim), penilaian, pintu akses, info lain, dan pengumuman aktif. */
  async detail(id: string, ctx: RequestContext, snap: ContentSnapshot, station?: Station, opts: { dataset?: boolean } = {}): Promise<StationDetail | undefined> {
    const st = station ?? (await this.get(id, ctx));
    if (!st) return undefined;
    // Peron dan pintu dari dataset butuh dua permintaan per kode stasiun; pemberhentian yang hanya dilewati tidak memerlukannya.
    const dataset = opts.dataset !== false;
    const [{ assessment, facilities }, platforms, exits] = await Promise.all([
      this.facilities.assess(id, ctx, snap),
      dataset ? this.commute.getPlatforms(id, ctx) : Promise.resolve([]),
      dataset ? this.commute.getExits(id, ctx) : Promise.resolve([]),
    ]);
    const merged = mergePlatforms(platforms, snap.platformsOf(id));
    return {
      ...st,
      ...facilities,
      assessment,
      platforms: merged,
      // Akses peron ke pintu keluar (isian data peron) ikut menjadi jalur gate → peron.
      entrances: applyPlatformExits(mergeEntrances(exits, snap.entrancesOf(id)), merged),
      concourses: snap.concoursesOf(id),
      info: snap.infoOf(id),
      notices: snap.notices({ stationIds: [id], lineIds: st.lineIds, hubIds: st.hubId ? [st.hubId] : [] }).filter((n) => n.scope !== "global"),
    };
  }
}

/**
 * Peron dataset digabung dengan isian tim per nomor peron: isian tim menang per field; lin/arah dari
 * dataset dipakai bila tim tidak mengisinya. Urut menurut nomor peron.
 */
export function mergePlatforms(dataset: Platform[], ntd: Platform[]): Platform[] {
  const out = new Map(dataset.map((p) => [p.code, p]));
  for (const p of ntd) {
    const base = out.get(p.code);
    out.set(p.code, base ? { ...base, ...p, serves: p.serves.length ? p.serves : base.serves, amenities: { ...base.amenities, ...p.amenities } } : p);
  }
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code, "id", { numeric: true }));
}

/** Pintu dataset (/exits) yang belum dilengkapi tim ikut ditampilkan; yang sudah dilengkapi memakai isian tim. */
export function mergeEntrances(dataset: Entrance[], ntd: Entrance[]): Entrance[] {
  return mergeGates(dataset, ntd);
}
