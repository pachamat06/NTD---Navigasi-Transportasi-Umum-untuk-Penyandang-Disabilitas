// Concourse: stasiun yang gate-nya tidak langsung ke peron, melainkan ke concourse (area penghubung) dulu.
// Jalur gate → concourse → peron beserta fasilitas tiap ruas menentukan skor, peringatan, dan akses saat pindah.

import request from "supertest";
import { crossingWarnings, withTransferAccess } from "../src/ai/NavigationAgent";
import { buildSuggestions, parseFloorPlan } from "../src/ai/vision/floorPlan";
import { newContext } from "../src/context";
import { CommuteApiClient } from "../src/data/commute/CommuteApiClient";
import { FixtureCommuteSource } from "../src/data/commute/FixtureCommuteSource";
import { concourseSchema, ContentSnapshot, entranceSchema } from "../src/domain/content";
import { FacilityAnalysisService, journeyAssessment, layoutAccess, viaText } from "../src/domain/FacilityAnalysisService";
import type { Concourse, Entrance, Platform, Route, Station, StationAssessment, StationDetail } from "../src/domain/models";
import { createMemoryStore } from "../src/store/memory";
import type { ContentItem } from "../src/store/types";
import { makeTestApp } from "./helpers";

const item = (over: Partial<ContentItem>): ContentItem => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  kind: "facility",
  stationId: null,
  draft: null,
  published: null,
  draftDeleted: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  publishedAt: null,
  updatedBy: null,
  ...over,
});

const gate = (name: string, accessible: boolean, over: Partial<Entrance> = {}): Entrance => ({ id: name, stationId: "s", name, accessible, features: [], source: "ntd", ...over });
const concourse = (code: string, platformLinks: Concourse["platformLinks"], over: Partial<Concourse> = {}): Concourse => ({ id: code, stationId: "s", code, platformLinks, source: "ntd", ...over });

// Stasiun kecil: toilet dan ramp ada, lift dan eskalator tidak tercatat (skor stasiun 40 dengan bobot bawaan).
const platforms: Platform[] = [
  { code: "1", serves: [{ lineId: "krl", direction: "Arah Bogor" }], amenities: {}, source: "ntd" },
  { code: "2", serves: [{ lineId: "krl", direction: "Arah Jakarta Kota" }], amenities: {}, source: "ntd" },
];
const station = (entrances: Entrance[], concourses: Concourse[]) =>
  ({ id: "s", name: "Kecil", amenities: { lift: "absent", eskalator: "absent", toilet: "available", ramp: "available" }, amenityDetails: [], platforms, entrances, concourses }) as unknown as StationDetail;
const a: StationAssessment = { stationId: "s", score: 40, adequate: false, dataAvailable: true };
const snap = new ContentSnapshot([], false, new Date());
const byId = new Map<string, Station>([["s", { id: "s", name: "Kecil" } as Station]]);

describe("skema concourse", () => {
  it("menerima concourse dan gate yang menuju concourse; cara berpindah wajib diisi", () => {
    expect(concourseSchema.parse({ code: "Utara", level: "Lantai 2", paid: true, platformLinks: [{ platform: "1", means: ["lift", "eskalator", "tangga"], lift: { count: 1 } }] })).toMatchObject({ code: "Utara" });
    // Concourse tanpa ruas ke peron boleh (diisi menyusul), platformLinks menjadi [].
    expect(concourseSchema.parse({ code: "B1" }).platformLinks).toEqual([]);
    expect(concourseSchema.safeParse({ code: "Utara", platformLinks: [{ platform: "1", means: [] }] }).success).toBe(false);
    expect(concourseSchema.safeParse({ code: "Utara", platformLinks: [{ platform: "1", means: ["terbang"] }] }).success).toBe(false);
    // Data pintu lama (langsung ke peron) tetap valid; concourseLinks opsional.
    expect(entranceSchema.parse({ name: "Gate A", accessible: true, platformLinks: [{ platform: "1", via: "langsung" }] }).concourseLinks).toBeUndefined();
    expect(entranceSchema.parse({ name: "Gate A", accessible: true, concourseLinks: [{ concourse: "Utara", means: ["datar"] }] }).concourseLinks).toHaveLength(1);
  });

  it("snapshot: satu concourse per kode per stasiun, entri terbaru menang", () => {
    const s = new ContentSnapshot(
      [
        item({ kind: "concourse", stationId: "s", published: { code: "Utara", platformLinks: [{ platform: "1", means: ["tangga"] }] } }),
        item({ kind: "concourse", stationId: "s", published: { code: "Utara", platformLinks: [{ platform: "1", means: ["lift"] }] } }),
        item({ kind: "concourse", stationId: "s", draft: { code: "Selatan" } }),
      ],
      false,
      new Date(),
    );
    expect(s.concoursesOf("s")).toHaveLength(1);
    expect(s.concoursesOf("s")[0]).toMatchObject({ code: "Utara", source: "ntd", platformLinks: [{ platform: "1", means: ["lift"] }] });
  });
});

