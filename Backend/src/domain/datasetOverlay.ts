// Stasiun dan lini di atas dataset (Commute Data API + GTFS Transjakarta). Sumbernya:
// 1. stasiun bawaan NTD (BUILTIN_STATIONS) untuk stasiun yang sudah beroperasi tetapi belum dimuat dataset atau
//    cache dataset NTD, mis. LRT Jakarta Pramuka (beroperasi 12 November 2026). Hanya dipakai bila dataset belum
//    memuat stasiun dengan id yang sama;
// 2. isian admin (jenis konten "station" dan "line"): tambah manual, impor dari GTFS / lin Commute, atau koreksi
//    data stasiun/lini dataset dengan id yang sama. Isian admin menang atas dataset dan daftar bawaan.
// Urutan pemberhentian lini tetap diatur lewat pengaturan rute (jenis konten "route_pattern").

import type { RequestContext } from "../context";
import type { Line, Mode, Station } from "./models";

export interface StationContent {
  stationId: string;
  name: string;
  operator: string;
  codes?: string[];
  lineIds?: string[];
  lat?: number;
  lng?: number;
  source: "manual" | "commute" | "gtfs";
  syncedAt?: string;
  note?: string;
}

export interface LineContent {
  lineId: string;
  name: string;
  operator: string;
  mode: Mode;
  color?: string;
  source: "manual" | "commute" | "gtfs";
  syncedAt?: string;
  note?: string;
}

export interface DatasetOverlay {
  stations: StationContent[];
  lines: LineContent[];
}

export type OverlayProvider = (ctx: RequestContext) => Promise<DatasetOverlay>;

/** Awalan id stasiun/lini yang dibuat admin dan tidak punya padanan di Commute Data API. */
export const LOCAL_PREFIX = "ntd:";

/**
 * Stasiun yang sudah beroperasi menurut tim NTD, dipakai bila dataset belum memuatnya. Data dari Commute Data API
 * (/stations/LRTJ/PKA dan /lines/LRTJ/S, diperiksa 13 November 2026).
 */
export const BUILTIN_STATIONS: Station[] = [
  {
    // LRT Jakarta Lin Selatan S08 Pramuka, perpanjangan Velodrome–Manggarai; beroperasi sejak 12 November 2026.
    id: "lrtj:pka",
    name: "Pramuka",
    operator: "LRT Jakarta",
    lineIds: ["lrtj:s"],
    codes: ["S08"],
    commuteIds: ["LRTJ-PKA"],
    lat: -6.1919,
    lng: 106.8706,
    source: "ntd",
  },
];

/**
 * Stasiun yang berlaku: dataset, ditambah stasiun bawaan NTD yang belum ada, lalu isian admin (id sama = field
 * dataset diganti, lini digabung; id baru = ditambah).
 */
export function applyStations(base: Station[], overrides: StationContent[], builtin: Station[] = BUILTIN_STATIONS): Station[] {
  const out = new Map(base.map((s) => [s.id, s]));
  for (const b of builtin) if (!out.has(b.id)) out.set(b.id, { ...b });
  for (const o of overrides) {
    const prev = out.get(o.stationId);
    const coords = typeof o.lat === "number" && typeof o.lng === "number" ? { lat: o.lat, lng: o.lng } : prev?.lat !== undefined ? { lat: prev.lat, lng: prev.lng } : {};
    out.set(o.stationId, {
      ...(prev ?? { commuteIds: [] }),
      id: o.stationId,
      name: o.name,
      operator: o.operator,
      lineIds: [...new Set([...(prev?.lineIds ?? []), ...(o.lineIds ?? [])])],
      codes: o.codes?.length ? o.codes : (prev?.codes ?? []),
      ...coords,
      // Koreksi stasiun dataset tetap stasiun dataset (rute tetap diminta ke Commute); id baru = stasiun admin.
      source: prev?.source ?? "admin",
    });
  }
  return [...out.values()];
}

/** Lini yang berlaku: dataset, lalu isian admin (id sama = nama/operator/moda/warna diganti; id baru = ditambah). */
export function applyLines(base: Line[], overrides: LineContent[]): Line[] {
  const out = new Map(base.map((l) => [l.id, l]));
  for (const o of overrides) {
    const prev = out.get(o.lineId);
    out.set(o.lineId, { id: o.lineId, name: o.name, operator: o.operator, mode: o.mode, color: o.color ?? prev?.color ?? "#555555", stationIds: prev?.stationIds ?? [], source: prev?.source ?? "admin" });
  }
  return [...out.values()];
}

/** Stasiun/lini bukan dari dataset (dibuat admin atau bawaan NTD): tidak bisa dimintakan rute ke Commute. */
export const isLocal = (s: { source?: string } | undefined) => s?.source === "admin" || s?.source === "ntd";
