// Sinkron stasiun, rute, dan hub dari Commute Data API / GTFS, tambah manual stasiun dan rute dari admin, serta
// stasiun LRT Jakarta Pramuka (beroperasi 12 November 2026).

import request from "supertest";
import { FixtureCommuteSource } from "../src/data/commute/FixtureCommuteSource";
import type { UpLine, UpOperator, UpStation } from "../src/data/commute/types";
import { TjGtfs } from "../src/data/gtfs/TjGtfs";
import { applyLines, applyStations, BUILTIN_STATIONS } from "../src/domain/datasetOverlay";
import { diffDataset, gtfsHubSuggestions, gtfsLineCandidates, stalePatterns } from "../src/domain/datasetSync";
import type { Line, Station } from "../src/domain/models";
import { buildStationIndex } from "../src/data/commute/station-index";
import { makeTestApp } from "./helpers";

/** Sumber offline ditambah LRT Jakarta Lin Selatan Velodrome–Manggarai; Pramuka bisa "dibuka" saat uji berjalan. */
class LrtSource extends FixtureCommuteSource {
  pramukaOpen = false;
  private lrt(code: string, name: string, lat: number, lng: number): UpStation {
    return { operator: "LRTJ", code, name, lines: ["LRTJ:S"], lat, lng, amenities: [], score: null } as UpStation;
  }
  async getOperators(): Promise<UpOperator[]> {
    return [...(await super.getOperators()).filter((o) => o.code !== "LRTJ"), { code: "LRTJ", name: "LRT Jakarta", mode: "TRAM" } as UpOperator];
  }
  async getStations(): Promise<UpStation[]> {
    const own = [this.lrt("VEL", "Velodrome", -6.1924, 106.8911), this.lrt("RWM", "Rawamangun", -6.193, 106.8826), ...(this.pramukaOpen ? [this.lrt("PKA", "Pramuka", -6.1919, 106.8706)] : [])];
    return [...(await super.getStations()), ...own];
  }
  async getLines(): Promise<UpLine[]> {
    const codes = ["VEL", "RWM", "PKA", "KYM"];
    return [
      ...(await super.getLines()),
      {
        operator: "LRTJ",
        code: "S",
        name: "Lin Selatan",
        color: "#F26324",
        mode: "TRAM",
        stations: codes.map((code) => ({ operator: "LRTJ", code })),
        stationNumbers: ["S06", "S07", "S08", "S09"],
        stationNames: ["Velodrome", "Rawamangun", "Pramuka", "Matraman"],
      },
    ];
  }
}

const st = (id: string, extra: Partial<Station> = {}): Station => ({ id, name: id, operator: "Op", lineIds: [], codes: [], source: "commute", ...extra });

