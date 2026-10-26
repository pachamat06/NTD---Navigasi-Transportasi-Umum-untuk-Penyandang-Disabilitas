// Modul Perencana Rute (UC-03). Rute disusun dari data dataset (/fares legs), bukan dari geometri
// peta; moda dan nama lini dilengkapi dari /lines dan /operators. Waktu tempuh yang tidak tersedia
// ditandai null dan TIDAK diperkirakan dari jarak (Tabel 3.4 no. 3, UC-01 E5).

import type { RequestContext } from "../context";
import type { CommuteApiClient, FareResult, LineHeadway } from "../data/commute/CommuteApiClient";
import type { Frequency, Hub, Line, Mode, RideOption, Route, RouteLeg, Station } from "./models";

/** Moda menurut kode operator, untuk ruas yang lininya tidak ada di daftar lini (mis. operator dikeluarkan). */
const OPERATOR_MODE: Record<string, Mode> = { KCI: "RAIL", RLK: "RAIL", MRTJ: "SUBWAY", LRTJ: "TRAM", LRTJBDB: "TRAM", TJ: "BUS", APCGK: "MONORAIL" };

/** Ruas naik yang memakai salah satu moda yang ingin dihindari. */
export function usesModes(route: Route, modes: readonly Mode[]): boolean {
  return modes.length > 0 && route.legs.some((l) => l.type === "RIDE" && !!l.mode && modes.includes(l.mode));
}

/** Biaya pindah lini (setara km) dalam pencarian rute topologi; berjalan antar stasiun hub ditambah jaraknya. */
const TRANSFER_COST_KM = 2;
/**
 * Pengali jarak jalan kaki terhadap jarak naik kendaraan. 2 = rata-rata; pengguna yang butuh lift/ramp/eskalator
 * memakai 4 agar perpindahan jauh kalah dari satu kali naik tambahan (meniru preferensi jalan kaki Commute).
 */
export const WALK_WEIGHT = { AVERAGE: 2, SLOW: 4 } as const;
/** Jarak antar stasiun bila koordinat tidak tersedia (hanya untuk membandingkan rute, tidak ditampilkan). */
const UNKNOWN_HOP_KM = 1;

/** Ruas naik pada satu lini; lineId "" = berjalan kaki antar stasiun di hub. */
interface Ride {
  lineId: string;
  stops: string[];
}

export class RoutePlannerService {
  constructor(private commute: CommuteApiClient) {}

  async getRoute(fromId: string, toId: string, ctx: RequestContext, at?: string): Promise<Route | null> {
    const fare = await this.commute.getFare(fromId, toId, ctx, at);
    if (!fare) return null;
    return this.enrich(fare, await this.commute.getLines(ctx));
  }

