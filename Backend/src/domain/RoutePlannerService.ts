// Modul Perencana Rute (UC-03). Rute disusun dari data dataset (/fares legs), bukan dari geometri
// peta; moda dan nama lini dilengkapi dari /lines dan /operators. Waktu tempuh yang tidak tersedia
// ditandai null dan TIDAK diperkirakan dari jarak (Tabel 3.4 no. 3, UC-01 E5). Pengecualian: ruas
// TransJakarta koridor BRT NTD memakai waktu jadwal GTFS Transjakarta, ditandai `minutesEstimated`.

import type { RequestContext } from "../context";
import type { CommuteApiClient, FareResult, LineHeadway } from "../data/commute/CommuteApiClient";
import { lineIdOf, lineRefOf, type StationIndex } from "../data/commute/station-index";
import type { TjGtfs } from "../data/gtfs/TjGtfs";
import type { Frequency, Hub, Line, Mode, RideOption, Route, RouteLeg, Station } from "./models";
import { applyHubs, straightDistanceM, walkBetween, type HubProvider } from "./hubs";
import { isLocal } from "./datasetOverlay";
import { applyPatternsToSequences, patternMinutes, type LineSequences, type PatternProvider } from "./routePatterns";
import { jakartaDayHour } from "../data/commute/HttpCommuteSource";
import { headwayAround, isoAt, jakartaMinutes, matchTrips, medianMinutes, nextTrip, serviceHours, terminusTrips, typicalMinutes, type TripMatch } from "./railTimetable";

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
  constructor(
    private commute: CommuteApiClient,
    /** Jadwal GTFS Transjakarta untuk waktu tempuh ruas TransJakarta yang tidak punya jadwal di dataset. */
    private gtfs?: TjGtfs,
    /** Pengaturan rute per lini dan arah dari admin (urutan pemberhentian dan waktu tempuh). */
    private patterns?: PatternProvider,
    /** Hub transfer dari admin (dibuat, diubah, atau dinonaktifkan) di atas hub Commute dan hub bawaan NTD. */
    private hubOverrides?: HubProvider,
  ) {}

  /** Hub transfer yang berlaku untuk pencarian rute topologi (titik pindah dengan jalan kaki). */
  async hubs(ctx: RequestContext): Promise<Hub[]> {
    const [base, overrides, stations] = await Promise.all([this.commute.getHubs(ctx), this.hubOverrides ? this.hubOverrides(ctx) : Promise.resolve([]), this.commute.getStations(ctx)]);
    return applyHubs(base, overrides, new Set(stations.map((s) => s.id)));
  }

  /** Urutan stasiun tiap lini: data bawaan, diganti pengaturan rute admin bila ada. */
  async sequences(ctx: RequestContext): Promise<LineSequences[]> {
    const [base, patterns] = await Promise.all([this.commute.getLineSequences(ctx), this.patterns ? this.patterns(ctx) : Promise.resolve([])]);
    return applyPatternsToSequences(base, patterns);
  }

  /**
   * Rute dari /fares. Bila asal atau tujuan bukan stasiun dataset (stasiun bawaan NTD atau tambahan admin, yang
   * tidak dikenal Commute), rute disusun dari urutan stasiun lini (`topology: false` mematikannya).
   */
  async getRoute(fromId: string, toId: string, ctx: RequestContext, at?: string, opts: { topology?: boolean } = {}): Promise<Route | null> {
    const local = await this.localStations([fromId, toId], ctx);
    const fare = await this.commute.getFare(fromId, toId, ctx, at).catch((e) => {
      if (local) return null;
      throw e;
    });
    if (!fare) return local && opts.topology !== false ? this.topologyRoute(fromId, toId, ctx, at) : null;
    const lines = await this.commute.getLines(ctx);
    return this.fixDirections(this.enrich(fare, lines), lines, ctx);
  }

  /** true bila salah satu stasiun bukan stasiun dataset (lihat datasetOverlay.ts). */
  private async localStations(ids: string[], ctx: RequestContext): Promise<boolean> {
    const stations = await this.commute.getStations(ctx);
    return ids.some((id) => isLocal(stations.find((s) => s.id === id)));
  }

  /** Rute di atas urutan stasiun lini (pengaturan rute admin + dataset): ruas naik dari /fares bila ada, selain itu dari urutan. */
  private async topologyRoute(fromId: string, toId: string, ctx: RequestContext, at?: string): Promise<Route | null> {
    const [stations, lines, hubs, sequences] = await Promise.all([this.commute.getStations(ctx), this.commute.getLines(ctx), this.hubs(ctx), this.sequences(ctx)]);
    const rides = findRides(fromId, toId, sequences, hubs, new Map(stations.map((s) => [s.id, s])), WALK_WEIGHT.AVERAGE);
    if (!rides) return null;
    return this.routeFromRides(rides, [], new Map(lines.map((l) => [l.id, l])), stations, hubs, ctx, at);
  }

  /**
   * Halte BRT gabungan dua arah (mis. Kebon Sirih Arah Utara/Selatan) sebagai halte asal atau tujuan: bila halte
   * arah yang dipakai tidak punya fasilitas yang dibutuhkan (`metAt` false) tetapi halte arah sebaliknya punya,
   * penumpang diarahkan berbalik arah:
   * - tujuan: lewati halte itu sampai halte berikutnya yang bisa berbalik arah, pindah bus, turun di halte seberang;
   * - asal: naik dari halte seberang ke halte berikutnya yang bisa berbalik arah, pindah bus, lalu lanjut.
   */
  async backtrackForNeeds(route: Route, ctx: RequestContext, metAt: (code: string) => Promise<boolean>): Promise<Route> {
    const gtfs = this.gtfs;
    if (!gtfs) return route;
    const idx = await this.commute.index(ctx);
    const idOf = (code: string) => idx.idOf({ operator: "TJ", code });
    const name = (code: string) => gtfs.stop(code)?.name ?? code;
    const lineName = async (code: string) => (await this.commute.getLines(ctx)).find((l) => l.id === lineIdOf("TJ", code))?.name;
    const legs = [...route.legs];
    let changed = false;
    const turn = (at: string, notes: string): RouteLeg => ({ type: "TRANSFER", stops: [at, at], distanceM: 0, minutes: null, fare: 0, turnaround: true, notes });
    const ride = async (line: string, codes: string[], headsign: string): Promise<RouteLeg> => {
      const ln = await lineName(line);
      return { type: "RIDE", lineId: lineIdOf("TJ", line), ...(ln ? { lineName: ln } : {}), operator: "TransJakarta", mode: "BUS", headsign, stops: codes.map(idOf), distanceM: gtfs.distance(codes), minutes: null, fare: 0 };
    };
    const opposite = (stopId: string, used: string) => {
      const codes = idx.refsOf(stopId).filter((r) => r.operator.toUpperCase() === "TJ").map((r) => r.code.toUpperCase());
      return codes.length > 1 ? codes.find((c) => c !== used) : undefined;
    };

    // Tujuan: ruas naik terakhir.
    const li = legs.map((l) => l.type).lastIndexOf("RIDE");
    if (li >= 0 && li === legs.length - 1) {
      const leg = legs[li];
      const lines = tjLines(leg, gtfs);
      const cands = tjCodes(leg.stops, idx);
      const m = lines.length && cands ? gtfs.match(lines, cands) : null;
      const used = m?.codes[m.codes.length - 1];
      const other = used ? opposite(leg.stops[leg.stops.length - 1], used) : undefined;
      const next = m ? gtfs.nextTurnaround(m) : undefined;
      if (m && used && other && next && !(await metAt(used)) && (await metAt(other))) {
        const back = gtfs.path(next.code, other, lines);
        if (back) {
          const ext = m.pattern.stops.slice(m.to + 1, next.index + 1);
          legs.splice(
            li,
            1,
            { ...leg, stops: [...leg.stops, ...ext.map(idOf)], distanceM: leg.distanceM + gtfs.distance([used, ...ext]), minutes: null, minutesEstimated: undefined },
            turn(idOf(next.code), `${name(used)} tidak memiliki fasilitas yang dibutuhkan, sedangkan ${name(other)} memilikinya. Jangan turun di ${name(used)}; lanjut ke ${name(next.code)}, pindah ke bus arah sebaliknya, lalu turun di ${name(other)}.`),
            await ride(back.line, back.stops, back.headsign),
          );
          changed = true;
        }
      }
    }

    // Asal: ruas naik pertama.
    const fi = legs.findIndex((l) => l.type === "RIDE");
    if (fi === 0) {
      const leg = legs[0];
      const lines = tjLines(leg, gtfs);
      const cands = tjCodes(leg.stops, idx);
      const m = lines.length && cands ? gtfs.match(lines, cands) : null;
      const used = m?.codes[0];
      const other = used ? opposite(leg.stops[0], used) : undefined;
      if (m && used && other && !(await metAt(used)) && (await metAt(other))) {
        const out = gtfs.turnaroundAfter(other, lines);
        const back = out ? gtfs.path(out.stops[out.stops.length - 1], used, lines) : null;
        if (out && back) {
          const at = out.stops[out.stops.length - 1];
          legs.splice(
            0,
            1,
            await ride(out.line, out.stops, out.headsign),
            turn(idOf(at), `${name(used)} tidak memiliki fasilitas yang dibutuhkan, sedangkan ${name(other)} memilikinya. Naik dari ${name(other)} ke ${name(at)}, pindah ke bus arah sebaliknya, lalu lanjutkan perjalanan.`),
            { ...leg, stops: [...back.stops.map(idOf), ...leg.stops.slice(1)], distanceM: leg.distanceM + gtfs.distance(back.stops), minutes: null, minutesEstimated: undefined },
          );
          changed = true;
        }
      }
    }
    if (!changed) return route;
    const next = totals(legs, route.totalFare, legs.reduce((s, l) => s + l.distanceM, 0));
    return { ...next, ...(route.stopNames ? { stopNames: route.stopNames } : {}), ...(route.fareComplete !== undefined ? { fareComplete: route.fareComplete } : {}) };
  }

  /**
   * Ruas naik TransJakarta yang urutan haltenya tidak dilayani satu bus (mis. Kampung Melayu > Matraman Baru >
   * Bali Mester: Bali Mester hanya dilayani arah Kampung Melayu) dipecah di halte tempat penumpang bisa berbalik
   * arah: turun, pindah ke bus arah sebaliknya, lalu naik sampai tujuan. Butuh data GTFS.
   */
  async fixDirections(route: Route, lines: Line[], ctx: RequestContext): Promise<Route> {
    const gtfs = this.gtfs;
    if (!gtfs) return route;
    const idx = await this.commute.index(ctx);
    let changed = false;
    const legs = route.legs.flatMap((leg): RouteLeg[] => {
      const lineCodes = tjLines(leg, gtfs);
      const cands = leg.type === "RIDE" ? tjCodes(leg.stops, idx) : undefined;
      if (!lineCodes.length || !cands || gtfs.match(lineCodes, cands)) return [leg];
      const s = gtfs.split(lineCodes, cands);
      if (!s) return [leg];
      changed = true;
      const at = leg.stops[s.at];
      const share = (codes: string[]) => gtfs.distance(codes);
      const [d1, d2] = [share(s.first.codes), share(s.second.codes)];
      const dist1 = d1 + d2 > 0 ? Math.round((leg.distanceM * d1) / (d1 + d2)) : 0;
      const ride = (m: typeof s.first, stops: string[], extra: Partial<RouteLeg>): RouteLeg => {
        const lineId = lineIdOf("TJ", m.line);
        const line = lines.find((l) => l.id === lineId);
        return {
          type: "RIDE",
          lineId,
          ...(line ? { lineName: line.name, operator: line.operator } : leg.operator ? { operator: leg.operator } : {}),
          mode: "BUS",
          headsign: m.pattern.headsign,
          stops,
          distanceM: 0,
          minutes: null,
          fare: 0,
          ...extra,
        };
      };
      const name = gtfs.stop(s.code)?.name ?? at;
      return [
        ride(s.first, leg.stops.slice(0, s.at + 1), { distanceM: dist1, fare: leg.fare }),
        {
          type: "TRANSFER",
          stops: [at, at],
          distanceM: 0,
          minutes: null,
          fare: 0,
          turnaround: true,
          notes: s.crossing
            ? `Turun di ${name}, keluar halte dan menyeberang ke halte arah sebaliknya, lalu naik bus ke arah ${s.second.pattern.headsign}. Bus arah ini tidak berhenti di halte tujuan.`
            : `Turun di ${name} lalu pindah ke bus arah sebaliknya (${s.second.pattern.headsign}) tanpa keluar halte. Bus arah ini tidak berhenti di halte tujuan.`,
        },
        ride(s.second, leg.stops.slice(s.at), { distanceM: Math.max(0, leg.distanceM - dist1) }),
      ];
    });
    if (!changed) return route;
    const next = totals(legs, route.totalFare, route.totalDistanceM);
    return { ...next, ...(route.stopNames ? { stopNames: route.stopNames } : {}), ...(route.fareComplete !== undefined ? { fareComplete: route.fareComplete } : {}) };
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
      this.hubs(ctx),
      this.sequences(ctx),
    ]);
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const allowed = sequences.filter((s) => {
      const mode = lineById.get(s.lineId)?.mode;
      return !mode || !avoidModes.includes(mode);
    });
    const rides = findRides(fromId, toId, allowed, hubs, new Map(stations.map((s) => [s.id, s])), walkWeight);
    if (!rides) return direct;
    return this.routeFromRides(rides, avoidModes, lineById, stations, hubs, ctx, at);
  }

  /**
   * Rute lain antara dua stasiun untuk pilihan rute (paling aksesibel, moderat, tercepat): dicari di atas urutan
   * stasiun lini-lini yang diizinkan dengan aturan berbeda, lalu tiap ruas naik diminta ke /fares. Rute yang sama
   * dengan `known` (lini dan titik pindah sama) tidak diulang. Paling banyak `limit` rute.
   * - paling sedikit pindah lini;
   * - tidak pindah di titik pindah rute `known` pertama (satu per titik pindah);
   * - jalan kaki antarstasiun dibuat mahal (pengguna yang butuh lift/ramp).
   */
  async routeVariants(fromId: string, toId: string, avoidModes: readonly Mode[], known: Route[], ctx: RequestContext, at?: string, limit = 3, avoidTransfers: string[] = []): Promise<Route[]> {
    const [stations, lines, hubs, sequences] = await Promise.all([this.commute.getStations(ctx), this.commute.getLines(ctx), this.hubs(ctx), this.sequences(ctx)]);
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const allowed = sequences.filter((s) => {
      const mode = lineById.get(s.lineId)?.mode;
      return !mode || !avoidModes.includes(mode);
    });
    const byId = new Map(stations.map((s) => [s.id, s]));
    const seen = new Set(known.map(routeSignature));
    const base = known[0];
    const transfersAt = base ? transferStationIds(base).filter((id) => id !== fromId && id !== toId) : [];
    const plans: { walkWeight: number; transferCost?: number; noTransferAt?: string[] }[] = [
      { walkWeight: WALK_WEIGHT.AVERAGE, transferCost: 12 },
      ...transfersAt.slice(0, 2).map((t) => ({ walkWeight: WALK_WEIGHT.AVERAGE, noTransferAt: [t] })),
      { walkWeight: WALK_WEIGHT.SLOW * 2 },
    ];
    const out: Route[] = [];
    const seenRides = new Set<string>();
    for (const p of plans) {
      if (out.length >= limit) break;
      const rides = findRides(fromId, toId, allowed, hubs, byId, p.walkWeight, { transferCost: p.transferCost, noTransferAt: new Set([...(p.noTransferAt ?? []), ...avoidTransfers]) });
      if (!rides) continue;
      const rk = rides.map((r) => `${r.lineId}:${r.stops[0]}>${r.stops[r.stops.length - 1]}`).join("|");
      if (seenRides.has(rk)) continue;
      seenRides.add(rk);
      const route = await this.routeFromRides(rides, avoidModes, lineById, stations, hubs, ctx, at).catch(() => null);
      if (!route) continue;
      const sig = routeSignature(route);
      // Rute yang melewati stasiun yang sama dua kali (bolak-balik) tidak ditawarkan.
      const ids = routeStationIds(route);
      if (seen.has(sig) || new Set(ids).size < ids.length) continue;
      seen.add(sig);
      out.push(route);
    }
    return out;
  }

  /** Menyusun rute dari ruas naik hasil pencarian topologi: tiap ruas naik dari /fares, jalan kaki dari data hub. */
  private async routeFromRides(rides: Ride[], avoidModes: readonly Mode[], lineById: Map<string, Line>, stations: Station[], hubs: Hub[], ctx: RequestContext, at?: string): Promise<Route> {
    const byId = new Map(stations.map((s) => [s.id, s]));
    const parts = await Promise.all(
      rides.map((r): Promise<Route> => {
        if (r.lineId) return this.rideRoute(r, avoidModes, lineById, stations, ctx, at);
        const [a, b] = r.stops;
        const walk = walkBetween(hubs, a, b);
        // Hub tanpa data jalan kaki (mis. hub bawaan NTD): jarak garis lurus antarkoordinat stasiun.
        const straight = walk ? undefined : straightDistanceM(byId.get(a), byId.get(b));
        return Promise.resolve(
          totals([
            {
              type: "TRANSFER",
              stops: [a, b],
              distanceM: walk?.distanceM ?? (straight !== undefined ? Math.round(straight) : 0),
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
    const fromDataset = await this.getRoute(from, to, ctx, at, { topology: false }).catch(() => null);
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
        ...(l.platform ? { platform: l.platform } : {}),
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
    const when = new Date(at ?? ctx.now.toISOString());
    // Moda rel: perjalanan dari jadwal Commute untuk tiap ruas naik (waktu tempuh dan frekuensi).
    const rail = await this.railTrips(route.legs, ctx, when);
    const needsParallel = route.legs.some((l) => l.type === "RIDE" && !l.options && l.lineId);
    const [lines, sequences] = await Promise.all([this.commute.getLines(ctx), needsParallel ? this.sequences(ctx) : Promise.resolve([])]);
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
        // Frekuensi moda rel dihitung dari jadwal keberangkatan yang sampai ke tujuan ruas.
        const trips = rail.get(route.legs.indexOf(leg));
        if (trips) {
          const ready = jakartaMinutes(when);
          const headway = headwayAround(trips, ready);
          const hours = serviceHours(trips);
          return headway ? { ...out, frequency: { headwayMinutes: headway, source: "TIMETABLE", ...(hours ? { serviceHours: hours } : {}) } } : out;
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
    const withTimes = await this.withGtfsTimes(legs, ctx);
    let timed = scheduleRail(withTimes, rail, when);
    // Perjalanan malam: kereta terakhir sudah lewat, jadwal keesokan harinya (hari kerja/Sabtu/Minggu sendiri).
    if (rail.size && timed.some((l, i) => rail.has(i) && !l.departureAt)) {
      const tomorrow = await this.railTrips(route.legs, ctx, new Date(when.getTime() + 86_400_000));
      if (tomorrow.size) timed = scheduleRail(withTimes, rail, when, tomorrow);
    }
    const next = { ...route, legs: timed };
    const estimated = timed.some((l) => l.minutesEstimated);
    const changed = estimated || timed.some((l) => l.fromTimetable);
    return {
      ...next,
      totalDistanceM: route.totalDistanceM || timed.reduce((s, l) => s + l.distanceM, 0),
      ...(changed
        ? {
            totalMinutes: timed.some((l) => l.minutes !== null) ? timed.reduce((s, l) => s + (l.minutes ?? 0), 0) : null,
            timeComplete: timed.every((l) => l.minutes !== null),
            ...(estimated ? { timeEstimated: true } : {}),
          }
        : {}),
    };
  }

  /**
   * Perjalanan kereta (nomor perjalanan sama) dari stasiun naik ke stasiun turun tiap ruas naik moda rel, dari jadwal
   * keberangkatan sehari penuh di kedua stasiun. Kunci = indeks ruas. TransJakarta tidak diproses (memakai GTFS).
   */
  private async railTrips(legs: RouteLeg[], ctx: RequestContext, when: Date): Promise<Map<number, TripMatch[]>> {
    const out = new Map<number, TripMatch[]>();
    const { day } = jakartaDayHour(when);
    await Promise.all(
      legs.map(async (leg, i) => {
        if (leg.type !== "RIDE" || leg.mode === "BUS" || leg.stops.length < 2) return;
        const trips = await this.tripsAlong(leg.stops, day, ctx);
        if (trips.length) out.set(i, trips);
      }),
    );
    return out;
  }

  /**
   * Perjalanan kereta sepanjang `stops` (ruas naik). Bila tidak ada kereta yang melayani seluruh ruas dengan nomor
   * perjalanan yang sama (mis. Lin Cikarang lewat Pasar Senen: kereta berakhir di Kampung Bandan, lalu kereta lain ke
   * Duri–Tanah Abang), ruas dibagi di pemberhentian terjauh yang masih bisa dicapai kereta pertama: jam tiba memakai
   * kereta sambungan pertama yang berangkat dari sana setelah kereta pertama tiba (`changeAt`).
   */
  async tripsAlong(stops: string[], day: "WD" | "SAT" | "SUN", ctx: RequestContext): Promise<TripMatch[]> {
    const a = stops[0];
    const b = stops[stops.length - 1];
    const before = (i: number) => (i > 1 ? stops[i - 1] : undefined);
    const direct = await this.tripsBetween(a, b, day, ctx, undefined, before(stops.length - 1));
    if (direct.length || stops.length < 3 || stops.length > 60) return direct;
    for (let k = stops.length - 2; k >= 1; k--) {
      const first = await this.tripsBetween(a, stops[k], day, ctx, undefined, before(k));
      if (!first.length) continue;
      const second = await this.tripsBetween(stops[k], b, day, ctx, undefined, stops.length - 2 > k ? stops[stops.length - 2] : undefined);
      if (!second.length) continue;
      return first.flatMap((t) => {
        const u = second.find((x) => x.depart >= t.arrive + MIN_CHANGE_MINUTES);
        return u ? [{ trip: `${t.trip}/${u.trip}`, depart: t.depart, arrive: u.arrive, changeAt: stops[k], changeDepart: u.depart }] : [];
      });
    }
    return [];
  }

  /**
   * Perjalanan kereta yang berangkat dari stasiun `a` lalu tiba di stasiun `b` pada hari `day` (nomor perjalanan sama,
   * dari jadwal keberangkatan sehari penuh di kedua stasiun), urut jam berangkat. Stasiun `b` yang menjadi stasiun
   * akhir perjalanan dikenali dari tujuan akhir (boundFor) keberangkatan di `a`. [] = jadwal tidak tersedia.
   */
  async tripsBetween(a: string, b: string, day: "WD" | "SAT" | "SUN", ctx: RequestContext, line?: { operator: string; code: string }, via?: string): Promise<TripMatch[]> {
    const [from, to, stations] = await Promise.all([this.commute.getTimetables(a, day, ctx), this.commute.getTimetables(b, day, ctx), this.commute.getStations(ctx)]);
    if (!from.length || !to.length) return [];
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const name = norm(stations.find((s) => s.id === b)?.name ?? "");
    const endsAt = (boundFor?: string) => !!name && !!boundFor && (norm(boundFor) === name || norm(boundFor).startsWith(name) || name.startsWith(norm(boundFor)));
    let out: TripMatch[] = [];
    // Satu lin saja (mis. sinkron rute Lin Bogor): kereta lin lain yang melewati kedua stasiun tidak dihitung. Kode lin
    // NTD tidak selalu sama dengan kode lin di jadwal (mis. MRT "NS" = "M", LRT Jabodebek = "BK" + "CB"); bila tidak ada
    // keberangkatan dengan kode itu, semua keberangkatan operator itu dipakai.
    const code = line?.code.toUpperCase();
    for (const f0 of from) {
      const own = code ? f0.departures.filter((d) => d.line?.toUpperCase() === code) : [];
      const f = own.length ? { ...f0, departures: own } : f0;
      // Operator yang sama di kedua ujung ruas (mis. KCI); nomor perjalanan hanya unik dalam satu operator.
      for (const t of to.filter((x) => x.operator === f.operator)) {
        const trips = matchTrips(f.departures, t.departures);
        // Stasiun turun adalah stasiun akhir sebagian perjalanan (mis. kereta tujuan Kampung Bandan atau Manggarai):
        // keretanya tidak tercantum di jadwal keberangkatan di sana. Ditambahkan juga walaupun kereta lain yang
        // melewatinya sudah cocok, supaya kereta yang berakhir di sana tidak hilang dari jadwal.
        const matched = new Set(trips.map((x) => x.trip));
        const ending = terminusTrips(
          f.departures.filter((d) => !matched.has(d.tripNumber)),
          matchTrips(t.departures, f.departures),
          endsAt,
        );
        out = [...out, ...trips, ...ending];
      }
    }
    // Stasiun naik dan turun sama-sama stasiun akhir (mis. Lebak Bulus → Bundaran HI, Dukuh Atas → Jatimulya,
    // Terminal 1 → Terminal 3): kereta yang berakhir di `b` tidak tercantum di jadwal `b`, dan kereta arah sebaliknya
    // tidak tercantum di jadwal `a`, sehingga keduanya tidak bisa dicocokkan langsung. Dipakai pemberhentian `via`
    // sebelum `b`: jam di `via` dari nomor perjalanan yang sama, ditambah waktu tempuh `via`–`b` dari arah sebaliknya.
    if (!out.length && via && via !== a && via !== b) {
      const mid = await this.commute.getTimetables(via, day, ctx);
      for (const f0 of from) {
        const own = code ? f0.departures.filter((d) => d.line?.toUpperCase() === code) : [];
        const f = own.length ? { ...f0, departures: own } : f0;
        const ending = new Set(f.departures.filter((d) => endsAt(d.boundFor)).map((d) => d.tripNumber));
        for (const m of mid.filter((x) => x.operator === f.operator)) {
          const toMid = matchTrips(f.departures, m.departures).filter((x) => ending.has(x.trip));
          if (!toMid.length) continue;
          for (const t of to.filter((x) => x.operator === f.operator)) {
            const last = medianMinutes(matchTrips(t.departures, m.departures));
            if (last === undefined) continue;
            out = [...out, ...toMid.map((x) => ({ trip: x.trip, depart: x.depart, arrive: x.arrive + last }))];
          }
        }
      }
    }
    return out.sort((x, y) => x.depart - y.depart);
  }

  /**
   * Ruas naik tanpa waktu tempuh (mis. /fares TJ tidak memuat jam): waktu dari pengaturan rute admin bila ada,
   * lalu waktu jadwal dari GTFS Transjakarta bila lin ruas itu (atau salah satu lin paralelnya) adalah koridor
   * BRT yang ada di data GTFS NTD. Keduanya perkiraan (`minutesEstimated`).
   */
  private async withGtfsTimes(legs: RouteLeg[], ctx: RequestContext): Promise<RouteLeg[]> {
    if (!legs.some((l) => l.type === "RIDE" && l.minutes === null)) return legs;
    const patterns = this.patterns ? await this.patterns(ctx) : [];
    if (patterns.length)
      legs = legs.map((leg) => {
        if (leg.type !== "RIDE" || leg.minutes !== null) return leg;
        const lineIds = [leg.lineId, ...(leg.options ?? []).map((o) => o.lineId)].filter((x): x is string => !!x);
        const t = patternMinutes(patterns, lineIds, leg.stops);
        return t ? { ...leg, minutes: t.minutes, minutesEstimated: true } : leg;
      });
    const gtfs = this.gtfs;
    if (!gtfs || !legs.some((l) => l.type === "RIDE" && l.minutes === null)) return legs;
    const idx = await this.commute.index(ctx);
    return legs.map((leg) => {
      if (leg.type !== "RIDE" || leg.minutes !== null) return leg;
      const codes = tjCodes(leg.stops, idx);
      if (!codes) return leg;
      for (const lineId of [leg.lineId, ...(leg.options ?? []).map((o) => o.lineId)]) {
        const ref = lineId ? lineRefOf(lineId) : undefined;
        if (ref?.operator !== "TJ" || !gtfs.hasRoute(ref.code)) continue;
        const t = gtfs.rideTime(ref.code, codes);
        if (t) return { ...leg, minutes: t.minutes, minutesEstimated: true };
      }
      return leg;
    });
  }
}

/** Jeda minimal berganti kereta di tengah ruas (kereta pertama berakhir, kereta sambungan berangkat dari peron sama). */
const MIN_CHANGE_MINUTES = 1;

/** Jeda pindah lini di dalam stasiun (menit) bila jadwal kereta berikutnya tidak diketahui; hanya untuk menyusun jam. */
const MIN_TRANSFER_MINUTES = 3;

/**
 * Jam berangkat dan tiba ruas berurutan dari waktu `when` (waktu berangkat pilihan pengguna):
 * - ruas rel memakai kereta pertama yang berangkat setelah penumpang siap (tiba dari ruas sebelumnya plus jalan kaki).
 *   Waktu tempuh ruas = selisih jam berangkat di stasiun naik dan turun pada nomor perjalanan yang sama. Pindah lini di
 *   dalam stasiun diberi jeda sampai kereta berikutnya berangkat (`includesWait`). Bila tidak ada kereta lagi hari
 *   itu, dipakai kereta pertama keesokan harinya (`nextDay`, `nextDayService`), atau waktu tempuh yang umum tanpa jam.
 * - ruas naik lain yang waktu tempuhnya diketahui (TransJakarta, perkiraan GTFS): berangkat setelah menunggu separuh
 *   frekuensi (rata-rata waktu tunggu), di dalam jam layanan; jamnya perkiraan (`scheduleEstimated`).
 */
export function scheduleRail(legs: RouteLeg[], rail: Map<number, TripMatch[]>, when: Date, nextDay?: Map<number, TripMatch[]>): RouteLeg[] {
  if (!rail.size && !legs.some((l) => l.type === "RIDE" && l.minutes !== null && !l.departureAt)) return legs;
  const out = legs.map((l) => ({ ...l }));
  let ready: number | null = jakartaMinutes(when);
  let lastArrive: number | null = null;
  out.forEach((leg, i) => {
    const trips = rail.get(i);
    if (leg.type === "RIDE" && trips) {
      let trip = ready !== null ? nextTrip(trips, ready) : undefined;
      let rolled = false;
      // Kereta terakhir hari itu sudah lewat: kereta pertama keesokan harinya (menit + 1440).
      const tomorrow = nextDay?.get(i);
      if (!trip && ready !== null && tomorrow?.length) {
        trip = nextTrip(tomorrow.map((t) => ({ ...t, depart: t.depart + 1440, arrive: t.arrive + 1440 })), ready);
        // Hanya ruas tempat layanan hari itu habis; ruas sesudahnya memang sudah keesokan harinya.
        rolled = !!trip && ready < 1440;
      }
      if (trip) {
        Object.assign(leg, {
          minutes: trip.arrive - trip.depart,
          minutesEstimated: undefined,
          fromTimetable: true,
          tripNumber: trip.trip,
          departureAt: isoAt(when, trip.depart),
          arrivalAt: isoAt(when, trip.arrive),
          ...(rolled ? { nextDayService: true } : {}),
          ...(trip.changeAt ? { changeAt: trip.changeAt, ...(trip.changeDepart !== undefined ? { changeDepartureAt: isoAt(when, trip.changeDepart) } : {}) } : {}),
        });
        // Pindah lini di dalam stasiun sebelum ruas ini: jeda sampai kereta ini berangkat.
        const prev = out[i - 1];
        if (prev?.type === "TRANSFER" && prev.stops[0] === prev.stops[prev.stops.length - 1] && prev.minutes === null && lastArrive !== null) {
          Object.assign(prev, { minutes: Math.max(0, trip.depart - lastArrive), includesWait: true, fromTimetable: true });
        }
        ready = lastArrive = trip.arrive;
        return;
      }
      const typical = typicalMinutes(trips, ready ?? 0);
      if (typical !== undefined) Object.assign(leg, { minutes: typical, minutesEstimated: undefined, fromTimetable: true });
      ready = lastArrive = ready !== null && typical !== undefined ? ready + typical : null;
      return;
    }
    if (ready === null) return;
    if (leg.type === "TRANSFER") {
      const inStation = leg.stops[0] === leg.stops[leg.stops.length - 1];
      // Jalan kaki tanpa data waktu: perkiraan 50 m/menit (pengguna berkebutuhan khusus), minimal 5 menit; hanya untuk
      // menyusun jam kendaraan berikutnya, tidak ditampilkan sebagai waktu tempuh ruas.
      ready += leg.minutes ?? (inStation ? MIN_TRANSFER_MINUTES : Math.max(5, Math.ceil(leg.distanceM / 50)));
      return;
    }
    // Ruas naik lain (TransJakarta): waktu tempuh perkiraan GTFS bila ada, berangkat setelah rata-rata waktu tunggu.
    if (leg.minutes === null) {
      ready = null;
      return;
    }
    if (!leg.departureAt) {
      const open = serviceStart(ready, leg.frequency?.serviceHours);
      const wait = leg.frequency ? Math.round(leg.frequency.headwayMinutes / 2) : 0;
      const depart = open + wait;
      Object.assign(leg, {
        departureAt: isoAt(when, depart),
        arrivalAt: isoAt(when, depart + leg.minutes),
        scheduleEstimated: true,
        ...(depart - ready > 0 ? { waitMinutes: depart - ready } : {}),
        ...(depart >= 1440 && ready < 1440 ? { nextDayService: true } : {}),
      });
      ready = depart + leg.minutes;
    } else ready += leg.minutes;
    lastArrive = ready;
  });
  return out;
}

/**
 * Menit paling awal pada atau setelah `ready` yang masih di dalam jam layanan `hours` ("05:00–22:00", boleh melewati
 * tengah malam, atau "24 jam"). Tanpa jam layanan dianggap selalu beroperasi.
 */
export function serviceStart(ready: number, hours?: string): number {
  const m = hours?.match(/(\d{1,2})[.:](\d{2})\s*[–-]\s*(\d{1,2})[.:](\d{2})/);
  if (!m) return ready;
  const start = +m[1] * 60 + +m[2];
  let end = +m[3] * 60 + +m[4];
  if (end <= start) end += 1440;
  const base = Math.floor(ready / 1440) * 1440;
  const t = ready - base;
  if ((t >= start && t <= end) || t + 1440 <= end) return ready;
  return t < start ? base + start : base + 1440 + start;
}

/**
 * Kode halte TJ tiap pemberhentian ruas (halte gabungan dua arah: kedua kodenya); undefined bila ada
 * pemberhentian yang bukan halte TransJakarta.
 */
export function tjCodes(stops: string[], idx: StationIndex): string[][] | undefined {
  const codes = stops.map((s) => idx.refsOf(s).flatMap((r) => (r.operator.toUpperCase() === "TJ" ? [r.code.toUpperCase()] : [])));
  return codes.every((c) => c.length > 0) ? codes : undefined;
}

/** Kode lin GTFS untuk ruas naik TransJakarta: lin ruas dan lin paralelnya yang ada di data GTFS. */
export function tjLines(leg: RouteLeg, gtfs: TjGtfs): string[] {
  if (leg.type !== "RIDE") return [];
  return [leg.lineId, ...(leg.options ?? []).map((o) => o.lineId)].flatMap((id) => {
    const ref = id ? lineRefOf(id) : undefined;
    return ref?.operator === "TJ" && gtfs.hasRoute(ref.code) ? [ref.code] : [];
  });
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
export function parallelLines(stops: string[], primary: string, sequences: LineSequences[], same: (lineId: string) => boolean): string[] {
  if (stops.length < 2) return [primary];
  const covers = (seq: string[], directed?: boolean) => {
    for (const dir of directed ? [seq] : [seq, [...seq].reverse()]) {
      const i = dir.indexOf(stops[0]);
      if (i >= 0 && stops.every((s, k) => dir[i + k] === s)) return true;
    }
    return false;
  };
  const found = sequences.filter((l) => l.lineId !== primary && same(l.lineId) && l.sequences.some((seq) => covers(seq, l.directed))).map((l) => l.lineId);
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

/** Ciri rute untuk membedakan pilihan: lini tiap ruas naik dan titik naik/turunnya. */
export function routeSignature(route: Route): string {
  return route.legs
    .filter((l) => l.type === "RIDE")
    .map((l) => `${l.lineId ?? ""}:${l.stops[0]}>${l.stops[l.stops.length - 1]}`)
    .join("|");
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
  sequences: LineSequences[],
  hubs: Hub[],
  stations: Map<string, Station>,
  walkWeight: number = WALK_WEIGHT.AVERAGE,
  opts: { transferCost?: number; noTransferAt?: Set<string> } = {},
): Ride[] | null {
  const transferCost = opts.transferCost ?? TRANSFER_COST_KM;
  const noTransfer = opts.noTransferAt ?? new Set<string>();
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
        // Urutan searah (pengaturan rute dua arah dari admin) tidak bisa dinaiki ke arah sebaliknya.
        if (!l.directed) addRide(seq[i], seq[i - 1], l.lineId);
      }
  const walks = new Map<string, { to: string; cost: number }[]>();
  const addWalk = (a: string, b: string, m?: number) => {
    if (a === b) return;
    if (!walks.has(a)) walks.set(a, []);
    walks.get(a)!.push({ to: b, cost: transferCost + (m !== undefined ? m / 1000 : hop(a, b)) * walkWeight });
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
    // Stasiun yang tidak boleh menjadi titik pindah (pilihan rute lain): tetap boleh dilewati di lini yang sama.
    const blocked = noTransfer.has(st) && st !== fromId;
    for (const e of rideNext.get(st) ?? []) {
      const change = !!line && line !== e.lineId;
      if (change && blocked) continue;
      if (!line && blocked) continue;
      relax(e.to, e.lineId, e.cost + (change ? transferCost : 0));
    }
    // Jalan kaki antarstasiun hub: setelah naik, atau di awal perjalanan (asal di anggota hub yang tidak
    // dilayani moda yang diizinkan, mis. halte TJ di sebelah stasiun kereta). Dua jalan kaki berturut tidak diizinkan.
    if ((line || st === fromId) && !blocked) for (const w of walks.get(st) ?? []) relax(w.to, "", w.cost);
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
