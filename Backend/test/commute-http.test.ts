// HttpCommuteSource terhadap respons tiruan yang meniru bentuk asli Commute Data API
// (envelope { status, data }, id stasiun `{operator}-{code}`, kunci lin `OPERATOR:KODE`).

import request from "supertest";
import { HttpCommuteSource, refOfId, stopParam } from "../src/data/commute/HttpCommuteSource";
import { makeTestApp } from "./helpers";

const st = (id: string, name: string, lines: string[], amenities: { type: string; text?: string }[] = [], extra: object = {}) => {
  const [operator, code] = [id.slice(0, id.indexOf("-")), id.slice(id.indexOf("-") + 1)];
  return { id, name, officialName: name.toUpperCase(), code, regionCode: "CGK", operator, lines, amenities, latitude: -6.2, longitude: 106.8, score: 50, searchable: true, ...extra };
};

const STATIONS = [
  st("KCI-THB", "Tanah Abang", ["KCI:C", "KCI:R"], [{ type: "ELEVATOR_PAID", text: "Peron 5" }, { type: "ESCALATOR_UNPAID" }, { type: "TOILET_ACCESSIBLE", text: "Hall utara" }]),
  st("KCI-KAT", "Karet", ["KCI:C"]),
  st("KCI-SUDB", "BNI City", ["KCI:A", "KCI:C"], [{ type: "ELEVATOR_UNPAID" }], { officialName: "SUDIRMAN BARU" }),
  st("KCI-SUD", "Sudirman", ["KCI:C"], [{ type: "TOILET", text: "Peron 1" }, { type: "ESCALATOR_PAID", text: "Peron 1" }, { type: "PRAYING_ROOM" }]),
  st("KCI-MRI", "Manggarai", ["KCI:A", "KCI:B", "KCI:C"], [{ type: "ELEVATOR_PAID" }, { type: "ESCALATOR_PAID" }, { type: "TOILET_ACCESSIBLE" }]),
  st("MRTJ-DKA", "Dukuh Atas BNI", ["MRTJ:M"], [{ type: "ELEVATOR_UNPAID" }]),
  st("MRTJ-BNH", "Bendungan Hilir", ["MRTJ:M"]),
  st("LRTJBDB-DKA", "Dukuh Atas BSI", ["LRTJBDB:C", "LRTJBDB:B"]),
  st("TJ-B01", "Dukuh Atas 1", ["TJ:1"]),
  st("KCI-JAKK", "Jakarta Kota", ["KCI:B"], [{ type: "TOILET_ACCESSIBLE" }]),
  st("MRTJ-BHI", "Bundaran HI Bank Jakarta", ["MRTJ:M"], [{ type: "ELEVATOR_UNPAID" }]),
  st("TJ-H00275P", "Kota", ["TJ:1"]),
  st("TJ-H00022P", "Bundaran HI Astra", ["TJ:1"]),
  st("KCI-BD", "Bandung", ["KCI:BDL"], [], { regionCode: "BDO" }),
];

const HUBS = [
  {
    id: "HUB-DKA",
    slug: "dukuh-atas",
    name: "Dukuh Atas",
    kind: "hub",
    heroImage: null,
    lines: ["KCI:C", "MRTJ:M"],
    members: ["KCI-SUD", "KCI-SUDB", "MRTJ-DKA", "LRTJBDB-DKA", "TJ-B01"].map((id) => {
      const s = STATIONS.find((x) => x.id === id)!;
      return { id, name: s.name, officialName: s.officialName, code: s.code, operator: s.operator, lines: s.lines };
    }),
  },
];

const OPERATORS = [
  { code: "KCI", name: "Commuter Line", url: "https://kci.id/", timezone: "Asia/Jakarta", lang: "id", mode: "RAIL", lines: [
    { name: "Lin Cikarang", lineCode: "C", colorCode: "#25B8EB", mode: "RAIL", searchable: true },
    { name: "Lin Bandara", lineCode: "A", colorCode: "#1d1a5c", mode: "RAIL", searchable: true },
    { name: "Lin Bogor", lineCode: "B", colorCode: "#E30A16", mode: "RAIL", searchable: true },
  ] },
  { code: "MRTJ", name: "MRT Jakarta", url: "https://jakartamrt.co.id/", timezone: "Asia/Jakarta", lang: "id", mode: "SUBWAY", lines: [{ name: "Lin Utara Selatan", lineCode: "M", colorCode: "#ca2a51", mode: "SUBWAY", searchable: true }] },
  { code: "LRTJBDB", name: "LRT Jabodebek", url: "https://lrtjabodebek.id/", timezone: "Asia/Jakarta", lang: "id", mode: "TRAM", lines: [
    { name: "Lin Cibubur", lineCode: "C", colorCode: "#155a2a", mode: "TRAM", searchable: true },
    { name: "Lin Bekasi", lineCode: "B", colorCode: "#155a2a", mode: "TRAM", searchable: true },
  ] },
  { code: "TJ", name: "TransJakarta", url: "https://transjakarta.co.id/", timezone: "Asia/Jakarta", lang: "id", mode: "BUS", lines: [{ name: "Koridor 1", lineCode: "1", colorCode: "#ccc", mode: "BUS", searchable: true }] },
];