describe("stasiun dan lini di atas dataset", () => {
  it("stasiun bawaan NTD hanya dipakai bila dataset belum memuatnya; isian admin menambah atau mengoreksi", () => {
    expect(BUILTIN_STATIONS.find((s) => s.id === "lrtj:pka")).toMatchObject({ name: "Pramuka", lineIds: ["lrtj:s"], codes: ["S08"] });
    expect(applyStations([st("a")], []).map((s) => [s.id, s.source])).toEqual([
      ["a", "commute"],
      ["lrtj:pka", "ntd"],
    ]);
    // Dataset sudah memuat Pramuka: data dataset yang dipakai.
    expect(applyStations([st("lrtj:pka", { name: "Pramuka (API)" })], []).map((s) => s.name)).toEqual(["Pramuka (API)"]);
    const out = applyStations([st("a", { lineIds: ["l1"], lat: 1, lng: 2 })], [
      { stationId: "a", name: "A baru", operator: "Op", lineIds: ["l2"], source: "manual" },
      { stationId: "ntd:baru", name: "Baru", operator: "Op", lineIds: ["l1"], lat: -6, lng: 106, source: "manual" },
    ], []);
    expect(out[0]).toMatchObject({ id: "a", name: "A baru", lineIds: ["l1", "l2"], lat: 1, lng: 2, source: "commute" });
    expect(out[1]).toMatchObject({ id: "ntd:baru", source: "admin", commuteIds: [] });
    const lines = applyLines([{ id: "l1", name: "L1", operator: "Op", mode: "RAIL", color: "#000000", stationIds: ["a"], source: "commute" }], [
      { lineId: "l1", name: "L1 (koreksi)", operator: "Op", mode: "RAIL", source: "manual" },
      { lineId: "ntd:rute-baru", name: "Rute baru", operator: "Op", mode: "BUS", color: "#123456", source: "manual" },
    ]);
    expect(lines.map((l) => [l.id, l.name, l.source, l.stationIds])).toEqual([
      ["l1", "L1 (koreksi)", "commute", ["a"]],
      ["ntd:rute-baru", "Rute baru", "admin", []],
    ]);
  });

  it("perbandingan dataset dan pengaturan rute yang tertinggal", () => {
    const line = (stationIds: string[]): Line => ({ id: "lrtj:s", name: "Lin Selatan", operator: "LRT Jakarta", mode: "TRAM", color: "#F26324", stationIds });
    const diff = diffDataset(
      { stations: [st("a")], lines: [line(["a"])], hubs: [] },
      { stations: [st("a"), st("b")], lines: [line(["a", "b"])], hubs: [{ id: "h", name: "H", memberIds: [], walks: [] }] },
    );
    expect(diff.stations.added.map((x) => x.id)).toEqual(["b"]);
    expect(diff.lines.changed).toEqual([{ id: "lrtj:s", name: "Lin Selatan", addedStations: ["b"], removedStations: [] }]);
    expect(diff.hubs.added.map((x) => x.id)).toEqual(["h"]);
    const pattern = { id: "p", lineId: "lrtj:s", direction: 0 as const, stops: [{ stationId: "a" }, { stationId: "c" }], source: "commute" as const };
    // Stasiun dataset yang dikenal (b) tetapi tidak ada di urutan admin; d belum dikenal (belum beroperasi).
    expect(stalePatterns([{ lineId: "lrtj:s", sequences: [["a", "b", "c", "d"]] }], [pattern], new Set(["a", "b", "c"]))).toEqual([{ lineId: "lrtj:s", missing: ["b"] }]);
  });

  it("usulan GTFS: koridor yang belum menjadi rute dan halte dekat stasiun rel untuk hub", () => {
    const gtfs = new TjGtfs();
    const lines = gtfs.routes.filter((c) => c !== "13E").map((c): Line => ({ id: `tj:${c.toLowerCase()}`, name: c, operator: "TransJakarta", mode: "BUS", color: "#000000", stationIds: [] }));
    expect(gtfsLineCandidates(gtfs, lines)).toEqual([{ lineId: "tj:13e", name: "Puri Beta - Flyover Kuningan", operator: "TransJakarta", mode: "BUS", color: "#7A357B", source: "gtfs" }]);
    const idx = buildStationIndex([]);
    const pramukaSari = gtfs.allStops().find((g) => g.name === "Pramuka Sari")!;
    const stations = [st("lrtj:pka", { name: "Pramuka", operator: "LRT Jakarta", lat: -6.1919, lng: 106.8706 }), st(`tj:${pramukaSari.code.toLowerCase()}`, { name: "Pramuka Sari", operator: "TransJakarta", lat: pramukaSari.lat, lng: pramukaSari.lng })];
    const s = gtfsHubSuggestions(gtfs, idx, stations, [], 250);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ hubId: "pramuka-tj", existing: false, memberIds: ["lrtj:pka", `tj:${pramukaSari.code.toLowerCase()}`] });
    expect(s[0].added[0].distanceM).toBeGreaterThan(150);
    // Sudah satu hub: tidak diusulkan lagi.
    expect(gtfsHubSuggestions(gtfs, idx, stations, [{ id: "h", name: "H", memberIds: stations.map((x) => x.id), walks: [] }], 250)).toEqual([]);
  });
});

