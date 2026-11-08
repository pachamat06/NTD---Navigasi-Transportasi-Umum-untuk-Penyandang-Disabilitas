// Regresi perbaikan sistem navigasi: jalan kaki di awal rute filter moda, "hindari stasiun" dengan pengganti
// berskor sama, dan pembacaan cache Commute satu kali per kunci per permintaan.

import request from "supertest";
import { newContext } from "../src/context";
import { CommuteApiClient } from "../src/data/commute/CommuteApiClient";
import { FixtureCommuteSource } from "../src/data/commute/FixtureCommuteSource";
import { AlternativeService } from "../src/domain/AlternativeService";
import type { ContentSnapshot } from "../src/domain/content";
import type { FacilityAnalysisService } from "../src/domain/FacilityAnalysisService";
import type { Hub, Route, StationAssessment } from "../src/domain/models";
import { findRides, totals, type RoutePlannerService } from "../src/domain/RoutePlannerService";
import { createMemoryStore } from "../src/store/memory";
import { makeTestApp } from "./helpers";

const st = (id: string) => ({ id, name: id, operator: "X", lineIds: [], codes: [] });

describe("findRides: jalan kaki di hub", () => {
  // Asal "halte" hanya terhubung ke "stasiun-a" lewat jalan kaki di hub; kereta berjalan stasiun-a -> b -> c.
  const sequences = [{ lineId: "kereta", sequences: [["stasiun-a", "stasiun-b", "stasiun-c"]] }];
  const hubs: Hub[] = [{ id: "hub-a", name: "Hub A", memberIds: ["halte", "stasiun-a"], walks: [{ from: "halte", to: "stasiun-a", distanceM: 150, minutes: 3 }] }];
  const stations = new Map(["halte", "stasiun-a", "stasiun-b", "stasiun-c"].map((id) => [id, st(id)]));

  it("rute boleh diawali jalan kaki dari asal ke anggota hub lain", () => {
    const rides = findRides("halte", "stasiun-c", sequences, hubs, stations);
    expect(rides).toEqual([
      { lineId: "", stops: ["halte", "stasiun-a"] },
      { lineId: "kereta", stops: ["stasiun-a", "stasiun-b", "stasiun-c"] },
    ]);
  });

  it("rute boleh diakhiri jalan kaki ke tujuan di hub", () => {
    const rides = findRides("stasiun-c", "halte", sequences, hubs, stations);
    expect(rides?.map((r) => r.lineId)).toEqual(["kereta", ""]);
  });

  it("dua jalan kaki berturut-turut tetap tidak dipakai", () => {
    const twoHubs: Hub[] = [
      ...hubs,
      { id: "hub-b", name: "Hub B", memberIds: ["stasiun-a", "halte-2"], walks: [{ from: "stasiun-a", to: "halte-2", distanceM: 100, minutes: 2 }] },
    ];
    // halte -> stasiun-a -> halte-2 tidak boleh hanya berjalan: harus ada ruas naik di antara dua jalan kaki.
    const rides = findRides("halte", "halte-2", sequences, twoHubs, stations)!;
    expect(rides.some((r) => r.lineId)).toBe(true);
    expect(rides.some((r, i) => i > 0 && !r.lineId && !rides[i - 1].lineId)).toBe(false);
    // Tanpa ruas naik sama sekali, tidak ada rute.
    expect(findRides("halte", "halte-2", [], twoHubs, stations)).toBeNull();
  });
});

