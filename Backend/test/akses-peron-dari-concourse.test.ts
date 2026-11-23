// Akses peron dari concourse: ruas concourse → peron yang sudah diisi otomatis menjadi akses peron terkait
// (lift, eskalator, ramp), tanpa input ganda. Isian tim pada peron tetap menang; hanya field kosong yang terisi.

import { newContext } from "../src/context";
import { CommuteApiClient } from "../src/data/commute/CommuteApiClient";
import { FixtureCommuteSource } from "../src/data/commute/FixtureCommuteSource";
import { applyConcourseAccess } from "../src/domain/concourseAccess";
import { ContentSnapshot } from "../src/domain/content";
import { FacilityAnalysisService } from "../src/domain/FacilityAnalysisService";
import type { Concourse, Platform } from "../src/domain/models";
import { StationService } from "../src/domain/StationService";
import { createMemoryStore } from "../src/store/memory";
import type { ContentItem } from "../src/store/types";

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

const concourse = (code: string, platformLinks: Concourse["platformLinks"], over: Partial<Concourse> = {}): Concourse => ({ id: code, stationId: "s", code, platformLinks, source: "ntd", ...over });
const platform = (code: string, over: Partial<Platform> = {}): Platform => ({ code, serves: [{ lineId: "krl" }], amenities: {}, source: "dataset", ...over });

describe("applyConcourseAccess", () => {
  it("lift, eskalator, dan ramp pada ruas concourse → peron mengisi peron yang bersangkutan", () => {
    const out = applyConcourseAccess(
      [platform("1"), platform("2")],
      [
        concourse("Utara", [
          { platform: "1", means: ["lift", "eskalator", "tangga"], lift: { count: 2 }, escalators: [{ count: 1, direction: "naik" }] },
          { platform: "2", means: ["ramp"] },
        ]),
      ],
    );
    const p1 = out.find((p) => p.code === "1")!;
    expect(p1.amenities).toEqual({ lift: "available", eskalator: "available" });
    expect(p1.lift).toEqual({ count: 2, connects: "concourse Utara – peron", status: "available" });
    expect(p1.escalators).toEqual([{ count: 1, direction: "naik", connects: "concourse Utara – peron" }]);
    expect(p1.accessFromConcourse).toEqual({ fields: ["lift", "eskalator", "liftInfo", "escalators"], from: [{ concourse: "Utara", means: ["lift", "eskalator", "tangga"] }] });
    // Peron lain: hanya ramp; lift dan eskalator tidak ditebak.
    const p2 = out.find((p) => p.code === "2")!;
    expect(p2.amenities).toEqual({ ramp: "available" });
    expect(p2.lift).toBeUndefined();
    expect(p2.accessFromConcourse?.fields).toEqual(["ramp"]);
    // Data masukan tidak diubah.
    expect(platform("1").amenities).toEqual({});
  });

  it("ruas yang tidak mencantumkan lift tidak membuat peron 'tidak ada lift'", () => {
    const [p] = applyConcourseAccess([platform("1")], [concourse("Utara", [{ platform: "1", means: ["tangga"] }])]);
    expect(p.amenities).toEqual({});
    expect(p.accessFromConcourse).toBeUndefined();
  });

  it("isian tim pada peron menang per field; yang kosong tetap terisi", () => {
    const own = platform("1", { source: "ntd", amenities: { lift: "out_of_service" }, escalators: [{ count: 3, direction: "turun", connects: "ke peron" }] });
    const [p] = applyConcourseAccess([own], [concourse("Utara", [{ platform: "1", means: ["lift", "eskalator", "ramp"], lift: { count: 1 }, escalators: [{ count: 9, direction: "naik" }] }])]);
    expect(p.amenities.lift).toBe("out_of_service");
    // Lift dinyatakan tim tidak berfungsi, jadi jumlah lift dari concourse tidak ikut dipakai.
    expect(p.lift).toBeUndefined();
    expect(p.escalators).toEqual([{ count: 3, direction: "turun", connects: "ke peron" }]);
    expect(p.amenities).toMatchObject({ eskalator: "available", ramp: "available" });
    expect(p.accessFromConcourse?.fields).toEqual(["eskalator", "ramp"]);
  });

  it("status lift/eskalator yang tidak berfungsi pada ruas ikut diturunkan; beberapa concourse memakai yang terbaik", () => {
    const down = concourse("Selatan", [{ platform: "1", means: ["lift", "eskalator"], lift: { count: 1, status: "out_of_service" }, escalators: [{ count: 1, direction: "naik", status: "out_of_service" }] }]);
    const [only] = applyConcourseAccess([platform("1")], [down]);
    expect(only.amenities).toEqual({ lift: "out_of_service", eskalator: "out_of_service" });
    const [both] = applyConcourseAccess([platform("1")], [down, concourse("Utara", [{ platform: "1", means: ["lift"], lift: { count: 2, connects: "Lantai 2 – peron" } }])]);
    expect(both.amenities.lift).toBe("available");
    expect(both.lift).toMatchObject({ count: 3, status: "available" });
    expect(both.lift?.connects).toBe("concourse Selatan – peron; Lantai 2 – peron");
    expect(both.accessFromConcourse?.from.map((f) => f.concourse)).toEqual(["Selatan", "Utara"]);
  });

  it("peron yang hanya disebut di concourse dibuat agar aksesnya tampil; tanpa concourse tidak ada perubahan", () => {
    const input = [platform("1")];
    expect(applyConcourseAccess(input, [])).toBe(input);
    const out = applyConcourseAccess(input, [concourse("B1", [{ platform: "3", means: ["lift"] }, { platform: "1", means: ["ramp"] }])]);
    expect(out.map((p) => p.code)).toEqual(["1", "3"]);
    expect(out[1]).toMatchObject({ code: "3", serves: [], source: "ntd", amenities: { lift: "available" } });
  });
});

