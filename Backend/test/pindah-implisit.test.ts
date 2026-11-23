// Pindah lini di stasiun yang sama tanpa ruas pindah dari dataset (mis. Kemayoran → Kampung Bandan → Jakarta Kota) harus
// tetap dihitung sebagai titik pindah: fasilitas yang dibutuhkan diperiksa dan jumlah pindah benar.

import { withImplicitTransfers } from "../src/domain/RoutePlannerService";
import type { RouteLeg } from "../src/domain/models";
import { makeTestApp } from "./helpers";

const ride = (lineId: string | undefined, stops: string[]): RouteLeg => ({ type: "RIDE", ...(lineId ? { lineId } : {}), stops, distanceM: 1000, minutes: 5, fare: 0 });

describe("withImplicitTransfers", () => {
  it("menyisipkan ruas pindah di stasiun bersama untuk dua ruas naik pada lini berbeda", () => {
    const legs = withImplicitTransfers([ride("krl-cikarang", ["kmo", "rjw", "kpb"]), ride("kci:tp", ["kpb", "jakarta-kota"])]);
    expect(legs.map((l) => l.type)).toEqual(["RIDE", "TRANSFER", "RIDE"]);
    expect(legs[1]).toMatchObject({ stops: ["kpb", "kpb"], distanceM: 0, minutes: null, fare: 0 });
  });

  it("tidak menyisipkan untuk lini yang sama, ruas yang tidak bersambung, atau yang sudah punya ruas pindah", () => {
    expect(withImplicitTransfers([ride("a", ["x", "y"]), ride("a", ["y", "z"])])).toHaveLength(2);
    expect(withImplicitTransfers([ride("a", ["x", "y"]), ride("b", ["z", "w"])])).toHaveLength(2);
    const walk: RouteLeg = { type: "TRANSFER", stops: ["y", "z"], distanceM: 100, minutes: 2, fare: 0 };
    expect(withImplicitTransfers([ride("a", ["x", "y"]), walk, ride("b", ["z", "w"])])).toHaveLength(3);
    // Lini tidak diketahui pada salah satu ruas: dianggap pindah (lebih aman memeriksa fasilitas).
    expect(withImplicitTransfers([ride(undefined, ["x", "y"]), ride("b", ["y", "z"])]).map((l) => l.type)).toEqual(["RIDE", "TRANSFER", "RIDE"]);
  });

  it("enrich: rute dataset tanpa ruas pindah kini menghitung pindah dan memeriksa fasilitas titik pindah itu", async () => {
    const { services } = await makeTestApp();
    const fare = {
      legs: [
        { type: "RIDE", lineId: "krl-cikarang", stops: ["tanah-abang", "bni-city", "sudirman"], distanceM: 3000, fare: 3000 },
        { type: "RIDE", lineId: "krl-bogor", stops: ["sudirman", "manggarai"], distanceM: 3400, fare: 0 },
      ],
      totalFare: 3000,
      totalDistanceM: 6400,
    };
    const lines = await services.commute.getLines({ preview: false, now: new Date() });
    const route = services.planner.enrich(fare as never, lines);
    expect(route.legs.map((l) => l.type)).toEqual(["RIDE", "TRANSFER", "RIDE"]);
    expect(route.transfers).toBe(1);
  });
});
