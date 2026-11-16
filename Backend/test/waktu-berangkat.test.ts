// Pilihan waktu berangkat: "sekarang" atau waktu tertentu. Jadwal kereta, waktu tunggu bus, rute tercepat (tiba paling
// awal), dan pengumuman dihitung pada waktu itu.

import request from "supertest";
import { pickOptions, summarize } from "../src/ai/NavigationAgent";
import type { Route, RouteLeg, StationAssessment } from "../src/domain/models";
import { RoutePlannerService, scheduleRail, serviceStart, totals } from "../src/domain/RoutePlannerService";
import { inactiveMessage, inactiveStations } from "../src/domain/stationStatus";
import { makeTestApp } from "./helpers";

const ride = (stops: string[], extra: Partial<RouteLeg> = {}): RouteLeg => ({ type: "RIDE", mode: "RAIL", stops, distanceM: 1000, minutes: null, fare: 0, ...extra });
// 08:00 WIB = 01:00 UTC.
const at8 = new Date("2026-11-10T01:00:00Z");

describe("jadwal dari waktu berangkat", () => {
  it("kereta pertama setelah waktu berangkat pilihan", () => {
    const rail = new Map([[0, [{ trip: "1", depart: 470, arrive: 480 }, { trip: "2", depart: 485, arrive: 495 }, { trip: "3", depart: 600, arrive: 610 }]]]);
    expect(scheduleRail([ride(["a", "b"])], rail, at8)[0]).toMatchObject({ tripNumber: "2", departureAt: "2026-11-10T01:05:00.000Z", arrivalAt: "2026-11-10T01:15:00.000Z" });
    // Berangkat 09:30 WIB: kereta 10:00.
    expect(scheduleRail([ride(["a", "b"])], rail, new Date("2026-11-10T02:30:00Z"))[0]).toMatchObject({ tripNumber: "3", departureAt: "2026-11-10T03:00:00.000Z" });
  });

  it("kereta terakhir sudah lewat: kereta pertama keesokan harinya", () => {
    const today = new Map([[0, [{ trip: "9", depart: 1380, arrive: 1390 }]]]);
    const tomorrow = new Map([[0, [{ trip: "1", depart: 300, arrive: 312 }]]]);
    // 23:30 WIB.
    const late = new Date("2026-11-10T16:30:00Z");
    const out = scheduleRail([ride(["a", "b"])], today, late, tomorrow)[0];
    expect(out).toMatchObject({ tripNumber: "1", nextDayService: true, departureAt: "2026-11-10T22:00:00.000Z", arrivalAt: "2026-11-10T22:12:00.000Z" });
  });

  it("bus: berangkat setelah rata-rata waktu tunggu (separuh frekuensi), di dalam jam layanan", () => {
    const bus = (serviceHours?: string): RouteLeg => ride(["x", "y"], { mode: "BUS", minutes: 20, minutesEstimated: true, frequency: { headwayMinutes: 10, source: "STOP", ...(serviceHours ? { serviceHours } : {}) } });
    expect(scheduleRail([bus("05:00–22:00")], new Map(), at8)[0]).toMatchObject({ departureAt: "2026-11-10T01:05:00.000Z", arrivalAt: "2026-11-10T01:25:00.000Z", scheduleEstimated: true, waitMinutes: 5 });
    // 03:00 WIB, sebelum jam layanan: berangkat 05:05.
    expect(scheduleRail([bus("05:00–22:00")], new Map(), new Date("2026-11-09T20:00:00Z"))[0]).toMatchObject({ departureAt: "2026-11-09T22:05:00.000Z", waitMinutes: 125 });
    // Kereta lalu bus: bus menunggu setelah kereta tiba.
    const rail = new Map([[0, [{ trip: "1", depart: 480, arrive: 490 }]]]);
    const legs = [ride(["a", "b"]), { type: "TRANSFER" as const, stops: ["b", "x"], distanceM: 100, minutes: 4, fare: 0 }, bus()];
    const out = scheduleRail(legs, rail, at8);
    // Tiba 08:10, jalan 4 mnt, tunggu 5 mnt: bus 08:19, tiba 08:39.
    expect(out[2]).toMatchObject({ departureAt: "2026-11-10T01:19:00.000Z", arrivalAt: "2026-11-10T01:39:00.000Z" });
    expect(totals(out)).toMatchObject({ totalMinutes: 34 });
  });

  it("jam layanan, termasuk yang melewati tengah malam dan 24 jam", () => {
    expect(serviceStart(480, "05:00–22:00")).toBe(480);
    expect(serviceStart(1350, "05:00–22:00")).toBe(1440 + 300);
    expect(serviceStart(60, "05:00–01:30")).toBe(60);
    expect(serviceStart(150, "05:00–01:30")).toBe(300);
    expect(serviceStart(150, "24 jam")).toBe(150);
  });
});

