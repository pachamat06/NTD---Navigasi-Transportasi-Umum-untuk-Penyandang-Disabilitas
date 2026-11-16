// Rute memakai jaringan admin (hub Manggarai dengan Halte Manggarai Temporer), ruas naik mengikuti urutan halte
// pengaturan rute admin (jalur BRT 4 dialihkan), dan gate/pintu hub beserta fasilitas aksesibelnya.

import request from "supertest";
import type { CommuteApiClient, FareResult } from "../src/data/commute/CommuteApiClient";
import { newContext } from "../src/context";
import type { HubContent, RoutePattern } from "../src/domain/content";
import { hubSchema } from "../src/domain/content";
import { applyHubs, gateToward } from "../src/domain/hubs";
import type { Hub, HubGate, Line, Route, Station } from "../src/domain/models";
import { findRides, RoutePlannerService, routeCost, ridesCost, servesRide, usesLocalNetwork, WALK_WEIGHT } from "../src/domain/RoutePlannerService";
import { patternStops } from "../src/domain/routePatterns";
import { makeTestApp } from "./helpers";

// Jaringan kecil meniru kasus nyata (koordinat kira-kira): LRT Jakarta Lin Selatan Rawamangun–Pramuka–Manggarai,
// BRT 4 Rawamangun ... Kesatrian – Halte Manggarai Temporer – Pasar Rumput, hub Manggarai buatan admin.
const st = (id: string, lat: number, lng: number, source: Station["source"] = "commute", lineIds: string[] = []): Station => ({ id, name: id, operator: "", lineIds, codes: [], lat, lng, source });
const STATIONS: Station[] = [
  st("lrtj:rwm", -6.1935, 106.882, "commute", ["lrtj:s"]),
  st("lrtj:pka", -6.1919, 106.8706, "commute", ["lrtj:s"]),
  st("lrtj:mgi", -6.2086, 106.8457, "commute", ["lrtj:s"]),
  st("tj:h00254p", -6.1948, 106.8838, "commute", ["tj:4"]),
  st("tj:h00146p", -6.2005, 106.8655, "commute", ["tj:4"]),
  st("tj:h00217p", -6.2067, 106.8532, "commute", ["tj:4"]),
  st("tj:b08301p", -6.209127, 106.847159, "gtfs", ["tj:4"]),
  st("tj:b08302p", -6.209383, 106.847603, "gtfs", ["tj:4"]),
  st("tj:h00153p", -6.207125, 106.84112, "commute", ["tj:4"]),
];
const byId = new Map(STATIONS.map((s) => [s.id, s]));
const LINES: Line[] = [
  { id: "lrtj:s", name: "Lin Selatan", operator: "LRT Jakarta", mode: "TRAM", color: "#c00", stationIds: [] },
  { id: "tj:4", name: "4", operator: "TransJakarta", mode: "BUS", color: "#512C62", stationIds: [] },
];
const SEQUENCES = [
  { lineId: "lrtj:s", sequences: [["lrtj:rwm", "lrtj:pka", "lrtj:mgi"]] },
  // Dataset: BRT 4 masih lewat halte arah sebaliknya (Temporer 1).
  { lineId: "tj:4", sequences: [["tj:h00254p", "tj:h00146p", "tj:h00217p", "tj:b08301p", "tj:h00153p"]] },
];
// Pengaturan rute admin: arah ke Dukuh Atas lewat Halte Manggarai Temporer 2.
const pattern = (direction: 0 | 1, ids: string[]): RoutePattern => ({ id: `p${direction}`, lineId: "tj:4", direction, source: "manual", stops: ids.map((stationId) => ({ stationId, minutes: null })) });
const PATTERNS: RoutePattern[] = [pattern(0, ["tj:h00254p", "tj:h00146p", "tj:h00217p", "tj:b08302p", "tj:h00153p"]), pattern(1, ["tj:h00153p", "tj:b08301p", "tj:h00217p", "tj:h00146p", "tj:h00254p"])];
const MANGGARAI: HubContent = {
  id: "x",
  hubId: "manggarai",
  name: "Manggarai",
  kind: "hub",
  memberIds: ["lrtj:mgi", "tj:b08301p", "tj:b08302p"],
  walks: [
    { from: "lrtj:mgi", to: "tj:b08301p", distanceM: 400 },
    { from: "lrtj:mgi", to: "tj:b08302p", distanceM: 400 },
    { from: "tj:b08301p", to: "tj:b08302p", distanceM: 50 },
  ],
  gates: [],
  source: "gtfs",
};

