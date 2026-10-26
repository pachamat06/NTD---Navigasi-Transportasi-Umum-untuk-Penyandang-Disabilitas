// Fitur dari Commute Data API: jarak/petunjuk transfer, `at` pada /fares, frekuensi (headway) bila jadwal
// tidak ada, lin paralel (bus gabungan), cache single-flight + stale-while-revalidate, dan penanganan 429.

import { accessWarnings, crossingWarnings, gapWarnings, gatePlatforms, withPlatforms, withTransferAccess } from "../src/ai/NavigationAgent";
import { newContext } from "../src/context";
import { CommuteApiClient } from "../src/data/commute/CommuteApiClient";
import { FixtureCommuteSource } from "../src/data/commute/FixtureCommuteSource";
import { directionLabel, HttpCommuteSource, jakartaDayHour } from "../src/data/commute/HttpCommuteSource";
import type { CommuteSource, UpFare, UpHeadway, UpHubTransfer, UpLine, UpStation } from "../src/data/commute/types";
import type { Entrance, Platform, Route, Station, StationAssessment, StationDetail } from "../src/domain/models";
import type { ContentSnapshot } from "../src/domain/content";
import { journeyAssessment } from "../src/domain/FacilityAnalysisService";
import { mergeEntrances, mergePlatforms } from "../src/domain/StationService";
import { combinedFrequency, frequencyOf, parallelLines, RoutePlannerService } from "../src/domain/RoutePlannerService";
import { UpstreamError } from "../src/errors";
import { createMemoryStore } from "../src/store/memory";

// ---------- Sumber tiruan: koridor TransJakarta Matraman -> Kesatrian (4, 4D, 5, 5C) ----------

const TJ = (code: string, name: string, lines: string[]): UpStation => ({ operator: "TJ", code, name, lines, amenities: [] });
const MATRAMAN = "tj:h00128p";
const KESATRIAN = "tj:h00217p";

class FakeSource implements CommuteSource {
  readonly name = "fake";
  calls: string[] = [];
  fail: Error | null = null;
  serviceLines = true;
  stations = [TJ("H00128P", "Matraman", ["4", "4D", "5", "5C"]), TJ("H00217P", "Kesatrian", ["4", "4D", "5", "5C", "10"]), TJ("H00300P", "Pulo Gadung", ["4"])];
  lines: UpLine[] = [
    ...["4", "4D", "5", "5C"].map((code) => ({ operator: "TJ", code, name: `Koridor ${code}`, mode: "BUS" as const, stations: [{ operator: "TJ", code: "H00128P" }, { operator: "TJ", code: "H00217P" }, { operator: "TJ", code: "H00300P" }] })),
    { operator: "TJ", code: "10", name: "Koridor 10", mode: "BUS", stations: [{ operator: "TJ", code: "H00217P" }, { operator: "TJ", code: "H00300P" }] },
  ];
  headways: UpHeadway[] = [
    { operator: "TJ", line: "4", headwayS: 600, boundFor: "Pulo Gadung", source: "STOP", serviceHours: { start: "05:00", end: "22:00" } },
    { operator: "TJ", line: "4", headwayS: 900, boundFor: "Dukuh Atas", source: "STOP" },
    { operator: "TJ", line: "4D", headwayS: 900, source: "STOP" },
    { operator: "TJ", line: "5", headwayS: 600, source: "LINE" },
    { operator: "TJ", line: "5C", headwayS: 1200, source: "STOP" },
  ];
  async getStations() {
    this.calls.push("stations");
    if (this.fail) throw this.fail;
    return this.stations;
  }
  async getStation(operator: string, code: string) {
    return this.stations.find((s) => s.operator === operator && s.code === code) ?? null;
  }
  async getOperators() {
    return [{ code: "TJ", name: "TransJakarta", mode: "BUS" as const }];
  }
  async getLines() {
    return this.lines;
  }
  async getLine(operator: string, code: string) {
    return this.lines.find((l) => l.operator === operator && l.code === code) ?? null;
  }
  async getHubs() {
    return [];
  }
  async getHeadways(operator: string, code: string, at?: string) {
    this.calls.push(`headway:${operator}-${code}:${at}`);
    return code === "H00128P" ? this.headways : [];
  }
  async getFare(): Promise<UpFare> {
    const leg = {
      type: "RIDE" as const,
      operator: "TJ",
      line: "4",
      headsign: "Pulo Gadung",
      ...(this.serviceLines ? { serviceLines: ["4", "4D", "5", "5C"].map((line) => ({ operator: "TJ", line })) } : {}),
      stops: [{ operator: "TJ", code: "H00128P" }, { operator: "TJ", code: "H00217P" }],
      distanceM: 1200,
      fare: 3500,
    };
    return { from: leg.stops[0], to: leg.stops[1], totalFare: 3500, totalDistanceM: 1200, legs: [leg] };
  }
}