describe("rute tercepat = tiba paling awal sejak waktu berangkat", () => {
  const base: StationAssessment = { stationId: "a", score: 80, adequate: true, dataAvailable: true };
  const opt = (minutes: number, departureAt: string, arrivalAt: string) => {
    const r: Route = { ...totals([{ type: "RIDE", lineId: "l", stops: ["a", "b"], distanceM: 1000, minutes, fare: 0, departureAt, arrivalAt }]), transfers: 0 };
    return { route: r, summary: summarize(r, [base, { ...base, stationId: "b" }], []) };
  };

  it("perjalanan lebih singkat yang berangkat jauh lebih lambat tidak menjadi tercepat", () => {
    // A: 30 mnt, berangkat 08:05 tiba 08:35. B: 20 mnt, tetapi kereta pertamanya 08:40 tiba 09:00.
    const list = [opt(30, "2026-11-10T01:05:00Z", "2026-11-10T01:35:00Z"), opt(20, "2026-11-10T01:40:00Z", "2026-11-10T02:00:00Z")];
    const fastest = (when?: Date) => list.indexOf(pickOptions(list, when).find((p) => p.kinds.includes("tercepat"))!.e);
    expect(fastest(at8)).toBe(0);
    // Tanpa waktu berangkat: waktu tempuh saja.
    expect(fastest()).toBe(1);
  });
});

describe("API: waktu berangkat", () => {
  it("sekarang dan waktu tertentu dicatat di rencana", async () => {
    const { app } = await makeTestApp();
    const now = (await request(app).post("/api/plan").send({ originId: "tanah-abang", destinationId: "dukuh-atas-mrt" })).body.data;
    expect(now.departMode).toBe("now");
    expect(Date.parse(now.departAt)).not.toBeNaN();
    const when = new Date(Date.now() + 2 * 86_400_000);
    when.setUTCHours(1, 0, 0, 0);
    const at = (await request(app).post("/api/plan").send({ originId: "tanah-abang", destinationId: "dukuh-atas-mrt", at: when.toISOString() })).body.data;
    expect(at).toMatchObject({ departMode: "at", departAt: when.toISOString() });
  });

  it("waktu berangkat yang tidak masuk akal ditolak", async () => {
    const { app } = await makeTestApp();
    const send = (at: string) => request(app).post("/api/plan").send({ originId: "tanah-abang", destinationId: "dukuh-atas-mrt", at });
    expect((await send("besok pagi")).body.code).toBe("INVALID");
    expect((await send(new Date(Date.now() - 3 * 86_400_000).toISOString())).body.code).toBe("INVALID");
    expect((await send(new Date(Date.now() + 120 * 86_400_000).toISOString())).body.code).toBe("INVALID");
  });
});

describe("jadwal ruas antara dua stasiun akhir", () => {
  // MRT Lebak Bulus → Bundaran HI: kereta yang berakhir di Bundaran HI tidak tercantum di jadwal Bundaran HI, dan
  // kereta arah Lebak Bulus tidak tercantum di jadwal Lebak Bulus. Jam tiba = jam di Dukuh Atas + waktu tempuh
  // Dukuh Atas–Bundaran HI dari arah sebaliknya.
  const tt = {
    lbb: [{ tripNumber: "N1", minutes: 545, boundFor: "Bundaran HI Bank Jakarta" }],
    dka: [
      { tripNumber: "N1", minutes: 570, boundFor: "Bundaran HI Bank Jakarta" },
      { tripNumber: "S1", minutes: 543, boundFor: "Lebak Bulus Bank Syariah Indonesia" },
    ],
    bhi: [{ tripNumber: "S1", minutes: 540, boundFor: "Lebak Bulus Bank Syariah Indonesia" }],
  } as const;
  const commute = {
    getTimetables: async (id: keyof typeof tt) => [{ operator: "MRTJ", code: id.toUpperCase(), departures: [...tt[id]] }],
    getStations: async () => [
      { id: "lbb", name: "Lebak Bulus Bank Syariah Indonesia" },
      { id: "dka", name: "Dukuh Atas BNI" },
      { id: "bhi", name: "Bundaran HI Bank Jakarta" },
    ],
  };
  const planner = new RoutePlannerService(commute as unknown as ConstructorParameters<typeof RoutePlannerService>[0]);
  const ctx = { preview: false, now: at8 };

  it("tanpa pemberhentian sebelum tujuan: jadwal tidak bisa dicocokkan", async () => {
    expect(await planner.tripsBetween("lbb", "bhi", "WD", ctx)).toEqual([]);
  });

  it("dengan pemberhentian sebelum tujuan: jam berangkat dari jadwal, jam tiba lewat stasiun itu", async () => {
    expect(await planner.tripsBetween("lbb", "bhi", "WD", ctx, undefined, "dka")).toEqual([{ trip: "N1", depart: 545, arrive: 573 }]);
  });
});

