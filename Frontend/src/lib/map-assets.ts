// Aset Peta Transit milik frontend: posisi stasiun dan bentuk lini pada Peta Integrasi Transportasi
// Umum Jakarta (FDTJ, edisi 2026-08c). Hanya untuk menggambar; data stasiun, lini, fasilitas, dan
// rute berasal dari Backend (lihat network.tsx).

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
