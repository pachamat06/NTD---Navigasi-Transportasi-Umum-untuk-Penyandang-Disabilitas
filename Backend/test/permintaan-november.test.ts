// Permintaan November 2026: waktu tempuh dan frekuensi rel dari jadwal Commute, fasilitas peron hanya mobilitas
// (toilet dll. informasi umum stasiun), peron mengisi fasilitas stasiun, peron kosong dihitung dari stasiun,
// pilihan pintu masuk/keluar dengan rekomendasi, notifikasi lift disembunyikan bila peron tanpa JPO/terowongan,
// dan pilihan rute paling aksesibel/moderat/tercepat.

import { GroundingGuard } from "../src/ai/GroundingGuard";
import { pickOptions, summarize } from "../src/ai/NavigationAgent";
import { ContentSnapshot } from "../src/domain/content";
import { applyPlatformExits, fromPlatforms, gateChoice, journeyAssessment } from "../src/domain/FacilityAnalysisService";
import type { Entrance, Platform, Route, RouteLeg, StationAssessment, StationDetail } from "../src/domain/models";
import { headwayAround, matchTrips, terminusTrips } from "../src/domain/railTimetable";
import { scheduleRail, totals } from "../src/domain/RoutePlannerService";
import type { ContentItem } from "../src/store/types";

const item = (kind: ContentItem["kind"], stationId: string | null, data: unknown, id = Math.random().toString(36).slice(2)): ContentItem => ({
  id,
  kind,
  stationId,
  draft: null,
  published: data,
  draftDeleted: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  publishedAt: new Date(),
  updatedBy: null,
});
const snapOf = (items: ContentItem[] = []) => new ContentSnapshot(items, false, new Date("2026-11-10T01:00:00Z"));

describe("jadwal rel dari Commute", () => {
  const A = [
    { tripNumber: "1", minutes: 480 },
    { tripNumber: "2", minutes: 490 },
    { tripNumber: "3", minutes: 500 },
    { tripNumber: "9", minutes: 485 }, // arah sebaliknya: sudah lewat B lebih dulu
  ];
  const B = [
    { tripNumber: "1", minutes: 492 },
    { tripNumber: "2", minutes: 503 },
    { tripNumber: "3", minutes: 512 },
    { tripNumber: "9", minutes: 470 },
  ];

  it("waktu tempuh = selisih jam berangkat pada nomor perjalanan yang sama; arah sebaliknya tersaring", () => {
    expect(matchTrips(A, B)).toEqual([
      { trip: "1", depart: 480, arrive: 492 },
      { trip: "2", depart: 490, arrive: 503 },
      { trip: "3", depart: 500, arrive: 512 },
    ]);
  });

  it("frekuensi = rata-rata selisih keberangkatan berurutan", () => {
    expect(headwayAround(matchTrips(A, B), 470)).toBe(10);
  });

  it("stasiun akhir perjalanan: dipakai tujuan akhir dan waktu tempuh arah sebaliknya", () => {
    const from = [
      { tripNumber: "M1", minutes: 600, boundFor: "Bundaran HI Bank Jakarta" },
      { tripNumber: "M2", minutes: 610, boundFor: "Lebak Bulus" },
    ];
    const reverse = [{ trip: "M0", depart: 590, arrive: 593 }];
    expect(terminusTrips(from, reverse, (b) => b === "Bundaran HI Bank Jakarta")).toEqual([{ trip: "M1", depart: 600, arrive: 603 }]);
  });

  it("jam berangkat dan tiba berurutan: kereta berikutnya setelah tiba dari ruas sebelumnya", () => {
    const ride = (stops: string[]): RouteLeg => ({ type: "RIDE", mode: "RAIL", stops, distanceM: 1000, minutes: null, fare: 0 });
    const legs: RouteLeg[] = [ride(["a", "b"]), { type: "TRANSFER", stops: ["b", "b"], distanceM: 0, minutes: null, fare: 0 }, ride(["b", "c"])];
    const rail = new Map([
      [0, [{ trip: "1", depart: 480, arrive: 492 }]],
      [2, [{ trip: "7", depart: 494, arrive: 500 }, { trip: "8", depart: 499, arrive: 505 }]],
    ]);
    // 08:00 WIB = 01:00 UTC.
    const out = scheduleRail(legs, rail, new Date("2026-11-10T01:00:00Z"));
    expect(out[0]).toMatchObject({ minutes: 12, tripNumber: "1", fromTimetable: true, departureAt: "2026-11-10T01:00:00.000Z" });
    // Jeda pindah minimal 3 menit: kereta 494 terlewat, naik kereta 499.
    expect(out[2]).toMatchObject({ minutes: 6, tripNumber: "8" });
    expect(out[1]).toMatchObject({ minutes: 7, includesWait: true });
    expect(totals(out)).toMatchObject({ totalMinutes: 25, timeComplete: true });
  });
});

