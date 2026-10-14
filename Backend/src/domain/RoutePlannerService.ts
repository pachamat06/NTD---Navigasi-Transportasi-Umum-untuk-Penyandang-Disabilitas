// Modul Perencana Rute (UC-03). Rute disusun dari data dataset (/fares legs), bukan dari geometri
// peta; moda dan nama lini dilengkapi dari /lines dan /operators. Waktu tempuh yang tidak tersedia
// ditandai null dan TIDAK diperkirakan dari jarak (Tabel 3.4 no. 3, UC-01 E5).

import type { RequestContext } from "../context";
import type { CommuteApiClient, FareResult } from "../data/commute/CommuteApiClient";
import type { Line, Route, RouteLeg } from "./models";

export class RoutePlannerService {
  constructor(private commute: CommuteApiClient) {}

  async getRoute(fromId: string, toId: string, ctx: RequestContext, at?: string): Promise<Route | null> {
    const fare = await this.commute.getFare(fromId, toId, ctx, at);
    if (!fare) return null;
    return this.enrich(fare, await this.commute.getLines(ctx));
  }

  /** Rute melalui stasiun perantara: asal → via, lalu via → tujuan (dipakai Rekomendasi Alternatif). */
  async getRouteVia(fromId: string, viaId: string, toId: string, ctx: RequestContext, at?: string): Promise<Route | null> {
    const first = await this.getRoute(fromId, viaId, ctx, at);
    if (!first) return null;
    const second = await this.getRoute(viaId, toId, ctx, at);
    if (!second) return null;
    return combine(first, second, viaId);
  }

  enrich(fare: FareResult, lines: Line[]): Route {
    const legs: RouteLeg[] = fare.legs.map((l) => {
      const line = l.lineId ? lines.find((x) => x.id === l.lineId) : undefined;
      const minutes = l.departureAt && l.arrivalAt ? Math.round((Date.parse(l.arrivalAt) - Date.parse(l.departureAt)) / 60_000) : null;
      return {
        type: l.type,
        ...(l.lineId ? { lineId: l.lineId } : {}),
        ...(line ? { lineName: line.name, mode: line.mode, operator: line.operator } : {}),
        stops: l.stops,
        distanceM: l.distanceM,
        minutes: minutes !== null && Number.isFinite(minutes) && minutes >= 0 ? minutes : null,
        fare: l.fare,
        ...(l.departureAt ? { departureAt: l.departureAt } : {}),
        ...(l.arrivalAt ? { arrivalAt: l.arrivalAt } : {}),
      };
    });
    return totals(legs, fare.totalFare, fare.totalDistanceM);
  }
}

export function totals(legs: RouteLeg[], totalFare?: number, totalDistanceM?: number): Route {
  return {
    legs,
    totalDistanceM: totalDistanceM ?? legs.reduce((s, l) => s + l.distanceM, 0),
    totalMinutes: legs.some((l) => l.minutes !== null) ? legs.reduce((s, l) => s + (l.minutes ?? 0), 0) : null,
    timeComplete: legs.every((l) => l.minutes !== null),
    totalFare: totalFare ?? legs.reduce((s, l) => s + l.fare, 0),
    transfers: legs.filter((l) => l.type === "TRANSFER").length,
  };
}

/** Menyambung dua rute di stasiun `viaId`; pindah lini di sana dicatat sebagai TRANSFER di dalam stasiun. */
export function combine(a: Route, b: Route, viaId: string): Route {
  const legs = [...a.legs.map((l) => ({ ...l, stops: [...l.stops] }))];
  for (const leg of b.legs) {
    const prev = legs[legs.length - 1];
    if (leg.type === "RIDE" && prev?.type === "RIDE") {
      if (prev.lineId && prev.lineId === leg.lineId) {
        // Masih di lini yang sama: gabungkan ruas.
        prev.stops.push(...leg.stops.slice(1));
        prev.distanceM += leg.distanceM;
        prev.minutes = prev.minutes === null || leg.minutes === null ? null : prev.minutes + leg.minutes;
        prev.fare += leg.fare;
        prev.arrivalAt = leg.arrivalAt;
        continue;
      }
      legs.push({ type: "TRANSFER", stops: [viaId, viaId], distanceM: 0, minutes: null, fare: 0 });
    }
    legs.push({ ...leg, stops: [...leg.stops] });
  }
  // Tarif gabungan bisa berbeda dari tarif resmi satu perjalanan; dijumlahkan per ruas.
  return totals(legs);
}

export function routeStationIds(route: Route): string[] {
  const ids: string[] = [];
  for (const leg of route.legs) for (const s of leg.stops) if (ids[ids.length - 1] !== s) ids.push(s);
  return ids;
}

export function transferStationIds(route: Route): string[] {
  return [...new Set(route.legs.filter((l) => l.type === "TRANSFER").flatMap((l) => l.stops))];
}