const ls = (id: string, n: string) => ({ id, code: refOfId(id).code, name: STATIONS.find((s) => s.id === id)?.name ?? id, stationNumber: n, isInterchange: false, otherLines: [] });
const LINES: Record<string, object> = {
  "KCI/C": { segments: [{ kind: "TRUNK", joinsAtCode: null, stations: [ls("KCI-THB", "C10"), ls("KCI-KAT", "C11"), ls("KCI-SUDB", "C12"), ls("KCI-SUD", "C13"), ls("KCI-MRI", "C14")] }] },
  "KCI/A": { segments: [{ kind: "TRUNK", joinsAtCode: null, stations: [ls("KCI-MRI", "A01"), ls("KCI-SUDB", "A02")] }] },
  "KCI/B": { segments: [{ kind: "TRUNK", joinsAtCode: null, stations: [ls("KCI-JAKK", "B01"), ls("KCI-MRI", "B10")] }] },
  "TJ/1": { segments: [{ kind: "TRUNK", joinsAtCode: null, stations: [ls("TJ-H00275P", "1-20"), ls("TJ-H00022P", "1-8"), ls("TJ-B01", "1-6")] }] },
  "MRTJ/M": { segments: [{ kind: "TRUNK", joinsAtCode: null, stations: [ls("MRTJ-BNH", "M10"), ls("MRTJ-DKA", "M12")] }] },
  "LRTJBDB/C": { segments: [{ kind: "TRUNK", joinsAtCode: null, stations: [ls("LRTJBDB-DKA", "C01")] }] },
};

const fs = (id: string) => ({ id, name: STATIONS.find((s) => s.id === id)?.name ?? id, latitude: -6.2, longitude: 106.8 });
const FARE_THB_DKA = {
  from: fs("KCI-THB"),
  to: fs("MRTJ-DKA"),
  legs: [
    {
      type: "RIDE", line: "KCI:C", operator: "KCI", from: fs("KCI-THB"), to: fs("KCI-SUD"), stationCount: 3,
      stops: ["KCI-THB", "KCI-KAT", "KCI-SUDB", "KCI-SUD"].map(fs), headsign: "Cikarang", distanceM: 4200, serviceLines: [{ line: "KCI:C", headsign: "Cikarang" }],
      departureAt: "2026-10-14T08:00:00+07:00", arrivalAt: "2026-10-14T08:09:00+07:00", lastService: false, stopTimes: [], tripId: "t1", platformCode: "5",
    },
    { type: "TRANSFER", from: fs("KCI-SUD"), to: fs("MRTJ-DKA"), distanceM: 300, fare: 0, corridorLabel: "Terowongan Kendal" },
  ],
  segments: [{ operator: "KCI", from: fs("KCI-THB"), to: fs("KCI-SUD"), fare: 3000 }],
  totalFare: 3000,
  totalDistanceM: 4500,
  transferCount: 1,
};