describe("fasilitas peron dan fasilitas umum stasiun", () => {
  const platform = (code: string, amenities: Platform["amenities"], extra: Partial<Platform> = {}): Platform => ({ code, serves: [], amenities, source: "ntd", ...extra });

  it("peron punya lift berarti stasiun punya lift", () => {
    const d = fromPlatforms([platform("1", { lift: "available" }), platform("2", { lift: "absent" })]);
    expect(d).toEqual([expect.objectContaining({ type: "lift", status: "available", note: "Dari data peron 1." })]);
  });

  it("lift yang dicatat jumlahnya di peron juga dihitung", () => {
    expect(fromPlatforms([platform("1", {}, { lift: { count: 2 } })])).toEqual([expect.objectContaining({ type: "lift", status: "available" })]);
  });

  it("toilet yang dulu diisi per peron menjadi fasilitas umum stasiun dan dihapus dari peron", () => {
    const snap = snapOf([item("platform", "manggarai", { code: "1", amenities: { toilet: "available", lift: "available" } })]);
    expect(snap.platformsOf("manggarai")[0].amenities).toEqual({ lift: "available" });
    expect(fromPlatforms(snap.platformsOf("manggarai"), snap.legacyPlatformToilet("manggarai"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "toilet", status: "available" }), expect.objectContaining({ type: "lift", status: "available" })]),
    );
  });

  it("akses peron ke pintu keluar menjadi jalur gate → peron", () => {
    const gates: Entrance[] = [{ id: "KCI-MRI:A", stationId: "manggarai", name: "Pintu A", accessible: false, features: [], source: "dataset" }];
    const out = applyPlatformExits(gates, [platform("1", {}, { exitAccess: [{ gate: "A", via: "langsung" }, { gate: "Gate Selatan", via: "jpo" }] })]);
    expect(out[0].platformLinks).toEqual([{ platform: "1", via: "langsung" }]);
    expect(out[1]).toMatchObject({ name: "Gate Selatan", accessible: true, platformLinks: [{ platform: "1", via: "jpo" }] });
  });
});

const detail = (over: Partial<StationDetail>): StationDetail => ({
  id: "x",
  name: "Stasiun X",
  operator: "KCI",
  lineIds: [],
  codes: [],
  amenities: { lift: "absent", eskalator: "available", toilet: "available", ramp: "unknown" },
  amenityDetails: [],
  dataAvailable: true,
  assessment: { stationId: "x", score: 60, adequate: false, dataAvailable: true },
  platforms: [{ code: "1", serves: [], amenities: {}, source: "dataset" }],
  entrances: [],
  info: [],
  notices: [],
  ...over,
});
const base: StationAssessment = { stationId: "x", score: 60, adequate: false, dataAvailable: true };

describe("peron tanpa detail dihitung dari fasilitas umum stasiun", () => {
  it("lift peron belum diisi: status lift stasiun dipakai dan dicatat", () => {
    const d = detail({ entrances: [{ id: "g1", stationId: "x", name: "Gate 1", accessible: true, features: [], platformLinks: [{ platform: "1", via: "jpo" }] }] });
    const a = journeyAssessment(base, d, ["1"], snapOf());
    expect(a.journey).toMatchObject({ level: false, lift: "absent", fromStation: expect.arrayContaining(["lift", "eskalator"]) });
    expect(a.notes?.some((n) => n.includes("dihitung dari fasilitas umum stasiun"))).toBe(true);
  });
});

