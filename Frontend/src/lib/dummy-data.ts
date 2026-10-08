// DATA DUMMY untuk GUI basic. Nama dan kode stasiun mengikuti Peta Integrasi Transportasi Umum
// Jakarta (FDTJ, edisi 2026-08c), tetapi jarak, waktu, tarif, dan status fasilitas hanyalah
// ilustrasi, bukan data Commute Data API.

import type { Hub, Line, Station } from "./types";

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

export const LINES: (Line & { geometry: (string | Pt)[]; stopAt?: Record<string, Pt> })[] = [
  {
    id: "krl-cikarang",
    name: "Lin Cikarang",
    operator: "KAI Commuter",
    mode: "RAIL",
    color: "#38b6d8",
    stationIds: ["tanah-abang", "bni-city", "sudirman", "manggarai"],
    segmentDistanceM: [2100, 900, 3400],
    segmentMinutes: [4, 2, 6],
    geometry: ["tanah-abang", [2962, 3610], [3030, 3676], "bni-city", "sudirman", [4610, 3680], [4700, 3715], "manggarai"],
    stopAt: { "bni-city": [3585, 3676], manggarai: [4759, 3759] },
  },
  {
    id: "krl-bogor",
    name: "Lin Bogor",
    operator: "KAI Commuter",
    mode: "RAIL",
    color: "#e8262a",
    stationIds: ["jakarta-kota", "jayakarta", "mangga-besar", "sawah-besar", "juanda", "gondangdia", "cikini", "manggarai"],
    segmentDistanceM: [1400, 1300, 1200, 1400, 2100, 1000, 1600],
    segmentMinutes: [2, 2, 2, 2, null, 2, 3],
    geometry: ["jakarta-kota", [4255, 1822], [4324, 1890], "jayakarta", "mangga-besar", "sawah-besar", "juanda", [4324, 3265], "gondangdia", "cikini", "manggarai"],
    stopAt: { manggarai: [4787, 3725] },
  },
  {
    id: "ka-bandara",
    name: "KA Bandara",
    operator: "Railink",
    mode: "RAIL",
    color: "#1d1a5c",
    stationIds: ["manggarai", "bni-city", "duri"],
    segmentDistanceM: [3800, 5600],
    segmentMinutes: [7, null],
    geometry: ["manggarai", [4630, 3719], "bni-city", [2990, 3719], [2918, 3650], "duri"],
    stopAt: { manggarai: [4730, 3781], "bni-city": [3585, 3719] },
  },
  {
    id: "mrt-ns",
    name: "Lin Utara–Selatan",
    operator: "MRT Jakarta",
    mode: "SUBWAY",
    color: "#d0103a",
    stationIds: ["bendungan-hilir", "setiabudi-astra", "dukuh-atas-mrt", "bundaran-hi"],
    segmentDistanceM: [1100, 1000, 1200],
    segmentMinutes: [2, 2, 2],
    geometry: ["bendungan-hilir", "setiabudi-astra", [3636, 3980], "dukuh-atas-mrt", "bundaran-hi"],
  },
  {
    id: "lrt-jbd",
    name: "LRT Jabodebek",
    operator: "KAI",
    mode: "TRAM",
    color: "#155a2a",
    stationIds: ["dukuh-atas-lrt", "setiabudi-lrt", "rasuna-said", "kuningan"],
    segmentDistanceM: [1300, 1100, 900],
    segmentMinutes: [3, 2, null],
    geometry: ["dukuh-atas-lrt", [4235, 3872], [4313, 3950], "setiabudi-lrt", "rasuna-said", "kuningan"],
  },
];

const a = (
  lift: Station["amenities"]["lift"],
  eskalator: Station["amenities"]["eskalator"],
  toilet: Station["amenities"]["toilet"],
  ramp: Station["amenities"]["ramp"],
): Station["amenities"] => ({ lift, eskalator, toilet, ramp });