const ride = (lineId: string, stops: string[], distanceM: number): FareResult["legs"][number] => ({ type: "RIDE", lineId, stops, distanceM, fare: 0 });
/** /fares Commute: tidak mengenal hub admin, jadi rute LRT Pramuka → Pasar Rumput memutar lewat Rawamangun. */
function fakeFare(from: string, to: string): FareResult | null {
  const detour = from === "lrtj:pka" && to === "tj:h00153p";
  const legs: FareResult["legs"] = detour
    ? [ride("lrtj:s", ["lrtj:pka", "lrtj:rwm"], 1332), { type: "TRANSFER", stops: ["lrtj:rwm", "tj:h00254p"], distanceM: 380, fare: 0 }, ride("tj:4", ["tj:h00254p", "tj:h00146p", "tj:h00217p", "tj:b08301p", "tj:h00153p"], 6370)]
    : from === "lrtj:pka" && to === "lrtj:mgi"
      ? [ride("lrtj:s", ["lrtj:pka", "lrtj:mgi"], 3621)]
      : from === "tj:h00254p" && to === "tj:h00153p"
        ? [ride("tj:4", ["tj:h00254p", "tj:h00146p", "tj:h00217p", "tj:b08301p", "tj:h00153p"], 6370)]
        : [];
  if (!legs.length) return null;
  return { fromId: from, toId: to, totalFare: 0, totalDistanceM: legs.reduce((s, l) => s + l.distanceM, 0), legs, stopNames: { [from]: from, [to]: to } } as FareResult;
}

function planner(hubs: HubContent[] = [MANGGARAI], patterns: RoutePattern[] = PATTERNS) {
  const commute = {
    getStations: async () => STATIONS,
    getLines: async () => LINES,
    getHubs: async () => [] as Hub[],
    getLineSequences: async () => SEQUENCES,
    getFare: async (a: string, b: string) => {
      const f = fakeFare(a, b);
      if (!f) throw new Error("tidak ada rute");
      return f;
    },
    getWalk: async () => undefined,
  } as unknown as CommuteApiClient;
  return new RoutePlannerService(commute, undefined, async () => patterns, async () => hubs);
}

const legsOf = (r: Route | null) => r?.legs.map((l) => `${l.type} ${l.lineId ?? ""} ${l.stops.join(">")}`.replace(/\s+/g, " ").trim());

describe("rute memakai hub dan halte buatan admin", () => {
  it("LRT Pramuka → Pasar Rumput lewat hub Manggarai, bukan memutar lewat Rawamangun", async () => {
    const ctx = newContext({});
    const r = await planner().getRoute("lrtj:pka", "tj:h00153p", ctx);
    expect(legsOf(r)).toEqual(["RIDE lrtj:s lrtj:pka>lrtj:mgi", "TRANSFER lrtj:mgi>tj:b08302p", "RIDE tj:4 tj:b08302p>tj:h00153p"]);
    expect(r!.legs[1].distanceM).toBe(400);
  });

  it("tanpa hub admin, rute dataset tetap dipakai (hanya urutan halte yang mengikuti pengaturan rute)", async () => {
    const r = await planner([]).getRoute("lrtj:pka", "tj:h00153p", newContext({}));
    expect(legsOf(r)).toEqual(["RIDE lrtj:s lrtj:pka>lrtj:rwm", "TRANSFER lrtj:rwm>tj:h00254p", "RIDE tj:4 tj:h00254p>tj:h00146p>tj:h00217p>tj:b08302p>tj:h00153p"]);
  });

  it("biaya rute sebanding dengan findRides; rute admin hanya dipilih bila memakai jaringan lokal", () => {
    const hubs = applyHubs([], [MANGGARAI]);
    const rides = findRides("lrtj:pka", "tj:h00153p", [{ lineId: "lrtj:s", sequences: SEQUENCES[0].sequences }, { lineId: "tj:4", sequences: PATTERNS.map((p) => p.stops.map((s) => s.stationId)), directed: true }], hubs, byId, WALK_WEIGHT.AVERAGE)!;
    expect(rides.map((r) => r.lineId)).toEqual(["lrtj:s", "", "tj:4"]);
    expect(usesLocalNetwork(rides, hubs, byId)).toBe(true);
    const detour: Route = { legs: fakeFare("lrtj:pka", "tj:h00153p")!.legs.map((l) => ({ ...l, minutes: null })), totalDistanceM: 0, totalMinutes: null, timeComplete: false, totalFare: 0, transfers: 1 };
    expect(ridesCost(rides, hubs, byId)).toBeLessThan(routeCost(detour, byId) * 0.9);
    // Rute yang hanya memakai stasiun dan hub Commute tidak menggantikan /fares.
    expect(usesLocalNetwork([{ lineId: "lrtj:s", stops: ["lrtj:pka", "lrtj:mgi"] }], hubs, byId)).toBe(false);
  });

  it("ruas /fares yang memutar (jalan kaki ke stasiun lain) tidak dipakai untuk satu ruas naik", () => {
    const base = { totalDistanceM: 0, totalMinutes: null, timeComplete: false, totalFare: 0, transfers: 0 };
    expect(servesRide({ ...base, legs: [{ type: "RIDE", lineId: "tj:4", stops: ["a", "b"], distanceM: 1, minutes: null, fare: 0 }] }, "tj:4")).toBe(true);
    expect(
      servesRide(
        {
          ...base,
          legs: [
            { type: "RIDE", lineId: "tj:4", stops: ["a", "b"], distanceM: 1, minutes: null, fare: 0 },
            { type: "TRANSFER", stops: ["b", "c"], distanceM: 100, minutes: null, fare: 0 },
            { type: "RIDE", lineId: "tj:6", stops: ["c", "d"], distanceM: 1, minutes: null, fare: 0 },
          ],
        },
        "tj:4",
      ),
    ).toBe(false);
  });
});

