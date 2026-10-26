// Aset Peta Transit milik frontend: posisi stasiun dan bentuk lini pada Peta Integrasi Transportasi
// Umum Jakarta (FDTJ, edisi 2026-08c). Hanya untuk menggambar; data stasiun, lini, fasilitas, dan
// rute berasal dari Backend (lihat network.tsx).

import COMMUTE_POINTS from "../data/commute-map-points.json";
import { BUS_STOPS, RAIL_STOPS, TRACKS, type BusStopLabel } from "./map-stops";
import type { MapStop, MapTrack } from "./types";

type Pt = [number, number];

/** Ukuran Aset Peta Transit (public/peta/fdtj-2026-08c.svg), dalam satuan pt PDF asli. */
export const MAP_ASSET = {
  src: "/peta/fdtj-2026-08c.svg",
  width: 9513.57,
  height: 6726.88,
  /** Tampilan awal: area hub MVP Dukuh Atas sampai Manggarai. */
  initialView: { x: 2700, y: 2900, width: 2400, height: 1700 },
  credit: "Peta Integrasi Transportasi Umum Jakarta © FDTJ (edisi 2026-08c).",
};

/** Bentuk tiap lini pada peta: urutan id stasiun dan titik belok (satuan pt). */
const LINE_GEOMETRY: Record<string, { geometry: (string | Pt)[]; stopAt?: Record<string, Pt> }> = {
  "krl-cikarang": {
    geometry: ["tanah-abang", [2962, 3610], [3030, 3676], "bni-city", "sudirman", [4610, 3680], [4700, 3715], "manggarai"],
    stopAt: { "bni-city": [3585, 3676], manggarai: [4759, 3759] },
  },
  "krl-bogor": {
    geometry: ["jakarta-kota", [4255, 1822], [4324, 1890], "jayakarta", "mangga-besar", "sawah-besar", "juanda", [4324, 3265], "gondangdia", "cikini", "manggarai"],
    stopAt: { manggarai: [4787, 3725] },
  },
  "ka-bandara": {
    geometry: ["manggarai", [4630, 3719], "bni-city", [2990, 3719], [2918, 3650], "duri"],
    stopAt: { manggarai: [4730, 3781], "bni-city": [3585, 3719] },
  },
  "mrt-ns": {
    geometry: ["bendungan-hilir", "setiabudi-astra", [3636, 3980], "dukuh-atas-mrt", "bundaran-hi"],
  },
  "lrt-jbd": {
    geometry: ["dukuh-atas-lrt", [4235, 3872], [4313, 3950], "setiabudi-lrt", "rasuna-said", "kuningan"],
  },
};

/**
 * Indeks posisi pemberhentian: kode stasiun -> titik (x, y) pada Aset Peta Transit (satuan pt PDF).
 * Dibaca dari PDF peta FDTJ 2026-08c; bukan lintang-bujur dan tidak dipakai menentukan rute.
 */
export const STOP_POSITIONS: Record<string, { x: number; y: number }> = {
  "tanah-abang": { x: 2962, y: 3272 },
  "bni-city": { x: 3585, y: 3697 },
  sudirman: { x: 3835, y: 3676 },
  manggarai: { x: 4759, y: 3756 },
  "jakarta-kota": { x: 3909, y: 1822 },
  jayakarta: { x: 4324, y: 2031 },
  "mangga-besar": { x: 4324, y: 2215 },
  "sawah-besar": { x: 4324, y: 2413 },
  juanda: { x: 4324, y: 2645 },
  gondangdia: { x: 4449, y: 3391 },
  cikini: { x: 4603, y: 3542 },
  duri: { x: 2918, y: 2538 },
  "bendungan-hilir": { x: 3498, y: 4154 },
  "setiabudi-astra": { x: 3597, y: 4047 },
  "dukuh-atas-mrt": { x: 3636, y: 3593 },
  "bundaran-hi": { x: 3636, y: 3492 },
  "dukuh-atas-lrt": { x: 3835, y: 3872 },
  "setiabudi-lrt": { x: 4313, y: 4139 },
  "rasuna-said": { x: 4313, y: 4422 },
  kuningan: { x: 4313, y: 4517 },
};

/** Titik ruas pada peta untuk lini `lineId` dari stasiun `from` ke `to` (mengikuti bentuk lini, bukan garis lurus). */
export function legGeometry(lineId: string, from: string, to: string): Pt[] {
  const line = LINE_GEOMETRY[lineId];
  if (!line) return [];
  const pts: { id?: string; p: Pt }[] = line.geometry.map((g) =>
    typeof g === "string" ? { id: g, p: line.stopAt?.[g] ?? [STOP_POSITIONS[g].x, STOP_POSITIONS[g].y] } : { p: g },
  );
  const i = pts.findIndex((x) => x.id === from);
  const j = pts.findIndex((x) => x.id === to);
  if (i < 0 || j < 0) return [];
  const seg = pts.slice(Math.min(i, j), Math.max(i, j) + 1).map((x) => x.p);
  return i <= j ? seg : seg.reverse();
}

