// Hub transfer (bawaan NTD, isian admin, sinkron dari Commute) dan sinkron rute dari dataset (waktu, frekuensi, jam
// layanan; banyak rute sekaligus).

import request from "supertest";
import type { HubContent } from "../src/domain/content";
import { applyHubs, CURATED_HUBS, hubOfStation, straightDistanceM } from "../src/domain/hubs";
import type { Hub } from "../src/domain/models";
import { averageHeadway, medianMinutes } from "../src/domain/railTimetable";
import { applyPatternsToSequences, attachBranches, gtfsFrequency } from "../src/domain/routePatterns";
import { dropUnknown, summarize } from "../src/domain/routeSync";
import { makeTestApp } from "./helpers";

const commuteHub: Hub = { id: "dukuh-atas", name: "Dukuh Atas", memberIds: ["a", "b", "c"], walks: [{ from: "a", to: "b", distanceM: 200, minutes: 3 }] };
const over = (o: Partial<HubContent>): HubContent => ({ id: "x", hubId: "baru", name: "Baru", kind: "hub", memberIds: ["a", "d"], walks: [], source: "manual", ...o });

describe("hub transfer", () => {
  it("hub bawaan NTD: halte TransJakarta Cawang dan stasiun LRT Cawang", () => {
    expect(CURATED_HUBS[0].memberIds).toEqual(["tj:h00276p", "lrtjbdb:cwg"]);
    const known = new Set(["tj:h00276p", "lrtjbdb:cwg", "a", "b", "c"]);
    const hubs = applyHubs([commuteHub], [], known);
    expect(hubs.map((h) => [h.id, h.source])).toEqual([
      ["dukuh-atas", "commute"],
      ["cawang-lrt-tj", "ntd"],
    ]);
    expect(hubOfStation(hubs).get("lrtjbdb:cwg")).toBe("cawang-lrt-tj");
    // Anggota yang tidak dikenal dibuang; hub dengan kurang dari dua anggota tidak dipakai.
    expect(applyHubs([commuteHub], [], new Set(["a", "b", "c"])).map((h) => h.id)).toEqual(["dukuh-atas"]);
  });

  it("isian admin menambah, menggantikan, atau menonaktifkan hub", () => {
    const hubs = applyHubs([commuteHub], [over({}), over({ hubId: "dukuh-atas", name: "Dukuh Atas (survei)", memberIds: ["a", "b"], walks: [{ from: "a", to: "b", distanceM: 150, minutes: 2 }] }), over({ hubId: "cawang-lrt-tj", disabled: true })]);
    expect(hubs.map((h) => h.id)).toEqual(["dukuh-atas", "baru"]);
    expect(hubs[0]).toMatchObject({ name: "Dukuh Atas (survei)", memberIds: ["a", "b"], walks: [{ distanceM: 150, minutes: 2 }], source: "admin" });
  });

  it("jarak garis lurus untuk hub tanpa data jalan kaki", () => {
    // Halte TJ Cawang ↔ LRT Cawang: sekitar 19 m.
    expect(Math.round(straightDistanceM({ lat: -6.245863, lng: 106.871143 }, { lat: -6.2457, lng: 106.8712 })!)).toBe(19);
    expect(straightDistanceM({}, { lat: 0, lng: 0 })).toBeUndefined();
  });

  it("admin membuat hub, satu isian per id hub, berlaku setelah terbit, dan bisa menonaktifkan hub dataset", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const base = (await request(app).get("/api/admin/hubs").set(auth)).body.data;
    expect(base.base.map((h: Hub) => h.id)).toContain("dukuh-atas");

    const data = { hubId: "manggarai-tanah-abang", name: "Uji", memberIds: ["manggarai", "tanah-abang"], walks: [{ from: "manggarai", to: "tanah-abang", distanceM: 120 }] };
    const res = await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ stationId: null, draft: { source: "manual", kind: "hub" } });
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data })).status).toBe(409);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data: { ...data, hubId: "lain", memberIds: ["manggarai", "tidak-ada"], walks: [] } })).status).toBe(400);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data: { ...data, hubId: "lain", walks: [{ from: "manggarai", to: "sudirman", distanceM: 1 }] } })).status).toBe(400);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data: { ...data, hubId: "Bukan Slug" } })).status).toBe(400);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data: { hubId: "dukuh-atas", name: "Dukuh Atas", disabled: true } })).status).toBe(201);

    const preview = (await request(app).get("/api/admin/hubs").set(auth)).body.data.hubs.map((h: Hub) => h.id);
    expect(preview).toContain("manggarai-tanah-abang");
    expect(preview).not.toContain("dukuh-atas");
    expect((await request(app).get("/api/hubs")).body.data.map((h: Hub) => h.id)).not.toContain("manggarai-tanah-abang");
    await request(app).post("/api/admin/publish").set(auth).send({});
    const pub = (await request(app).get("/api/hubs")).body.data;
    expect(pub.find((h: Hub) => h.id === "manggarai-tanah-abang")).toMatchObject({ source: "admin", walks: [{ from: "manggarai", to: "tanah-abang", distanceM: 120, minutes: null }] });
    expect(pub.map((h: Hub) => h.id)).not.toContain("dukuh-atas");
    const stations = (await request(app).get("/api/stations")).body.data;
    expect(stations.find((s: { id: string }) => s.id === "manggarai").hubId).toBe("manggarai-tanah-abang");
    expect(stations.find((s: { id: string }) => s.id === "sudirman").hubId).toBeUndefined();
  });

  it("sinkron hub dari Commute: anggota dan jalan kaki hub dataset", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const d = (await request(app).get("/api/admin/hubs/defaults?hubId=dukuh-atas").set(auth)).body.data;
    expect(d.hub.name).toBe("Dukuh Atas");
    expect(d.memberIds).toEqual(expect.arrayContaining(["sudirman", "bni-city"]));
    expect(d.walks).toEqual(expect.arrayContaining([expect.objectContaining({ from: "sudirman", to: "bni-city", distanceM: 250 })]));
  });
});

