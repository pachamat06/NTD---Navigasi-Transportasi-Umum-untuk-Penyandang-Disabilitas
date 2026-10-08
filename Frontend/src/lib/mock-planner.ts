// Simulasi POST /api/plan dengan data dummy. Nanti diganti panggilan ke Backend;
// bentuk respons {status, data} sudah mengikuti Bab III (3.2.3 langkah 8).

import { HUBS, LINES, STATIONS, hubById, lineById, stationById } from "./dummy-data";
import type {
  Alternative,
  AmenityType,
  JourneyPlan,
  Notification,
  PlanResponse,
  Route,
  RouteLeg,
  StationAssessment,
} from "./types";

export const ADEQUATE_THRESHOLD = 70;

const WEIGHTS: Record<AmenityType, number> = { lift: 40, eskalator: 20, toilet: 25, ramp: 15 };

export const AMENITY_LABEL: Record<AmenityType, string> = {
  lift: "Lift",
  eskalator: "Eskalator",
  toilet: "Toilet aksesibel",
  ramp: "Ramp",
};

export const DISCLAIMER =
  "Informasi fasilitas berasal dari data statis dan bisa berbeda dengan kondisi di lapangan. Bukan status real-time.";

export function assess(stationId: string): StationAssessment {
  const st = stationById(stationId)!;
  const entries = Object.entries(st.amenities) as [AmenityType, string][];
  const dataAvailable = entries.some(([, v]) => v !== "unknown");
  const score = entries.reduce((sum, [k, v]) => sum + (v === "available" ? WEIGHTS[k] : 0), 0);
  return { stationId, score, adequate: dataAvailable && score >= ADEQUATE_THRESHOLD, dataAvailable };
}

type Edge = {
  to: string;
  kind: "RIDE" | "TRANSFER";
  lineId?: string;
  distanceM: number;
  minutes: number | null;
};

function buildGraph(): Map<string, Edge[]> {
  const g = new Map<string, Edge[]>();
  const add = (from: string, e: Edge) => g.set(from, [...(g.get(from) ?? []), e]);
  for (const line of LINES) {
    for (let i = 0; i < line.stationIds.length - 1; i++) {
      const [x, y] = [line.stationIds[i], line.stationIds[i + 1]];
      const base = { kind: "RIDE" as const, lineId: line.id, distanceM: line.segmentDistanceM[i], minutes: line.segmentMinutes[i] };
      add(x, { ...base, to: y });
      add(y, { ...base, to: x });
    }
  }
  for (const hub of HUBS) {
    for (const [x, y, m, min] of hub.walks) {
      add(x, { to: y, kind: "TRANSFER", distanceM: m, minutes: min });
      add(y, { to: x, kind: "TRANSFER", distanceM: m, minutes: min });
    }
  }
  return g;
}

const GRAPH = buildGraph();
const TRANSFER_PENALTY_M = 3000;

/**
 * Mencari jalur pada jaringan dataset (bukan jarak geografis). Status = (stasiun, lini saat ini) agar
 * pindah lini di stasiun yang sama (mis. Manggarai) juga dihitung sebagai transfer.
 * `avoid` = stasiun yang tidak boleh menjadi titik transfer.
 */