const setup = (source = new FakeSource()) => {
  const client = new CommuteApiClient(source, createMemoryStore().cache);
  return { source, client, planner: new RoutePlannerService(client) };
};

describe("Lin paralel dan frekuensi (bus gabungan)", () => {
  it("Matraman -> Kesatrian: pilihan 4, 4D, 5, 5C dengan frekuensi gabungan bila jadwal tidak ada", async () => {
    const { planner, source } = setup();
    const ctx = newContext();
    const at = "2026-10-26T08:15:00+07:00";
    const route = await planner.annotate((await planner.getRoute(MATRAMAN, KESATRIAN, ctx, at))!, ctx, at);
    const leg = route.legs[0];
    expect(leg.options!.map((o) => o.lineId)).toEqual(["tj:4", "tj:4d", "tj:5", "tj:5c"]);
    expect(leg.headsign).toBe("Pulo Gadung");
    // Arah 4 dipilih lewat tujuan akhir (10 mnt, bukan 15 mnt arah Dukuh Atas).
    expect(leg.options![0].frequency).toEqual({ headwayMinutes: 10, source: "STOP", serviceHours: "05:00–22:00" });
    // 1 / (1/10 + 1/15 + 1/10 + 1/20) = 3,2 menit.
    expect(leg.frequency).toEqual({ headwayMinutes: 3, source: "LINE" });
    expect(source.calls).toContain(`headway:TJ-H00128P:${at}`);
  });

  it("tanpa serviceLines dari API: lin paralel dicari dari urutan halte lin operator yang sama", async () => {
    const source = new FakeSource();
    source.serviceLines = false;
    const { planner } = setup(source);
    const ctx = newContext();
    const route = await planner.annotate((await planner.getRoute(MATRAMAN, KESATRIAN, ctx))!, ctx);
    // Koridor 10 tidak berhenti di Matraman, jadi tidak ikut.
    expect(route.legs[0].options!.map((o) => o.lineId)).toEqual(["tj:4", "tj:4d", "tj:5", "tj:5c"]);
  });

  it("helper frekuensi", () => {
    const rows = [
      { lineId: "a", headwayMinutes: 6, boundFor: "Utara", source: "STOP" as const },
      { lineId: "a", headwayMinutes: 12, boundFor: "Selatan", source: "STOP" as const },
    ];
    expect(frequencyOf(rows, "a", "Utara")?.headwayMinutes).toBe(6);
    // Arah tidak diketahui: pakai yang paling jarang.
    expect(frequencyOf(rows, "a")?.headwayMinutes).toBe(12);
    expect(frequencyOf(rows, "b")).toBeUndefined();
    expect(combinedFrequency([{ headwayMinutes: 10, source: "STOP" }, undefined])).toEqual({ headwayMinutes: 10, source: "STOP" });
    expect(parallelLines(["x", "y"], "p", [{ lineId: "q", sequences: [["y", "x"]] }, { lineId: "r", sequences: [["x", "z", "y"]] }], () => true)).toEqual(["p", "q"]);
  });
});

describe("Jarak jalan kaki transfer dari /transfers", () => {
  it("ruas pindah tanpa jarak dilengkapi dari dataset; pindah di stasiun yang sama tidak diubah", async () => {
    const client = new CommuteApiClient(new FixtureCommuteSource(), createMemoryStore().cache);
    const planner = new RoutePlannerService(client);
    const ctx = newContext();
    const route: Route = {
      legs: [
        { type: "TRANSFER", stops: ["bni-city", "dukuh-atas-lrt"], distanceM: 0, minutes: null, fare: 0 },
        { type: "TRANSFER", stops: ["manggarai", "manggarai"], distanceM: 0, minutes: null, fare: 0 },
      ],
      totalDistanceM: 0, totalMinutes: null, timeComplete: false, totalFare: 0, transfers: 2,
    };
    const out = await planner.annotate(route, ctx);
    expect(out.legs[0]).toMatchObject({ distanceM: 400, minutes: 6 });
    expect(out.legs[1]).toEqual(route.legs[1]);
    expect(out.totalDistanceM).toBe(400);
    expect(await client.getWalk("bni-city", "kuningan", ctx)).toBeUndefined();
  });
});