describe("sinkron rute dari dataset", () => {
  it("ruas cabang dataset ikut tersimpan dua arah sehingga tidak hilang dari peta dan pencarian rute", () => {
    const base = [
      { direction: 0 as const, stops: [{ stationId: "a", minutes: null }, { stationId: "b", minutes: 2 }] },
      { direction: 1 as const, stops: [{ stationId: "b", minutes: null }, { stationId: "a", minutes: 2 }] },
    ];
    const withBranches = attachBranches(base, [["b", "z", "y"], ["a", "b"]]);
    expect(withBranches.map((p) => p.branches)).toEqual([[["b", "z", "y"]], [["y", "z", "b"]]]);
    const seqs = applyPatternsToSequences([], withBranches.map((p) => ({ ...p, id: String(p.direction), lineId: "l", source: "commute" as const })));
    expect(seqs).toEqual([{ lineId: "l", sequences: [["a", "b"], ["b", "z", "y"], ["b", "a"], ["y", "z", "b"]], directed: true }]);
    expect(attachBranches(base, [["a", "b"]])[0].branches).toBeUndefined();
  });

  it("frekuensi dan jam layanan dari jendela frekuensi GTFS", () => {
    expect(gtfsFrequency([["00:00", "23:59", 360]])).toEqual({ headwayMinutes: 6, serviceHours: "24 jam" });
    // Rata-rata ditimbang lama jendela: 2 jam tiap 5 menit, 2 jam tiap 15 menit = 10 menit.
    expect(gtfsFrequency([["05:00", "07:00", 300], ["07:00", "09:00", 900]])).toEqual({ headwayMinutes: 10, serviceHours: "05:00–09:00" });
    expect(gtfsFrequency([])).toEqual({});
  });

  it("pemberhentian yang belum dikenal NTD dibuang dan waktunya digabung ke ruas berikutnya", () => {
    const dropped = new Set<string>();
    const out = dropUnknown(
      [
        { stationId: "x", minutes: null },
        { stationId: "a", minutes: 2 },
        { stationId: "y", minutes: 3 },
        { stationId: "b", minutes: 4 },
        { stationId: "z", minutes: 1 },
      ],
      new Set(["a", "b"]),
      dropped,
    );
    expect(out).toEqual([
      { stationId: "a", minutes: null },
      { stationId: "b", minutes: 7 },
    ]);
    expect([...dropped]).toEqual(["x", "y", "z"]);
  });

  it("frekuensi rata-rata dan waktu tempuh umum dari jadwal kereta", () => {
    const trips = [
      { trip: "1", depart: 300, arrive: 305 },
      { trip: "2", depart: 310, arrive: 316 },
      { trip: "3", depart: 330, arrive: 335 },
    ];
    expect(averageHeadway(trips)).toBe(15);
    expect(medianMinutes(trips)).toBe(5);
    expect(averageHeadway(trips.slice(0, 1))).toBeUndefined();
    expect(summarize([{ direction: 0, stops: [{ stationId: "a", minutes: null }, { stationId: "b", minutes: 5 }, { stationId: "c", minutes: null }], headwayMinutes: 15 }])).toEqual([
      "Arah 1: waktu 1/2 ruas, frekuensi 15 mnt, jam layanan tidak tersedia",
    ]);
  });

  it("banyak rute sekaligus disimpan sebagai draft kedua arah; catatan admin dipertahankan", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const lines = (await request(app).get("/api/lines")).body.data.map((l: { id: string }) => l.id) as string[];
    const target = lines.find((id) => id === "krl-cikarang")!;
    const base = (await request(app).get(`/api/admin/routes/${target}/defaults?source=commute`).set(auth)).body.data;
    expect(base.notes).toHaveLength(2);
    const stops = base.patterns[0].stops.map((s: { stationId: string }, i: number) => ({ stationId: s.stationId, ...(i === 1 ? { note: "naik di gerbong 1" } : {}) }));
    await request(app).post("/api/admin/content").set(auth).send({ kind: "route_pattern", data: { lineId: target, direction: 0, stops, note: "catatan admin", headwayMinutes: 12 } });

    const res = await request(app).post("/api/admin/routes/sync").set(auth).send({ lineIds: [target, "tidak-ada"] });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ lineId: target, ok: true, source: "commute", saved: [0, 1] });
    expect(res.body.data[1]).toMatchObject({ lineId: "tidak-ada", ok: false });
    const items = (await request(app).get("/api/admin/content?kind=route_pattern").set(auth)).body.data;
    expect(items).toHaveLength(2);
    const dir0 = items.find((i: { draft: { direction: number } }) => i.draft.direction === 0).draft;
    expect(dir0).toMatchObject({ source: "commute", note: "catatan admin", headwayMinutes: 12 });
    expect(dir0.syncedAt).toBeDefined();
    expect(dir0.stops[1].note).toBe("naik di gerbong 1");
    expect((await request(app).post("/api/admin/routes/sync").set(auth).send({ lineIds: [] })).status).toBe(400);
  });
});
