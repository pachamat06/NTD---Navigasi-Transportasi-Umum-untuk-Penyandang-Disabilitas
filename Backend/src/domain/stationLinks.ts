// Tautan transfer antar stasiun/halte di luar hub: dua tempat yang bisa dipakai pindah dengan berjalan kaki walau tidak
// satu hub, mis. halte BRT Bali Mester dengan halte BRT Stasiun Jatinegara, atau halte BRT Matraman Baru dengan Stasiun
// Matraman. Tiap tautan memuat akses yang tersedia di jalan itu (tangga, eskalator, lift, ramp, datar; boleh lebih dari
// satu), jarak/waktu jalan, dan arah (dua arah bawaan). Sumbernya:
// 1. tautan bawaan NTD (CURATED_LINKS) untuk perpindahan yang belum tercatat di dataset;
// 2. isian admin (jenis konten "station_link"): menambah tautan (manual, atau usulan otomatis dari kedekatan/Commute
//    yang dikonfirmasi), mengubah tautan bawaan dengan pasangan stasiun yang sama, atau menonaktifkannya.
// Perencana rute memakai tautan sebagai titik pindah dan memeriksa akses terhadap kebutuhan pengguna (lift, eskalator,
// ramp); aturan "lift menggantikan eskalator" tetap berlaku.

import type { RequestContext } from "../context";
import type { StationLinkContent } from "./content";
import { hubOfStation, straightDistanceM } from "./hubs";
import type { AmenityDetailStatus, Hub, LegLink, SegmentMeans, Station, StationLink, TransferNeed } from "./models";

/** Sumber isian tautan admin (published, atau draft untuk pratinjau admin). */
export type LinkProvider = (ctx: RequestContext) => Promise<StationLinkContent[]>;

/** Kunci pasangan stasiun; urutan tidak berpengaruh. */
export const linkKey = (a: string, b: string): string => [a, b].sort().join("~");

/**
 * Tautan bawaan NTD. Akses belum disurvei (`access` kosong = belum diketahui), jadi pengguna yang butuh lift/eskalator/ramp
 * mendapat peringatan "data belum tersedia" sampai tim melengkapinya di admin (Detail stasiun → Terhubung ke stasiun lain).
 * Jarak memakai garis lurus antar koordinat stasiun bila tidak diisi.
 */
export const CURATED_LINKS: StationLink[] = [
  {
    id: linkKey("tj:h00148p", "tj:h00225p"),
    fromId: "tj:h00148p",
    toId: "tj:h00225p",
    distanceM: null,
    minutes: null,
    access: [],
    note: "Halte BRT Bali Mester ke halte BRT Stasiun Jatinegara; akses jalan belum disurvei.",
    source: "ntd",
  },
  {
    id: linkKey("tj:h00104p", "kci:mtr"),
    fromId: "tj:h00104p",
    toId: "kci:mtr",
    distanceM: null,
    minutes: null,
    access: [],
    note: "Halte BRT Matraman Baru ke Stasiun Matraman; akses jalan belum disurvei.",
    source: "ntd",
  },
];

/**
 * Tautan yang berlaku: bawaan NTD, lalu isian admin (pasangan sama = diganti, pasangan baru = ditambah, `disabled` =
 * dihapus dari daftar). Tautan dengan stasiun yang tidak dikenal (`known`) dibuang.
 */
export function applyLinks(overrides: StationLinkContent[], known?: Set<string>): StationLink[] {
  const out = new Map<string, StationLink>();
  for (const l of CURATED_LINKS) out.set(l.id, l);
  for (const o of overrides) {
    const id = linkKey(o.fromId, o.toId);
    if (o.disabled) {
      out.delete(id);
      continue;
    }
    out.set(id, {
      id,
      fromId: o.fromId,
      toId: o.toId,
      ...(o.oneWay ? { oneWay: true } : {}),
      distanceM: o.distanceM ?? null,
      minutes: o.minutes ?? null,
      access: [...o.access],
      ...(o.dedicated ? { dedicated: true } : {}),
      ...(o.note ? { note: o.note } : {}),
      source: "admin",
    });
  }
  return [...out.values()].filter((l) => !known || (known.has(l.fromId) && known.has(l.toId)));
}

/** Tautan yang bisa dipakai berjalan dari `a` ke `b` (arah mana pun, kecuali tautan satu arah). */
export function linkBetween(links: readonly StationLink[], a: string, b: string): StationLink | undefined {
  return links.find((l) => (l.fromId === a && l.toId === b) || (!l.oneWay && l.fromId === b && l.toId === a));
}

/** Tautan yang menyentuh stasiun `id`, beserta stasiun di seberangnya; tautan satu arah hanya dari asalnya. */
export function linksOf(links: readonly StationLink[], id: string): { link: StationLink; otherId: string }[] {
  const out: { link: StationLink; otherId: string }[] = [];
  for (const l of links) {
    if (l.fromId === id) out.push({ link: l, otherId: l.toId });
    else if (l.toId === id && !l.oneWay) out.push({ link: l, otherId: l.fromId });
  }
  return out;
}

/** Keterangan tautan yang dibawa ruas pindah pada rute. */
export const legLink = (l: StationLink): LegLink => ({ access: [...l.access], ...(l.dedicated ? { dedicated: true } : {}), source: l.source });

