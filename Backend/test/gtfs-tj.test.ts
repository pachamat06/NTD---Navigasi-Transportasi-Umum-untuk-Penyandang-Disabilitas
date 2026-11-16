// Pelengkap data TransJakarta dari GTFS Transjakarta (koridor BRT 1–14 dan 16 lin BRT turunannya):
// waktu tempuh ruas TJ yang tidak punya jadwal di /fares dan halte yang tidak ada di /stations.

import { newContext } from "../src/context";
import { CommuteApiClient } from "../src/data/commute/CommuteApiClient";
import { buildStationIndex } from "../src/data/commute/station-index";
import type { CommuteSource, UpFare, UpLine, UpStation } from "../src/data/commute/types";
import { TjGtfs } from "../src/data/gtfs/TjGtfs";
import { TJ_BRT_GTFS } from "../src/data/gtfs/tj-brt-data";
import { RoutePlannerService } from "../src/domain/RoutePlannerService";
import { createMemoryStore } from "../src/store/memory";

const gtfs = new TjGtfs();
const ref = (code: string) => ({ operator: "TJ", code });

// Koridor 1, Kota -> Bundaran HI Astra, persis seperti urutan halte /fares Commute.
const KOTA_BHI = ["H00275P", "H00068P", "H00133P", "H00281P", "H00280P", "H00278P", "H00131P", "H00268S", "H00207P", "H00022P"];

describe("Data GTFS koridor BRT NTD", () => {
  it("hanya koridor 1 sampai 14 dan lin BRT turunan yang dipilih", () => {
    const variants = ["2A", "3F", "3H", "4D", "5C", "6A", "6B", "6V", "7F", "9A", "9C", "9N", "10H", "13B", "13E", "L13E"];
    expect(gtfs.routes.sort()).toEqual([...Array.from({ length: 14 }, (_, i) => String(i + 1)), ...variants].sort());
    expect(gtfs.hasRoute("4d")).toBe(true);
    expect(gtfs.hasRoute("8A")).toBe(false);
    expect(gtfs.hasRoute("JAK.10")).toBe(false);
    expect(TJ_BRT_GTFS.meta.patterns).toBeGreaterThan(0);
  });

  it("waktu tempuh dari stop_times: Kota -> Bundaran HI Astra (koridor 1)", () => {
    const t = gtfs.rideTime("1", KOTA_BHI)!;
    expect(t.minutes).toBeGreaterThanOrEqual(25);
    expect(t.minutes).toBeLessThanOrEqual(40);
    // Arah sebaliknya (arah utara memakai halte Kebon Sirih Arah Utara, jadi cukup ujung ruasnya).
    expect(gtfs.rideTime("1", ["H00022P", "H00131P"])).not.toBeNull();
    // Koridor yang tidak melewati halte itu, atau halte tak dikenal: tidak ada perkiraan.
    expect(gtfs.rideTime("13", KOTA_BHI)).toBeNull();
    expect(gtfs.rideTime("1", ["H00275P", "XXXX"])).toBeNull();
  });

  it("halte sementara Manggarai (koridor 4) punya nama dan koordinat", () => {
    expect(gtfs.stop("B08301P")).toMatchObject({ name: "Halte Manggarai Temporer 1" });
    expect(gtfs.stop("b08302p")?.lat).toBeCloseTo(-6.2094, 3);
  });

  it("koridor yang berhenti di halte menurut GTFS", () => {
    // Juanda menurut GTFS (koridor 3 tidak mencantumkan Juanda di /lines Commute).
    expect(gtfs.routesAt("H00092P").sort()).toEqual(["10H", "2", "2A", "3", "5C", "7F", "8"]);
  });

  it("lin BRT turunan juga punya waktu tempuh", () => {
    for (const line of ["4D", "6A", "9C", "L13E"]) {
      const p = TJ_BRT_GTFS.routes[line].patterns[0];
      const t = gtfs.rideTime(line.toLowerCase(), [p.stops[0], p.stops[3]]);
      expect(t?.line).toBe(line);
      expect(t!.minutes).toBeGreaterThan(0);
    }
  });
});