describe("Cache: single-flight, stale-while-revalidate, 429", () => {
  it("permintaan serentak ke kunci yang sama hanya memanggil sumber sekali", async () => {
    const { client, source } = setup();
    const ctx = newContext();
    await Promise.all([client.getStations(ctx), client.getStations(ctx), client.getLines(ctx)]);
    expect(source.calls.filter((c) => c === "stations")).toHaveLength(1);
  });

  it("cache kedaluwarsa disajikan langsung lalu diperbarui di latar belakang; galat API memakai salinan lama", async () => {
    const { client, source } = setup();
    await client.getStations(newContext());
    const later = newContext({ now: new Date(Date.now() + 2 * 24 * 3600_000) });
    source.fail = new UpstreamError("down", 503);
    const list = await client.getStations(later);
    expect(list.map((s) => s.id)).toContain(MATRAMAN);
    // Salinan lama (< 7 hari) dipakai tanpa menunggu API.
    expect(later.staleSince).toBeUndefined();
    const muchLater = newContext({ now: new Date(Date.now() + 30 * 24 * 3600_000) });
    expect((await client.getStations(muchLater)).length).toBe(3);
    expect(muchLater.staleSince).toBeDefined();
  });

  it("HTTP 429: menghormati Retry-After dan tidak mengirim permintaan lagi selama ditahan", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response(JSON.stringify({ status: 429, error: { code: "RATE_LIMITED", message: "x" } }), { status: 429, headers: { "retry-after": "30" } });
    }) as unknown as typeof fetch;
    const src = new HttpCommuteSource({ baseUrl: "https://api.test", timeoutMs: 1000, fetchImpl });
    await expect(src.getOperators()).rejects.toThrow("429");
    await expect(src.getOperators()).rejects.toThrow("membatasi");
    expect(n).toBe(1);
  });
});

describe("HttpCommuteSource: /fares?at, /transfers, /headway", () => {
  const ok = (data: unknown) => new Response(JSON.stringify({ status: 200, data }), { status: 200, headers: { "content-type": "application/json" } });

  it("meneruskan `at` ke /fares dan memetakan headsign serta serviceLines", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string | URL) => {
      urls.push(String(u));
      return ok({
        from: { id: "TJ-H00128P" },
        to: { id: "TJ-H00217P" },
        totalFare: 3500,
        totalDistanceM: 1200,
        legs: [
          {
            type: "RIDE", line: "TJ:4", operator: "TJ", from: { id: "TJ-H00128P" }, to: { id: "TJ-H00217P" }, stops: [{ id: "TJ-H00128P" }, { id: "TJ-H00217P" }], distanceM: 1200, headsign: "Pulo Gadung",
            serviceLines: ["TJ:4", "TJ:4D", "TJ:5", "TJ:5C"].map((line) => ({ line })),
          },
        ],
        segments: [{ operator: "TJ", from: { id: "TJ-H00128P" }, to: { id: "TJ-H00217P" }, fare: 3500 }],
      });
    }) as unknown as typeof fetch;
    const src = new HttpCommuteSource({ baseUrl: "https://api.test", timeoutMs: 1000, fetchImpl });
    const fare = await src.getFare({ operator: "TJ", code: "H00128P" }, { operator: "TJ", code: "H00217P" }, "2026-10-26T08:15:00+07:00");
    expect(urls[0]).toBe("https://api.test/fares/TJ-H00128P/TJ-H00217P?at=2026-10-26T01%3A15%3A00.000Z");
    expect(fare!.legs[0].headsign).toBe("Pulo Gadung");
    expect(fare!.legs[0].serviceLines!.map((x) => x.line)).toEqual(["4", "4D", "5", "5C"]);
  });

  it("transfer INTERNAL dengan petunjuk dan pintu; EXTERNAL diabaikan", async () => {
    const fetchImpl = (async () =>
      ok([
        {
          dataType: "INTERNAL", toStation: { id: "MRTJ-DKA", operator: "MRTJ", code: "DKA" }, distanceM: 350, notes: "Lewat terowongan Kendal",
          fromExit: { ref: "B", name: "Pintu Barat", signs: [{ text: "Kendal" }] }, toExit: { ref: "A" },
        },
        { dataType: "EXTERNAL", toStation: { name: "Halte Ojek", operatorName: "x" }, distanceM: 50 },
      ])) as unknown as typeof fetch;
    const src = new HttpCommuteSource({ baseUrl: "https://api.test", timeoutMs: 1000, fetchImpl });
    const t = (await src.getTransfers("KCI", "SUD")) as UpHubTransfer[];
    expect(t).toEqual([
      { from: { operator: "KCI", code: "SUD" }, to: { operator: "MRTJ", code: "DKA" }, distanceM: 350, notes: "Lewat terowongan Kendal", fromExit: { ref: "B", name: "Pintu Barat", signs: ["Kendal"] }, toExit: { ref: "A" } },
    ]);
  });

  it("headway diminta per hari layanan dan jam Jakarta", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string | URL) => {
      urls.push(String(u));
      return ok([{ line: "TJ:4", headwayS: 600, source: "STOP" }]);
    }) as unknown as typeof fetch;
    const src = new HttpCommuteSource({ baseUrl: "https://api.test", timeoutMs: 1000, fetchImpl });
    // Sabtu 23:30 UTC = Minggu 06:30 WIB.
    const rows = await src.getHeadways("TJ", "H00128P", "2026-10-24T23:30:00Z");
    expect(urls[0]).toBe("https://api.test/stations/TJ/H00128P/headway?day=SUN&hour=6");
    expect(rows).toEqual([{ operator: "TJ", line: "4", headwayS: 600, source: "STOP" }]);
    expect(jakartaDayHour(new Date("2026-10-26T01:00:00Z"))).toEqual({ day: "WD", hour: 8 });
  });
});

