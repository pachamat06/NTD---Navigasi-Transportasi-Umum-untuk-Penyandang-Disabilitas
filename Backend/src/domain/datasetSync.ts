// Sinkron data stasiun, rute, dan hub dari dataset untuk halaman admin:
// - perbandingan daftar sebelum dan sesudah dimuat ulang dari Commute Data API (stasiun/lini/hub baru dan hilang,
//   stasiun yang bertambah di lini, mis. Pramuka di LRT Jakarta Lin Selatan);
// - usulan dari GTFS Transjakarta: halte koridor BRT yang belum ada di NTD, nama/koordinat yang berbeda, koridor
//   yang belum menjadi rute NTD, dan halte di dekat stasiun rel untuk hub transfer;
// - pengaturan rute admin yang tertinggal dari dataset (stasiun dataset baru yang belum masuk urutan admin).
// Semua hasil hanya usulan: admin memeriksa lalu menyimpannya sebagai draft.

import { lineIdOf, type StationIndex } from "../data/commute/station-index";
import type { TjGtfs } from "../data/gtfs/TjGtfs";
import { straightDistanceM } from "./hubs";
import type { Hub, Line, Station } from "./models";
import type { RoutePattern } from "./content";
import type { LineSequences } from "./routePatterns";

export interface DatasetCounts {
  stations: Station[];
  lines: Line[];
  hubs: Hub[];
}

export interface DatasetDiff {
  stations: { total: number; added: { id: string; name: string; operator: string }[]; removed: { id: string; name: string; operator: string }[] };
  lines: { total: number; added: { id: string; name: string }[]; removed: { id: string; name: string }[]; changed: { id: string; name: string; addedStations: string[]; removedStations: string[] }[] };
  hubs: { total: number; added: { id: string; name: string }[]; removed: { id: string; name: string }[] };
}

/** Perubahan dataset antara dua pemuatan. */
export function diffDataset(before: DatasetCounts, after: DatasetCounts): DatasetDiff {
  const pick = <T extends { id: string }>(a: T[], b: T[]) => {
    const ids = new Set(a.map((x) => x.id));
    return b.filter((x) => !ids.has(x.id));
  };
  const st = (x: Station) => ({ id: x.id, name: x.name, operator: x.operator });
  const nm = (x: { id: string; name: string }) => ({ id: x.id, name: x.name });
  const prevLine = new Map(before.lines.map((l) => [l.id, l]));
  const changed = after.lines.flatMap((l) => {
    const p = prevLine.get(l.id);
    if (!p) return [];
    const was = new Set(p.stationIds);
    const now = new Set(l.stationIds);
    const addedStations = l.stationIds.filter((id) => !was.has(id));
    const removedStations = p.stationIds.filter((id) => !now.has(id));
    return addedStations.length || removedStations.length ? [{ id: l.id, name: l.name, addedStations, removedStations }] : [];
  });
  return {
    stations: { total: after.stations.length, added: pick(before.stations, after.stations).map(st), removed: pick(after.stations, before.stations).map(st) },
    lines: { total: after.lines.length, added: pick(before.lines, after.lines).map(nm), removed: pick(after.lines, before.lines).map(nm), changed },
    hubs: { total: after.hubs.length, added: pick(before.hubs, after.hubs).map(nm), removed: pick(after.hubs, before.hubs).map(nm) },
  };
}

export interface StationCandidate {
  id: string;
  name: string;
  operator: string;
  codes: string[];
  lineIds: string[];
  lat?: number;
  lng?: number;
  source: "commute" | "gtfs";
  /** Penjelasan untuk admin, mis. "ada di Lin Selatan, belum di daftar stasiun Commute". */
  reason: string;
}

/** Halte koridor BRT di GTFS yang belum ada di daftar stasiun NTD. */
export function gtfsStationCandidates(gtfs: TjGtfs, idx: StationIndex, stations: Station[]): StationCandidate[] {
  const known = new Set(stations.map((s) => s.id));
  const out: StationCandidate[] = [];
  for (const g of gtfs.allStops()) {
    const id = idx.idOf({ operator: "TJ", code: g.code });
    if (known.has(id)) continue;
    const routes = gtfs.routesAt(g.code);
    out.push({
      id,
      name: g.name,
      operator: "TransJakarta",
      codes: [g.code],
      lineIds: routes.map((r) => lineIdOf("TJ", r)),
      lat: g.lat,
      lng: g.lng,
      source: "gtfs",
      reason: routes.length ? `dilayani koridor ${routes.join(", ")} menurut GTFS` : "ada di GTFS",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "id"));
}

export interface StationDifference {
  stationId: string;
  name: string;
  gtfsName: string;
  distanceM: number | null;
  lat: number;
  lng: number;
}

/** Halte NTD yang nama atau koordinatnya berbeda dengan GTFS (lebih dari `minDistanceM`). */
export function gtfsStationDifferences(gtfs: TjGtfs, idx: StationIndex, stations: Station[], minDistanceM = 50): StationDifference[] {
  const out: StationDifference[] = [];
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const s of stations) {
    const refs = idx.refsOf(s.id).filter((r) => r.operator.toUpperCase() === "TJ");
    // Halte gabungan dua arah punya dua kode GTFS; dibandingkan hanya halte satu kode agar tidak salah tafsir.
    if (refs.length !== 1) continue;
    const g = gtfs.stop(refs[0].code);
    if (!g) continue;
    const d = straightDistanceM(s, g);
    const renamed = norm(g.name) !== norm(s.name);
    if (renamed || d === undefined || d > minDistanceM) out.push({ stationId: s.id, name: s.name, gtfsName: g.name, distanceM: d === undefined ? null : Math.round(d), lat: g.lat, lng: g.lng });
  }
  return out;
}