export const STATIONS: (Station & { codes: string[] })[] = [
  { id: "tanah-abang", codes: ["C10"], name: "Tanah Abang", operator: "KAI Commuter", lineIds: ["krl-cikarang"], amenities: a("available", "available", "available", "absent") },
  { id: "bni-city", codes: ["C11", "A02"], name: "Sudirman Baru BNI City", operator: "KAI Commuter · Railink", lineIds: ["krl-cikarang", "ka-bandara"], amenities: a("available", "available", "available", "available"), hubId: "dukuh-atas" },
  { id: "sudirman", codes: ["C12"], name: "Sudirman", operator: "KAI Commuter", lineIds: ["krl-cikarang"], amenities: a("absent", "available", "available", "unknown"), hubId: "dukuh-atas" },
  { id: "manggarai", codes: ["C13", "B09", "A01"], name: "Manggarai", operator: "KAI Commuter · Railink", lineIds: ["krl-cikarang", "krl-bogor", "ka-bandara"], amenities: a("available", "available", "available", "available") },
  { id: "jakarta-kota", codes: ["B01"], name: "Jakarta Kota", operator: "KAI Commuter", lineIds: ["krl-bogor"], amenities: a("absent", "absent", "available", "available") },
  { id: "jayakarta", codes: ["B02"], name: "Jayakarta", operator: "KAI Commuter", lineIds: ["krl-bogor"], amenities: a("unknown", "unknown", "unknown", "unknown") },
  { id: "mangga-besar", codes: ["B03"], name: "Mangga Besar", operator: "KAI Commuter", lineIds: ["krl-bogor"], amenities: a("available", "available", "unknown", "unknown") },
  { id: "sawah-besar", codes: ["B04"], name: "Sawah Besar", operator: "KAI Commuter", lineIds: ["krl-bogor"], amenities: a("absent", "available", "absent", "unknown") },
  { id: "juanda", codes: ["B05"], name: "Juanda", operator: "KAI Commuter", lineIds: ["krl-bogor"], amenities: a("available", "available", "unknown", "available") },
  { id: "gondangdia", codes: ["B07"], name: "Gondangdia", operator: "KAI Commuter", lineIds: ["krl-bogor"], amenities: a("absent", "available", "available", "unknown") },
  { id: "cikini", codes: ["B08"], name: "Cikini", operator: "KAI Commuter", lineIds: ["krl-bogor"], amenities: a("available", "available", "available", "unknown") },
  { id: "duri", codes: ["A03"], name: "Duri", operator: "Railink", lineIds: ["ka-bandara"], amenities: a("unknown", "unknown", "unknown", "unknown") },
  { id: "bendungan-hilir", codes: ["M10"], name: "Bendungan Hilir", operator: "MRT Jakarta", lineIds: ["mrt-ns"], amenities: a("available", "available", "available", "available") },
  { id: "setiabudi-astra", codes: ["M11"], name: "Setiabudi Astra", operator: "MRT Jakarta", lineIds: ["mrt-ns"], amenities: a("unknown", "unknown", "unknown", "unknown") },
  { id: "dukuh-atas-mrt", codes: ["M12"], name: "Dukuh Atas BNI", operator: "MRT Jakarta", lineIds: ["mrt-ns"], amenities: a("available", "available", "available", "absent"), hubId: "dukuh-atas" },
  { id: "bundaran-hi", codes: ["M13"], name: "Bundaran HI Bank Jakarta", operator: "MRT Jakarta", lineIds: ["mrt-ns"], amenities: a("available", "available", "unknown", "available") },
  { id: "dukuh-atas-lrt", codes: ["BK01", "CB01"], name: "Dukuh Atas BSI (LRT)", operator: "KAI", lineIds: ["lrt-jbd"], amenities: a("available", "available", "available", "unknown"), hubId: "dukuh-atas" },
  { id: "setiabudi-lrt", codes: ["BK02", "CB02"], name: "Setiabudi (LRT)", operator: "KAI", lineIds: ["lrt-jbd"], amenities: a("available", "available", "absent", "unknown") },
  { id: "rasuna-said", codes: ["BK03", "CB03"], name: "Rasuna Said (LRT)", operator: "KAI", lineIds: ["lrt-jbd"], amenities: a("available", "absent", "unknown", "unknown") },
  { id: "kuningan", codes: ["BK04", "CB04"], name: "Kuningan (LRT)", operator: "KAI", lineIds: ["lrt-jbd"], amenities: a("available", "available", "available", "available") },
];

export const HUBS: Hub[] = [
  {
    id: "dukuh-atas",
    name: "Dukuh Atas",
    memberIds: ["sudirman", "bni-city", "dukuh-atas-mrt", "dukuh-atas-lrt"],
    walks: [
      ["sudirman", "bni-city", 250, 4],
      ["sudirman", "dukuh-atas-mrt", 300, null],
      ["bni-city", "dukuh-atas-mrt", 350, 5],
      ["bni-city", "dukuh-atas-lrt", 400, 6],
      ["dukuh-atas-mrt", "dukuh-atas-lrt", 250, 4],
    ],
  },
];

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
  const line = LINES.find((l) => l.id === lineId);
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

export const stationById = (id: string) => STATIONS.find((s) => s.id === id);
export const lineById = (id: string) => LINES.find((l) => l.id === id);
export const hubById = (id: string) => HUBS.find((h) => h.id === id);