  /**
   * Rute yang tidak memakai moda tertentu. Bila rute dataset memakainya, rute dicari sendiri di atas urutan
   * stasiun lini-lini yang diizinkan (/lines) dan perpindahan di hub, lalu tiap ruas naik diminta ke /fares
   * agar tarif dan jadwalnya tetap dari dataset. Tidak ada rute yang lolos = rute dataset dikembalikan apa
   * adanya (pemanggil memberi peringatan).
   */
  async getRouteAvoiding(fromId: string, toId: string, avoidModes: readonly Mode[], ctx: RequestContext, at?: string, walkWeight: number = WALK_WEIGHT.AVERAGE): Promise<Route | null> {
    const direct = await this.getRoute(fromId, toId, ctx, at);
    if (direct && !usesModes(direct, avoidModes)) return direct;
    const [stations, lines, hubs, sequences] = await Promise.all([
      this.commute.getStations(ctx),
      this.commute.getLines(ctx),
      this.commute.getHubs(ctx),
      this.commute.getLineSequences(ctx),
    ]);
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const allowed = sequences.filter((s) => {
      const mode = lineById.get(s.lineId)?.mode;
      return !mode || !avoidModes.includes(mode);
    });
    const rides = findRides(fromId, toId, allowed, hubs, new Map(stations.map((s) => [s.id, s])), walkWeight);
    if (!rides) return direct;
    const walksOf = hubs.flatMap((h) => h.walks);
    const parts = await Promise.all(
      rides.map((r): Promise<Route> => {
        if (r.lineId) return this.rideRoute(r, avoidModes, lineById, stations, ctx, at);
        const [a, b] = r.stops;
        const walk = walksOf.find((w) => (w.from === a && w.to === b) || (w.from === b && w.to === a));
        return Promise.resolve(
          totals([
            {
              type: "TRANSFER",
              stops: [a, b],
              distanceM: walk?.distanceM ?? 0,
              minutes: walk?.minutes ?? null,
              fare: 0,
              ...(walk?.notes ? { notes: walk.notes } : {}),
            },
          ]),
        );
      }),
    );
    const legs: RouteLeg[] = [];
    let stopNames: Record<string, string> = {};
    for (const part of parts) {
      const prev = legs[legs.length - 1];
      const next = part.legs[0];
      // Dua ruas naik bersambung di stasiun yang sama: pindah lini di dalam stasiun.
      if (prev?.type === "RIDE" && next?.type === "RIDE") {
        const stop = prev.stops[prev.stops.length - 1];
        legs.push({ type: "TRANSFER", stops: [stop, stop], distanceM: 0, minutes: null, fare: 0 });
      }
      legs.push(...part.legs);
      stopNames = { ...stopNames, ...part.stopNames };
    }
    // Tarif per ruas dari dataset ditagih per segmen operator; jumlahkan total tiap ruas, bukan tarif per leg.
    const totalFare = parts.reduce((sum, p) => sum + p.totalFare, 0);
    const route: Route = { ...totals(legs, totalFare), ...(parts.some((p) => p.fareComplete === false) ? { fareComplete: false } : {}) };
    return Object.keys(stopNames).length ? { ...route, stopNames } : route;
  }

