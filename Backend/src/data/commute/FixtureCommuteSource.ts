// Sumber data OFFLINE yang meniru Commute Data API, dipakai untuk pengembangan, pengujian, dan
// demo saat API tidak dapat dihubungi. Isinya sama dengan data dummy GUI
// (Frontend/src/lib/dummy-data.ts): nama dan kode stasiun mengikuti Peta Integrasi FDTJ 2026-08c,
// tetapi jarak, waktu, tarif, dan fasilitas hanyalah ILUSTRASI, bukan data sungguhan.

import type { Mode } from "../../domain/models";
import { UpstreamError } from "../../errors";
import { LINE_INDEX, lineIdOf, refsOf, stationIdOf } from "./station-index";
import type { CommuteSource, UpFare, UpHub, UpLeg, UpLine, UpOperator, UpStation, UpStopRef } from "./types";

type A = "y" | "n" | "?";

interface FxStation {
  id: string;
  name: string;
  /** lift, eskalator, toilet aksesibel, ramp. "?" di keempatnya = data amenity kosong. */
  am: [A, A, A, A];
}

interface FxLine {
  id: string;
  name: string;
  mode: Mode;
  color: string;
  stations: string[];
  distM: number[];
  minutes: (number | null)[];
}

const OPERATORS: UpOperator[] = [
  { code: "KCI", name: "KAI Commuter", mode: "RAIL" },
  { code: "RLK", name: "Railink", mode: "RAIL" },
  { code: "MRTJ", name: "MRT Jakarta", mode: "SUBWAY" },
  { code: "LRTJ", name: "KAI", mode: "TRAM" },
];

const LINES: FxLine[] = [
  { id: "krl-cikarang", name: "Lin Cikarang", mode: "RAIL", color: "#38b6d8", stations: ["tanah-abang", "bni-city", "sudirman", "manggarai"], distM: [2100, 900, 3400], minutes: [4, 2, 6] },
  { id: "krl-bogor", name: "Lin Bogor", mode: "RAIL", color: "#e8262a", stations: ["jakarta-kota", "jayakarta", "mangga-besar", "sawah-besar", "juanda", "gondangdia", "cikini", "manggarai"], distM: [1400, 1300, 1200, 1400, 2100, 1000, 1600], minutes: [2, 2, 2, 2, null, 2, 3] },
  { id: "ka-bandara", name: "KA Bandara", mode: "RAIL", color: "#1d1a5c", stations: ["manggarai", "bni-city", "duri"], distM: [3800, 5600], minutes: [7, null] },
  { id: "mrt-ns", name: "Lin Utara–Selatan", mode: "SUBWAY", color: "#d0103a", stations: ["bendungan-hilir", "setiabudi-astra", "dukuh-atas-mrt", "bundaran-hi"], distM: [1100, 1000, 1200], minutes: [2, 2, 2] },
  { id: "lrt-jbd", name: "LRT Jabodebek", mode: "TRAM", color: "#155a2a", stations: ["dukuh-atas-lrt", "setiabudi-lrt", "rasuna-said", "kuningan"], distM: [1300, 1100, 900], minutes: [3, 2, null] },
];

const STATIONS: FxStation[] = [
  { id: "tanah-abang", name: "Tanah Abang", am: ["y", "y", "y", "n"] },
  { id: "bni-city", name: "Sudirman Baru BNI City", am: ["y", "y", "y", "y"] },
  { id: "sudirman", name: "Sudirman", am: ["n", "y", "y", "?"] },
  { id: "manggarai", name: "Manggarai", am: ["y", "y", "y", "y"] },
  { id: "jakarta-kota", name: "Jakarta Kota", am: ["n", "n", "y", "y"] },
  { id: "jayakarta", name: "Jayakarta", am: ["?", "?", "?", "?"] },
  { id: "mangga-besar", name: "Mangga Besar", am: ["y", "y", "?", "?"] },
  { id: "sawah-besar", name: "Sawah Besar", am: ["n", "y", "n", "?"] },
  { id: "juanda", name: "Juanda", am: ["y", "y", "?", "y"] },
  { id: "gondangdia", name: "Gondangdia", am: ["n", "y", "y", "?"] },
  { id: "cikini", name: "Cikini", am: ["y", "y", "y", "?"] },
  { id: "duri", name: "Duri", am: ["?", "?", "?", "?"] },
  { id: "bendungan-hilir", name: "Bendungan Hilir", am: ["y", "y", "y", "y"] },
  { id: "setiabudi-astra", name: "Setiabudi Astra", am: ["?", "?", "?", "?"] },
  { id: "dukuh-atas-mrt", name: "Dukuh Atas BNI", am: ["y", "y", "y", "n"] },
  { id: "bundaran-hi", name: "Bundaran HI Bank Jakarta", am: ["y", "y", "?", "y"] },
  { id: "dukuh-atas-lrt", name: "Dukuh Atas BSI (LRT)", am: ["y", "y", "y", "?"] },
  { id: "setiabudi-lrt", name: "Setiabudi (LRT)", am: ["y", "y", "n", "?"] },
  { id: "rasuna-said", name: "Rasuna Said (LRT)", am: ["y", "n", "?", "?"] },
  { id: "kuningan", name: "Kuningan (LRT)", am: ["y", "y", "y", "y"] },
];