// ---------------------------------------------------------------------------------------------
// Posisi untuk stasiun dan halte di luar indeks STOP_POSITIONS (data dari Commute Data API).

export interface PositionedStation {
  id: string;
  name: string;
  codes: string[];
  lineIds: string[];
  /** Station id Commute (mis. "KCI-SUDB"), kunci posisi pada points.json Commute. */
  commuteIds?: string[];
}

/** Posisi stasiun pada peta FDTJ yang sama, dari Commute (station id -> titik tengah penanda). */
const COMMUTE_AT = COMMUTE_POINTS.points as unknown as Record<string, Pt>;

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Indeks posisi semua stasiun: (1) posisi yang ditetapkan admin, (2) nomor stasiun yang sama dengan
 * penanda di peta (mis. C12, 1-13), (3) station id Commute pada points.json Commute, (4) STOP_POSITIONS
 * yang dikurasi, (5) khusus halte TransJakarta: nama halte di peta, dipersempit dengan nomor koridor.
 * Stasiun yang tidak ditemukan tidak digambar di peta.
 */
export function buildPositions(stations: PositionedStation[], overrides: MapStop[] = []): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const manual = new Map(overrides.map((o) => [o.stationId, { x: o.x, y: o.y }]));
  const busByCode = new Map<string, BusStopLabel>();
  for (const b of BUS_STOPS) for (const c of b.codes) busByCode.set(c, b);
  const busNames = BUS_STOPS.filter((b) => b.name).map((b) => ({ b, n: norm(b.name), corridors: b.codes.map((c) => c.split("-")[0]) }));
  for (const s of stations) {
    const set = manual.get(s.id);
    if (set) {
      out.set(s.id, set);
      continue;
    }
    // Penanda di peta lebih dulu, agar titik tepat di lingkaran pemberhentian lini tersebut.
    const code = s.codes.find((c) => RAIL_STOPS[c] || busByCode.get(c)?.exact);
    if (code) {
      const [x, y] = RAIL_STOPS[code] ?? busByCode.get(code)!.at;
      out.set(s.id, { x, y });
      continue;
    }
    // Commute memakai peta FDTJ yang sama, jadi station id-nya kunci yang stabil (tanpa mencocokkan nama).
    const live = s.commuteIds?.find((c) => COMMUTE_AT[c]);
    if (live) {
      const [x, y] = COMMUTE_AT[live];
      out.set(s.id, { x, y });
      continue;
    }
    const label = s.codes.find((c) => busByCode.has(c));
    if (label) {
      const [x, y] = busByCode.get(label)!.at;
      out.set(s.id, { x, y });
      continue;
    }
    const fixed = STOP_POSITIONS[s.id];
    if (fixed) {
      out.set(s.id, fixed);
      continue;
    }
    const corridors = s.lineIds.filter((l) => l.startsWith("tj:")).map((l) => l.slice(3).toUpperCase());
    if (!corridors.length) continue;
    const n = norm(s.name);
    const cands = busNames.filter((x) => x.n === n || n.startsWith(x.n + " ") || x.n.startsWith(n + " "));
    const onCorridor = cands.filter((x) => x.corridors.some((c) => corridors.includes(c)));
    // Nama sama di koridor lain (mis. "8-23 Petojo" untuk halte Petojo Koridor 1) hanya dipakai bila koridornya tidak ada di peta.
    const corridorOnMap = busNames.some((x) => x.corridors.some((c) => corridors.includes(c)));
    const pick = onCorridor.length === 1 ? onCorridor[0] : !corridorOnMap && cands.length === 1 ? cands[0] : null;
    if (pick) out.set(s.id, { x: pick.b.at[0], y: pick.b.at[1] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Garis rute yang mengikuti jalur di peta (TRACKS), termasuk lengkungan dan belokan.

type Edge = { to: string; color: [number, number, number]; points: Pt[]; length: number };

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const v = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const colorDiff = (a: [number, number, number], b: [number, number, number]) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const polyLength = (pts: Pt[]) => pts.reduce((sum, p, i) => (i ? sum + dist(pts[i - 1], p) : 0), 0);

let graph: { nodes: [string, Pt][]; edges: Map<string, Edge[]> } | null = null;

function trackGraph() {
  if (graph) return graph;
  const nodes = new Map<string, Pt>();
  for (const [code, at] of Object.entries(RAIL_STOPS)) nodes.set(code, at);
  for (const b of BUS_STOPS) if (b.exact && b.codes[0]) nodes.set(b.codes[0], b.at);
  const edges = new Map<string, Edge[]>();
  const add = (from: string, e: Edge) => {
    if (!edges.has(from)) edges.set(from, []);
    edges.get(from)!.push(e);
  };
  for (const [key, list] of Object.entries(TRACKS)) {
    const [a, b] = key.split("|");
    const pa = nodes.get(a);
    const pb = nodes.get(b);
    if (!pa || !pb) continue;
    for (const t of list) {
      const points: Pt[] = [pa, ...t.points, pb];
      const color = rgb(t.color);
      const length = polyLength(points);
      add(a, { to: b, color, points, length });
      add(b, { to: a, color, points: [...points].reverse(), length });
    }
  }
  graph = { nodes: [...nodes.entries()], edges };
  return graph;
}

/**
 * Kunci penanda (kode stasiun/halte) terdekat dari posisi `p`, bila ada. Toleransinya selebar penanda,
 * karena posisi dari Commute atau admin bisa sedikit bergeser dari pusat lingkaran.
 */
function nodeAt(p: Pt): string | undefined {
  let best: string | undefined;
  let bestD = 12;
  for (const [key, at] of trackGraph().nodes) {
    const d = dist(at, p);
    if (d < bestD) [best, bestD] = [key, d];
  }
  return best;
}

/**
 * Jalur peta antara dua penanda: Dijkstra di atas ruas TRACKS, panjang ruas diperberat bila warnanya
 * jauh dari warna lini, dibatasi 3x jarak lurus. null = tidak ada jalur di peta.
 */
function trackBetween(a: string, b: string, color: [number, number, number], straight: number): Pt[] | null {
  const { edges } = trackGraph();
  const limit = straight * 3 + 200;
  const best = new Map<string, number>([[a, 0]]);
  const prev = new Map<string, { from: string; edge: Edge }>();
  const queue: [number, string][] = [[0, a]];
  while (queue.length) {
    queue.sort((x, y) => x[0] - y[0]);
    const [d, k] = queue.shift()!;
    if (k === b) break;
    if (d > (best.get(k) ?? Infinity) || d > limit) continue;
    for (const e of edges.get(k) ?? []) {
      const nd = d + e.length * (1 + colorDiff(e.color, color) / 120);
      if (nd < (best.get(e.to) ?? Infinity)) {
        best.set(e.to, nd);
        prev.set(e.to, { from: k, edge: e });
        queue.push([nd, e.to]);
      }
    }
  }
  if (!prev.has(b)) return null;
  const parts: Pt[][] = [];
  for (let k = b; k !== a; ) {
    const step = prev.get(k)!;
    parts.unshift(step.edge.points);
    k = step.from;
  }
  if (polyLength(parts.flat()) > limit) return null;
  return parts.flatMap((pts, i) => (i ? pts.slice(1) : pts));
}

/** Bentuk jalur dari admin untuk lini `lineId` dari `from` ke `to` (dibalik bila tersimpan terbalik). */
function manualTrack(tracks: MapTrack[], lineId: string | undefined, from: string, to: string): Pt[] | null {
  if (!lineId) return null;
  for (const t of tracks) {
    if (t.lineId !== lineId) continue;
    if (t.fromStationId === from && t.toStationId === to) return t.points;
    if (t.fromStationId === to && t.toStationId === from) return [...t.points].reverse();
  }
  return null;
}

/**
 * Garis untuk satu ruas naik: lewati semua pemberhentian (posisi penanda) berurutan dan, di antara dua
 * pemberhentian, pakai bentuk jalur dari admin bila ada, lalu jalur di peta. Bila keduanya tidak ada,
 * pakai garis lurus.
 */
export function ridePath(stops: { id: string; x: number; y: number }[], lineColor: string, opts: { lineId?: string; tracks?: MapTrack[] } = {}): Pt[] {
  const color = rgb(lineColor);
  const pts: Pt[] = [];
  stops.forEach((s, i) => {
    const p: Pt = [s.x, s.y];
    if (i === 0) return pts.push(p);
    const manual = manualTrack(opts.tracks ?? [], opts.lineId, stops[i - 1].id, s.id);
    if (manual) return pts.push(...manual, p);
    const q: Pt = [stops[i - 1].x, stops[i - 1].y];
    const a = nodeAt(q);
    const b = nodeAt(p);
    const track = a && b && a !== b ? trackBetween(a, b, color, dist(q, p)) : null;
    pts.push(...(track ? track.slice(1) : [p]));
  });
  return pts;
}