  /**
   * Satu ruas naik pada lini yang diizinkan: dipakai rute /fares bila tidak memakai moda yang dihindari;
   * bila tidak, ruas disusun dari urutan stasiun lini (jarak dari koordinat, waktu dan tarif tidak tersedia).
   */
  private async rideRoute(ride: Ride, avoidModes: readonly Mode[], lineById: Map<string, Line>, stations: Station[], ctx: RequestContext, at?: string): Promise<Route> {
    const from = ride.stops[0];
    const to = ride.stops[ride.stops.length - 1];
    const fromDataset = await this.getRoute(from, to, ctx, at).catch(() => null);
    if (fromDataset && !usesModes(fromDataset, avoidModes)) {
      // Ruas pindah di ujung tidak diperlukan; perpindahan disusun oleh pemanggil.
      const legs = fromDataset.legs.slice();
      while (legs[0]?.type === "TRANSFER") legs.shift();
      while (legs[legs.length - 1]?.type === "TRANSFER") legs.pop();
      if (legs.length) return { ...fromDataset, legs };
    }
    const line = lineById.get(ride.lineId);
    const byId = new Map(stations.map((s) => [s.id, s]));
    let distanceM = 0;
    for (let i = 1; i < ride.stops.length; i++) {
      const a = byId.get(ride.stops[i - 1]);
      const b = byId.get(ride.stops[i]);
      if (a && b && hasCoords(a) && hasCoords(b)) distanceM += km(a, b) * 1000;
    }
    const leg: RouteLeg = {
      type: "RIDE",
      lineId: ride.lineId,
      ...(line ? { lineName: line.name, operator: line.operator, mode: line.mode } : {}),
      stops: ride.stops,
      distanceM: Math.round(distanceM),
      minutes: null,
      fare: 0,
    };
    return { ...totals([leg]), fareComplete: false };
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
      const mode = line?.mode ?? (l.operator ? OPERATOR_MODE[l.operator.toUpperCase()] : undefined);
      const minutes = l.departureAt && l.arrivalAt ? Math.round((Date.parse(l.arrivalAt) - Date.parse(l.departureAt)) / 60_000) : null;
      const options: RideOption[] | undefined =
        l.serviceLines && l.serviceLines.length > 1
          ? l.serviceLines.map((x) => {
              const ln = lines.find((y) => y.id === x.lineId);
              return { lineId: x.lineId, ...(ln ? { lineName: ln.name } : {}), ...(x.headsign ? { headsign: x.headsign } : {}) };
            })
          : undefined;
      return {
        type: l.type,
        ...(l.lineId ? { lineId: l.lineId } : {}),
        ...(line ? { lineName: line.name, operator: line.operator } : {}),
        ...(l.headsign ? { headsign: l.headsign } : {}),
        ...(options ? { options } : {}),
        ...(l.type === "RIDE" && mode ? { mode } : {}),
        stops: l.stops,
        distanceM: l.distanceM,
        minutes: minutes !== null && Number.isFinite(minutes) && minutes >= 0 ? minutes : null,
        fare: l.fare,
        ...(l.departureAt ? { departureAt: l.departureAt } : {}),
        ...(l.arrivalAt ? { arrivalAt: l.arrivalAt } : {}),
      };
    });
    const route = totals(legs, fare.totalFare, fare.totalDistanceM);
    return Object.keys(fare.stopNames ?? {}).length ? { ...route, stopNames: fare.stopNames } : route;
  }

  /**
   * Melengkapi rute untuk ditampilkan:
   * - ruas pindah antarstasiun: jarak, petunjuk jalan, dan pintu keluar dari /transfers;
   * - ruas naik yang dilayani beberapa lin paralel tetapi belum punya pilihan (mis. ruas yang disusun sendiri):
   *   lin lain dari operator yang sama yang berhenti di semua pemberhentian ruas itu berurutan;
   * - ruas naik tanpa jadwal: frekuensi lin di pemberhentian naik (gabungan bila ada beberapa pilihan).
   */
  async annotate(route: Route, ctx: RequestContext, at?: string): Promise<Route> {
    const needsParallel = route.legs.some((l) => l.type === "RIDE" && !l.options && l.lineId);
    const [lines, sequences] = await Promise.all([this.commute.getLines(ctx), needsParallel ? this.commute.getLineSequences(ctx) : Promise.resolve([])]);
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const legs = await Promise.all(
      route.legs.map(async (leg): Promise<RouteLeg> => {
        if (leg.type === "TRANSFER") {
          const [a, b] = [leg.stops[0], leg.stops[leg.stops.length - 1]];
          if (a === b) return leg;
          const walk = await this.commute.getWalk(a, b, ctx).catch(() => undefined);
          if (!walk) return leg;
          return {
            ...leg,
            distanceM: leg.distanceM || walk.distanceM,
            ...(leg.minutes === null && walk.minutes !== null ? { minutes: walk.minutes } : {}),
            ...(walk.notes ? { notes: walk.notes } : {}),
            ...(walk.fromExit ? { fromExit: walk.fromExit } : {}),
            ...(walk.toExit ? { toExit: walk.toExit } : {}),
          };
        }
        let out = leg;
        if (!out.options && out.lineId) {
          const operator = lineById.get(out.lineId)?.operator;
          const parallel = parallelLines(out.stops, out.lineId, sequences, (id) => lineById.get(id)?.operator === operator);
          if (parallel.length > 1) out = { ...out, options: parallel.map((id) => ({ lineId: id, ...(lineById.get(id) ? { lineName: lineById.get(id)!.name } : {}) })) };
        }
        // Waktu tempuh bukan jadwal: frekuensi tetap dicari selama jam berangkat tidak diketahui.
        if (out.departureAt) return out;
        const rows = await this.commute.getHeadways(out.stops[0], ctx, at);
        if (!rows.length) return out;
        const choices = out.options ?? [{ lineId: out.lineId ?? "", ...(out.headsign ? { headsign: out.headsign } : {}) }];
        const options = choices.map((o) => {
          // Lin utama memakai tujuan akhir ruas bila pilihan itu sendiri tidak membawanya.
          const f = frequencyOf(rows, o.lineId, o.headsign ?? (o.lineId === out.lineId ? out.headsign : undefined));
          return f ? { ...o, frequency: f } : o;
        });
        const frequency = combinedFrequency(options.map((o) => o.frequency));
        return { ...out, ...(out.options ? { options } : {}), ...(frequency ? { frequency } : {}) };
      }),
    );
    const next = { ...route, legs };
    return { ...next, totalDistanceM: route.totalDistanceM || legs.reduce((s, l) => s + l.distanceM, 0) };
  }
}