const HUB = {
  id: "dukuh-atas",
  name: "Dukuh Atas",
  members: ["sudirman", "bni-city", "dukuh-atas-mrt", "dukuh-atas-lrt"],
  walks: [
    ["sudirman", "bni-city", 250, 4],
    ["sudirman", "dukuh-atas-mrt", 300, null],
    ["bni-city", "dukuh-atas-mrt", 350, 5],
    ["bni-city", "dukuh-atas-lrt", 400, 6],
    ["dukuh-atas-mrt", "dukuh-atas-lrt", 250, 4],
  ] as [string, string, number, number | null][],
};

const AMENITY_TYPES = ["ELEVATOR", "ESCALATOR", "ACCESSIBLE_TOILET", "RAMP"];

const lineOperator = (lineId: string) => LINE_INDEX.find((l) => l.id === lineId)!.operator;
const lineCode = (lineId: string) => LINE_INDEX.find((l) => l.id === lineId)!.code;

/** Referensi upstream sebuah stasiun untuk operator tertentu (stasiun bersama punya kode per operator). */
function refFor(stationId: string, operator?: string): UpStopRef {
  const refs = refsOf(stationId);
  return refs.find((r) => r.operator === operator) ?? refs[0];
}

function toUpStation(st: FxStation, ref: UpStopRef): UpStation {
  const unknownAll = st.am.every((x) => x === "?");
  const lines = LINES.filter((l) => l.stations.includes(st.id) && lineOperator(l.id) === ref.operator).map((l) => lineCode(l.id));
  return {
    operator: ref.operator,
    code: ref.code,
    name: st.name,
    lines,
    hub: HUB.members.includes(st.id) ? HUB.id : null,
    amenities: unknownAll ? [] : st.am.flatMap((v, i) => (v === "y" ? [{ type: AMENITY_TYPES[i] }] : [])),
    score: null,
  };
}

interface Edge {
  to: string;
  kind: "RIDE" | "TRANSFER";
  lineId?: string;
  distanceM: number;
  minutes: number | null;
}

const TRANSFER_PENALTY_M = 3000;

export class FixtureCommuteSource implements CommuteSource {
  readonly name = "fixture";
  private graph = new Map<string, Edge[]>();
  /** Untuk pengujian: paksa sumber gagal agar jalur cache/galat (E2) dapat diuji. */
  failing = false;

  constructor() {
    const add = (from: string, e: Edge) => this.graph.set(from, [...(this.graph.get(from) ?? []), e]);
    for (const l of LINES) {
      for (let i = 0; i < l.stations.length - 1; i++) {
        const [x, y] = [l.stations[i], l.stations[i + 1]];
        const base = { kind: "RIDE" as const, lineId: l.id, distanceM: l.distM[i], minutes: l.minutes[i] };
        add(x, { ...base, to: y });
        add(y, { ...base, to: x });
      }
    }
    for (const [x, y, m, min] of HUB.walks) {
      add(x, { to: y, kind: "TRANSFER", distanceM: m, minutes: min });
      add(y, { to: x, kind: "TRANSFER", distanceM: m, minutes: min });
    }
  }

  private check() {
    if (this.failing) throw new UpstreamError("fixture: sumber dimatikan untuk pengujian");
  }

  async getOperators() {
    this.check();
    return OPERATORS;
  }

  async getStations() {
    this.check();
    return STATIONS.flatMap((s) => refsOf(s.id).map((r) => toUpStation(s, r)));
  }

  async getStation(operator: string, code: string) {
    this.check();
    const id = stationIdOf({ operator, code });
    const st = STATIONS.find((s) => s.id === id);
    return st ? toUpStation(st, { operator, code }) : null;
  }

  async getLines(): Promise<UpLine[]> {
    this.check();
    return LINES.map((l) => ({
      operator: lineOperator(l.id),
      code: lineCode(l.id),
      name: l.name,
      color: l.color,
      mode: l.mode,
      stations: l.stations.map((s) => refFor(s, lineOperator(l.id))),
    }));
  }

  async getLine(operator: string, code: string) {
    return (await this.getLines()).find((l) => l.operator === operator && l.code === code) ?? null;
  }

  async getHubs(): Promise<UpHub[]> {
    this.check();
    return [
      {
        id: HUB.id,
        name: HUB.name,
        stations: HUB.members.map((m) => refFor(m)),
        transfers: HUB.walks.map(([f, t, d, min]) => ({ from: refFor(f), to: refFor(t), distanceM: d, durationS: min === null ? null : min * 60 })),
      },
    ];
  }

