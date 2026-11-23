// Hub transfer: kumpulan stasiun/halte yang bisa dipakai berpindah dengan berjalan kaki. Sumbernya:
// 1. /hubs Commute Data API (beserta jarak jalan kaki dari /stations/{op}/{code}/transfers);
// 2. hub bawaan NTD (CURATED_HUBS) untuk perpindahan yang belum dicatat Commute, mis. halte TransJakarta Cawang dan
//    stasiun LRT Cawang;
// 3. isian admin (jenis konten "hub"): membuat hub baru, mengubah anggota/jalan kaki/nama hub yang ada, atau
//    menonaktifkan hub dataset yang keliru. Isian admin dengan id hub yang sama menggantikan hub dari sumber 1–2.

import type { RequestContext } from "../context";
import type { HubContent } from "./content";
import type { Hub, HubGate, HubWalk } from "./models";

/** Sumber isian hub admin (published, atau draft untuk pratinjau admin). */
export type HubProvider = (ctx: RequestContext) => Promise<HubContent[]>;

/**
 * Hub bawaan NTD yang belum ada di /hubs Commute. Jarak jalan kaki dari /stations/{op}/{code}/transfers Commute
 * (TJ Cawang ↔ LRT Cawang 170 m, November 2026); tim bisa melengkapi waktu dan petunjuk jalan di admin (Hub transfer).
 */
export const CURATED_HUBS: Hub[] = [
  {
    id: "cawang-lrt-tj",
    name: "Cawang (LRT – TransJakarta)",
    kind: "hub",
    // Halte TransJakarta Cawang (TJ-H00276P) dan stasiun LRT Jabodebek Cawang (LRTJBDB-CWG).
    memberIds: ["tj:h00276p", "lrtjbdb:cwg"],
    walks: [
      { from: "tj:h00276p", to: "lrtjbdb:cwg", distanceM: 170, minutes: null },
      { from: "lrtjbdb:cwg", to: "tj:h00276p", distanceM: 170, minutes: null },
    ],
    source: "ntd",
  },
];

/**
 * Hub yang berlaku: hub Commute, ditambah hub bawaan NTD yang id-nya belum dipakai, lalu isian admin (id sama =
 * diganti, id baru = ditambah, `disabled` = dihapus dari daftar). Anggota yang tidak dikenal (`known`) dibuang;
 * hub dengan kurang dari dua anggota tidak dipakai.
 */
export function applyHubs(base: Hub[], overrides: HubContent[], known?: Set<string>): Hub[] {
  const out = new Map<string, Hub>();
  for (const h of base) out.set(h.id, { ...h, source: h.source ?? "commute" });
  for (const h of CURATED_HUBS) if (!out.has(h.id)) out.set(h.id, h);
  for (const o of overrides) {
    if (o.disabled) {
      out.delete(o.hubId);
      continue;
    }
    out.set(o.hubId, {
      id: o.hubId,
      name: o.name,
      kind: o.kind,
      memberIds: [...new Set(o.memberIds)],
      walks: (o.walks ?? []).map((w) => ({ from: w.from, to: w.to, distanceM: w.distanceM, minutes: w.minutes ?? null, ...(w.notes ? { notes: w.notes } : {}) })),
      // Isian lama (sebelum ada gate) tidak memuat `gates`.
      ...(o.gates?.length ? { gates: o.gates.map((g) => ({ ...g, connectsTo: g.connectsTo ?? [], facilities: g.facilities ?? [], accessible: !!g.accessible })) } : {}),
      source: "admin",
    });
  }
  const list: Hub[] = [];
  for (const h of out.values()) {
    const memberIds = known ? h.memberIds.filter((id) => known.has(id)) : h.memberIds;
    if (memberIds.length < 2) continue;
    const inHub = new Set(memberIds);
    const gates = h.gates?.filter((g) => inHub.has(g.stationId)).map((g) => ({ ...g, connectsTo: g.connectsTo.filter((t) => inHub.has(t)) }));
    list.push({ ...h, memberIds, walks: h.walks.filter((w) => inHub.has(w.from) && inHub.has(w.to) && w.from !== w.to), ...(gates?.length ? { gates } : {}) });
  }
  return list;
}

/**
 * Gate di stasiun `at` yang dipakai berjalan ke anggota hub `toward`: gate yang `connectsTo`-nya memuat `toward`
 * lebih dulu, lalu gate tanpa `connectsTo` (ke semua anggota). Bila ada beberapa, diutamakan gate aksesibel, lalu
 * yang punya fasilitas `prefer` (mis. lift untuk pengguna kursi roda), lalu yang fasilitasnya paling banyak.
 */
export function gateToward(hubs: Hub[], at: string, toward: string, prefer: readonly string[] = []): HubGate | undefined {
  for (const h of hubs) {
    if (!h.gates?.length || !h.memberIds.includes(at) || !h.memberIds.includes(toward)) continue;
    const mine = h.gates.filter((g) => g.stationId === at);
    const named = mine.filter((g) => g.connectsTo.includes(toward));
    const cands = named.length ? named : mine.filter((g) => !g.connectsTo.length);
    if (!cands.length) continue;
    return bestGate(cands, prefer);
  }
  return undefined;
}

/** Gate terbaik di antara beberapa calon: aksesibel dulu, lalu yang punya fasilitas `prefer`, lalu fasilitas terbanyak. */
export function bestGate(cands: readonly HubGate[], prefer: readonly string[] = []): HubGate | undefined {
  const score = (g: HubGate) => (g.accessible ? 100 : 0) + prefer.filter((p) => g.facilities.includes(p as HubGate["facilities"][number])).length * 10 + g.facilities.length;
  return [...cands].sort((a, b) => score(b) - score(a))[0];
}

/** Hub tiap stasiun menurut daftar hub yang berlaku (stasiun pertama kali muncul menang). */
export function hubOfStation(hubs: Hub[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of hubs) for (const id of h.memberIds) if (!m.has(id)) m.set(id, h.id);
  return m;
}

/** Jarak garis lurus (meter) antara dua koordinat. */
export function straightDistanceM(a: { lat?: number; lng?: number } | undefined, b: { lat?: number; lng?: number } | undefined): number | undefined {
  if (a?.lat === undefined || a.lng === undefined || b?.lat === undefined || b.lng === undefined) return undefined;
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Jalan kaki antarstasiun anggota hub, bila hub mencatatnya (arah mana pun). */
export function walkBetween(hubs: Hub[], a: string, b: string): HubWalk | undefined {
  for (const h of hubs) {
    const w = h.walks.find((x) => x.from === a && x.to === b) ?? h.walks.find((x) => x.from === b && x.to === a);
    if (w) return w;
  }
  return undefined;
}