describe("ruas naik mengikuti pengaturan rute admin (jalur dialihkan)", () => {
  it("urutan halte dari pengaturan rute: searah bila kedua arah diatur, dua arah bila satu arah", () => {
    expect(patternStops(PATTERNS, ["tj:4"], "tj:h00146p", "tj:h00153p")).toEqual(["tj:h00146p", "tj:h00217p", "tj:b08302p", "tj:h00153p"]);
    expect(patternStops(PATTERNS, ["tj:4"], "tj:h00153p", "tj:h00146p")).toEqual(["tj:h00153p", "tj:b08301p", "tj:h00217p", "tj:h00146p"]);
    expect(patternStops(PATTERNS, ["tj:4d", "tj:4"], "tj:h00146p", "tj:h00217p")).toEqual(["tj:h00146p", "tj:h00217p"]);
    expect(patternStops(PATTERNS.slice(0, 1), ["tj:4"], "tj:h00153p", "tj:h00217p")).toEqual(["tj:h00153p", "tj:b08302p", "tj:h00217p"]);
    expect(patternStops(PATTERNS, ["tj:4"], "tj:h00146p", "lrtj:mgi")).toBeNull();
    expect(patternStops(PATTERNS, ["tj:9"], "tj:h00146p", "tj:h00153p")).toBeNull();
  });

  it("rute dataset Pasar Genjing → Pasar Rumput memakai Halte Manggarai Temporer 2 sesuai admin (garis peta admin cocok)", async () => {
    const r = await planner([]).getRoute("tj:h00254p", "tj:h00153p", newContext({}));
    expect(r!.legs[0].stops).toEqual(["tj:h00254p", "tj:h00146p", "tj:h00217p", "tj:b08302p", "tj:h00153p"]);
    // Nama halte baru ikut dilengkapi.
    expect(r!.stopNames?.["tj:b08302p"]).toBe("tj:b08302p");
  });
});