function findPath(from: string, to: string, avoid: string[]): { node: string; via?: Edge }[] | null {
  type State = string; // `${stasiun}|${lini|walk|start}`
  const key = (n: string, l: string) => `${n}|${l}`;
  const start = key(from, "start");
  const dist = new Map<State, number>([[start, 0]]);
  const prev = new Map<State, { state: State; edge: Edge }>();
  const done = new Set<State>();
  let goal: State | null = null;
  while (true) {
    let cur: State | null = null;
    for (const [n, d] of dist) if (!done.has(n) && (cur === null || d < dist.get(cur)!)) cur = n;
    if (cur === null) return null;
    const [node, line] = cur.split("|");
    if (node === to) {
      goal = cur;
      break;
    }
    done.add(cur);
    for (const e of GRAPH.get(node) ?? []) {
      let cost = e.distanceM;
      if (e.kind === "TRANSFER") {
        if (avoid.includes(e.to) || avoid.includes(node)) continue;
        cost += TRANSFER_PENALTY_M;
      } else if (line !== "start" && line !== "walk" && line !== e.lineId) {
        if (avoid.includes(node)) continue;
        cost += TRANSFER_PENALTY_M;
      }
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

function fareFor(lineId: string, distanceM: number): number {
  const line = lineById(lineId)!;
  if (line.mode === "SUBWAY") return 3000 + 1000 * Math.ceil(distanceM / 1000);
  if (line.id === "ka-bandara") return 10000;
  if (line.mode === "TRAM") return 5000 + 700 * Math.ceil(distanceM / 1000);
  return 3000;
}

function toRoute(path: { node: string; via?: Edge }[]): Route {
  const legs: RouteLeg[] = [];
  for (let i = 1; i < path.length; i++) {
    const e = path[i].via!;
    const prevLeg = legs[legs.length - 1];
    if (e.kind === "RIDE" && prevLeg?.type === "RIDE" && prevLeg.lineId === e.lineId) {
      prevLeg.stops.push(path[i].node);
      prevLeg.distanceM += e.distanceM;
      prevLeg.minutes = prevLeg.minutes === null || e.minutes === null ? null : prevLeg.minutes + e.minutes;
      continue;
    }
    if (e.kind === "RIDE" && prevLeg?.type === "RIDE") {
      // Pindah lini di stasiun yang sama (mis. Manggarai): transfer di dalam stasiun.
      const here = path[i - 1].node;
      legs.push({ type: "TRANSFER", stops: [here, here], distanceM: 0, minutes: null, fare: 0 });
    }
    legs.push({ type: e.kind, lineId: e.lineId, stops: [path[i - 1].node, path[i].node], distanceM: e.distanceM, minutes: e.minutes, fare: 0 });
  }
  for (const leg of legs) if (leg.type === "RIDE") leg.fare = fareFor(leg.lineId!, leg.distanceM);
  const timeComplete = legs.every((l) => l.minutes !== null);
  return {
    legs,
    totalDistanceM: legs.reduce((s, l) => s + l.distanceM, 0),
    totalMinutes: legs.some((l) => l.minutes !== null) ? legs.reduce((s, l) => s + (l.minutes ?? 0), 0) : null,
    timeComplete,
    totalFare: legs.reduce((s, l) => s + l.fare, 0),
    transfers: legs.filter((l) => l.type === "TRANSFER").length,
  };
}

export function routeStationIds(route: Route): string[] {
  const ids: string[] = [];
  for (const leg of route.legs) for (const s of leg.stops) if (ids[ids.length - 1] !== s) ids.push(s);
  return ids;
}

function transferStationIds(route: Route): string[] {
  return [...new Set(route.legs.filter((l) => l.type === "TRANSFER").flatMap((l) => l.stops))];
}

function findAlternatives(from: string, to: string, route: Route, avoid: string[]): Alternative[] {
  const weak = transferStationIds(route).filter((id) => !assess(id).adequate);
  const result: Alternative[] = [];
  for (const weakId of weak) {
    const hubId = stationById(weakId)?.hubId;
    if (!hubId) continue;
    const nextAvoid = [...avoid, weakId];
    const path = findPath(from, to, nextAvoid);
    if (!path) continue;
    const alt = toRoute(path);
    const via = transferStationIds(alt).filter((id) => !transferStationIds(route).includes(id));
    for (const v of via) {
      const assessment = assess(v);
      if (assessment.score > assess(weakId).score && !result.some((r) => r.viaStationId === v)) {
        result.push({ hubId, viaStationId: v, replacesStationId: weakId, assessment, avoid: nextAvoid });
      }
    }
  }
  return result;
}

/** Template statis Grounding Guard: hanya menyebut fakta yang ada di hasil tool. */
function composeNotification(route: Route, assessments: StationAssessment[]): Notification {
  const name = (id: string) => stationById(id)!.name;
  const parts: string[] = [];
  route.legs.forEach((leg, i) => {
    if (leg.type === "RIDE") {
      const line = lineById(leg.lineId!)!;
      parts.push(`${i === 0 ? "Naik" : "lalu naik"} ${line.operator} ${line.name} dari ${name(leg.stops[0])} ke ${name(leg.stops[leg.stops.length - 1])}`);
    } else {
      parts.push(leg.stops[0] === leg.stops[1] ? `pindah lini di dalam Stasiun ${name(leg.stops[0])}` : `pindah dengan berjalan kaki ke ${name(leg.stops[1])}`);
    }
  });
  const key = new Set(route.legs.flatMap((l) => [l.stops[0], l.stops[l.stops.length - 1]]));
  const notes: string[] = [];
  for (const a of assessments.filter((x) => key.has(x.stationId))) {
    const st = stationById(a.stationId)!;
    if (!a.dataAvailable) notes.push(`Data fasilitas ${st.name} belum tersedia.`);
    else if (st.amenities.lift === "available") notes.push(`Lift tercatat tersedia di ${st.name}.`);
    else if (st.amenities.lift === "unknown") notes.push(`Data lift di ${st.name} tidak tersedia.`);
    else notes.push(`Lift tidak tercatat di ${st.name}.`);
  }
  return { text: `${parts.join(", ")}. ${notes.join(" ")}`, source: "TEMPLATE", grounded: true };
}

export type DemoMode = "normal" | "cache" | "down";

export async function planJourney(
  originId: string,
  destinationId: string,
  opts: { avoid?: string[]; demoMode?: DemoMode } = {},
): Promise<PlanResponse> {
  const { avoid = [], demoMode = "normal" } = opts;
  if (!stationById(originId) || !stationById(destinationId) || originId === destinationId) {
    return { status: "error", code: "INVALID", message: "Pilih stasiun asal dan tujuan yang berbeda dari daftar saran." };
  }
  if (demoMode === "down") {
    return { status: "error", code: "API_DOWN", message: "Sumber data sedang tidak dapat dihubungi dan belum ada data tersimpan untuk rute ini." };
  }
  const path = findPath(originId, destinationId, avoid);
  if (!path) {
    return {
      status: "error",
      code: "NOT_FOUND",
      message: `Rute antara ${stationById(originId)!.name} dan ${stationById(destinationId)!.name} tidak ditemukan dalam data saat ini.`,
    };
  }
  const route = toRoute(path);
  const assessments = routeStationIds(route).map(assess);
  const warnings: string[] = [];
  if (!route.timeComplete) warnings.push("Sebagian ruas tidak memiliki data waktu tempuh, sehingga total waktu belum lengkap.");
  const alternatives = findAlternatives(originId, destinationId, route, avoid);
  const weak = transferStationIds(route).filter((id) => !assess(id).adequate);
  if (weak.length && !alternatives.length) warnings.push("Tidak ada alternatif transfer yang lebih aksesibel di hub ini.");

  const data: JourneyPlan = {
    originId,
    destinationId,
    route,
    assessments,
    alternatives,
    notification: composeNotification(route, assessments),
    warnings,
    disclaimer: DISCLAIMER,
    fromCache: demoMode === "cache" ? "7 Oktober 2026, 21.00 WIB" : undefined,
  };
  return { status: "ok", data };
}

export function searchStations(query: string) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return STATIONS.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 6);
}

export { hubById };