describe("AlternativeService: stasiun yang dihindari pengguna", () => {
  const assessment = (stationId: string, score: number): StationAssessment => ({ stationId, score, adequate: score >= 70, dataAvailable: true });
  const ride = (stops: string[]) => ({ type: "RIDE" as const, lineId: "l", stops, distanceM: 1000, minutes: 5, fare: 0 });
  const transfer = (a: string, b: string) => ({ type: "TRANSFER" as const, stops: [a, b], distanceM: 100, minutes: 2, fare: 0 });
  const viaRoute = (via: string): Route => totals([ride(["asal", via]), transfer(via, "x"), ride(["x", "tujuan"])]);

  it("pengganti yang memadai dipakai walau skornya sama dengan stasiun yang dihindari", async () => {
    const scores: Record<string, number> = { "pindah-1": 80, "pindah-2": 80 };
    const facilities = { assess: async (id: string) => ({ assessment: assessment(id, scores[id] ?? 80) }), facilities: async () => ({ amenities: {} }) } as unknown as FacilityAnalysisService;
    const planner = { getRouteVia: async (_o: string, via: string) => viaRoute(via) } as unknown as RoutePlannerService;
    const alternatives = new AlternativeService(planner, facilities);
    const route = totals([ride(["asal", "pindah-1"]), transfer("pindah-1", "x"), ride(["x", "tujuan"])]);
    const hubs: Hub[] = [{ id: "hub", name: "Hub", memberIds: ["pindah-1", "pindah-2"], walks: [] }];
    const out = await alternatives.suggest(
      { originId: "asal", destinationId: "tujuan", route, assessments: new Map(), hubs, avoid: ["pindah-1"] },
      newContext(),
      {} as ContentSnapshot,
    );
    expect(out.map((a) => a.viaStationId)).toEqual(["pindah-2"]);
  });

  it("tanpa permintaan hindari, pengganti tetap harus berskor lebih tinggi", async () => {
    const scores: Record<string, number> = { "pindah-1": 50, "pindah-2": 50 };
    const facilities = { assess: async (id: string) => ({ assessment: assessment(id, scores[id]) }), facilities: async () => ({ amenities: {} }) } as unknown as FacilityAnalysisService;
    const planner = { getRouteVia: async (_o: string, via: string) => viaRoute(via) } as unknown as RoutePlannerService;
    const route = totals([ride(["asal", "pindah-1"]), transfer("pindah-1", "x"), ride(["x", "tujuan"])]);
    const hubs: Hub[] = [{ id: "hub", name: "Hub", memberIds: ["pindah-1", "pindah-2"], walks: [] }];
    const out = await new AlternativeService(planner, facilities).suggest(
      { originId: "asal", destinationId: "tujuan", route, assessments: new Map(), hubs },
      newContext(),
      {} as ContentSnapshot,
    );
    expect(out).toEqual([]);
  });
});

describe("CommuteApiClient: satu kali baca cache per kunci per permintaan", () => {
  it("permintaan berulang dalam satu konteks memakai hasil yang sama", async () => {
    const store = createMemoryStore();
    const client = new CommuteApiClient(new FixtureCommuteSource(), store.cache);
    await client.getStations(newContext());
    let reads = 0;
    const get = store.cache.get.bind(store.cache);
    store.cache.get = (k) => {
      reads++;
      return get(k);
    };
    const ctx = newContext();
    const ids = (await client.getStations(ctx)).map((s) => s.id);
    for (const id of ids) await client.getStationAmenities(id, ctx);
    // stations, lines, operators: masing-masing sekali, bukan sekali per stasiun.
    expect(reads).toBeLessThanOrEqual(3);
    // Konteks baru membaca store lagi, sehingga data yang diperbarui tetap terlihat.
    await client.getStations(newContext());
    expect(reads).toBeGreaterThan(3);
  });

  it("GET /api/network tidak membaca daftar stasiun berulang-ulang", async () => {
    const { app, store } = await makeTestApp();
    await request(app).get("/api/network");
    const keys: string[] = [];
    const get = store.cache.get.bind(store.cache);
    store.cache.get = (k) => {
      keys.push(k);
      return get(k);
    };
    const res = await request(app).get("/api/network");
    expect(res.status).toBe(200);
    expect(keys.filter((k) => k.endsWith(":stations"))).toHaveLength(1);
  });
});
