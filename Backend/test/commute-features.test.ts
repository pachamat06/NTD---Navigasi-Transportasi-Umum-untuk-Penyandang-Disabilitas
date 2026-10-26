// Fitur dari Commute Data API: jarak/petunjuk transfer, `at` pada /fares, frekuensi (headway) bila jadwal
// tidak ada, lin paralel (bus gabungan), cache single-flight + stale-while-revalidate, dan penanganan 429.

import { withTransferAccess, accessWarnings } from "../src/ai/NavigationAgent";
import { newContext } from "../src/context";
import { CommuteApiClient } from "../src/data/commute/CommuteApiClient";
import { FixtureCommuteSource } from "../src/data/commute/FixtureCommuteSource";
import { HttpCommuteSource, jakartaDayHour } from "../src/data/commute/HttpCommuteSource";
import type { CommuteSource, UpFare, UpHeadway, UpHubTransfer, UpLine, UpStation } from "../src/data/commute/types";
import type { Route, Station, StationDetail } from "../src/domain/models";
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