describe("Pramuka dan sinkron dataset dari admin", () => {
  it("Pramuka bisa dipakai walau cache dataset belum memuatnya, lalu sinkron dataset memuatnya dari API", async () => {
    const source = new LrtSource();
    const { app, login } = await makeTestApp({ source });
    const auth = { Authorization: `Bearer ${await login()}` };

    // Dataset (cache) belum memuat Pramuka: stasiun bawaan NTD dipakai, rute disusun dari urutan lini.
    const stations = (await request(app).get("/api/stations").query({ q: "pramuka" })).body.data;
    expect(stations.map((s: Station) => [s.id, s.name])).toEqual([["lrtj:pka", "Pramuka"]]);
    const plan = await request(app).post("/api/plan").send({ originId: "lrtj:vel", destinationId: "lrtj:pka" });
    expect(plan.status).toBe(200);
    expect(plan.body.data.route.legs.map((l: { type: string; lineId?: string; stops: string[] }) => [l.type, l.lineId, l.stops])).toEqual([["RIDE", "lrtj:s", ["lrtj:vel", "lrtj:rwm", "lrtj:pka"]]]);

    // Usulan dari lin Commute: Matraman (S09) tercantum di lin tetapi belum di daftar stasiun.
    const cand = (await request(app).get("/api/admin/stations/candidates?source=commute").set(auth)).body.data.candidates;
    expect(cand.map((c: { id: string; name: string; codes: string[] }) => [c.id, c.name, c.codes])).toEqual([["lrtj:kym", "Matraman", ["S09"]]]);

    // Pengaturan rute admin disimpan sebelum Pramuka dikenal (Velodrome > Rawamangun saja): ditandai tertinggal.
    await request(app).post("/api/admin/content").set(auth).send({ kind: "route_pattern", data: { lineId: "lrtj:s", direction: 0, stops: [{ stationId: "lrtj:vel" }, { stationId: "lrtj:rwm", minutes: 2 }], source: "commute" } });
    const routes = (await request(app).get("/api/admin/routes").set(auth)).body.data;
    expect(routes.find((r: { lineId: string }) => r.lineId === "lrtj:s").missing).toEqual(["lrtj:pka"]);

    // API memuat Pramuka: sinkron dataset memuat ulang tanpa menunggu cache kedaluwarsa dan melaporkan perubahannya.
    source.pramukaOpen = true;
    const editor = { Authorization: `Bearer ${await login({ email: "editor@ntd.test", password: "rahasia-editor-123" })}` };
    expect((await request(app).post("/api/admin/dataset/refresh").set(editor).send({})).status).toBe(403);
    const refreshed = await request(app).post("/api/admin/dataset/refresh").set(auth).send({ parts: ["stations"] });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.stalePatterns).toEqual([{ lineId: "lrtj:s", missing: ["lrtj:pka"] }]);
    const list = (await request(app).get("/api/admin/stations").set(auth)).body.data;
    expect(list.find((s: Station) => s.id === "lrtj:pka")).toMatchObject({ name: "Pramuka", source: "commute", codes: ["S08"] });

    // Isian stasiun dari API untuk form tambah manual.
    const def = (await request(app).get("/api/admin/stations/defaults").query({ stationId: "lrtj:kym", source: "commute" }).set(auth)).body.data;
    expect(def.data).toMatchObject({ name: "Matraman", operator: "LRT Jakarta", codes: ["S09"], lineIds: ["lrtj:s"] });
    const gtfsDef = await request(app).get("/api/admin/stations/defaults").query({ stationId: "lrtj:kym", source: "gtfs" }).set(auth);
    expect(gtfsDef.status).toBe(404);
  });

  it("admin menambah stasiun dan rute manual; stasiun manual bisa dipakai pencarian rute setelah terbit", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const station = { name: "Halte Uji", operator: "KAI Commuter", lineIds: ["krl-cikarang"], codes: ["C99"], lat: -6.21, lng: 106.84, source: "manual" };
    const res = await request(app).post("/api/admin/content").set(auth).send({ kind: "station", stationId: "ntd:halte-uji", data: station });
    expect(res.status).toBe(201);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "station", stationId: "ntd:halte-uji", data: station })).status).toBe(409);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "station", stationId: "Bukan Id", data: station })).status).toBe(400);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "station", stationId: "ntd:lain", data: { ...station, lineIds: ["tidak-ada"] } })).status).toBe(400);

    // Stasiun manual disisipkan ke urutan Lin Cikarang (Sudirman > Halte Uji > Manggarai).
    const pattern = { lineId: "krl-cikarang", direction: 0, stops: ["tanah-abang", "bni-city", "sudirman", "ntd:halte-uji", "manggarai"].map((stationId, i) => ({ stationId, ...(i ? { minutes: 3 } : {}) })), source: "manual" };
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "route_pattern", data: pattern })).status).toBe(201);

    // Rute manual baru dengan urutannya.
    const line = { lineId: "ntd:shuttle-uji", name: "Shuttle Uji", operator: "NTD", mode: "BUS", color: "#123456", source: "manual" };
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "line", data: line })).status).toBe(201);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "line", data: line })).status).toBe(409);
    const shuttle = { lineId: "ntd:shuttle-uji", direction: 0, stops: [{ stationId: "ntd:halte-uji" }, { stationId: "duri", minutes: 9 }], source: "manual" };
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "route_pattern", data: shuttle })).status).toBe(201);

    // Sebelum terbit belum terlihat pengguna.
    expect((await request(app).get("/api/stations").query({ q: "halte uji" })).body.data).toEqual([]);
    expect((await request(app).post("/api/admin/publish").set(auth).send({ force: true })).status).toBe(200);

    expect((await request(app).get("/api/stations").query({ q: "halte uji" })).body.data.map((s: Station) => s.id)).toEqual(["ntd:halte-uji"]);
    expect((await request(app).get("/api/lines")).body.data.find((l: Line) => l.id === "ntd:shuttle-uji")).toMatchObject({ name: "Shuttle Uji", stationIds: ["ntd:halte-uji", "duri"], source: "admin" });

    const plan = await request(app).post("/api/plan").send({ originId: "tanah-abang", destinationId: "ntd:halte-uji" });
    expect(plan.status).toBe(200);
    const leg = plan.body.data.route.legs[0];
    expect(leg).toMatchObject({ type: "RIDE", lineId: "krl-cikarang", stops: ["tanah-abang", "bni-city", "sudirman", "ntd:halte-uji"], minutes: 9 });
    const viaShuttle = await request(app).post("/api/plan").send({ originId: "sudirman", destinationId: "duri", avoidModes: ["RAIL"] });
    expect(viaShuttle.status).toBe(200);
  });

  it("usulan hub dan halte dari GTFS di admin", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const sug = await request(app).get("/api/admin/hubs/suggestions").set(auth);
    expect(sug.status).toBe(200);
    expect(Array.isArray(sug.body.data.suggestions)).toBe(true);
    const cand = await request(app).get("/api/admin/stations/candidates?source=gtfs").set(auth);
    expect(cand.status).toBe(200);
    // Sumber offline tidak memuat halte TransJakarta: semua halte koridor BRT GTFS menjadi usulan.
    expect(cand.body.data.candidates.length).toBeGreaterThan(100);
    expect(cand.body.data.candidates[0]).toMatchObject({ operator: "TransJakarta", source: "gtfs" });
    const routes = await request(app).get("/api/admin/routes/candidates?source=gtfs").set(auth);
    expect(routes.status).toBe(200);
    const hubGtfs = await request(app).get("/api/admin/hubs/defaults").query({ source: "gtfs", members: "manggarai" }).set(auth);
    expect(hubGtfs.status).toBe(200);
    expect(hubGtfs.body.data.memberIds[0]).toBe("manggarai");
  });
});