/** Frekuensi satu lin dari baris /headway; arah dipilih lewat tujuan akhir bila frekuensi dua arah berbeda. */
export function frequencyOf(rows: LineHeadway[], lineId: string, headsign?: string): Frequency | undefined {
  const mine = rows.filter((r) => r.lineId === lineId && r.headwayMinutes !== null);
  if (!mine.length) return undefined;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const byDir = headsign ? mine.find((r) => r.boundFor && (norm(r.boundFor).includes(norm(headsign)) || norm(headsign).includes(norm(r.boundFor)))) : undefined;
  // Arah tidak diketahui: ambil yang paling jarang agar waktu tunggu tidak terlihat lebih singkat dari kenyataan.
  const pick = byDir ?? mine.reduce((a, b) => (b.headwayMinutes! > a.headwayMinutes! ? b : a));
  return { headwayMinutes: pick.headwayMinutes!, source: pick.source, ...(pick.serviceHours ? { serviceHours: pick.serviceHours } : {}) };
}

/** Frekuensi gabungan beberapa lin paralel: kendaraan lin mana pun yang datang lebih dulu bisa dinaiki. */
export function combinedFrequency(list: (Frequency | undefined)[]): Frequency | undefined {
  const known = list.filter((f): f is Frequency => !!f);
  if (!known.length) return undefined;
  if (known.length === 1) return known[0];
  const perMinute = known.reduce((s, f) => s + 1 / f.headwayMinutes, 0);
  return { headwayMinutes: Math.max(1, Math.round(1 / perMinute)), source: known.every((f) => f.source === "STOP") ? "STOP" : "LINE" };
}

/**
 * Lin (memenuhi `same`) yang berhenti di SEMUA pemberhentian `stops` secara berurutan tanpa melewati
 * pemberhentian lain di antaranya, ke arah mana pun. Lin `primary` paling depan.
 */
export function parallelLines(stops: string[], primary: string, sequences: { lineId: string; sequences: string[][] }[], same: (lineId: string) => boolean): string[] {
  if (stops.length < 2) return [primary];
  const covers = (seq: string[]) => {
    for (const dir of [seq, [...seq].reverse()]) {
      const i = dir.indexOf(stops[0]);
      if (i >= 0 && stops.every((s, k) => dir[i + k] === s)) return true;
    }
    return false;
  };
  const found = sequences.filter((l) => l.lineId !== primary && same(l.lineId) && l.sequences.some(covers)).map((l) => l.lineId);
  return [primary, ...new Set(found)];
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
  const stopNames = { ...a.stopNames, ...b.stopNames };
  return Object.keys(stopNames).length ? { ...totals(legs), stopNames } : totals(legs);
}

export function routeStationIds(route: Route): string[] {
  const ids: string[] = [];
  for (const leg of route.legs) for (const s of leg.stops) if (ids[ids.length - 1] !== s) ids.push(s);
  return ids;
}

export function transferStationIds(route: Route): string[] {
  return [...new Set(route.legs.filter((l) => l.type === "TRANSFER").flatMap((l) => l.stops))];
}

/**
 * Dijkstra di atas (stasiun, lini): naik ke stasiun berikut pada ruas lini berbiaya jaraknya, pindah lini di
 * stasiun yang sama atau berjalan ke stasiun lain di hub berbiaya TRANSFER_COST_KM. Hasilnya dipecah menjadi
 * ruas naik per lini. null = tujuan tidak terjangkau.
 */