class TjSource implements CommuteSource {
  readonly name = "tj";
  // Dua halte terakhir koridor 1 tidak ada di /stations (meniru B08301P di koridor 4).
  stations: UpStation[] = KOTA_BHI.slice(0, 8).map((code) => ({ operator: "TJ", code, name: code, lines: ["1"], amenities: [] }));
  lines: UpLine[] = [
    { operator: "TJ", code: "1", name: "Blok M - Kota", mode: "BUS", stations: [...KOTA_BHI.map(ref), ref("B08301P")] },
    // Lin non-koridor yang tidak berhenti di semua halte koridor 1 (bukan lin paralel).
    { operator: "TJ", code: "1A", name: "PIK - Balai Kota", mode: "BUS", stations: [ref("H00275P"), ref("H00133P")] },
  ];
  line = "1";
  async getStations() {
    return this.stations;
  }
  async getStation() {
    return null;
  }
  async getOperators() {
    return [{ code: "TJ", name: "TransJakarta", mode: "BUS" as const }];
  }
  async getLines() {
    return this.lines;
  }
  async getLine() {
    return null;
  }
  async getHubs() {
    return [];
  }
  async getFare(): Promise<UpFare> {
    const stops = (this.line === "1" ? KOTA_BHI : ["H00275P", "H00133P"]).map(ref);
    const leg = { type: "RIDE" as const, operator: "TJ", line: this.line, headsign: "Blok M", stops, distanceM: 6563, fare: 3500 };
    return { from: stops[0], to: stops[stops.length - 1], totalFare: 3500, totalDistanceM: 6563, legs: [leg] };
  }
}

const setup = (source: TjSource, withGtfs = true) => {
  const client = new CommuteApiClient(source, createMemoryStore().cache, withGtfs ? gtfs : undefined);
  return { client, planner: new RoutePlannerService(client, withGtfs ? gtfs : undefined) };
};

describe("Rute TransJakarta dilengkapi GTFS", () => {
  it("ruas koridor 1 tanpa jadwal mendapat waktu perkiraan dan total waktu", async () => {
    const { planner } = setup(new TjSource());
    const ctx = newContext();
    const route = await planner.annotate((await planner.getRoute("tj:h00275p", "tj:h00022p", ctx))!, ctx);
    expect(route.legs[0].minutes).toBe(gtfs.rideTime("1", KOTA_BHI)!.minutes);
    expect(route.legs[0].minutesEstimated).toBe(true);
    expect(route.timeComplete).toBe(true);
    expect(route.timeEstimated).toBe(true);
    expect(route.totalMinutes).toBe(route.legs[0].minutes);
  });

  it("lin di luar koridor BRT NTD (mis. 1A) tetap tanpa waktu", async () => {
    const source = new TjSource();
    source.line = "1A";
    const { planner } = setup(source);
    const ctx = newContext();
    const route = await planner.annotate((await planner.getRoute("tj:h00275p", "tj:h00133p", ctx))!, ctx);
    expect(route.legs[0].minutes).toBeNull();
    expect(route.timeEstimated).toBeUndefined();
  });

  it("tanpa data GTFS perilaku lama tidak berubah", async () => {
    const { planner } = setup(new TjSource(), false);
    const ctx = newContext();
    const route = await planner.annotate((await planner.getRoute("tj:h00275p", "tj:h00022p", ctx))!, ctx);
    expect(route.legs[0].minutes).toBeNull();
    expect(route.timeComplete).toBe(false);
  });

  it("halte di /lines yang tidak ada di /stations ditambahkan dari GTFS", async () => {
    const { client } = setup(new TjSource());
    const stations = await client.getStations(newContext());
    const bhi = stations.find((s) => s.id === "tj:h00022p")!;
    expect(bhi).toMatchObject({ name: "Bundaran HI Astra", operator: "TransJakarta", lineIds: ["tj:1"] });
    expect(bhi.lat).toBeCloseTo(-6.193, 3);
    expect(stations.find((s) => s.id === "tj:b08301p")?.name).toBe("Halte Manggarai Temporer 1");
    // Tanpa GTFS halte itu tidak ada.
    const plain = await setup(new TjSource(), false).client.getStations(newContext());
    expect(plain.find((s) => s.id === "tj:h00022p")).toBeUndefined();
  });
});

// ---------- Halte per arah dan halte satu arah ----------

const KM = "H00095P";
const MB = "H00104P";
const BM = "H00148P";

