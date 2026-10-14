// Indeks identitas NTD <-> Commute Data API.
//
// GUI (Frontend/src/lib/dummy-data.ts) memakai id stasiun dan lini berbentuk slug, karena indeks posisi
// pada Aset Peta Transit (STOP_POSITIONS) dan geometri lini dikunci dengan slug tersebut. Commute Data API
// memakai pasangan (operator, kode). Tabel di bawah menjembatani keduanya dan dipelihara tim
// bersama indeks posisi peta (Risiko #13, NTD-16). Stasiun/lini di luar tabel tetap bisa dipakai
// dengan id turunan `operator:kode`.

import type { StationRef } from "../../domain/models";

export interface StationIndexEntry {
  id: string;
  refs: StationRef[];
  /** Label kode di peta (mis. C13, B09, A01). */
  codes: string[];
}

export const STATION_INDEX: StationIndexEntry[] = [
  { id: "tanah-abang", refs: [{ operator: "KCI", code: "C10" }], codes: ["C10"] },
  { id: "bni-city", refs: [{ operator: "KCI", code: "C11" }, { operator: "RLK", code: "A02" }], codes: ["C11", "A02"] },
  { id: "sudirman", refs: [{ operator: "KCI", code: "C12" }], codes: ["C12"] },
  { id: "manggarai", refs: [{ operator: "KCI", code: "C13" }, { operator: "KCI", code: "B09" }, { operator: "RLK", code: "A01" }], codes: ["C13", "B09", "A01"] },
  { id: "jakarta-kota", refs: [{ operator: "KCI", code: "B01" }], codes: ["B01"] },
  { id: "jayakarta", refs: [{ operator: "KCI", code: "B02" }], codes: ["B02"] },
  { id: "mangga-besar", refs: [{ operator: "KCI", code: "B03" }], codes: ["B03"] },
  { id: "sawah-besar", refs: [{ operator: "KCI", code: "B04" }], codes: ["B04"] },
  { id: "juanda", refs: [{ operator: "KCI", code: "B05" }], codes: ["B05"] },
  { id: "gondangdia", refs: [{ operator: "KCI", code: "B07" }], codes: ["B07"] },
  { id: "cikini", refs: [{ operator: "KCI", code: "B08" }], codes: ["B08"] },
  { id: "duri", refs: [{ operator: "RLK", code: "A03" }], codes: ["A03"] },
  { id: "bendungan-hilir", refs: [{ operator: "MRTJ", code: "M10" }], codes: ["M10"] },
  { id: "setiabudi-astra", refs: [{ operator: "MRTJ", code: "M11" }], codes: ["M11"] },
  { id: "dukuh-atas-mrt", refs: [{ operator: "MRTJ", code: "M12" }], codes: ["M12"] },
  { id: "bundaran-hi", refs: [{ operator: "MRTJ", code: "M13" }], codes: ["M13"] },
  { id: "dukuh-atas-lrt", refs: [{ operator: "LRTJ", code: "BK01" }, { operator: "LRTJ", code: "CB01" }], codes: ["BK01", "CB01"] },
  { id: "setiabudi-lrt", refs: [{ operator: "LRTJ", code: "BK02" }, { operator: "LRTJ", code: "CB02" }], codes: ["BK02", "CB02"] },
  { id: "rasuna-said", refs: [{ operator: "LRTJ", code: "BK03" }, { operator: "LRTJ", code: "CB03" }], codes: ["BK03", "CB03"] },
  { id: "kuningan", refs: [{ operator: "LRTJ", code: "BK04" }, { operator: "LRTJ", code: "CB04" }], codes: ["BK04", "CB04"] },
];

export interface LineIndexEntry {
  id: string;
  operator: string;
  code: string;
}

export const LINE_INDEX: LineIndexEntry[] = [
  { id: "krl-cikarang", operator: "KCI", code: "CKR" },
  { id: "krl-bogor", operator: "KCI", code: "BOO" },
  { id: "ka-bandara", operator: "RLK", code: "SHIA" },
  { id: "mrt-ns", operator: "MRTJ", code: "NS" },
  { id: "lrt-jbd", operator: "LRTJ", code: "JBD" },
];

const refKey = (r: StationRef) => `${r.operator}:${r.code}`.toUpperCase();

const BY_REF = new Map<string, StationIndexEntry>();
for (const e of STATION_INDEX) for (const r of e.refs) BY_REF.set(refKey(r), e);
const BY_ID = new Map(STATION_INDEX.map((e) => [e.id, e]));
const LINE_BY_REF = new Map(LINE_INDEX.map((l) => [`${l.operator}:${l.code}`.toUpperCase(), l]));
const LINE_BY_ID = new Map(LINE_INDEX.map((l) => [l.id, l]));

/** id NTD untuk sebuah stasiun upstream. */
export function stationIdOf(ref: StationRef): string {
  return BY_REF.get(refKey(ref))?.id ?? refKey(ref).toLowerCase();
}

/** Semua referensi upstream untuk id NTD. */
export function refsOf(stationId: string): StationRef[] {
  const e = BY_ID.get(stationId);
  if (e) return e.refs;
  const m = /^([a-z0-9]+):([a-z0-9-]+)$/i.exec(stationId);
  return m ? [{ operator: m[1].toUpperCase(), code: m[2].toUpperCase() }] : [];
}

export function codesOf(stationId: string, fallback: string): string[] {
  return BY_ID.get(stationId)?.codes ?? [fallback];
}

export function lineIdOf(operator: string, code: string): string {
  return LINE_BY_REF.get(`${operator}:${code}`.toUpperCase())?.id ?? `${operator}:${code}`.toLowerCase();
}

export function lineRefOf(lineId: string): { operator: string; code: string } | undefined {
  const l = LINE_BY_ID.get(lineId);
  if (l) return { operator: l.operator, code: l.code };
  const m = /^([a-z0-9]+):([a-z0-9-]+)$/i.exec(lineId);
  return m ? { operator: m[1].toUpperCase(), code: m[2].toUpperCase() } : undefined;
}
