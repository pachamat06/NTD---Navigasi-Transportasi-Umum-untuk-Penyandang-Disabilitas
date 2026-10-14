// Modul Pencarian Stasiun (UC-02). Dipanggil langsung oleh controller untuk autocomplete
// tanpa melewati agen (Tabel 3.4 no. 11).

import type { RequestContext } from "../context";
import type { CommuteApiClient } from "../data/commute/CommuteApiClient";
import type { ContentSnapshot } from "./content";
import type { FacilityAnalysisService } from "./FacilityAnalysisService";
import type { Hub, Line, Station, StationDetail } from "./models";

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
  ) {}

  list(ctx: RequestContext): Promise<Station[]> {
    return this.commute.getStations(ctx);
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

  lines(ctx: RequestContext): Promise<Line[]> {
    return this.commute.getLines(ctx);
  }

  hubs(ctx: RequestContext): Promise<Hub[]> {
    return this.commute.getHubs(ctx);
  }

  /** Detail stasiun: fasilitas (dataset + tim), penilaian, pintu akses, info lain, dan pengumuman aktif. */
  async detail(id: string, ctx: RequestContext, snap: ContentSnapshot, station?: Station): Promise<StationDetail | undefined> {
    const st = station ?? (await this.get(id, ctx));
    if (!st) return undefined;
    const { assessment, facilities } = await this.facilities.assess(id, ctx, snap);
    return {
      ...st,
      ...facilities,
      assessment,
      entrances: snap.entrancesOf(id),
      info: snap.infoOf(id),
      notices: snap.notices({ stationIds: [id], lineIds: st.lineIds, hubIds: st.hubId ? [st.hubId] : [] }).filter((n) => n.scope !== "global"),
    };
  }
}
