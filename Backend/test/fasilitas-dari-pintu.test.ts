// Fasilitas stasiun dari isian pintu (gate): lift, eskalator, dan ramp yang sudah dicatat pada pintu aksesibel ikut
// menjadi fasilitas umum stasiun (dan skornya), tanpa diisi dua kali. Isian tim pada stasiun tetap menang.

import { newContext } from "../src/context";
import { CommuteApiClient } from "../src/data/commute/CommuteApiClient";
import { FixtureCommuteSource } from "../src/data/commute/FixtureCommuteSource";
import { ContentSnapshot } from "../src/domain/content";
import { FacilityAnalysisService, fromEntrances } from "../src/domain/FacilityAnalysisService";
import type { Entrance } from "../src/domain/models";
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

const gate = (name: string, over: Partial<Entrance> = {}): Entrance => ({ id: name, stationId: "s", name, accessible: true, features: [], source: "ntd", ...over });
const entranceItem = (stationId: string, data: Record<string, unknown>) => item({ kind: "entrance", stationId, published: { accessible: true, features: [], ...data } });

describe("fromEntrances", () => {
  it("lift, eskalator, dan ramp yang tercatat pada pintu menjadi fasilitas stasiun", () => {
    const out = fromEntrances([
      gate("Pintu Atas", { features: ["lift", "eskalator", "tangga"] }),
      gate("Pintu Bawah", { features: ["ramp", "datar"] }),
    ]);
    expect(out).toEqual([
      { type: "lift", status: "available", source: "ntd", note: "Dari data pintu Pintu Atas." },
      { type: "eskalator", status: "available", source: "ntd", note: "Dari data pintu Pintu Atas." },
      { type: "ramp", status: "available", source: "ntd", note: "Dari data pintu Pintu Bawah." },
    ]);
  });

  it("jumlah lift dari isian pintu dipakai; jumlah 0 atau lift rusak tidak diturunkan", () => {
    expect(fromEntrances([gate("A", { lift: { count: 2 } })]).map((x) => x.type)).toEqual(["lift"]);
    expect(fromEntrances([gate("A", { features: ["lift"], lift: { count: 0 } })])).toEqual([]);
    expect(fromEntrances([gate("A", { features: ["lift"], lift: { count: 1, status: "out_of_service" } })])).toEqual([]);
    expect(fromEntrances([gate("A", { features: ["eskalator"], escalators: [{ count: 1, direction: "naik", status: "out_of_service" }] })])).toEqual([]);
  });

  it("pintu yang tidak aksesibel dari jalan dan pintu tanpa fasilitas tidak menurunkan apa pun", () => {
    expect(fromEntrances([gate("A", { accessible: false, features: ["lift", "ramp"] }), gate("B", { features: ["tangga", "datar"] })])).toEqual([]);
  });
});

describe("fasilitas dan skor stasiun dari pintu", () => {
  const svc = () => new FacilityAnalysisService(new CommuteApiClient(new FixtureCommuteSource(), createMemoryStore().cache));
  const at = (items: ContentItem[]) => new ContentSnapshot(items, true, new Date());

  it("stasiun tanpa data fasilitas terisi dari pintunya dan skornya naik", async () => {
    const ctx = newContext();
    const before = await svc().assess("jayakarta", ctx, at([]));
    expect(before.assessment.dataAvailable).toBe(false);
    expect(before.assessment.score).toBe(0);

    const after = await svc().assess("jayakarta", ctx, at([entranceItem("jayakarta", { name: "JPO", features: ["lift", "tangga"], lift: { count: 2 } }), entranceItem("jayakarta", { name: "Pintu Barat", features: ["ramp", "datar"] })]));
    expect(after.facilities.amenities).toMatchObject({ lift: "available", ramp: "available" });
    expect(after.facilities.amenityDetails.find((x) => x.type === "lift")).toMatchObject({ source: "ntd", note: "Dari data pintu JPO." });
    expect(after.assessment.dataAvailable).toBe(true);
    // lift 40 + ramp 15 dari bobot 100 (eskalator dan toilet belum ada datanya).
    expect(after.assessment.score).toBe(55);
  });

  it("isian tim pada stasiun menang: lift yang dinyatakan tidak berfungsi tidak ditimpa pintu", async () => {
    const ctx = newContext();
    const r = await svc().facilities(
      "jayakarta",
      ctx,
      at([item({ kind: "facility", stationId: "jayakarta", published: { type: "lift", status: "out_of_service", note: "Rusak" } }), entranceItem("jayakarta", { name: "JPO", features: ["lift"] })]),
    );
    expect(r.amenities.lift).toBe("absent");
    expect(r.amenityDetails.find((x) => x.type === "lift")).toMatchObject({ status: "out_of_service", source: "ntd" });
  });

  it("pintu menimpa 'tidak ada' dari dataset (dataset hanya mendaftar yang ada), tapi tidak mengubah toilet", async () => {
    const ctx = newContext();
    // Jakarta Kota: dataset tanpa lift dan eskalator.
    const base = await svc().facilities("jakarta-kota", ctx, at([]));
    expect(base.amenities.lift).toBe("absent");
    const r = await svc().facilities("jakarta-kota", ctx, at([entranceItem("jakarta-kota", { name: "Pintu Utara", features: ["lift"] })]));
    expect(r.amenities.lift).toBe("available");
    expect(r.amenities.toilet).toBe(base.amenities.toilet);
  });
});