export interface LineCandidate {
  lineId: string;
  name: string;
  operator: string;
  mode: Line["mode"];
  color: string;
  source: "gtfs" | "commute";
}

/** Koridor BRT di GTFS yang belum menjadi lini NTD. */
export function gtfsLineCandidates(gtfs: TjGtfs, lines: Line[]): LineCandidate[] {
  const known = new Set(lines.map((l) => l.id));
  return gtfs.routes.flatMap((code) => {
    const lineId = lineIdOf("TJ", code);
    const r = gtfs.routeInfo(code);
    if (known.has(lineId) || !r) return [];
    return [{ lineId, name: r.name || `Koridor ${code}`, operator: "TransJakarta", mode: "BUS" as const, color: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : "#555555", source: "gtfs" as const }];
  });
}

export interface HubSuggestion {
  /** Id hub yang sudah ada (anggota ditambah) atau usulan id baru. */
  hubId: string;
  existing: boolean;
  name: string;
  memberIds: string[];
  /** Halte TransJakarta yang diusulkan beserta jarak garis lurus ke stasiun rel (meter). */
  added: { stationId: string; name: string; nearId: string; distanceM: number }[];
}

const slug = (v: string) =>
  v
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

/** Halte TransJakarta (GTFS) dalam `radiusM` dari stasiun `near`, terdekat lebih dulu. */
export function gtfsHalteNear(gtfs: TjGtfs, idx: StationIndex, byId: Map<string, Station>, near: Station, radiusM: number): { stationId: string; name: string; distanceM: number }[] {
  if (near.lat === undefined || near.lng === undefined) return [];
  const out = new Map<string, { stationId: string; name: string; distanceM: number }>();
  for (const g of gtfs.allStops()) {
    const d = straightDistanceM(near, g);
    if (d === undefined || d > radiusM) continue;
    const id = idx.idOf({ operator: "TJ", code: g.code });
    const st = byId.get(id);
    if (!st || id === near.id) continue;
    const prev = out.get(id);
    if (!prev || prev.distanceM > d) out.set(id, { stationId: id, name: st.name, distanceM: Math.round(d) });
  }
  return [...out.values()].sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * Usulan hub dari GTFS: halte koridor BRT dalam `radiusM` dari stasiun rel yang belum satu hub dengannya. Bila
 * stasiun rel sudah punya hub, halte diusulkan menjadi anggota hub itu; bila belum, diusulkan hub baru.
 */
export function gtfsHubSuggestions(gtfs: TjGtfs, idx: StationIndex, stations: Station[], hubs: Hub[], radiusM = 250): HubSuggestion[] {
  const byId = new Map(stations.map((s) => [s.id, s]));
  const hubOf = new Map<string, Hub>();
  for (const h of hubs) for (const id of h.memberIds) if (!hubOf.has(id)) hubOf.set(id, h);
  const out = new Map<string, HubSuggestion>();
  for (const s of stations) {
    if (s.inactive || idx.refsOf(s.id).some((r) => r.operator.toUpperCase() === "TJ") || s.operator === "TransJakarta") continue;
    const hub = hubOf.get(s.id);
    const near = gtfsHalteNear(gtfs, idx, byId, s, radiusM).filter((h) => !hub?.memberIds.includes(h.stationId) && !byId.get(h.stationId)?.inactive);
    if (!near.length) continue;
    const key = hub?.id ?? `${slug(s.name)}-tj`;
    const prev = out.get(key) ?? {
      hubId: key,
      existing: !!hub,
      name: hub?.name ?? `${s.name} (${s.operator.split(" · ")[0]} – TransJakarta)`,
      memberIds: hub ? [...hub.memberIds] : [s.id],
      added: [],
    };
    for (const h of near) {
      if (prev.memberIds.includes(h.stationId)) continue;
      prev.memberIds.push(h.stationId);
      prev.added.push({ ...h, nearId: s.id });
    }
    if (prev.added.length) out.set(key, prev);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, "id"));
}

export interface StalePattern {
  lineId: string;
  /** Stasiun yang dikenal NTD dan ada di urutan dataset lini, tetapi tidak ada di pengaturan rute admin. */
  missing: string[];
}

/**
 * Pengaturan rute admin yang tertinggal dari dataset: stasiun dataset (yang dikenal NTD, jadi sudah beroperasi)
 * yang tidak tercantum di urutan admin, mis. Pramuka setelah urutan LRT Jakarta disinkron sebelum Pramuka dibuka.
 */
export function stalePatterns(base: LineSequences[], patterns: RoutePattern[], known: Set<string>): StalePattern[] {
  const byLine = new Map<string, Set<string>>();
  for (const p of patterns) {
    const set = byLine.get(p.lineId) ?? new Set<string>();
    for (const s of p.stops) set.add(s.stationId);
    for (const b of p.branches ?? []) for (const id of b) set.add(id);
    byLine.set(p.lineId, set);
  }
  const out: StalePattern[] = [];
  for (const b of base) {
    const mine = byLine.get(b.lineId);
    if (!mine) continue;
    const missing = [...new Set(b.sequences.flat())].filter((id) => known.has(id) && !mine.has(id));
    if (missing.length) out.push({ lineId: b.lineId, missing });
  }
  return out;
}