function fakeApi(extraFares: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const ok = (data: unknown) => new Response(JSON.stringify({ status: 200, data }), { status: 200, headers: { "content-type": "application/json" } });
  const err = (status: number, code: string) => new Response(JSON.stringify({ status, error: { code, message: code } }), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const p = url.pathname.replace(/^\//, "");
    calls.push(p);
    if (p === "stations") return ok(STATIONS);
    if (p === "hubs") return ok(HUBS);
    if (p === "operators") return ok(OPERATORS);
    let m = /^stations\/([^/]+)\/([^/]+)$/.exec(p);
    if (m) {
      const s = STATIONS.find((x) => x.operator === m![1] && x.code === m![2]);
      return s ? ok(s) : err(404, "UNKNOWN_STATION");
    }
    m = /^lines\/([^/]+)\/([^/]+)$/.exec(p);
    if (m) return LINES[`${m[1]}/${m[2]}`] ? ok({ operator: {}, line: {}, ...LINES[`${m[1]}/${m[2]}`] }) : err(404, "NO_TOPOLOGY");
    if (p === "fares/KCI-THB/MRTJ-DKA") return ok(FARE_THB_DKA);
    if (extraFares[p]) return ok(extraFares[p]);
    if (p === "fares/MRTJ-BNH/KCI-MRI") return err(500, "DATABASE_ERROR");
    if (p.startsWith("fares/")) return err(404, "UNKNOWN_STATION");
    return new Response("404 Not Found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function setup(extraFares: Record<string, unknown> = {}, operators?: string[]) {
  const api = fakeApi(extraFares);
  const source = new HttpCommuteSource({ baseUrl: "https://api.test", timeoutMs: 1000, fetchImpl: api.fetchImpl, operators });
  const t = await makeTestApp({ source });
  return { ...t, api };
}

describe("HttpCommuteSource (bentuk Commute Data API asli)", () => {
  it("konversi id stasiun", () => {
    expect(stopParam({ operator: "KCI", code: "SUD" })).toBe("KCI-SUD");
    expect(refOfId("LRTJBDB-DKA")).toEqual({ operator: "LRTJBDB", code: "DKA" });
  });

  it("stasiun dicocokkan ke slug GUI lewat nama; operator di luar COMMUTE_OPERATORS dan wilayah lain tidak disertakan", async () => {
    const { app } = await setup({}, ["KCI", "MRTJ", "LRTJ", "LRTJBDB", "APCGK"]);
    const ids = (await request(app).get("/api/stations")).body.data.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["tanah-abang", "bni-city", "sudirman", "manggarai", "dukuh-atas-mrt", "bendungan-hilir", "dukuh-atas-lrt", "kci:kat"]));
    expect(ids).not.toContain("tj:b01");
    expect(ids).not.toContain("kci:bd");
  });

  it("fasilitas: lift/eskalator/toilet dari dataset, ramp tetap 'data tidak tersedia'", async () => {
    const { app } = await setup();
    const thb = (await request(app).get("/api/stations/tanah-abang")).body.data;
    expect(thb.amenities).toEqual({ lift: "available", eskalator: "available", toilet: "available", ramp: "unknown" });
    expect(thb.dataAvailable).toBe(true);
    expect(thb.amenityDetails.find((d: { type: string }) => d.type === "lift").note).toBeUndefined();

    // Toilet biasa bukan toilet aksesibel.
    const sud = (await request(app).get("/api/stations/sudirman")).body.data;
    expect(sud.amenities).toEqual({ lift: "absent", eskalator: "available", toilet: "absent", ramp: "unknown" });

    // amenities [] = data belum ada.
    const bnh = (await request(app).get("/api/stations/bendungan-hilir")).body.data;
    expect(bnh.dataAvailable).toBe(false);
    expect(bnh.amenities.lift).toBe("unknown");
  });

  it("lini dari /operators + /lines, hub memakai slug", async () => {
    const { app, api } = await setup({}, ["KCI", "MRTJ", "LRTJ", "LRTJBDB", "APCGK"]);
    const net = (await request(app).get("/api/network")).body.data;
    const ckr = net.lines.find((l: { id: string }) => l.id === "krl-cikarang");
    expect(ckr).toMatchObject({ name: "Lin Cikarang", color: "#25B8EB", operator: "Commuter Line", stationIds: ["tanah-abang", "kci:kat", "bni-city", "sudirman", "manggarai"] });
    expect(net.lines.find((l: { id: string }) => l.id === "lrt-jbd")).toMatchObject({ stationIds: ["dukuh-atas-lrt"] });
    expect(net.lines.some((l: { operator: string }) => l.operator === "TransJakarta")).toBe(false);
    expect(net.hubs).toEqual([expect.objectContaining({ id: "dukuh-atas", memberIds: ["sudirman", "bni-city", "dukuh-atas-mrt", "dukuh-atas-lrt"] })]);
    expect(net.stations.find((s: { id: string }) => s.id === "sudirman")).toMatchObject({ hubId: "dukuh-atas", lineIds: ["krl-cikarang"] });
    // Amenity dibaca dari daftar stasiun, tanpa panggilan per stasiun.
    expect(api.calls.filter((c) => /^stations\/.+/.test(c))).toEqual([]);
  });

  it("rencana perjalanan memakai /fares/{OP-KODE}/{OP-KODE}", async () => {
    const { app, api } = await setup();
    const res = await request(app).post("/api/plan").send({ originId: "tanah-abang", destinationId: "dukuh-atas-mrt" });
    expect(res.status).toBe(200);
    expect(api.calls).toContain("fares/KCI-THB/MRTJ-DKA");
    const r = res.body.data.route;
    expect(r).toMatchObject({ totalFare: 3000, totalDistanceM: 4500, transfers: 1 });
    expect(r.legs[0]).toMatchObject({ type: "RIDE", lineId: "krl-cikarang", stops: ["tanah-abang", "kci:kat", "bni-city", "sudirman"], minutes: 9, fare: 3000 });
    expect(r.legs[1]).toMatchObject({ type: "TRANSFER", stops: ["sudirman", "dukuh-atas-mrt"], distanceM: 300 });
  });

  it("rute tidak ditemukan dan API bermasalah", async () => {
    const { app } = await setup();
    expect((await request(app).post("/api/plan").send({ originId: "tanah-abang", destinationId: "dukuh-atas-lrt" })).status).toBe(404);
    const down = await request(app).post("/api/plan").send({ originId: "bendungan-hilir", destinationId: "manggarai" });
    expect(down.status).toBe(503);
  });

  it("halaman admin melaporkan slug peta yang belum cocok", async () => {
    const { app, login } = await setup();
    const token = await login();
    const sys = (await request(app).get("/api/admin/system").set({ authorization: `Bearer ${token}` })).body.data;
    expect(sys.commute.source).toBe("http");
    expect(sys.commute.mapping.unmatched).toEqual(expect.arrayContaining(["jayakarta", "duri", "kuningan"]));
    expect(sys.commute.mapping.unmatched).not.toContain("bni-city");
  });
});

describe("Beralih dari fixture ke API sungguhan", () => {
  it("cache data fixture tidak terbaca oleh sumber http (store yang sama)", async () => {
    const fx = await makeTestApp();
    expect((await request(fx.app).post("/api/plan").send({ originId: "tanah-abang", destinationId: "dukuh-atas-mrt" })).status).toBe(200);
    const api = fakeApi();
    const source = new HttpCommuteSource({ baseUrl: "https://api.test", timeoutMs: 1000, fetchImpl: api.fetchImpl });
    const { app } = await makeTestApp({ store: fx.store, source });
    const res = await request(app).post("/api/plan").send({ originId: "tanah-abang", destinationId: "dukuh-atas-mrt" });
    expect(res.status).toBe(200);
    expect(api.calls).toContain("fares/KCI-THB/MRTJ-DKA");
  });
});

// Respons asli /fares/KCI-JAKK/MRTJ-DKA (dikirim camat, 14 Okt 2026): lewat TransJakarta Koridor 1.
const FARE_JAKK_DKA = {"from":{"id":"KCI-JAKK","name":"Jakarta Kota"},"to":{"id":"MRTJ-DKA","name":"Dukuh Atas BNI"},"legs":[{"type":"TRANSFER","from":{"id":"KCI-JAKK","name":"Jakarta Kota"},"to":{"id":"TJ-H00275P","name":"Kota"},"distanceM":50},{"type":"RIDE","line":"TJ:1","operator":"TJ","from":{"id":"TJ-H00275P","name":"Kota"},"to":{"id":"TJ-H00022P","name":"Bundaran HI Astra"},"stationCount":10,"stops":[{"id":"TJ-H00275P","name":"Kota"},{"id":"TJ-H00068P","name":"Glodok"},{"id":"TJ-H00133P","name":"Taman Sari"},{"id":"TJ-H00281P","name":"Mangga Besar"},{"id":"TJ-H00280P","name":"Sawah Besar"},{"id":"TJ-H00278P","name":"Harmoni"},{"id":"TJ-H00170P","name":"Petojo"},{"id":"TJ-H00268S","name":"Kebon Sirih Arah Selatan"},{"id":"TJ-H00207P","name":"MH Thamrin"},{"id":"TJ-H00022P","name":"Bundaran HI Astra"}],"headsign":"Blok M","distanceM":9224},{"type":"TRANSFER","from":{"id":"TJ-H00022P","name":"Bundaran HI Astra"},"to":{"id":"MRTJ-BHI","name":"Bundaran HI Bank Jakarta"},"distanceM":180},{"type":"RIDE","line":"MRTJ:M","operator":"MRTJ","from":{"id":"MRTJ-BHI","name":"Bundaran HI Bank Jakarta"},"to":{"id":"MRTJ-DKA","name":"Dukuh Atas BNI"},"stationCount":2,"stops":[{"id":"MRTJ-BHI","name":"Bundaran HI Bank Jakarta"},{"id":"MRTJ-DKA","name":"Dukuh Atas BNI"}],"headsign":"Lebak Bulus Bank Syariah Indonesia","distanceM":994}],"segments":[{"operator":"TJ","from":{"id":"TJ-H00275P","name":"Kota"},"to":{"id":"TJ-H00022P","name":"Bundaran HI Astra"},"fare":3500},{"operator":"MRTJ","from":{"id":"MRTJ-BHI","name":"Bundaran HI Bank Jakarta"},"to":{"id":"MRTJ-DKA","name":"Dukuh Atas BNI"},"fare":3000}],"totalFare":6500,"totalDistanceM":10448,"transferCount":2};

describe("Rute lintas operator dari API asli", () => {
  const plan = (app: Parameters<typeof request>[0]) => request(app).post("/api/plan").send({ originId: "jakarta-kota", destinationId: "dukuh-atas-mrt" });

  it("rute lewat TransJakarta: halte ikut dikenali dengan namanya", async () => {
    const { app } = await setup({ "fares/KCI-JAKK/MRTJ-DKA": FARE_JAKK_DKA });
    const res = await plan(app);
    expect(res.status).toBe(200);
    const r = res.body.data.route;
    expect(r).toMatchObject({ totalFare: 6500, transfers: 2 });
    expect(r.legs.map((l: { type: string; lineId?: string }) => l.lineId ?? l.type)).toEqual(["TRANSFER", "tj:1", "TRANSFER", "mrt-ns"]);
    expect(r.legs[1]).toMatchObject({ stops: expect.arrayContaining(["tj:h00275p", "tj:h00022p"]), fare: 3500 });
    expect(r.legs[3]).toMatchObject({ stops: ["bundaran-hi", "dukuh-atas-mrt"], fare: 3000 });
    expect(r.stopNames["tj:h00068p"]).toBe("Glodok");
    expect(res.body.data.assessments.map((a: { stationId: string }) => a.stationId)).toContain("tj:h00022p");
  });

  it("tetap berhasil walau TransJakarta dikeluarkan lewat COMMUTE_OPERATORS", async () => {
    const { app } = await setup({ "fares/KCI-JAKK/MRTJ-DKA": FARE_JAKK_DKA }, ["KCI", "MRTJ"]);
    const res = await plan(app);
    expect(res.status).toBe(200);
    expect(res.body.data.route.stopNames["tj:h00275p"]).toBe("Kota");
    expect(res.body.data.notification.text).toContain("Kota");
  });
});

describe("Filter moda", () => {
  const ride = (line: string, op: string, ids: string[], distanceM: number) => ({
    type: "RIDE", line, operator: op, from: fs(ids[0]), to: fs(ids[ids.length - 1]), stationCount: ids.length - 1, stops: ids.map(fs), headsign: null, distanceM, serviceLines: [],
  });
  const fare = (from: string, to: string, legs: object[], total: number, dist: number) => ({
    from: fs(from), to: fs(to), legs, segments: [], totalFare: total, totalDistanceM: dist, transferCount: legs.filter((l) => (l as { type: string }).type === "TRANSFER").length,
  });
  const FARES = {
    "fares/KCI-JAKK/MRTJ-DKA": FARE_JAKK_DKA,
    "fares/KCI-JAKK/KCI-MRI": fare("KCI-JAKK", "KCI-MRI", [ride("KCI:B", "KCI", ["KCI-JAKK", "KCI-MRI"], 9900)], 5000, 9900),
    "fares/KCI-MRI/KCI-KAT": fare("KCI-MRI", "KCI-KAT", [ride("KCI:C", "KCI", ["KCI-MRI", "KCI-SUD", "KCI-SUDB", "KCI-KAT"], 5300)], 3000, 5300),
    // Rute dataset Jakarta Kota -> Karet lewat TransJakarta (seperti di API sungguhan).
    "fares/KCI-JAKK/KCI-KAT": fare(
      "KCI-JAKK",
      "KCI-KAT",
      [
        { type: "TRANSFER", from: fs("KCI-JAKK"), to: fs("TJ-H00275P"), distanceM: 200 },
        ride("TJ:1", "TJ", ["TJ-H00275P", "TJ-H00022P"], 6000),
        { type: "TRANSFER", from: fs("TJ-H00022P"), to: fs("KCI-KAT"), distanceM: 900 },
      ],
      3500,
      7100,
    ),
  };
  const plan = (app: Parameters<typeof request>[0], avoidModes: string[]) =>
    request(app).post("/api/plan").send({ originId: "jakarta-kota", destinationId: "dukuh-atas-mrt", avoidModes });

  it("menghindari bus: rute dicari di atas lini kereta, tarif tiap ruas dari dataset", async () => {
    const { app, api } = await setup(FARES);
    const res = await request(app).post("/api/plan").send({ originId: "jakarta-kota", destinationId: "kci:kat", avoidModes: ["BUS"] });
    expect(res.status).toBe(200);
    const r = res.body.data.route;
    expect(r.legs.map((l: { type: string; lineId?: string }) => l.lineId ?? l.type)).toEqual(["krl-bogor", "TRANSFER", "krl-cikarang"]);
    expect(r.legs[1].stops).toEqual(["manggarai", "manggarai"]);
    expect(r.legs[2].stops).toEqual(["manggarai", "sudirman", "bni-city", "kci:kat"]);
    expect(r.totalFare).toBe(8000);
    expect(api.calls).toEqual(expect.arrayContaining(["fares/KCI-JAKK/KCI-MRI", "fares/KCI-MRI/KCI-KAT"]));
    expect(res.body.data.warnings.join(" ")).not.toMatch(/tidak ditemukan|Tarif sebagian/);
  });

  it("ruas tanpa tarif di dataset disusun dari urutan stasiun lini, dengan peringatan", async () => {
    const rest: Record<string, unknown> = { ...FARES };
    delete rest["fares/KCI-MRI/KCI-KAT"];
    const { app } = await setup(rest);
    const res = await request(app).post("/api/plan").send({ originId: "jakarta-kota", destinationId: "kci:kat", avoidModes: ["BUS"] });
    const r = res.body.data.route;
    expect(r.legs.some((l: { mode?: string }) => l.mode === "BUS")).toBe(false);
    expect(r.legs.at(-1)).toMatchObject({ type: "RIDE", lineId: "krl-cikarang", mode: "RAIL", fare: 0, minutes: null });
    expect(res.body.data.warnings).toContain("Tarif sebagian ruas tidak tersedia di dataset, sehingga total tarif belum lengkap.");
  });

  it("menghindari bus ke stasiun hub: pindah berjalan kaki di hub", async () => {
    const { app } = await setup(FARES);
    const r = (await plan(app, ["BUS"])).body.data.route;
    expect(r.legs.some((l: { mode?: string }) => l.mode === "BUS")).toBe(false);
    expect(r.legs[0]).toMatchObject({ type: "RIDE", lineId: "krl-bogor", mode: "RAIL" });
    expect(r.legs.at(-1)).toMatchObject({ type: "TRANSFER" });
    expect(r.legs.at(-1).stops[1]).toBe("dukuh-atas-mrt");
  });

  it("tanpa filter, rute bus dari dataset tetap dipakai", async () => {
    const { app } = await setup(FARES);
    const r = (await plan(app, [])).body.data.route;
    expect(r.legs[1]).toMatchObject({ mode: "BUS", lineId: "tj:1" });
  });

  it("tidak ada rute yang lolos: rute dataset ditampilkan dengan peringatan", async () => {
    const { app } = await setup(FARES);
    const res = await plan(app, ["BUS", "RAIL"]);
    expect(res.status).toBe(200);
    expect(res.body.data.warnings).toContain("Rute tanpa bus TransJakarta, kereta (KRL) tidak ditemukan; ditampilkan rute yang tetap memakainya.");
  });

  it("moda tidak dikenal ditolak", async () => {
    const { app } = await setup(FARES);
    expect((await plan(app, ["KAPAL"])).status).toBe(400);
  });
});

describe("Nomor stasiun dari /lines untuk posisi di peta", () => {
  it("stasiun di luar tabel memakai stationNumber sebagai kode", async () => {
    const { app } = await setup({}, ["KCI", "MRTJ", "LRTJ", "LRTJBDB", "APCGK"]);
    const st = (await request(app).get("/api/network")).body.data.stations;
    expect(st.find((s: { id: string }) => s.id === "kci:kat").codes).toEqual(["C11"]);
    expect(st.find((s: { id: string }) => s.id === "sudirman").codes).toEqual(["C12"]);
  });
});