describe("jalur gate → concourse → peron", () => {
  it("tanpa concourse hasilnya sama dengan data lama", () => {
    const old = [gate("Gate B", true, { platformLinks: [{ platform: "1", via: "langsung" }] })];
    expect(layoutAccess(old, ["1"])).toEqual(layoutAccess(old, ["1"], []));
    expect(layoutAccess(old, ["1"])).toEqual({ platforms: ["1"], level: true, via: "langsung", gate: "Gate B" });
  });

  it("concourse selantai dengan gate dan peron (datar/ramp): lift dan eskalator tidak dibutuhkan", () => {
    const d = station([gate("Gate A", true, { concourseLinks: [{ concourse: "Hall", means: ["datar"] }] })], [concourse("Hall", [{ platform: "1", means: ["ramp"] }])]);
    const j = journeyAssessment(a, d, ["1"], snap);
    expect(j).toMatchObject({ score: 100, adequate: true, journey: { level: true, via: "concourse", gate: "Gate A", concourse: { code: "Hall", toConcourse: ["datar"], toPlatform: ["ramp"] }, excluded: ["lift", "eskalator"] } });
    expect(j.notes?.some((n) => n.includes("lewat concourse Hall (gate ke concourse: datar; concourse ke peron: ramp)"))).toBe(true);
  });

  it("ruas concourse ke peron yang pindah lantai: lift ruas itu yang menentukan, bukan status lift stasiun", () => {
    // Dataset tidak mencatat lift di stasiun, tetapi survei menemukan lift di ruas concourse ke peron 1.
    const entrances = [gate("Gate A", true, { concourseLinks: [{ concourse: "Lantai 2", means: ["datar"] }] })];
    const withLift = station(entrances, [concourse("Lantai 2", [{ platform: "1", means: ["lift", "eskalator", "tangga"], lift: { count: 1 } }])]);
    const j = journeyAssessment(a, withLift, ["1"], snap);
    expect(j).toMatchObject({ score: 100, journey: { level: false, via: "concourse", pathLift: "available", pathEscalator: "available", lift: "available", excluded: [] } });
    expect(crossingWarnings([j], byId)).toEqual([]);

    // Ruas yang hanya tangga: lift tidak ada di jalur itu, diperingatkan.
    const stairs = station(entrances, [concourse("Lantai 2", [{ platform: "1", means: ["tangga"] }])]);
    const s = journeyAssessment({ ...a, score: 100 }, { ...stairs, amenities: { lift: "available", eskalator: "available", toilet: "available", ramp: "available" } } as StationDetail, ["1"], snap);
    expect(s).toMatchObject({ score: 40, journey: { level: false, pathLift: "absent", lift: "absent" } });
    expect(crossingWarnings([s], byId)[0]).toBe("Kecil (peron 1) hanya dapat dicapai lewat concourse Lantai 2 (gate ke concourse: datar; concourse ke peron: tangga), dan lift tidak tercatat.");

    // Lift ruas sedang tidak berfungsi.
    const broken = station(entrances, [concourse("Lantai 2", [{ platform: "1", means: ["lift", "tangga"], lift: { count: 1, status: "out_of_service" } }])]);
    const b = journeyAssessment(a, broken, ["1"], snap);
    expect(b.journey).toMatchObject({ pathLift: "out_of_service", lift: "absent" });
    expect(crossingWarnings([b], byId)[0]).toContain("lift di jalur itu dilaporkan sedang tidak berfungsi");
  });

  it("memilih jalur terbaik: concourse ber-lift dari gate aksesibel mengalahkan JPO bertangga; ruas gate ke concourse ikut dinilai", () => {
    const entrances = [
      gate("Gate JPO", true, { platformLinks: [{ platform: "2", via: "jpo" }] }),
      gate("Gate Concourse", true, { concourseLinks: [{ concourse: "C", means: ["eskalator", "tangga", "lift"], lift: { count: 1 } }] }),
    ];
    const d = station(entrances, [concourse("C", [{ platform: "2", means: ["lift", "tangga"] }])]);
    const l = layoutAccess(d.entrances, ["2"], d.concourses);
    expect(l).toMatchObject({ via: "concourse", gate: "Gate Concourse", level: false, pathLift: "available", pathEscalator: "absent" });
    // Ruas gate ke concourse tanpa lift: lift jalur itu tidak ada walau ruas concourse ke peron punya lift.
    const noLiftAtGate = station([gate("Gate Concourse", true, { concourseLinks: [{ concourse: "C", means: ["tangga"] }] })], [concourse("C", [{ platform: "2", means: ["lift"] }])]);
    expect(layoutAccess(noLiftAtGate.entrances, ["2"], noLiftAtGate.concourses)).toMatchObject({ pathLift: "absent" });
    // Gate menuju concourse yang tidak dikenal diabaikan: peron tanpa jalur lain berarti jalur belum diketahui.
    expect(layoutAccess([gate("Gate X", true, { concourseLinks: [{ concourse: "Tidak ada", means: ["datar"] }] })], ["2"], d.concourses)).toBeUndefined();
  });

  it("ruas khusus disabilitas dipakai walau gate tidak aksesibel", () => {
    const d = station([gate("Gate Samping", false, { concourseLinks: [{ concourse: "C", means: ["ramp"], dedicated: true }] })], [concourse("C", [{ platform: "1", means: ["datar"] }])]);
    const l = layoutAccess(d.entrances, ["1"], d.concourses);
    expect(l).toMatchObject({ level: true, via: "concourse", dedicated: true });
    expect(viaText(l!)).toBe("lewat concourse C (gate ke concourse: ramp; concourse ke peron: datar) khusus pengguna disabilitas");
  });

  it("akses saat pindah memakai lift di ruas concourse", () => {
    const entrances = [gate("Gate A", true, { concourseLinks: [{ concourse: "C", means: ["datar"] }] })];
    const d = station(entrances, [concourse("C", [{ platform: "1", means: ["lift", "tangga"], lift: { count: 2 } }])]);
    const route: Route = {
      legs: [
        { type: "RIDE", lineId: "mrt", stops: ["x", "y"], distanceM: 1, minutes: 1, fare: 0 },
        { type: "TRANSFER", stops: ["y", "s"], distanceM: 200, minutes: 4, fare: 0 },
        { type: "RIDE", lineId: "krl", headsign: "Bogor", platform: "1", stops: ["s", "t"], distanceM: 1, minutes: 1, fare: 0 },
      ],
      totalDistanceM: 202, totalMinutes: 6, timeComplete: true, totalFare: 0, transfers: 1,
    };
    const out = withTransferAccess(route, ["lift", "ramp"], new Map([["s", d]]));
    expect(out.legs[1].access?.find((x) => x.stationId === "s" && x.need === "lift")).toEqual({ stationId: "s", need: "lift", status: "available", platform: "1" });
    // Concourse selantai: lift tidak dibutuhkan, dan jalurnya ikut dicatat.
    const flat = station(entrances, [concourse("C", [{ platform: "1", means: ["datar"] }])]);
    const out2 = withTransferAccess(route, ["lift"], new Map([["s", flat]]));
    expect(out2.legs[1].access?.find((x) => x.stationId === "s")?.notNeeded).toMatchObject({ via: "concourse", concourse: { code: "C" } });
  });

  it("skor stasiun dari isian tim: concourse menghubungkan semua peron", async () => {
    const commute = new CommuteApiClient(new FixtureCommuteSource(), createMemoryStore().cache);
    const facilities = new FacilityAnalysisService(commute);
    const before = (await facilities.assess("sudirman", newContext(), new ContentSnapshot([], false, new Date()))).assessment;
    const items = [
      item({ kind: "entrance", stationId: "sudirman", published: { name: "Gate utama", accessible: true, features: [], concourseLinks: [{ concourse: "Concourse", means: ["ramp"] }] } }),
      item({ kind: "concourse", stationId: "sudirman", published: { code: "Concourse", level: "Lantai 2", platformLinks: [{ platform: "1", means: ["datar"] }, { platform: "2", means: ["datar"] }] } }),
    ];
    const r = (await facilities.assess("sudirman", newContext(), new ContentSnapshot(items, false, new Date()))).assessment;
    expect(r.layout).toMatchObject({ level: true, via: "concourse", concourse: { code: "Concourse" } });
    expect(r.factors?.filter((f) => f.result === "not_needed").map((f) => f.type)).toEqual(["lift", "eskalator"]);
    expect(r.score).toBeGreaterThan(before.score);
  });
});