  async getFare(from: UpStopRef, to: UpStopRef, at?: string): Promise<UpFare | null> {
    this.check();
    const a = stationIdOf(from);
    const b = stationIdOf(to);
    if (!this.graph.has(a) || !this.graph.has(b) || a === b) return null;
    const path = this.findPath(a, b);
    if (!path) return null;

    // Gabungkan ruas berurutan pada lini yang sama; pindah lini di stasiun yang sama = TRANSFER di dalam stasiun.
    type Seg = { type: "RIDE" | "TRANSFER"; lineId?: string; stops: string[]; distanceM: number; minutes: number | null };
    const segs: Seg[] = [];
    for (let i = 1; i < path.length; i++) {
      const e = path[i].via!;
      const prev = segs[segs.length - 1];
      if (e.kind === "RIDE" && prev?.type === "RIDE" && prev.lineId === e.lineId) {
        prev.stops.push(path[i].node);
        prev.distanceM += e.distanceM;
        prev.minutes = prev.minutes === null || e.minutes === null ? null : prev.minutes + e.minutes;
        continue;
      }
      if (e.kind === "RIDE" && prev?.type === "RIDE") {
        const here = path[i - 1].node;
        segs.push({ type: "TRANSFER", stops: [here, here], distanceM: 0, minutes: null });
      }
      segs.push({ type: e.kind, lineId: e.lineId, stops: [path[i - 1].node, path[i].node], distanceM: e.distanceM, minutes: e.minutes });
    }

    const start = at ? new Date(at) : new Date();
    let clock = start.getTime();
    const legs: UpLeg[] = segs.map((s) => {
      const operator = s.lineId ? lineOperator(s.lineId) : undefined;
      const leg: UpLeg = {
        type: s.type,
        operator,
        line: s.lineId ? lineCode(s.lineId) : undefined,
        stops: s.stops.map((x) => refFor(x, operator)),
        distanceM: s.distanceM,
        fare: s.type === "RIDE" ? fareFor(s.lineId!, s.distanceM) : 0,
      };
      if (s.minutes !== null) {
        leg.departureAt = new Date(clock).toISOString();
        clock += s.minutes * 60_000;
        leg.arrivalAt = new Date(clock).toISOString();
      }
      return leg;
    });
    return {
      from,
      to,
      at: start.toISOString(),
      currency: "IDR",
      totalFare: legs.reduce((s, l) => s + (l.fare ?? 0), 0),
      totalDistanceM: legs.reduce((s, l) => s + l.distanceM, 0),
      legs,
    };
  }

  /** Dijkstra pada jaringan dataset (bukan jarak geografis); status = (stasiun, lini) agar pindah lini dihitung transfer. */
  private findPath(from: string, to: string): { node: string; via?: Edge }[] | null {
    const key = (n: string, l: string) => `${n}|${l}`;
    const start = key(from, "start");
    const dist = new Map<string, number>([[start, 0]]);
    const prev = new Map<string, { state: string; edge: Edge }>();
    const done = new Set<string>();
    let goal: string | null = null;
    for (;;) {
      let cur: string | null = null;
      for (const [n, d] of dist) if (!done.has(n) && (cur === null || d < dist.get(cur)!)) cur = n;
      if (cur === null) return null;
      const [node, line] = cur.split("|");
      if (node === to) {
        goal = cur;
        break;
      }
      done.add(cur);
      for (const e of this.graph.get(node) ?? []) {
        let cost = e.distanceM;
        if (e.kind === "TRANSFER" || (line !== "start" && line !== "walk" && line !== e.lineId)) cost += TRANSFER_PENALTY_M;
        const next = key(e.to, e.kind === "TRANSFER" ? "walk" : e.lineId!);
        const nd = dist.get(cur)! + cost;
        if (nd < (dist.get(next) ?? Infinity)) {
          dist.set(next, nd);
          prev.set(next, { state: cur, edge: e });
        }
      }
    }
    const path: { node: string; via?: Edge }[] = [{ node: to }];
    let st = goal;
    while (prev.has(st)) {
      const p = prev.get(st)!;
      path[0].via = p.edge;
      path.unshift({ node: p.state.split("|")[0] });
      st = p.state;
    }
    return path;
  }
}

function fareFor(lineId: string, distanceM: number): number {
  const line = LINES.find((l) => l.id === lineId)!;
  if (line.mode === "SUBWAY") return 3000 + 1000 * Math.ceil(distanceM / 1000);
  if (line.id === "ka-bandara") return 10000;
  if (line.mode === "TRAM") return 5000 + 700 * Math.ceil(distanceM / 1000);
  return 3000;
}

/** Dipakai pengujian untuk memastikan indeks dan fixture sinkron. */
export const FIXTURE_STATION_IDS = STATIONS.map((s) => s.id);
export const FIXTURE_LINE_IDS = LINES.map((l) => lineIdOf(lineOperator(l.id), lineCode(l.id)));