describe("Halte BRT per arah digabung", () => {
  it("Kebon Sirih Arah Utara dan Arah Selatan menjadi satu stasiun NTD", () => {
    const idx = buildStationIndex([
      { operator: "TJ", code: "H00267S", name: "Kebon Sirih Arah Utara" },
      { operator: "TJ", code: "H00268S", name: "Kebon Sirih Arah Selatan" },
      { operator: "TJ", code: "H00022P", name: "Bundaran HI Astra" },
    ]);
    expect(idx.idOf(ref("H00267S"))).toBe("tj:kebon-sirih");
    expect(idx.idOf(ref("H00268S"))).toBe("tj:kebon-sirih");
    expect(idx.refsOf("tj:kebon-sirih").map((r) => r.code).sort()).toEqual(["H00267S", "H00268S"]);
    expect(idx.nameOf?.("tj:kebon-sirih")).toBe("Kebon Sirih");
    // Id per arah tetap bisa dipakai untuk data satu arah.
    expect(idx.refsOf("tj:h00267s")).toEqual([ref("H00267S")]);
    expect(idx.idOf(ref("H00022P"))).toBe("tj:h00022p");
  });
});

describe("Halte satu arah (Bali Mester)", () => {
  it("Kampung Melayu > Matraman Baru > Bali Mester tidak dilayani satu bus; berbalik arah di Matraman Baru", () => {
    expect(gtfs.match(["5", "5C"], [KM, MB, BM])).toBeNull();
    expect(gtfs.match(["5"], ["H00128P", "H00245P", "H00217P", MB, BM])).not.toBeNull();
    const s = gtfs.split(["5", "5C"], [KM, MB, BM])!;
    expect(s).toMatchObject({ at: 1, code: MB, crossing: false });
  });
});

class DirSource extends TjSource {
  legStops: string[] = [KM, MB, BM];
  legLine = "5C";
  constructor() {
    super();
    this.stations = [
      ...[KM, MB, BM, "H00022P", "H00207P", "H00131P"].map((code) => ({ operator: "TJ", code, name: code, lines: ["5C", "1"], amenities: [] })),
      { operator: "TJ", code: "H00267S", name: "Kebon Sirih Arah Utara", lines: ["1"], amenities: [] },
      { operator: "TJ", code: "H00268S", name: "Kebon Sirih Arah Selatan", lines: ["1"], amenities: [] },
    ];
    this.lines = [];
  }
  async getFare(): Promise<UpFare> {
    const stops = this.legStops.map(ref);
    const leg = { type: "RIDE" as const, operator: "TJ", line: this.legLine, stops, distanceM: 3000, fare: 3500 };
    return { from: stops[0], to: stops[stops.length - 1], totalFare: 3500, totalDistanceM: 3000, legs: [leg] };
  }
}

describe("Rute berbalik arah", () => {
  it("Kampung Melayu -> Bali Mester: turun di Matraman Baru, pindah ke bus arah sebaliknya", async () => {
    const source = new DirSource();
    const { planner } = setup(source);
    const ctx = newContext();
    const route = (await planner.getRoute("tj:h00095p", "tj:h00148p", ctx))!;
    expect(route.legs.map((l) => l.type)).toEqual(["RIDE", "TRANSFER", "RIDE"]);
    expect(route.legs[0].stops).toEqual(["tj:h00095p", "tj:h00104p"]);
    expect(route.legs[1]).toMatchObject({ turnaround: true, stops: ["tj:h00104p", "tj:h00104p"] });
    expect(route.legs[2].stops).toEqual(["tj:h00104p", "tj:h00148p"]);
    expect(route.transfers).toBe(1);
    expect(route.totalFare).toBe(3500);
  });

  it("tujuan halte gabungan: arah yang dipakai tidak punya fasilitas, lewati lalu berbalik ke halte seberang", async () => {
    const source = new DirSource();
    source.legLine = "1";
    source.legStops = ["H00022P", "H00207P", "H00267S"];
    const { planner } = setup(source);
    const ctx = newContext();
    const route = (await planner.getRoute("tj:h00022p", "tj:kebon-sirih", ctx))!;
    expect(route.legs).toHaveLength(1);
    const back = await planner.backtrackForNeeds(route, ctx, async (code) => code === "H00268S");
    expect(back.legs.map((l) => l.type)).toEqual(["RIDE", "TRANSFER", "RIDE"]);
    expect(back.legs[0].stops).toEqual(["tj:h00022p", "tj:h00207p", "tj:kebon-sirih", "tj:h00131p"]);
    expect(back.legs[1]).toMatchObject({ turnaround: true, stops: ["tj:h00131p", "tj:h00131p"] });
    expect(back.legs[2].stops).toEqual(["tj:h00131p", "tj:kebon-sirih"]);
    // Fasilitas ada di arah yang dipakai: rute tidak berubah.
    expect(await planner.backtrackForNeeds(route, ctx, async () => true)).toBe(route);
  });
});