describe("pilihan pintu masuk/keluar", () => {
  const gates: Entrance[] = [
    { id: "jpo", stationId: "x", name: "Gate Utara", accessible: true, features: [], platformLinks: [{ platform: "1", via: "jpo" }] },
    { id: "datar", stationId: "x", name: "Gate Selatan", accessible: true, features: [], platformLinks: [{ platform: "1", via: "langsung" }] },
  ];

  it("skor memakai jalur pintu pilihan, dan pintu yang lebih mudah disarankan", () => {
    const d = detail({ entrances: gates });
    const a = journeyAssessment(base, d, ["1"], snapOf(), { id: "jpo", role: "masuk" });
    expect(a.journey).toMatchObject({ via: "jpo", level: false, gate: "Gate Utara" });
    expect(a.gateChoice).toMatchObject({ chosen: "Gate Utara", known: true, recommended: "Gate Selatan", recommendedVia: "langsung" });
    expect(a.gateChoice?.reason).toContain("JPO");
    const auto = journeyAssessment(base, d, ["1"], snapOf());
    expect(auto.journey).toMatchObject({ level: true });
    expect(a.score).toBeLessThan(auto.score);
  });

  it("pintu terbaik yang dipilih tidak diberi saran", () => {
    expect(gateChoice({ entrances: gates }, ["1"], "datar", "keluar")?.choice).toEqual({ role: "keluar", chosenId: "datar", chosen: "Gate Selatan", known: true });
  });
});

describe("notifikasi lift saat peron tanpa JPO/terowongan", () => {
  it("template tidak menyebut lift tidak tercatat bila peron dicapai tanpa pindah lantai", () => {
    const d = detail({ entrances: [{ id: "g", stationId: "x", name: "Gate", accessible: true, features: [], platformLinks: [{ platform: "1", via: "langsung" }] }] });
    const a = journeyAssessment(base, d, ["1"], snapOf());
    const route: Route = totals([{ type: "RIDE", lineId: "l", stops: ["x", "y"], distanceM: 1000, minutes: 5, fare: 0 }]);
    const y = detail({ id: "y", name: "Stasiun Y" });
    const text = new GroundingGuard().fallback(
      { route, assessments: [a, { ...base, stationId: "y" }], alternatives: [], stations: new Map([["x", d], ["y", y]]), knownStationNames: new Map(), notices: [] },
      () => undefined,
    ).text;
    expect(text).not.toContain("Lift tidak tercatat di Stasiun X");
    expect(text).toContain("Lift tidak tercatat di Stasiun Y");
  });
});

describe("pilihan rute", () => {
  const route = (minutes: number, transfers = 0): Route => ({ ...totals([{ type: "RIDE", lineId: "l", stops: ["a", "b"], distanceM: 1000, minutes, fare: 0 }]), transfers });
  const opt = (score: number, minutes: number) => {
    const r = route(minutes);
    return { route: r, summary: summarize(r, [{ ...base, stationId: "a", score }, { ...base, stationId: "b", score }], []) };
  };

  it("paling aksesibel lebih dulu, lalu moderat dan tercepat", () => {
    const list = [opt(60, 30), opt(90, 50), opt(40, 20), opt(75, 35)];
    const picked = pickOptions(list);
    expect(picked.map((p) => [p.kinds, list.indexOf(p.e)])).toEqual([
      [["aksesibel"], 1],
      // Biaya seimbang: (90−75)/50 + (35−20)/20 = 1,05 lebih kecil dari (90−60)/50 + (30−20)/20 = 1,1.
      [["moderat"], 3],
      [["tercepat"], 2],
      [[], 0],
    ]);
  });

  it("rute yang sama untuk beberapa jenis digabung", () => {
    const list = [opt(90, 20), opt(40, 30)];
    expect(pickOptions(list)[0].kinds).toEqual(expect.arrayContaining(["aksesibel", "tercepat"]));
  });
});
