// Modul Rekomendasi Alternatif (UC-05): bila titik transfer tidak memadai, cari anggota lain dalam
// hub yang sama (/hubs), susun rute melalui anggota itu, lalu nilai ulang (nilaiUlangTransfer).

import type { RequestContext } from "../context";
import type { ContentSnapshot } from "./content";
import type { FacilityAnalysisService } from "./FacilityAnalysisService";
import type { Alternative, Hub, Route, StationAssessment, TransferNeed } from "./models";
import { transferStationIds, type RoutePlannerService } from "./RoutePlannerService";

export const MAX_ALTERNATIVES = 3;

export class AlternativeService {
  constructor(
    private planner: RoutePlannerService,
    private facilities: FacilityAnalysisService,
  ) {}

  async suggest(
    input: { originId: string; destinationId: string; route: Route; assessments: Map<string, StationAssessment>; hubs: Hub[]; avoid?: string[]; at?: string; needs?: TransferNeed[] },
    ctx: RequestContext,
    snap: ContentSnapshot,
  ): Promise<Alternative[]> {
    const { originId, destinationId, route, hubs } = input;
    const avoid = input.avoid ?? [];
    const assess = async (id: string) => input.assessments.get(id) ?? (await this.facilities.assess(id, ctx, snap)).assessment;
    const needs = input.needs ?? [];
    // Fasilitas yang dibutuhkan pengguna (mis. lift) harus tercatat tersedia di stasiun tempat pindah.
    const meetsNeeds = async (id: string) => {
      if (!needs.length) return true;
      const f = await this.facilities.facilities(id, ctx, snap);
      return needs.every((n) => f.amenities[n] === "available");
    };

    const weak: string[] = [];
    for (const id of transferStationIds(route)) {
      if (id === originId || id === destinationId) continue;
      if (!(await assess(id)).adequate || avoid.includes(id) || !(await meetsNeeds(id))) weak.push(id);
    }

    const out: Alternative[] = [];
    for (const weakId of weak) {
      const weakScore = (await assess(weakId)).score;
      for (const hub of hubs.filter((h) => h.memberIds.includes(weakId))) {
        for (const via of hub.memberIds) {
          if ([weakId, originId, destinationId, ...avoid].includes(via)) continue;
          if (out.some((a) => a.viaStationId === via)) continue;
          const assessment = await assess(via);
          if (!assessment.dataAvailable || !(await meetsNeeds(via))) continue;
          // Tanpa kebutuhan khusus, alternatif harus lebih baik skornya; dengan kebutuhan, cukup memenuhinya.
          if (assessment.score <= weakScore && (!needs.length || (await meetsNeeds(weakId)))) continue;
          const alt = await this.planner.getRouteVia(originId, via, destinationId, ctx, input.at);
          if (!alt) continue;
          const altTransfers = transferStationIds(alt);
          if (altTransfers.includes(weakId) || altTransfers.some((t) => avoid.includes(t))) continue;
          out.push({ hubId: hub.id, viaStationId: via, replacesStationId: weakId, assessment, avoid: [...avoid, weakId], route: alt });
        }
      }
    }
    return out.sort((a, b) => b.assessment.score - a.assessment.score).slice(0, MAX_ALTERNATIVES);
  }
}