describe("detail stasiun dan fasilitas stasiun", () => {
  const setup = () => {
    const commute = new CommuteApiClient(new FixtureCommuteSource(), createMemoryStore().cache);
    const facilities = new FacilityAnalysisService(commute);
    return { stations: new StationService(commute, facilities), facilities };
  };
  const items = [
    item({ kind: "concourse", stationId: "sudirman", published: { code: "Utara", platformLinks: [{ platform: "1", means: ["lift", "tangga"], lift: { count: 1 } }] } }),
    item({ kind: "platform", stationId: "sudirman", published: { code: "2", amenities: { lift: "absent" } } }),
    item({ kind: "concourse", stationId: "sudirman", draft: { code: "Selatan", platformLinks: [{ platform: "2", means: ["lift"] }] } }),
  ];

  it("detail: peron dari dataset terisi dari concourse; peron dengan isian tim tidak ditimpa", async () => {
    const { stations } = setup();
    const snap = new ContentSnapshot(items, true, new Date());
    const d = (await stations.detail("sudirman", newContext(), snap))!;
    const p1 = d.platforms.find((p) => p.code === "1");
    expect(p1?.amenities.lift).toBe("available");
    expect(p1?.lift).toMatchObject({ count: 1 });
    expect(p1?.accessFromConcourse?.fields).toContain("lift");
    const p2 = d.platforms.find((p) => p.code === "2");
    expect(p2?.amenities.lift).toBe("absent");
    expect(p2?.accessFromConcourse).toBeUndefined();
  });

  it("tanpa concourse, detail sama seperti sebelumnya", async () => {
    const { stations } = setup();
    const d = (await stations.detail("sudirman", newContext(), new ContentSnapshot([], false, new Date())))!;
    expect(d.platforms.every((p) => !p.accessFromConcourse)).toBe(true);
  });

  it("fasilitas umum stasiun ikut terisi dari lift peron yang diturunkan dari concourse", async () => {
    const { facilities } = setup();
    const ctx = newContext();
    const none = await facilities.facilities("sudirman", ctx, new ContentSnapshot([item({ kind: "concourse", stationId: "sudirman", published: { code: "Utara", platformLinks: [{ platform: "1", means: ["tangga"] }] } })], false, new Date()));
    const withLift = await facilities.facilities("sudirman", ctx, new ContentSnapshot(items.slice(0, 1), false, new Date()));
    expect(withLift.amenityDetails.find((x) => x.type === "lift")).toMatchObject({ status: "available" });
    expect(none.amenityDetails.find((x) => x.type === "lift")?.source).not.toBe("ntd");
  });
});