export function findRides(
  fromId: string,
  toId: string,
  sequences: { lineId: string; sequences: string[][] }[],
  hubs: Hub[],
  stations: Map<string, Station>,
  walkWeight: number = WALK_WEIGHT.AVERAGE,
): Ride[] | null {
  const hop = (a: string, b: string) => {
    const p = stations.get(a);
    const q = stations.get(b);
    const d = p && q && hasCoords(p) && hasCoords(q) ? km(p, q) : 0;
    return d > 0 ? d : UNKNOWN_HOP_KM;
  };
  // Tetangga per stasiun pada tiap lini.
  const rideNext = new Map<string, { lineId: string; to: string; cost: number }[]>();
  const linesAt = new Map<string, Set<string>>();
  const addRide = (a: string, b: string, lineId: string) => {
    if (a === b) return;
    if (!rideNext.has(a)) rideNext.set(a, []);
    rideNext.get(a)!.push({ lineId, to: b, cost: hop(a, b) });
    if (!linesAt.has(a)) linesAt.set(a, new Set());
    linesAt.get(a)!.add(lineId);
  };
  for (const l of sequences)
    for (const seq of l.sequences)
      for (let i = 1; i < seq.length; i++) {
        addRide(seq[i - 1], seq[i], l.lineId);
        addRide(seq[i], seq[i - 1], l.lineId);
      }
  const walks = new Map<string, { to: string; cost: number }[]>();
  const addWalk = (a: string, b: string, m?: number) => {
    if (a === b) return;
    if (!walks.has(a)) walks.set(a, []);
    walks.get(a)!.push({ to: b, cost: TRANSFER_COST_KM + (m !== undefined ? m / 1000 : hop(a, b)) * walkWeight });
  };
  for (const h of hubs) {
    if (h.walks.length) for (const w of h.walks) (addWalk(w.from, w.to, w.distanceM), addWalk(w.to, w.from, w.distanceM));
    else for (const a of h.memberIds) for (const b of h.memberIds) addWalk(a, b);
  }

  // Keadaan: stasiun + lini yang sedang dinaiki ("" = belum naik / baru pindah).
  const key = (st: string, line: string) => `${st}|${line}`;
  const dist = new Map<string, number>([[key(fromId, ""), 0]]);
  const prev = new Map<string, string>();
  const queue = new MinHeap<[number, string, string]>((a, b) => a[0] - b[0]);
  queue.push([0, fromId, ""]);
  let goal: string | null = null;
  while (queue.size) {
    const [d, st, line] = queue.pop()!;
    const k = key(st, line);
    if (d > (dist.get(k) ?? Infinity)) continue;
    if (st === toId) {
      goal = k;
      break;
    }
    const relax = (nst: string, nline: string, cost: number) => {
      const nk = key(nst, nline);
      if (d + cost < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, d + cost);
        prev.set(nk, k);
        queue.push([d + cost, nst, nline]);
      }
    };
    for (const e of rideNext.get(st) ?? []) relax(e.to, e.lineId, e.cost + (line && line !== e.lineId ? TRANSFER_COST_KM : 0));
    if (line) for (const w of walks.get(st) ?? []) relax(w.to, "", w.cost);
  }
  if (!goal) return null;
  const path: [string, string][] = [];
  for (let k: string | undefined = goal; k; k = prev.get(k)) {
    const [st, line] = k.split("|");
    path.unshift([st, line]);
  }
  const rides: Ride[] = [];
  for (let i = 1; i < path.length; i++) {
    const [st, line] = path[i];
    const last = rides[rides.length - 1];
    const before = path[i - 1][0];
    if (!line) rides.push({ lineId: "", stops: [before, st] });
    else if (last?.lineId === line && last.stops[last.stops.length - 1] === before) last.stops.push(st);
    else rides.push({ lineId: line, stops: [before, st] });
  }
  return rides.some((r) => r.lineId) ? rides : null;
}

/** Antrean prioritas biner untuk Dijkstra. */
class MinHeap<T> {
  private items: T[] = [];
  constructor(private compare: (a: T, b: T) => number) {}

  get size() {
    return this.items.length;
  }

  push(x: T) {
    const a = this.items;
    a.push(x);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (this.compare(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length && last !== undefined) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.compare(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.compare(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

const hasCoords = (s: Station): s is Station & { lat: number; lng: number } => typeof s.lat === "number" && typeof s.lng === "number";

/** Jarak garis lurus (km) antara dua titik lintang-bujur. */
function km(a: { lat?: number; lng?: number }, b: { lat?: number; lng?: number }): number {
  const r = Math.PI / 180;
  const dLat = (b.lat! - a.lat!) * r;
  const dLng = (b.lng! - a.lng!) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat! * r) * Math.cos(b.lat! * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