describe("Fasilitas yang dibutuhkan saat pindah", () => {
  const detail = (id: string, lift: "available" | "absent" | "unknown", ntdLift?: "out_of_service") =>
    ({
      id, name: id, operator: "x", lineIds: [], codes: [],
      amenities: { lift, eskalator: "available", toilet: "unknown", ramp: "unknown" },
      amenityDetails: ntdLift ? [{ type: "lift", status: ntdLift, source: "ntd" }] : [],
    }) as unknown as StationDetail;

  it("status per kebutuhan di kedua ujung perpindahan, plus peringatan", () => {
    const route: Route = {
      legs: [
        { type: "RIDE", lineId: "l1", stops: ["a", "b"], distanceM: 1000, minutes: 3, fare: 0 },
        { type: "TRANSFER", stops: ["b", "c"], distanceM: 200, minutes: 4, fare: 0 },
      ],
      totalDistanceM: 1200, totalMinutes: 7, timeComplete: true, totalFare: 0, transfers: 1,
    };
    const details = new Map([["b", detail("b", "available", "out_of_service")], ["c", detail("c", "absent")]]);
    const out = withTransferAccess(route, ["lift", "eskalator"], details);
    expect(out.legs[0].access).toBeUndefined();
    expect(out.legs[1].access).toEqual([
      { stationId: "b", need: "lift", status: "out_of_service" },
      { stationId: "b", need: "eskalator", status: "available" },
      { stationId: "c", need: "lift", status: "absent" },
      { stationId: "c", need: "eskalator", status: "available" },
    ]);
    const byId = new Map<string, Station>([["b", { id: "b", name: "Stasiun B" } as Station]]);
    const warn = accessWarnings(out, byId);
    expect(warn).toHaveLength(2);
    expect(warn[0]).toContain("Stasiun B");
  });
});

