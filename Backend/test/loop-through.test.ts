// Ruas putaran pada lin: lingkar Lin Cikarang (urutan stasiun untuk peta admin dan pencarian rute) dan
// putaran koridor 1 TransJakarta di Kali Besar (rute Monumen Nasional -> Kota tanpa pindah bus).

import { newContext } from "../src/context";
import { CommuteApiClient } from "../src/data/commute/CommuteApiClient";
import type { CommuteSource, UpFare, UpLine, UpStation, UpStopRef } from "../src/data/commute/types";
import { TjGtfs } from "../src/data/gtfs/TjGtfs";
import { RoutePlannerService } from "../src/domain/RoutePlannerService";
import { createMemoryStore } from "../src/store/memory";

const gtfs = new TjGtfs();
const kci = (code: string): UpStopRef => ({ operator: "KCI", code });
const tj = (code: string): UpStopRef => ({ operator: "TJ", code });

class Source implements CommuteSource {
  readonly name = "loop";
  stations: UpStation[] = [];
  lines: UpLine[] = [];
  fareStops: UpStopRef[] = [];
  fareLine = "1";
  async getStations() {
    return this.stations;
  }
  async getStation() {
    return null;
  }
  async getOperators() {
    return [
      { code: "KCI", name: "Commuter Line", mode: "RAIL" as const },
      { code: "TJ", name: "TransJakarta", mode: "BUS" as const },
    ];
  }
  async getLines() {
    return this.lines;
  }
  async getLine() {
    return null;
  }
  async getHubs() {
    return [];
  }
  async getFare(): Promise<UpFare> {
    const stops = this.fareStops;
    const leg = { type: "RIDE" as const, operator: "TJ", line: this.fareLine, stops, distanceM: 5911, fare: 3500 };
    return { from: stops[0], to: stops[stops.length - 1], totalFare: 3500, totalDistanceM: 5911, legs: [leg] };
  }
}

const setup = (source: Source) => {
  const client = new CommuteApiClient(source, createMemoryStore().cache, gtfs);
  return { client, planner: new RoutePlannerService(client, gtfs) };
};

describe("Ruas putaran Lin Cikarang (LOOP)", () => {
  // Bentuk /lines/KCI/C asli: batang utama Cikarang..Jatinegara, lingkar Pondok Jati..Matraman bergabung di Jatinegara.
  const TRUNK = ["CKR", "BKS", "KLD", "JNG"];
  const LOOP = ["POK", "KMT", "PSE", "KPB", "AK", "DU", "THB", "SUD", "MRI", "MTR"];
  const source = () => {
    const s = new Source();
    const coord: Record<string, [number, number]> = { JNG: [-6.215, 106.87], POK: [-6.2, 106.866], MTR: [-6.214, 106.86], CKR: [-6.255, 107.145] };
    s.stations = [...TRUNK, ...LOOP].map((code) => ({ operator: "KCI", code, name: code, lines: ["C"], amenities: [], lat: coord[code]?.[0] ?? -6.18, lng: coord[code]?.[1] ?? 106.83 }));
    s.lines = [
      {
        operator: "KCI",
        code: "C",
        name: "Lin Cikarang",
        mode: "RAIL",
        stations: [...TRUNK, ...LOOP].map(kci),
        segments: [{ stations: TRUNK.map(kci) }, { stations: LOOP.map(kci), joinsAt: kci("JNG"), loop: true }],
      },
    ];
    return s;
  };

  it("lingkar tersambung ke Jatinegara di kedua ujungnya (Jatinegara-Pondok Jati dan Matraman-Jatinegara)", async () => {
    const { client } = setup(source());
    const [c] = await client.getLineSequences(newContext());
    const loop = c.sequences[1];
    const idx = await client.index(newContext());
    const [jng, pok, mtr, kpb, ak] = ["JNG", "POK", "MTR", "KPB", "AK"].map((code) => idx.idOf(kci(code)));
    expect(loop.slice(0, 2)).toEqual([jng, pok]);
    expect(loop.slice(-2)).toEqual([mtr, jng]);
    // Kampung Bandan dan Angke tetap bersebelahan.
    expect(loop.indexOf(ak)).toBe(loop.indexOf(kpb) + 1);
  });

  it("cabang biasa (bukan LOOP) tetap disambung di satu ujung saja", async () => {
    const s = source();
    s.lines[0].segments![1].loop = undefined;
    const { client } = setup(s);
    const [c] = await client.getLineSequences(newContext());
    const loop = c.sequences[1];
    expect(loop[0]).not.toBe(loop[loop.length - 1]);
    expect(loop).toHaveLength(LOOP.length + 1);
  });
});

describe("Putaran koridor 1 di Kali Besar", () => {
  // Urutan halte /fares Commute untuk Monumen Nasional -> Kota (satu ruas TJ:1, tanpa pindah).
  const MONAS_KOTA = ["H00131P", "H00278P", "H00280P", "H00281P", "H00133P", "H00068P", "H00093P", "H00132P", "H00275P"];

  it("satu bus koridor 1 melayani Monumen Nasional > Kali Besar > Museum Sejarah Jakarta > Kota", () => {
    const m = gtfs.match(["1"], MONAS_KOTA)!;
    expect(m).not.toBeNull();
    expect(m.line).toBe("1");
    expect(m.extra).toBe(0);
    // GTFS memotong trip di Kali Besar; trip berikutnya (bus yang sama) lanjut ke Museum Sejarah Jakarta dan Kota.
    expect(m.pattern.through).toBe(true);
    expect(gtfs.rideTime("1", MONAS_KOTA)?.minutes).toBeGreaterThan(0);
  });

  it("ruas yang sudah dilayani satu trip GTFS tetap memakai trip itu, bukan trip sambungan", () => {
    // Kota -> Bundaran HI Astra ada utuh di trip 1-R08.
    const m = gtfs.match(["1"], ["H00275P", "H00068P", "H00133P", "H00281P", "H00280P", "H00278P", "H00131P", "H00268S", "H00207P", "H00022P"])!;
    expect(m.pattern.through).toBeUndefined();
    // Trip 3H berakhir di Kota lalu kembali lewat Glodok (berbalik arah di jalur yang sama): tidak disambung.
    expect(gtfs.match(["3H"], ["H00093P", "H00132P", "H00275P"])!.pattern.through).toBeUndefined();
  });

  it("rute Monumen Nasional -> Kota tetap satu kali naik koridor 1, tidak pindah ke 3H di Harmoni", async () => {
    const s = new Source();
    s.stations = MONAS_KOTA.map((code) => ({ operator: "TJ", code, name: code, lines: ["1", "3H"], amenities: [] }));
    s.lines = [
      { operator: "TJ", code: "1", name: "Blok M - Kota", mode: "BUS", stations: MONAS_KOTA.map(tj) },
      { operator: "TJ", code: "3H", name: "Damai - Kota", mode: "BUS", stations: MONAS_KOTA.slice(1).map(tj) },
    ];
    s.fareStops = MONAS_KOTA.map(tj);
    const { planner } = setup(s);
    const route = (await planner.getRoute("tj:h00131p", "tj:h00275p", newContext()))!;
    expect(route.legs).toHaveLength(1);
    expect(route.legs[0]).toMatchObject({ type: "RIDE", lineId: "tj:1" });
    expect(route.legs[0].stops).toEqual(MONAS_KOTA.map((c) => `tj:${c.toLowerCase()}`));
    expect(route.transfers).toBe(0);
  });
});