describe("gate hub dan fasilitas aksesibel", () => {
  const gate = (o: Partial<HubGate>): HubGate => ({ id: "g", stationId: "lrtj:mgi", name: "Gate", connectsTo: [], facilities: [], accessible: false, ...o });
  const withGates = (gates: HubGate[]) => applyHubs([], [{ ...MANGGARAI, gates }]);

  it("gate yang tersambung ke anggota tujuan dipilih lebih dulu; gate aksesibel dan berfasilitas yang dibutuhkan diutamakan", () => {
    const hubs = withGates([
      gate({ id: "selatan", name: "Gate Selatan", connectsTo: ["manggarai-krl-tidak-ada"] }),
      gate({ id: "umum", name: "Gate Umum", facilities: ["tangga"] }),
      gate({ id: "utara", name: "Gate Utara", connectsTo: ["tj:b08302p"], facilities: ["eskalator"] }),
      gate({ id: "utara-lift", name: "Gate Utara (lift)", connectsTo: ["tj:b08302p"], facilities: ["lift", "ramp"], accessible: true }),
      gate({ id: "halte", stationId: "tj:b08302p", name: "Pintu halte", facilities: ["ramp"], accessible: true }),
    ]);
    // Anggota yang tidak dikenal dibuang dari connectsTo; gate ke semua anggota tetap.
    expect(hubs.find((h) => h.id === "manggarai")!.gates!.find((g) => g.id === "selatan")!.connectsTo).toEqual([]);
    expect(gateToward(hubs, "lrtj:mgi", "tj:b08302p")?.id).toBe("utara-lift");
    expect(gateToward(hubs, "lrtj:mgi", "tj:b08302p", ["lift"])?.id).toBe("utara-lift");
    expect(gateToward(hubs, "tj:b08302p", "lrtj:mgi")?.name).toBe("Pintu halte");
    // Tidak ada gate khusus ke Temporer 1: gate tanpa connectsTo.
    expect(["umum", "selatan"]).toContain(gateToward(hubs, "lrtj:mgi", "tj:b08301p")?.id);
    expect(gateToward(hubs, "tj:b08301p", "lrtj:mgi")).toBeUndefined();
  });

  it("isian hub lama tanpa gate tetap terbaca", () => {
    const { gates: _, ...old } = MANGGARAI;
    const hubs = applyHubs([], [old as HubContent]);
    expect(hubs.find((h) => h.id === "manggarai")!.gates).toBeUndefined();
    expect(gateToward(hubs, "lrtj:mgi", "tj:b08302p")).toBeUndefined();
  });

  it("skema: gate harus milik anggota hub, tersambung ke anggota lain, id unik, fasilitas dikenal", () => {
    const ok = hubSchema.safeParse({ ...MANGGARAI, gates: [{ id: "utara", stationId: "lrtj:mgi", name: "Gate Utara", connectsTo: ["tj:b08302p"], facilities: ["lift"], accessible: true }] });
    expect(ok.success).toBe(true);
    expect(hubSchema.safeParse({ ...MANGGARAI, gates: [{ id: "x", stationId: "bukan-anggota", name: "G" }] }).success).toBe(false);
    expect(hubSchema.safeParse({ ...MANGGARAI, gates: [{ id: "x", stationId: "lrtj:mgi", name: "G", connectsTo: ["lrtj:mgi"] }] }).success).toBe(false);
    expect(hubSchema.safeParse({ ...MANGGARAI, gates: [{ id: "x", stationId: "lrtj:mgi", name: "G" }, { id: "x", stationId: "tj:b08301p", name: "H" }] }).success).toBe(false);
    expect(hubSchema.safeParse({ ...MANGGARAI, gates: [{ id: "x", stationId: "lrtj:mgi", name: "G", facilities: ["teleport"] }] }).success).toBe(false);
  });

  it("gate tampil di ruas jalan kaki hasil rute (annotate)", async () => {
    const p = planner([{ ...MANGGARAI, gates: [gate({ id: "utara", name: "Gate Utara", connectsTo: ["tj:b08302p"], facilities: ["lift"], accessible: true }), gate({ id: "halte", stationId: "tj:b08302p", name: "Pintu halte", facilities: ["ramp"], accessible: true })] }]);
    const route: Route = { legs: [{ type: "TRANSFER", stops: ["lrtj:mgi", "tj:b08302p"], distanceM: 400, minutes: null, fare: 0 }], totalDistanceM: 400, totalMinutes: null, timeComplete: false, totalFare: 0, transfers: 1 };
    const out = await p.annotate(route, newContext({}), undefined, { needs: ["lift"] });
    expect(out.legs[0]).toMatchObject({ fromGate: { name: "Gate Utara", facilities: ["lift"] }, toGate: { name: "Pintu halte" } });
  });

  it("admin menyimpan gate hub lewat API; anggota gate yang keliru ditolak; gate tampil di /api/hubs setelah terbit", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const data = {
      hubId: "manggarai-tanah-abang",
      name: "Uji gate",
      memberIds: ["manggarai", "tanah-abang"],
      walks: [{ from: "manggarai", to: "tanah-abang", distanceM: 120 }],
      // Gate dipilih dari pintu yang sudah tercatat di stasiun (entranceId).
      gates: [{ id: "utara", stationId: "manggarai", entranceId: "pintu-utara", name: "Gate Utara", connectsTo: ["tanah-abang"], facilities: ["lift", "guiding_block"], accessible: true, openHours: "05.00–22.00" }],
    };
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data: { ...data, hubId: "salah", gates: [{ ...data.gates[0], stationId: "sudirman" }] } })).status).toBe(400);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data })).status).toBe(201);
    await request(app).post("/api/admin/publish").set(auth).send({});
    const hub = (await request(app).get("/api/hubs")).body.data.find((h: Hub) => h.id === "manggarai-tanah-abang");
    expect(hub.gates).toEqual([expect.objectContaining({ id: "utara", stationId: "manggarai", entranceId: "pintu-utara", connectsTo: ["tanah-abang"], facilities: ["lift", "guiding_block"], accessible: true })]);
  });
});