describe("Peron dan gate: dataset lalu isian admin", () => {
  it("dataset: nomor peron dan arah dari /timetable/grouped, pintu dari /exits", async () => {
    const urls: string[] = [];
    const ok = (data: unknown) => new Response(JSON.stringify({ status: 200, data }), { status: 200 });
    const fetchImpl = (async (u: string | URL) => {
      const url = String(u);
      urls.push(url);
      if (url.includes("/exits")) return ok([{ id: "KCI-SUD:A", ref: "A", name: "Jl. Kendal", signs: [{ text: "MRT" }], source: "FIELD" }]);
      // Label arah pada API berupa daftar stasiun yang dilewati.
      return ok([{ line: "KCI:C", timetable: [{ key: "a", label: ["Manggarai", "Jatinegara", "Cikarang"], platformCode: "2" }, { key: "b", label: ["Tanah Abang"], platformCode: null }] }]);
    }) as unknown as typeof fetch;
    const src = new HttpCommuteSource({ baseUrl: "https://api.test", timeoutMs: 1000, fetchImpl });
    expect(await src.getPlatforms("KCI", "SUD")).toEqual([{ operator: "KCI", line: "C", platformCode: "2", direction: "Arah Manggarai – Jatinegara – Cikarang" }]);
    expect(directionLabel("Arah Manggarai")).toBe("Arah Manggarai");
    expect(directionLabel([])).toBeUndefined();
    expect(urls[0]).toBe("https://api.test/stations/KCI/SUD/timetable/grouped?compact=1&from=04:00&to=05:00");
    expect(await src.getExits("KCI", "SUD")).toEqual([{ ref: "A", name: "Jl. Kendal", signs: ["MRT"], source: "FIELD" }]);

    const client = new CommuteApiClient(new FixtureCommuteSource(), createMemoryStore().cache);
    const platforms = await client.getPlatforms("sudirman", newContext());
    expect(platforms.map((p) => [p.code, p.serves[0].lineId, p.serves[0].direction])).toEqual([
      ["1", "krl-cikarang", "Arah Tanah Abang"],
      ["2", "krl-cikarang", "Arah Manggarai"],
    ]);
  });

  it("isian admin melengkapi peron dataset dengan nomor yang sama; pintu dataset yang sudah dilengkapi tidak ganda", () => {
    const ds: Platform[] = [{ code: "1", serves: [{ lineId: "l", direction: "Arah A" }], amenities: {}, source: "dataset" }];
    const ntd: Platform[] = [
      { code: "1", type: "side", serves: [], amenities: { lift: "absent", eskalator: "available" }, escalators: [{ count: 2, direction: "naik" }], gap: { level: "tangga", steps: 2 }, source: "ntd" },
      { code: "2", type: "side", serves: [{ lineId: "l", direction: "Arah B" }], amenities: { lift: "available" }, source: "ntd" },
    ];
    const merged = mergePlatforms(ds, ntd);
    expect(merged.map((p) => p.code)).toEqual(["1", "2"]);
    expect(merged[0]).toMatchObject({ type: "side", serves: [{ lineId: "l", direction: "Arah A" }], escalators: [{ count: 2, direction: "naik" }], source: "ntd" });

    const exit = (ref: string): Entrance => ({ id: `KCI-SUD:${ref}`, stationId: "s", name: `Pintu ${ref}`, accessible: false, features: [], signs: ["MRT"], source: "dataset" });
    const team: Entrance = { id: "x", stationId: "s", name: "Pintu A (Kendal)", accessible: true, features: ["lift"], exitRef: "A", lift: { count: 1 }, source: "ntd" };
    const list = mergeEntrances([exit("A"), exit("B")], [team]);
    expect(list.map((e) => e.name)).toEqual(["Pintu A (Kendal)", "Pintu B"]);
    expect(list[0].signs).toEqual(["MRT"]);
  });

  it("status fasilitas pindah memakai peron naik/turun; celah bertangga diperingatkan", () => {
    const platforms: Platform[] = [
      { code: "1", serves: [{ lineId: "krl", direction: "Arah Tanah Abang" }], amenities: { lift: "absent" }, gap: { level: "tangga", steps: 2, boardingAid: true }, source: "ntd" },
      { code: "2", serves: [{ lineId: "krl", direction: "Arah Manggarai" }], amenities: { lift: "available" }, source: "ntd" },
    ];
    const d = { id: "sud", name: "Sudirman", amenities: { lift: "available" }, amenityDetails: [], platforms } as unknown as StationDetail;
    const route: Route = {
      legs: [
        { type: "RIDE", lineId: "mrt", stops: ["x", "dka"], distanceM: 1, minutes: 1, fare: 0 },
        { type: "TRANSFER", stops: ["dka", "sud"], distanceM: 300, minutes: 5, fare: 0 },
        { type: "RIDE", lineId: "krl", headsign: "Tanah Abang", stops: ["sud", "thb"], distanceM: 1, minutes: 1, fare: 0 },
      ],
      totalDistanceM: 302, totalMinutes: 7, timeComplete: true, totalFare: 0, transfers: 1,
    };
    const details = new Map([["sud", d]]);
    const withP = withPlatforms(route, details);
    expect(withP.legs[2].boardAt?.code).toBe("1");
    const out = withTransferAccess(withP, ["lift"], details);
    // Stasiun tercatat punya lift, tetapi peron 1 (arah Tanah Abang) tidak.
    expect(out.legs[1].access).toEqual([
      { stationId: "dka", need: "lift", status: "unknown" },
      { stationId: "sud", need: "lift", status: "absent", platform: "1" },
    ]);
    const byId = new Map<string, Station>([["sud", { id: "sud", name: "Sudirman" } as Station]]);
    expect(accessWarnings(out, byId).some((w) => w.includes("Sudirman (peron 1)"))).toBe(true);
    expect(gapWarnings(withP, byId)).toEqual(["Naik di Sudirman (peron 1): ada 2 anak tangga antara peron dan kendaraan. Petugas dapat menyediakan pelat/ramp portabel."]);
  });

  it("skor perjalanan: gate langsung/sebidang ke peron membuat lift dan eskalator tidak dihitung; JPO menghitungnya", () => {
    const W = { lift: 40, eskalator: 20, toilet: 25, ramp: 15 } as const;
    const snap = { weight: (t: keyof typeof W) => W[t], settings: { scoring: { threshold: 70 } } } as unknown as ContentSnapshot;
    const platforms: Platform[] = [
      { code: "1", serves: [{ lineId: "krl", direction: "Arah Tanah Abang" }], amenities: {}, source: "ntd" },
      { code: "2", serves: [{ lineId: "krl", direction: "Arah Manggarai" }], amenities: { lift: "absent" }, source: "ntd" },
    ];
    const gate = (name: string, accessible: boolean, links: Entrance["platformLinks"]): Entrance => ({ id: name, stationId: "s", name, accessible, features: [], platformLinks: links, source: "ntd" });
    const entrances = [
      gate("Gate utara", true, [{ platform: "1", via: "langsung" }, { platform: "2", via: "jpo" }]),
      gate("Gate selatan", false, [{ platform: "2", via: "sebidang" }]),
    ];
    // Stasiun kecil: toilet dan ramp ada, lift dan eskalator tidak; skor stasiun 40.
    const d = { id: "s", name: "Kecil", amenities: { lift: "absent", eskalator: "absent", toilet: "available", ramp: "available" }, amenityDetails: [], platforms, entrances } as unknown as StationDetail;
    const a: StationAssessment = { stationId: "s", score: 40, adequate: false, dataAvailable: true };

    const p1 = journeyAssessment(a, d, ["1"], snap);
    expect(p1).toMatchObject({ score: 100, adequate: true, journey: { level: true, via: "langsung", gate: "Gate utara", excluded: ["lift", "eskalator"], stationScore: 40 } });
    // Peron 2 hanya lewat JPO dari gate yang aksesibel (gate selatan tidak aksesibel): lift dihitung dan tidak ada.
    const p2 = journeyAssessment(a, d, ["2"], snap);
    expect(p2).toMatchObject({ score: 40, adequate: false, journey: { level: false, via: "jpo", lift: "absent", excluded: [] } });
    // Tanpa data hubungan gate dan peron, skor stasiun dipakai apa adanya.
    expect(journeyAssessment(a, { ...d, entrances: [] }, ["1"], snap)).toBe(a);

    const byId = new Map<string, Station>([["s", { id: "s", name: "Kecil" } as Station]]);
    expect(crossingWarnings([p2], byId)).toEqual(["Kecil (peron 2) hanya dapat dicapai lewat JPO, dan lift tidak tercatat."]);
    const viaRail = journeyAssessment(a, { ...d, entrances: [gate("Gate selatan", true, [{ platform: "2", via: "sebidang" }])] }, ["2"], snap);
    expect(viaRail.score).toBe(100);
    expect(crossingWarnings([viaRail], byId)[0]).toContain("pelintasan sebidang");

    const route: Route = {
      legs: [{ type: "RIDE", lineId: "krl", headsign: "Tanah Abang", stops: ["s", "t"], distanceM: 1, minutes: 1, fare: 0 }],
      totalDistanceM: 1, totalMinutes: 1, timeComplete: true, totalFare: 0, transfers: 0,
    };
    expect([...gatePlatforms(withPlatforms(route, new Map([["s", d]])), new Map([["s", d]]))]).toEqual([["s", ["1"]]]);
  });
});
