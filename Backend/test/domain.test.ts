import { GroundingGuard, findStations, type PlanFacts } from "../src/ai/GroundingGuard";
import { newContext } from "../src/context";
import { CommuteApiClient } from "../src/data/commute/CommuteApiClient";
import { FIXTURE_LINE_IDS, FIXTURE_STATION_IDS, FixtureCommuteSource } from "../src/data/commute/FixtureCommuteSource";
import { STATION_INDEX, refsOf, stationIdOf } from "../src/data/commute/station-index";
import { ContentSnapshot, DEFAULT_SETTINGS } from "../src/domain/content";
import { FacilityAnalysisService } from "../src/domain/FacilityAnalysisService";
import type { Route } from "../src/domain/models";
import { combine, RoutePlannerService, transferStationIds } from "../src/domain/RoutePlannerService";
import { StationService } from "../src/domain/StationService";
import { createMemoryStore } from "../src/store/memory";
import type { ContentItem } from "../src/store/types";

const item = (over: Partial<ContentItem>): ContentItem => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  kind: "facility",
  stationId: null,
  draft: null,
  published: null,
  draftDeleted: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  publishedAt: null,
  updatedBy: null,
  ...over,
});

function setup() {
  const source = new FixtureCommuteSource();
  const commute = new CommuteApiClient(source, createMemoryStore().cache);
  const facilities = new FacilityAnalysisService(commute);
  return { source, commute, facilities, stations: new StationService(commute, facilities), planner: new RoutePlannerService(commute) };
}

describe("indeks stasiun", () => {
  it("memetakan setiap stasiun fixture dan kode operatornya", () => {
    expect(FIXTURE_STATION_IDS.every((id) => STATION_INDEX.some((e) => e.id === id))).toBe(true);
    expect(FIXTURE_LINE_IDS).toEqual(["krl-cikarang", "krl-bogor", "ka-bandara", "mrt-ns", "lrt-jbd"]);
    expect(stationIdOf({ operator: "RLK", code: "A01" })).toBe("manggarai");
    expect(stationIdOf({ operator: "XYZ", code: "Q1" })).toBe("xyz:q1");
    expect(refsOf("xyz:q1")).toEqual([{ operator: "XYZ", code: "Q1" }]);
  });
});

describe("StationService.search", () => {
  it("mengutamakan awalan dan mendukung kode stasiun", async () => {
    const { stations } = setup();
    const ctx = newContext();
    expect((await stations.search("sud", ctx)).map((s) => s.id)).toEqual(["sudirman", "bni-city"]);
    expect((await stations.search("c13", ctx)).map((s) => s.id)).toEqual(["manggarai"]);
    expect(await stations.search("m", ctx)).toEqual([]);
  });

  it("menggabungkan stasiun multi-operator menjadi satu", async () => {
    const { stations } = setup();
    const m = (await stations.list(newContext())).find((s) => s.id === "manggarai")!;
    expect(m.operator).toBe("KAI Commuter · Railink");
    expect(m.lineIds.sort()).toEqual(["ka-bandara", "krl-bogor", "krl-cikarang"]);
  });
});

describe("RoutePlannerService", () => {
  it("menyusun rute dari legs dataset, lengkap dengan moda dan waktu", async () => {
    const { planner } = setup();
    const r = (await planner.getRoute("jakarta-kota", "kuningan", newContext()))!;
    expect(r.legs[0]).toMatchObject({ type: "RIDE", lineId: "krl-bogor", mode: "RAIL" });
    // Lin Bogor punya ruas tanpa jadwal: waktu tidak diperkirakan dari jarak.
    expect(r.legs[0].minutes).toBeNull();
    expect(r.timeComplete).toBe(false);
    expect(r.transfers).toBeGreaterThan(0);
  });

  it("mengembalikan null bila rute tidak ada", async () => {
    const { planner } = setup();
    expect(await planner.getRoute("tanah-abang", "tanah-abang", newContext())).toBeNull();
    expect(await planner.getRoute("tanah-abang", "xyz:q1", newContext())).toBeNull();
  });

  it("combine menyisipkan transfer di stasiun perantara bila lini berganti", () => {
    const a: Route = { legs: [{ type: "RIDE", lineId: "x", stops: ["a", "b"], distanceM: 100, minutes: 2, fare: 3000 }], totalDistanceM: 100, totalMinutes: 2, timeComplete: true, totalFare: 3000, transfers: 0 };
    const b: Route = { legs: [{ type: "RIDE", lineId: "y", stops: ["b", "c"], distanceM: 200, minutes: 3, fare: 4000 }], totalDistanceM: 200, totalMinutes: 3, timeComplete: true, totalFare: 4000, transfers: 0 };
    const c = combine(a, b, "b");
    expect(c.legs.map((l) => l.type)).toEqual(["RIDE", "TRANSFER", "RIDE"]);
    expect(c.totalFare).toBe(7000);
    expect(c.timeComplete).toBe(false);
    expect(transferStationIds(c)).toEqual(["b"]);
    const same = combine(a, { ...b, legs: [{ ...b.legs[0], lineId: "x" }] }, "b");
    expect(same.legs).toHaveLength(1);
    expect(same.legs[0].stops).toEqual(["a", "b", "c"]);
  });
});

