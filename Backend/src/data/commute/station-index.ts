// Indeks identitas NTD <-> Commute Data API.
//
// GUI memakai id stasiun dan lini berbentuk slug, karena indeks posisi pada Aset Peta Transit
// (Frontend/src/lib/map-assets.ts) dan geometri lini dikunci dengan slug tersebut. Commute Data API
// memakai pasangan (operator, kode), mis. KCI-SUD. Tabel di bawah menjembatani keduanya dan dipelihara
// tim bersama indeks posisi peta (Risiko #13, NTD-16):
// - `refs`  = kode pada sumber offline (FixtureCommuteSource), mengikuti label peta FDTJ;
// - `match` = cara mengenali stasiun yang sama pada API sungguhan: kode operator + nama tampilan atau
//             nama resmi (officialName). Kode asli API tidak ditulis tetap agar tahan perubahan kode.
// Stasiun di luar tabel tetap bisa dipakai dengan id turunan `operator:kode` (huruf kecil).

import type { StationRef } from "../../domain/models";
import type { UpStation } from "./types";

export interface StationIndexEntry {
  id: string;
  refs: StationRef[];
  /** Label kode di peta (mis. C13, B09, A01). */
  codes: string[];
  match: { operators: string[]; names: string[] };
}

const m = (operators: string[], ...names: string[]) => ({ operators, names });

export const STATION_INDEX: StationIndexEntry[] = [
  { id: "tanah-abang", refs: [{ operator: "KCI", code: "C10" }], codes: ["C10"], match: m(["KCI"], "Tanah Abang") },
  { id: "bni-city", refs: [{ operator: "KCI", code: "C11" }, { operator: "RLK", code: "A02" }], codes: ["C11", "A02"], match: m(["KCI", "RLK"], "BNI City", "Sudirman Baru", "Sudirman Baru BNI City") },
  { id: "sudirman", refs: [{ operator: "KCI", code: "C12" }], codes: ["C12"], match: m(["KCI"], "Sudirman") },
  { id: "manggarai", refs: [{ operator: "KCI", code: "C13" }, { operator: "KCI", code: "B09" }, { operator: "RLK", code: "A01" }], codes: ["C13", "B09", "A01"], match: m(["KCI", "RLK"], "Manggarai") },
  { id: "jakarta-kota", refs: [{ operator: "KCI", code: "B01" }], codes: ["B01"], match: m(["KCI"], "Jakarta Kota") },
  { id: "jayakarta", refs: [{ operator: "KCI", code: "B02" }], codes: ["B02"], match: m(["KCI"], "Jayakarta") },
  { id: "mangga-besar", refs: [{ operator: "KCI", code: "B03" }], codes: ["B03"], match: m(["KCI"], "Mangga Besar") },
  { id: "sawah-besar", refs: [{ operator: "KCI", code: "B04" }], codes: ["B04"], match: m(["KCI"], "Sawah Besar") },
  { id: "juanda", refs: [{ operator: "KCI", code: "B05" }], codes: ["B05"], match: m(["KCI"], "Juanda") },
  { id: "gondangdia", refs: [{ operator: "KCI", code: "B07" }], codes: ["B07"], match: m(["KCI"], "Gondangdia") },
  { id: "cikini", refs: [{ operator: "KCI", code: "B08" }], codes: ["B08"], match: m(["KCI"], "Cikini") },
  { id: "duri", refs: [{ operator: "RLK", code: "A03" }], codes: ["A03"], match: m(["KCI", "RLK"], "Duri") },
  { id: "bendungan-hilir", refs: [{ operator: "MRTJ", code: "M10" }], codes: ["M10"], match: m(["MRTJ"], "Bendungan Hilir") },
  { id: "setiabudi-astra", refs: [{ operator: "MRTJ", code: "M11" }], codes: ["M11"], match: m(["MRTJ"], "Setiabudi Astra", "Setiabudi") },
  { id: "dukuh-atas-mrt", refs: [{ operator: "MRTJ", code: "M12" }], codes: ["M12"], match: m(["MRTJ"], "Dukuh Atas BNI", "Dukuh Atas") },
  { id: "bundaran-hi", refs: [{ operator: "MRTJ", code: "M13" }], codes: ["M13"], match: m(["MRTJ"], "Bundaran HI Bank Jakarta", "Bundaran HI") },
  { id: "dukuh-atas-lrt", refs: [{ operator: "LRTJ", code: "BK01" }, { operator: "LRTJ", code: "CB01" }], codes: ["BK01", "CB01"], match: m(["LRTJBDB"], "Dukuh Atas BSI", "Dukuh Atas") },
  { id: "setiabudi-lrt", refs: [{ operator: "LRTJ", code: "BK02" }, { operator: "LRTJ", code: "CB02" }], codes: ["BK02", "CB02"], match: m(["LRTJBDB"], "Setiabudi") },
  { id: "rasuna-said", refs: [{ operator: "LRTJ", code: "BK03" }, { operator: "LRTJ", code: "CB03" }], codes: ["BK03", "CB03"], match: m(["LRTJBDB"], "Rasuna Said") },
  { id: "kuningan", refs: [{ operator: "LRTJ", code: "BK04" }, { operator: "LRTJ", code: "CB04" }], codes: ["BK04", "CB04"], match: m(["LRTJBDB"], "Kuningan") },
];

export interface LineIndexEntry {
  id: string;
  /** Kunci pada sumber offline. */
  operator: string;
  code: string;
  /** Kunci `OPERATOR:KODE` pada API sungguhan; `OPERATOR:*` = semua lini operator itu. */
  live: string[];
}