/**
 * Apakah kebutuhan pengguna terpenuhi oleh akses tautan:
 * - kosong = belum diketahui (`unknown`);
 * - lift: ada lift, atau jalannya tanpa anak tangga (datar/ramp) sehingga lift tidak dibutuhkan;
 * - eskalator: ada eskalator atau jalan tanpa anak tangga; lift menggantikan eskalator (`substitute`);
 * - ramp: ada ramp atau jalannya datar.
 * Hanya tangga (atau tangga dengan fasilitas lain yang tidak cocok) = `absent`.
 */
export function linkNeedStatus(access: readonly SegmentMeans[], need: TransferNeed): { status: AmenityDetailStatus; substitute?: "lift" } {
  if (!access.length) return { status: "unknown" };
  const has = (m: SegmentMeans) => access.includes(m);
  const stepFree = has("datar") || has("ramp");
  if (need === "lift") return { status: has("lift") || stepFree ? "available" : "absent" };
  if (need === "eskalator") {
    if (has("eskalator") || stepFree) return { status: "available" };
    return has("lift") ? { status: "available", substitute: "lift" } : { status: "absent" };
  }
  return { status: has("ramp") || has("datar") ? "available" : "absent" };
}

/** true bila akses tautan PASTI tidak memenuhi salah satu kebutuhan (tercatat tanpa fasilitas itu); belum diisi = tidak. */
export function linkFailsNeeds(link: Pick<StationLink, "access">, needs: readonly TransferNeed[]): boolean {
  return needs.some((n) => linkNeedStatus(link.access, n).status === "absent");
}

/** Teks akses untuk pengguna, mis. "tangga, lift". */
export const accessText = (access: readonly SegmentMeans[]): string => (access.length ? access.join(", ") : "belum diketahui");

export interface LinkSuggestion {
  fromId: string;
  toId: string;
  /** Jarak garis lurus antar koordinat (m); jarak jalan kaki sebenarnya bisa lebih jauh. */
  distanceM: number;
  sameOperator: boolean;
}

/**
 * Usulan tautan dari dataset: pasangan stasiun/halte yang berdekatan (`radiusM`) tetapi belum satu hub, belum bertaut, dan
 * tidak sama-sama melayani satu lini (halte berurutan satu lini bukan titik pindah). Terdekat lebih dulu. Dengan
 * `stationId`, hanya pasangan yang melibatkan stasiun itu. Hanya usulan: admin memeriksa jaraknya (dan menambahkan akses)
 * lalu menyimpannya sebagai draf.
 */
export function suggestLinks(stations: Station[], hubs: Hub[], links: readonly StationLink[], opts: { radiusM?: number; stationId?: string } = {}): LinkSuggestion[] {
  const radius = opts.radiusM ?? 300;
  const hubOf = hubOfStation(hubs);
  const linked = new Set(links.map((l) => linkKey(l.fromId, l.toId)));
  const usable = stations.filter((s) => !s.inactive && s.lat !== undefined && s.lng !== undefined);
  const focus = opts.stationId ? usable.filter((s) => s.id === opts.stationId) : usable;
  const out = new Map<string, LinkSuggestion>();
  for (const a of focus)
    for (const b of usable) {
      if (a.id === b.id) continue;
      const key = linkKey(a.id, b.id);
      if (out.has(key) || linked.has(key)) continue;
      const hub = hubOf.get(a.id);
      if (hub && hub === hubOf.get(b.id)) continue;
      if (a.lineIds.some((id) => b.lineIds.includes(id))) continue;
      const d = straightDistanceM(a, b);
      if (d === undefined || d > radius) continue;
      out.set(key, { fromId: a.id, toId: b.id, distanceM: Math.round(d), sameOperator: a.operator === b.operator });
    }
  return [...out.values()].sort((x, y) => x.distanceM - y.distanceM);
}

/** Satu tautan dilihat dari sebuah stasiun: stasiun di seberangnya beserta akses jalan kaki ke sana. */
export interface StationLinkView {
  linkId: string;
  otherId: string;
  otherName: string;
  /** Jarak tautan; bila belum diisi, jarak garis lurus antar koordinat (`distanceEstimated`). */
  distanceM: number | null;
  distanceEstimated?: boolean;
  minutes: number | null;
  access: SegmentMeans[];
  dedicated?: boolean;
  note?: string;
  /** true = tautan satu arah dari stasiun ini ke seberang. */
  oneWay?: boolean;
  source: "ntd" | "admin";
}

/** Tautan yang bisa dipakai dari stasiun `id` (untuk detail stasiun di GUI dan admin). */
export function linkViews(links: readonly StationLink[], id: string, byId: Map<string, Station>): StationLinkView[] {
  return linksOf(links, id)
    .map(({ link, otherId }) => {
      const straight = link.distanceM === null ? straightDistanceM(byId.get(id), byId.get(otherId)) : undefined;
      return {
        linkId: link.id,
        otherId,
        otherName: byId.get(otherId)?.name ?? otherId,
        distanceM: link.distanceM ?? (straight !== undefined ? Math.round(straight) : null),
        ...(link.distanceM === null && straight !== undefined ? { distanceEstimated: true } : {}),
        minutes: link.minutes,
        access: [...link.access],
        ...(link.dedicated ? { dedicated: true } : {}),
        ...(link.note ? { note: link.note } : {}),
        ...(link.oneWay ? { oneWay: true } : {}),
        source: link.source,
      } satisfies StationLinkView;
    })
    .sort((a, b) => a.otherName.localeCompare(b.otherName, "id"));
}