describe("kereta yang berakhir di stasiun turun atau di tengah ruas", () => {
  // Lin Cikarang lewat Pasar Senen: kereta tujuan Kampung Bandan berakhir di sana (tidak tercantum di jadwal Kampung
  // Bandan), kereta tujuan Jakarta Kota melewatinya. Dari Kampung Bandan, kereta lain ke Duri.
  const tt: Record<string, { tripNumber: string; minutes: number; boundFor: string; arriveFinal?: number }[]> = {
    gst: [
      { tripNumber: "K1", minutes: 416, boundFor: "Kampung Bandan", arriveFinal: 434 },
      { tripNumber: "J1", minutes: 420, boundFor: "Jakarta Kota", arriveFinal: 445 },
    ],
    kpb: [
      { tripNumber: "J1", minutes: 438, boundFor: "Jakarta Kota" },
      { tripNumber: "M1", minutes: 436, boundFor: "Manggarai" },
    ],
    dri: [{ tripNumber: "M1", minutes: 446, boundFor: "Manggarai" }],
  };
  const names: Record<string, string> = { gst: "Gang Sentiong", kpb: "Kampung Bandan", dri: "Duri" };
  const commute = {
    getTimetables: async (id: string) => [{ operator: "KCI", code: id.toUpperCase(), departures: [...(tt[id] ?? [])] }],
    getStations: async () => Object.entries(names).map(([id, name]) => ({ id, name })),
  };
  const planner = new RoutePlannerService(commute as unknown as ConstructorParameters<typeof RoutePlannerService>[0]);
  const ctx = { preview: false, now: at8 };

  it("kereta yang berakhir di stasiun turun tetap dihitung walau kereta lain cocok", async () => {
    expect(await planner.tripsBetween("gst", "kpb", "WD", ctx)).toEqual([
      { trip: "K1", depart: 416, arrive: 434 },
      { trip: "J1", depart: 420, arrive: 438 },
    ]);
  });

  it("tanpa kereta langsung sepanjang ruas: ganti kereta di stasiun tempat kereta pertama berakhir", async () => {
    expect(await planner.tripsAlong(["gst", "kpb", "dri"], "WD", ctx)).toEqual([{ trip: "K1/M1", depart: 416, arrive: 446, changeAt: "kpb", changeDepart: 436 }]);
    const out = scheduleRail([ride(["gst", "kpb", "dri"])], new Map([[0, await planner.tripsAlong(["gst", "kpb", "dri"], "WD", ctx)]]), new Date("2026-11-09T23:50:00Z"));
    expect(out[0]).toMatchObject({ changeAt: "kpb", changeDepartureAt: "2026-11-10T00:16:00.000Z", arrivalAt: "2026-11-10T00:26:00.000Z" });
  });
});

describe("stasiun nonaktif", () => {
  it("daftar bawaan dan isian admin (nonaktif ditambah, aktif kembali menghapus)", () => {
    expect([...inactiveStations([]).keys()]).toEqual(["kci:kat"]);
    const m = inactiveStations([
      { stationId: "kci:kat", inactive: false },
      { stationId: "manggarai", inactive: true, note: "Renovasi total" },
    ]);
    expect([...m.entries()]).toEqual([["manggarai", { source: "admin", note: "Renovasi total" }]]);
    expect(inactiveMessage("Manggarai", m.get("manggarai")!)).toBe("Stasiun Manggarai sudah tidak beroperasi. Renovasi total. Pilih stasiun lain.");
  });

  it("stasiun nonaktif ditandai di daftar stasiun dan ditolak di pencarian rute dengan pesan yang jelas", async () => {
    const { app, login } = await makeTestApp();
    const token = await login();
    const auth = { authorization: `Bearer ${token}` };
    const created = await request(app).post("/api/admin/content").set(auth).send({ kind: "station_status", stationId: "sudirman", data: { inactive: true, note: "Layanan dipindahkan ke BNI City" } });
    expect(created.status).toBe(201);
    // Satu status per stasiun.
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "station_status", stationId: "sudirman", data: { inactive: false } })).status).toBe(409);
    // Belum terbit: pengguna belum terpengaruh.
    expect((await request(app).post("/api/plan").send({ originId: "sudirman", destinationId: "manggarai" })).status).toBe(200);
    expect((await request(app).post("/api/admin/publish").set(auth).send({})).status).toBe(200);
    const st = (await request(app).get("/api/stations")).body.data.find((s: { id: string }) => s.id === "sudirman");
    expect(st).toMatchObject({ inactive: true, inactiveNote: "Layanan dipindahkan ke BNI City" });
    const res = await request(app).post("/api/plan").send({ originId: "manggarai", destinationId: "sudirman" });
    expect(res.body).toMatchObject({ status: "error", code: "INVALID", message: "Stasiun Sudirman sudah tidak beroperasi. Layanan dipindahkan ke BNI City. Pilih stasiun lain." });
  });
});