describe("FacilityAnalysisService", () => {
  const snap = (items: ContentItem[] = []) => new ContentSnapshot(items, false, new Date());

  it("membedakan data tidak tersedia dari fasilitas tidak ada", async () => {
    const { facilities } = setup();
    const none = await facilities.assess("jayakarta", newContext(), snap());
    expect(none.assessment).toMatchObject({ dataAvailable: false, adequate: false, score: 0 });
    expect(none.facilities.amenities.lift).toBe("unknown");
    const sud = await facilities.assess("sudirman", newContext(), snap());
    expect(sud.facilities.amenities.lift).toBe("absent");
    expect(sud.assessment).toMatchObject({ dataAvailable: true, score: 45, adequate: false });
  });

  it("menerapkan informasi tim (gangguan lift, fasilitas tambahan) di atas dataset", async () => {
    const { facilities } = setup();
    const items = [
      item({ stationId: "bni-city", published: { type: "lift", status: "out_of_service", note: "Perbaikan" } }),
      item({ stationId: "bni-city", published: { type: "guiding_block", status: "available" } }),
      // Gangguan yang sudah lewat masa berlakunya diabaikan.
      item({ stationId: "manggarai", published: { type: "lift", status: "out_of_service", until: "2020-01-01T00:00:00Z" } }),
      // Draft belum terlihat oleh pengguna.
      item({ stationId: "tanah-abang", draft: { type: "lift", status: "absent" } }),
    ];
    const bni = await facilities.assess("bni-city", newContext(), snap(items));
    expect(bni.facilities.amenities.lift).toBe("absent");
    expect(bni.assessment.score).toBe(60);
    expect(bni.assessment.notes?.[0]).toMatch(/Lift sedang tidak berfungsi/);
    expect(bni.facilities.amenityDetails.find((d) => d.type === "guiding_block")).toMatchObject({ source: "ntd", status: "available" });
    expect((await facilities.assess("manggarai", newContext(), snap(items))).facilities.amenities.lift).toBe("available");
    expect((await facilities.assess("tanah-abang", newContext(), snap(items))).facilities.amenities.lift).toBe("available");
  });

  it("data tim dapat melengkapi stasiun tanpa data amenity", async () => {
    const { facilities } = setup();
    const items = [item({ stationId: "duri", published: { type: "lift", status: "available", verifiedAt: "2026-10-01" } })];
    const a = await facilities.assess("duri", newContext(), snap(items));
    expect(a.assessment.dataAvailable).toBe(true);
    expect(a.facilities.amenities).toEqual({ lift: "available", eskalator: "unknown", toilet: "unknown", ramp: "unknown" });
  });

  it("bobot dan ambang dari pengaturan dinormalisasi ke 0-100", async () => {
    const { facilities } = setup();
    const settings = item({ id: "settings", kind: "settings", published: { ...DEFAULT_SETTINGS, scoring: { weights: { lift: 1, eskalator: 1, toilet: 0, ramp: 0 }, threshold: 50 } } });
    const a = await facilities.assess("sudirman", newContext(), snap([settings]));
    expect(a.assessment).toMatchObject({ score: 50, adequate: true });
  });
});

describe("GroundingGuard", () => {
  const guard = new GroundingGuard();
  const station = (id: string, name: string, lift: "available" | "absent") => ({
    id,
    name,
    operator: "KAI Commuter",
    lineIds: [],
    codes: [],
    amenities: { lift, eskalator: "available" as const, toilet: "available" as const, ramp: "absent" as const },
    amenityDetails: [],
    dataAvailable: true,
    assessment: { stationId: id, score: 0, adequate: false, dataAvailable: true },
    entrances: [],
    info: [],
    notices: [],
  });
  const facts: PlanFacts = {
    route: { legs: [{ type: "RIDE", lineId: "krl-cikarang", stops: ["tanah-abang", "sudirman"], distanceM: 3000, minutes: 6, fare: 3000 }], totalDistanceM: 3000, totalMinutes: 6, timeComplete: true, totalFare: 3000, transfers: 0 },
    assessments: [],
    alternatives: [],
    stations: new Map([
      ["tanah-abang", station("tanah-abang", "Tanah Abang", "available")],
      ["sudirman", station("sudirman", "Sudirman", "absent")],
    ]),
    knownStationNames: new Map([
      ["tanah abang", "tanah-abang"],
      ["sudirman", "sudirman"],
      ["sudirman baru bni city", "bni-city"],
      ["manggarai", "manggarai"],
    ]),
    notices: [],
  };

  it("menerima narasi yang sesuai data", () => {
    const r = guard.validate("Naik Lin Cikarang dari Tanah Abang ke Sudirman, sekitar 6 menit dengan tarif Rp3.000. Lift tidak tercatat di Sudirman.", facts);
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  it("menolak stasiun, angka, dan klaim fasilitas yang tidak berasal dari data", () => {
    expect(guard.validate("Transit di Manggarai.", facts).ok).toBe(false);
    expect(guard.validate("Perjalanan memakan waktu 25 menit.", facts).ok).toBe(false);
    expect(guard.validate("Lift tersedia di Sudirman.", facts).reasons[0]).toMatch(/lift/);
    expect(guard.validate("Lift tidak ada di Tanah Abang.", facts).ok).toBe(false);
  });

  it("mencocokkan nama stasiun terpanjang lebih dulu", () => {
    expect(findStations("Turun di Sudirman Baru BNI City", facts.knownStationNames)).toEqual(["bni-city"]);
  });
});
