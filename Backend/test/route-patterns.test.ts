import request from "supertest";
import { findRides, parallelLines } from "../src/domain/RoutePlannerService";
import { applyPatternsToLines, applyPatternsToSequences, defaultsFromGtfs, defaultsFromSequences, patternMinutes } from "../src/domain/routePatterns";
import type { RoutePattern } from "../src/domain/content";
import { TjGtfs, type TjGtfsData } from "../src/data/gtfs/TjGtfs";
import type { Line, Station } from "../src/domain/models";
import { makeTestApp } from "./helpers";

const pattern = (lineId: string, direction: 0 | 1, stops: [string, number | null][]): RoutePattern => ({
  id: `${lineId}-${direction}`,
  lineId,
  direction,
  source: "manual",
  stops: stops.map(([stationId, minutes]) => ({ stationId, minutes })),
});

// Putaran satu arah: arah 0 lewat b > c, arah 1 lewat d (mis. putaran Kota Tua koridor 1).
const loop = [
  pattern("tj:1", 0, [["a", null], ["b", 2], ["c", 3]]),
  pattern("tj:1", 1, [["c", null], ["d", 4], ["a", 5]]),
];

describe("pengaturan rute per arah", () => {
  it("menggantikan urutan stasiun lini dan membuat urutan searah bila kedua arah diatur", () => {
    const seqs = applyPatternsToSequences([{ lineId: "tj:1", sequences: [["a", "b", "c", "d"]] }, { lineId: "x", sequences: [["p", "q"]] }], loop);
    expect(seqs).toEqual([
      { lineId: "tj:1", sequences: [["a", "b", "c"], ["c", "d", "a"]], directed: true },
      { lineId: "x", sequences: [["p", "q"]] },
    ]);
    // Hanya satu arah: berlaku dua arah.
    expect(applyPatternsToSequences([], [loop[0]])).toEqual([{ lineId: "tj:1", sequences: [["a", "b", "c"]], directed: false }]);
    const lines = applyPatternsToLines([{ id: "tj:1", name: "1", operator: "TJ", mode: "BUS", color: "#f00", stationIds: ["a", "c"] } as Line], loop);
    expect(lines[0].stationIds).toEqual(["a", "b", "c", "d"]);
  });

  it("rute searah tidak bisa dinaiki ke arah sebaliknya", () => {
    const seqs = applyPatternsToSequences([], loop);
    const stations = new Map<string, Station>();
    // b ke a: tidak boleh mundur di arah 0, jadi bus lanjut ke c lalu d lalu a (arah 1).
    const rides = findRides("b", "a", seqs, [], stations)!;
    expect(rides.flatMap((r) => r.stops)).toEqual(["b", "c", "d", "a"]);
    expect(parallelLines(["b", "a"], "p", [{ lineId: "q", sequences: [["a", "b"]], directed: true }], () => true)).toEqual(["p"]);
    expect(parallelLines(["a", "b"], "p", [{ lineId: "q", sequences: [["a", "b"]], directed: true }], () => true)).toEqual(["p", "q"]);
  });

  it("waktu tempuh dijumlahkan dari pengaturan rute", () => {
    expect(patternMinutes(loop, ["tj:1"], ["a", "b", "c"])).toEqual({ minutes: 5, lineId: "tj:1" });
    expect(patternMinutes(loop, ["tj:1"], ["c", "a"])).toEqual({ minutes: 9, lineId: "tj:1" });
    expect(patternMinutes(loop, ["tj:1"], ["b", "a"])).toBeNull();
    expect(patternMinutes([pattern("tj:1", 0, [["a", null], ["b", null], ["c", 3]])], ["tj:1"], ["a", "c"])).toBeNull();
  });

  it("rute bawaan dari GTFS (dua arah, waktu jadwal) dan dari Commute (batang utama, tanpa waktu)", () => {
    const data: TjGtfsData = {
      meta: { agency: "TJ", routes: ["1"], stops: 3, patterns: 2 },
      stops: { A: ["A", 0, 0], B: ["B", 0, 0], C: ["C", 0, 0] },
      routes: {
        "1": {
          name: "1",
          color: "#f00",
          patterns: [
            { trip: "1-R01", service: "x", headsign: "C", stops: ["A", "B", "C"], arr: [0, 120, 300], dep: [0, 150, 300], freq: [] },
            { trip: "1-R02", service: "x", headsign: "A", stops: ["C", "A"], arr: [0, 400], dep: [0, 400], freq: [] },
          ],
        },
      },
    };
    const d = defaultsFromGtfs(new TjGtfs(data), "1", (c) => c.toLowerCase());
    expect(d).toEqual([
      { direction: 0, headsign: "C", stops: [{ stationId: "a", minutes: null }, { stationId: "b", minutes: 2 }, { stationId: "c", minutes: 2.5 }] },
      { direction: 1, headsign: "A", stops: [{ stationId: "c", minutes: null }, { stationId: "a", minutes: 6.7 }] },
    ]);
    // Cabang yang berawal di ujung batang utama disambung (mis. putaran Lin Cikarang); cabang lain tetap terpisah.
    const c = defaultsFromSequences({ lineId: "x", sequences: [["a", "b", "c"], ["b", "z"], ["c", "d", "c2", "c"]] });
    expect(c.patterns.map((p) => p.stops.map((s) => s.stationId))).toEqual([
      ["a", "b", "c", "d", "c2", "c"],
      ["c", "c2", "d", "c", "b", "a"],
    ]);
    expect(c.branches).toEqual([["b", "z"]]);
  });

  it("admin menyimpan pengaturan rute; satu per lini dan arah; berlaku di pratinjau lalu setelah terbit", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const data = { lineId: "krl-cikarang", direction: 0, headsign: "Manggarai", stops: [{ stationId: "tanah-abang" }, { stationId: "sudirman", minutes: 6 }, { stationId: "manggarai", minutes: 7 }] };
    const res = await request(app).post("/api/admin/content").set(auth).send({ kind: "route_pattern", data });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ stationId: null, draft: { source: "manual", direction: 0 } });
    // Arah yang sama tidak boleh dobel; lini dan stasiun harus dikenal; minimal dua pemberhentian.
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "route_pattern", data })).status).toBe(409);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "route_pattern", data: { ...data, lineId: "zzz" } })).status).toBe(400);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "route_pattern", data: { ...data, direction: 1, stops: [{ stationId: "tanah-abang" }, { stationId: "tidak-ada" }] } })).status).toBe(400);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "route_pattern", data: { ...data, direction: 1, stops: [{ stationId: "tanah-abang" }] } })).status).toBe(400);
    // Mengubah entri sendiri tidak dianggap dobel.
    expect((await request(app).put(`/api/admin/content/${res.body.data.id}`).set(auth).send({ data: { ...data, headsign: "Bekasi" } })).status).toBe(200);

    const routes = (await request(app).get("/api/admin/routes").set(auth)).body.data;
    expect(routes.find((r: { lineId: string }) => r.lineId === "krl-cikarang")).toMatchObject({ sequences: [["tanah-abang", "sudirman", "manggarai"]], directed: false });
    // Lini publik belum berubah sebelum terbit; sesudah terbit urutannya mengikuti pengaturan.
    const before = (await request(app).get("/api/lines")).body.data.find((l: { id: string }) => l.id === "krl-cikarang");
    await request(app).post("/api/admin/publish").set(auth).send({});
    const after = (await request(app).get("/api/lines")).body.data.find((l: { id: string }) => l.id === "krl-cikarang");
    expect(after.stationIds).toEqual(["tanah-abang", "sudirman", "manggarai"]);
    expect(before.stationIds).not.toEqual(after.stationIds);
  });

  it("rute bawaan untuk sinkron ulang dari Commute dan GTFS", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const commute = (await request(app).get("/api/admin/routes/krl-cikarang/defaults?source=commute").set(auth)).body.data;
    expect(commute.patterns).toHaveLength(2);
    expect(commute.patterns[1].stops.map((s: { stationId: string }) => s.stationId)).toEqual([...commute.patterns[0].stops.map((s: { stationId: string }) => s.stationId)].reverse());
    // GTFS hanya untuk koridor BRT TransJakarta.
    expect((await request(app).get("/api/admin/routes/krl-cikarang/defaults?source=gtfs").set(auth)).status).toBe(404);
    expect((await request(app).get("/api/admin/routes/tidak-ada/defaults").set(auth)).status).toBe(404);
  });

  it("titik anak stasiun per lini tersimpan terpisah dari posisi utama", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "map_stop", stationId: "manggarai", data: { x: 4759, y: 3756 } })).status).toBe(201);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "map_stop", stationId: "manggarai", data: { x: 4787, y: 3725, lineId: "krl-bogor" } })).status).toBe(201);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "map_stop", stationId: "manggarai", data: { x: 1, y: 1, lineId: "zzz" } })).status).toBe(400);
    const stops = (await request(app).get("/api/map").set(auth).set("X-NTD-Preview", "1")).body.data.stops;
    expect(stops).toEqual(expect.arrayContaining([expect.objectContaining({ stationId: "manggarai", x: 4759 }), expect.objectContaining({ stationId: "manggarai", lineId: "krl-bogor", x: 4787 })]));
    expect(stops).toHaveLength(2);
  });
});