export const LINE_INDEX: LineIndexEntry[] = [
  { id: "krl-cikarang", operator: "KCI", code: "CKR", live: ["KCI:C"] },
  { id: "krl-bogor", operator: "KCI", code: "BOO", live: ["KCI:B"] },
  { id: "ka-bandara", operator: "RLK", code: "SHIA", live: ["KCI:A"] },
  { id: "mrt-ns", operator: "MRTJ", code: "NS", live: ["MRTJ:M"] },
  // LRT Jabodebek punya lebih dari satu lin (Cibubur, Bekasi) yang berbagi ruas Dukuh Atas–Cawang.
  { id: "lrt-jbd", operator: "LRTJ", code: "JBD", live: ["LRTJBDB:*"] },
];

const refKey = (r: StationRef) => `${r.operator}:${r.code}`.toUpperCase();
const derivedId = (r: StationRef) => refKey(r).toLowerCase();

const BY_REF = new Map<string, StationIndexEntry>();
for (const e of STATION_INDEX) for (const r of e.refs) BY_REF.set(refKey(r), e);
const BY_ID = new Map(STATION_INDEX.map((e) => [e.id, e]));
const LINE_BY_KEY = new Map<string, LineIndexEntry>();
for (const l of LINE_INDEX) for (const k of [`${l.operator}:${l.code}`, ...l.live]) LINE_BY_KEY.set(k.toUpperCase(), l);
const LINE_BY_ID = new Map(LINE_INDEX.map((l) => [l.id, l]));

function parseDerived(stationId: string): StationRef[] {
  const x = /^([a-z0-9]+):([a-z0-9-]+)$/i.exec(stationId);
  return x ? [{ operator: x[1].toUpperCase(), code: x[2].toUpperCase() }] : [];
}

/** id NTD untuk sebuah stasiun pada sumber offline. */
export function stationIdOf(ref: StationRef): string {
  return BY_REF.get(refKey(ref))?.id ?? derivedId(ref);
}

/** Referensi sumber offline untuk id NTD. */
export function refsOf(stationId: string): StationRef[] {
  return BY_ID.get(stationId)?.refs ?? parseDerived(stationId);
}

export function codesOf(stationId: string, fallback: string): string[] {
  return BY_ID.get(stationId)?.codes ?? [fallback];
}

export function lineIdOf(operator: string, code: string): string {
  const key = `${operator}:${code}`.toUpperCase();
  return (LINE_BY_KEY.get(key) ?? LINE_BY_KEY.get(`${operator}:*`.toUpperCase()))?.id ?? key.toLowerCase();
}

export function lineRefOf(lineId: string): { operator: string; code: string } | undefined {
  const l = LINE_BY_ID.get(lineId);
  if (l) return { operator: l.operator, code: l.code };
  const x = /^([a-z0-9]+):([a-z0-9-]+)$/i.exec(lineId);
  return x ? { operator: x[1].toUpperCase(), code: x[2].toUpperCase() } : undefined;
}

// ---------------------------------------------------------------------------------------------
// Indeks yang dibangun dari daftar stasiun sumber data (offline maupun API sungguhan).

export interface StationIndex {
  idOf(ref: StationRef): string;
  refsOf(stationId: string): StationRef[];
  codesOf(stationId: string, fallback: string): string[];
  /** Slug pada tabel yang tidak ditemukan pada sumber data (untuk pemeriksaan di halaman admin). */
  unmatched: string[];
}

export const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/^\s*stasiun\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Mencocokkan stasiun sumber data ke slug NTD: (1) kode sumber offline, (2) nama sama persis
 * dengan operator yang sesuai, (3) nama diawali nama tabel bila kandidatnya tunggal. Sisanya memakai id turunan.
 */
export function buildStationIndex(stations: UpStation[]): StationIndex {
  const idByRef = new Map<string, string>();
  const refsById = new Map<string, StationRef[]>();
  const assign = (s: UpStation, id: string) => {
    idByRef.set(refKey(s), id);
    refsById.set(id, [...(refsById.get(id) ?? []), { operator: s.operator, code: s.code }]);
  };
  const rest: UpStation[] = [];
  for (const s of stations) {
    const e = BY_REF.get(refKey(s));
    if (e) assign(s, e.id);
    else rest.push(s);
  }
  const names = (s: UpStation) => [s.name, s.officialName ?? ""].map(normalizeName).filter(Boolean);
  const open = () => STATION_INDEX.filter((e) => !refsById.has(e.id));
  for (const e of open()) {
    const wanted = e.match.names.map(normalizeName);
    for (const s of rest) if (!idByRef.has(refKey(s)) && e.match.operators.includes(s.operator) && names(s).some((n) => wanted.includes(n))) assign(s, e.id);
  }
  for (const e of open()) {
    const wanted = e.match.names.map(normalizeName);
    const cands = rest.filter((s) => !idByRef.has(refKey(s)) && e.match.operators.includes(s.operator) && names(s).some((n) => wanted.some((w) => n.startsWith(w + " "))));
    if (cands.length === 1) assign(cands[0], e.id);
  }
  return {
    idOf: (ref) => idByRef.get(refKey(ref)) ?? derivedId(ref),
    refsOf: (id) => refsById.get(id) ?? parseDerived(id),
    codesOf: (id, fallback) => BY_ID.get(id)?.codes ?? [fallback],
    unmatched: STATION_INDEX.filter((e) => !refsById.has(e.id)).map((e) => e.id),
  };
}