describe("admin dan API", () => {
  it("concourse disimpan sebagai draft, ikut detail stasiun, dan dihitung di daftar stasiun", async () => {
    const { app, login } = await makeTestApp();
    const token = await login();
    const auth = { Authorization: `Bearer ${token}` };
    const bad = await request(app).post("/api/admin/content").set(auth).send({ kind: "concourse", stationId: "sudirman", data: { code: "Utara", platformLinks: [{ platform: "1", means: [] }] } });
    expect(bad.status).toBe(400);
    const ok = await request(app).post("/api/admin/content").set(auth).send({ kind: "concourse", stationId: "sudirman", data: { code: "Utara", platformLinks: [{ platform: "1", means: ["lift"] }] } });
    expect(ok.status).toBe(201);
    const rows = await request(app).get("/api/admin/stations").set(auth);
    expect(rows.body.data.find((s: { id: string }) => s.id === "sudirman").concourses).toBe(1);
    const detail = await request(app).get("/api/admin/stations/sudirman").set(auth);
    expect(detail.body.data.preview.concourses).toEqual([expect.objectContaining({ code: "Utara" })]);
    expect(detail.body.data.published.concourses).toEqual([]);
  });
});

describe("pembaca denah AI", () => {
  const base = { stationName: "Tanjung Barat", summary: "", levels: [], facilities: [], platforms: [], rooms: [], connections: [], warnings: [] };

  it("mengusulkan concourse dan ruas gate ke concourse; ruas tanpa cara berpindah tidak diusulkan", () => {
    const raw = parseFloorPlan(
      JSON.stringify({
        ...base,
        concourses: [
          {
            code: "Lantai 1",
            name: "Concourse",
            level: "Lantai 1",
            paid: "ya",
            platformLinks: [
              { platform: "1", means: ["eskalator", "tangga", "lift", "terbang"], note: "" },
              { platform: "2", means: [], note: "" },
            ],
            note: "",
            confidence: "tinggi",
            evidence: "Label concourse di lantai 1.",
          },
        ],
        entrances: [
          { name: "Gate A1", exitRef: "A1", level: "Lantai 1", accessible: "tidak_tahu", features: ["tangga"], platformLinks: [], concourseLinks: [{ concourse: "Lantai 1", means: ["datar"], note: "" }], escalators: [], liftCount: 0, description: "", confidence: "tinggi", evidence: "Label A1." },
        ],
      }),
    );
    const r = buildSuggestions(raw, [], { name: "Tanjung Barat" });
    expect(r.suggestions.filter((s) => s.issues.length)).toEqual([]);
    const c = r.suggestions.find((s) => s.kind === "concourse")!;
    expect(c.data).toMatchObject({ code: "Lantai 1", name: "Concourse", paid: true, platformLinks: [{ platform: "1", means: ["eskalator", "tangga", "lift"] }] });
    expect((c.data.platformLinks as unknown[]).length).toBe(1);
    expect(r.warnings.some((w) => w.includes("concourse Lantai 1 ke peron 2"))).toBe(true);
    const g = r.suggestions.find((s) => s.kind === "entrance")!;
    expect(g.data).toMatchObject({ concourseLinks: [{ concourse: "Lantai 1", means: ["datar"] }] });
    expect(g.data.platformLinks).toBeUndefined();
    // Lift/eskalator di ruas concourse ikut menjadi fasilitas stasiun.
    const fac = r.suggestions.filter((s) => s.kind === "facility").map((s) => s.data.type);
    expect(fac).toEqual(expect.arrayContaining(["lift", "eskalator"]));
  });

  it("jawaban lama tanpa concourse tetap terbaca", () => {
    const raw = parseFloorPlan(JSON.stringify({ ...base, entrances: [{ name: "Gate B", exitRef: "B", level: "", accessible: "ya", features: ["datar"], platformLinks: [{ platform: "2", via: "langsung", note: "" }], escalators: [], liftCount: 0, description: "", confidence: "tinggi", evidence: "" }] }));
    expect(raw.concourses).toEqual([]);
    expect(raw.entrances[0].concourseLinks).toEqual([]);
    const g = buildSuggestions(raw, [], { name: "Tanjung Barat" }).suggestions.find((s) => s.kind === "entrance")!;
    expect(g.data).not.toHaveProperty("concourseLinks");
  });
});
