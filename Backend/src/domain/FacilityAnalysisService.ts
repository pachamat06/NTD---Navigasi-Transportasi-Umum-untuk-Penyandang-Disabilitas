// Modul Analisis Fasilitas (UC-04). Skor dihitung deterministik dengan bobot per jenis amenity
// (Tabel 3.4 no. 7), bukan oleh LLM, dan "data tidak tersedia" dibedakan dari "fasilitas tidak ada" (no. 9).

import type { RequestContext } from "../context";
import type { CommuteApiClient } from "../data/commute/CommuteApiClient";
import type { ContentSnapshot } from "./content";
import {
  CORE_AMENITIES,
  EXTRA_AMENITIES,
  LEVEL_CONNECTIONS,
  PLATFORM_AMENITIES,
  isStepFree,
  type AccessSegment,
  type AccessVia,
  type AmenityDetail,
  type AmenityDetailStatus,
  type AmenityStatus,
  type AmenityType,
  type Concourse,
  type ConcourseRoute,
  type Entrance,
  type GateChoice,
  type GatePlatformLink,
  type LayoutAccess,
  type Platform,
  type PlatformAmenityType,
  type PlatformConnection,
  type ScoreFactor,
  type SegmentMeans,
  type ScorePenalty,
  type StationAssessment,
  type StationDetail,
} from "./models";

export const AMENITY_LABEL: Record<string, string> = {
  lift: "Lift",
  eskalator: "Eskalator",
  toilet: "Toilet aksesibel",
  ramp: "Ramp",
  guiding_block: "Guiding block",
  kursi_roda: "Kursi roda",
  petugas_bantuan: "Petugas bantuan",
  area_prioritas: "Area tunggu prioritas",
  pintu_lebar: "Gerbang tiket lebar",
  informasi_audio: "Informasi audio",
  informasi_visual: "Informasi visual",
};

export interface StationFacilities {
  amenities: Record<AmenityType, AmenityStatus>;
  amenityDetails: AmenityDetail[];
  dataAvailable: boolean;
}

export class FacilityAnalysisService {
  constructor(private commute: CommuteApiClient) {}

  /** Gabungan data dataset dan informasi tim NTD. Informasi tim menang karena lebih spesifik dan bertanggal. */
  async facilities(stationId: string, ctx: RequestContext, snap: ContentSnapshot): Promise<StationFacilities> {
    const dataset = await this.commute.getStationAmenities(stationId, ctx);
    const details = new Map<string, AmenityDetail>();
    if (dataset) {
      const listed = new Set(dataset.map((a) => a.type));
      // Jenis yang tidak dapat dinyatakan sumber data (mis. ramp pada Commute Data API) tetap "data tidak tersedia".
      const coverage = this.commute.amenityCoverage;
      for (const t of CORE_AMENITIES) {
        if (listed.has(t)) details.set(t, { type: t, status: "available", source: "dataset" });
        else if (!coverage || coverage.includes(t)) details.set(t, { type: t, status: "absent", source: "dataset" });
      }
      for (const a of dataset) if (!details.has(a.type)) details.set(a.type, { type: a.type, status: "available", source: "dataset", note: a.description });
    }
    const overrides = snap.facilityOverrides(stationId);
    for (const o of overrides) details.set(o.type, o);
    // Fasilitas yang diisi pada peron otomatis mengisi fasilitas umum stasiun (peron punya lift = stasiun punya lift).
    const derived = fromPlatforms(snap.platformsOf(stationId), snap.legacyPlatformToilet(stationId));
    for (const d of derived) {
      const cur = details.get(d.type);
      // Isian tim untuk stasiun yang menyatakan sedang tidak berfungsi tetap dipakai.
      if (cur?.source === "ntd" && cur.status === "out_of_service") continue;
      if (d.status === "available" ? cur?.status !== "available" : !cur || cur.status === "unknown") details.set(d.type, d);
    }

    const amenities = {} as Record<AmenityType, AmenityStatus>;
    for (const t of CORE_AMENITIES) {
      const d = details.get(t);
      amenities[t] = !d ? "unknown" : d.status === "out_of_service" ? "absent" : d.status;
    }
    const dataAvailable = !!dataset || [...overrides, ...derived].some((o) => (CORE_AMENITIES as readonly string[]).includes(o.type) && o.status !== "unknown");
    return { amenities, amenityDetails: [...details.values()], dataAvailable };
  }

  async assess(stationId: string, ctx: RequestContext, snap: ContentSnapshot): Promise<{ assessment: StationAssessment; facilities: StationFacilities }> {
    const f = await this.facilities(stationId, ctx, snap);
    // Jalur gate ke peron dan celah peron dari isian tim. Peron dataset ikut diperiksa, tetapi hanya untuk stasiun yang
    // sudah diisi tim, agar daftar stasiun tidak memicu permintaan peron untuk ratusan stasiun.
    const concourses = snap.concoursesOf(stationId);
    const own = snap.platformsOf(stationId);
    const ntdEntrances = snap.entrancesOf(stationId);
    const linked = [
      ...ntdEntrances.flatMap((e) => (e.platformLinks ?? []).map((l) => l.platform)),
      ...concourses.flatMap((c) => c.platformLinks.map((l) => l.platform)),
      ...own.flatMap((p) => (p.exitAccess?.length ? [p.code] : [])),
    ];
    const surveyed = own.length > 0 || linked.length > 0;
    const [dataset, exits] = surveyed
      ? await Promise.all([this.commute.getPlatforms(stationId, ctx).catch(() => [] as Platform[]), this.commute.getExits(stationId, ctx).catch(() => [] as Entrance[])])
      : [[] as Platform[], [] as Entrance[]];
    // Pintu dataset ikut dipakai agar akses peron ke "Pintu A" dari data peron menempel ke pintu yang sama dengan detail stasiun.
    const entrances = applyPlatformExits(mergeGates(exits, ntdEntrances), own);
    const codes = [...new Set([...dataset.map((p) => p.code), ...own.map((p) => p.code), ...linked])];
    // Bila ada peron yang belum diketahui jalurnya, faktor jalur diabaikan: skor memakai bobot fasilitas biasa.
    const layout = layoutAccess(entrances, codes, concourses);
    // Tanpa konteks perjalanan, celah peron terburuk di stasiun ini yang dihitung.
    const penalty = gapPenalty(codes.map((c) => own.find((p) => p.code === c) ?? dataset.find((p) => p.code === c)), snap);
    const penalties = penalty ? [penalty] : [];
    const { score, factors } = computeScore({ statusOf: (t) => pathStatus(layout, t) ?? f.amenities[t], details: f.amenityDetails, excluded: layout?.level ? VERTICAL : [], penalties }, snap);
    const notes: string[] = [];
    if (!f.dataAvailable) notes.push("Data fasilitas belum tersedia; belum terverifikasi.");
    for (const d of f.amenityDetails) {
      if (d.source !== "ntd") continue;
      const label = AMENITY_LABEL[d.type] ?? d.type;
      if (d.status === "out_of_service") notes.push(`${label} sedang tidak berfungsi${d.note ? `: ${d.note.replace(/[.\s]+$/, "")}` : ""}.`);
      else if (d.note) notes.push(`${label}: ${d.note}`);
    }
    if (layout) notes.push(layoutNote(STATION_NOTE, codes.length === 1 ? `peron ${codes[0]}` : "semua peron", layout));
    if (penalty) notes.push(penaltyNote(penalty));
    return {
      assessment: {
        stationId,
        score,
        adequate: f.dataAvailable && score >= snap.settings.scoring.threshold,
        dataAvailable: f.dataAvailable,
        factors,
        ...(penalties.length ? { penalties } : {}),
        ...(layout ? { layout } : {}),
        ...(notes.length ? { notes } : {}),
      },
      facilities: f,
    };
  }
}

const VERTICAL: AmenityType[] = ["lift", "eskalator"];

const STATUS_ORDER: Record<AmenityDetailStatus, number> = { out_of_service: 0, absent: 1, unknown: 2, available: 3 };

/**
 * Fasilitas umum stasiun dari isian peron: fasilitas mobilitas yang tersedia di peron mana pun (termasuk lift dan
 * eskalator yang dicatat jumlahnya) berarti stasiun itu memilikinya. Bila semua peron yang diisi mencatat tidak ada,
 * status itu dipakai hanya bila stasiun belum punya data. Toilet dari data lama per peron dipindahkan ke stasiun.
 */
export function fromPlatforms(platforms: Platform[], legacyToilet: { code: string; status: AmenityDetailStatus }[] = []): AmenityDetail[] {
  const out: AmenityDetail[] = [];
  const statusOf = (p: Platform, t: PlatformAmenityType): AmenityDetailStatus | undefined => {
    const own = p.amenities[t];
    if (own) return own;
    if (t === "lift" && p.lift) return p.lift.count > 0 ? (p.lift.status ?? "available") : "absent";
    if (t === "eskalator" && p.escalators?.length) return p.escalators.some((g) => !g.status || g.status === "available") ? "available" : (p.escalators[0].status ?? "available");
    return undefined;
  };
  for (const t of PLATFORM_AMENITIES) {
    const known = platforms.flatMap((p) => {
      const st = statusOf(p, t);
      return st ? [{ code: p.code, st }] : [];
    });
    if (!known.length) continue;
    const yes = known.filter((k) => k.st === "available");
    if (yes.length) out.push({ type: t, status: "available", source: "ntd", note: `Dari data peron ${yes.map((k) => k.code).join(", ")}.` });
    else {
      const best = known.reduce((a, b) => (STATUS_ORDER[b.st] > STATUS_ORDER[a.st] ? b : a));
      out.push({ type: t, status: best.st, source: "ntd", note: `Dari data peron ${known.map((k) => k.code).join(", ")}.` });
    }
  }
  if (legacyToilet.length) {
    const best = legacyToilet.reduce((a, b) => (STATUS_ORDER[b.status] > STATUS_ORDER[a.status] ? b : a));
    out.push({ type: "toilet", status: best.status, source: "ntd" });
  }
  return out;
}

/** Pintu dataset (/exits) yang belum dilengkapi tim ikut dipakai; yang sudah dilengkapi memakai isian tim. */
export function mergeGates(dataset: Entrance[], ntd: Entrance[]): Entrance[] {
  const refOf = (e: Entrance) => e.id.slice(e.id.lastIndexOf(":") + 1);
  const covered = new Set(ntd.flatMap((e) => (e.exitRef ? [e.exitRef] : [])));
  const filled = ntd.map((e) => {
    const d = e.exitRef ? dataset.find((x) => refOf(x) === e.exitRef) : undefined;
    return d?.signs && !e.signs ? { ...e, signs: d.signs } : e;
  });
  return [...filled, ...dataset.filter((d) => !covered.has(refOf(d)))];
}

const gateKey = (x: string) => x.toLowerCase().replace(/^(pintu|gate|exit)\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Akses peron ke pintu keluar tertentu (isian data peron) digabung ke data gate sebagai jalur gate → peron. Pintu
 * dicocokkan lewat nama, `exitRef`, atau nama pintu dataset ("Pintu A" = "A"); pintu yang belum ada dibuat sebagai
 * gate isian tim. Jalur yang sudah dicatat pada gate tidak ditimpa.
 */
export function applyPlatformExits(entrances: Entrance[], platforms: Platform[]): Entrance[] {
  const list = entrances.map((e) => ({ ...e, platformLinks: [...(e.platformLinks ?? [])] }));
  const stationId = list[0]?.stationId ?? "";
  for (const p of platforms)
    for (const a of p.exitAccess ?? []) {
      const key = gateKey(a.gate);
      let gate = list.find((e) => gateKey(e.name) === key || (e.exitRef && gateKey(e.exitRef) === key) || gateKey(e.name.replace(/\s*\(.*\)$/, "")) === key);
      if (!gate) {
        gate = { id: `peron:${p.code}:${key}`, stationId, name: a.gate, accessible: true, features: [], source: "ntd", platformLinks: [] };
        list.push(gate);
      }
      if (gate.platformLinks.some((l) => l.platform === p.code)) continue;
      gate.platformLinks.push({ platform: p.code, via: a.via, ...(a.stepFree ? { stepFree: true } : {}), ...(a.dedicated ? { dedicated: true } : {}), ...(a.note ? { note: a.note } : {}) });
    }
  // Gate yang semula tanpa platformLinks dan tidak mendapat jalur baru dikembalikan tanpa field itu.
  return list.map((e, i) => {
    if (e.platformLinks.length || entrances[i]?.platformLinks) return e;
    const { platformLinks: _, ...rest } = e;
    return rest;
  });
}

/** Kebutuhan pengguna terpenuhi: fasilitasnya tersedia, atau lift/eskalator tidak dibutuhkan karena semua peron dicapai tanpa anak tangga. */
export function needMet(need: AmenityType, amenities: Record<AmenityType, AmenityStatus>, layout?: LayoutAccess): boolean {
  if (layout?.level && VERTICAL.includes(need)) return true;
  return (pathStatus(layout, need) ?? amenities[need]) === "available";
}

/**
 * Status lift/eskalator pada jalur lewat concourse yang pindah lantai, menggantikan status stasiun/peron.
 * undefined bila jalurnya bukan lewat concourse (atau tanpa anak tangga), sehingga status biasa yang dipakai.
 */
export function pathStatus(layout: Pick<LayoutAccess, "level" | "pathLift" | "pathEscalator"> | undefined, t: AmenityType): AmenityStatus | undefined {
  if (!layout || layout.level) return undefined;
  if (t === "lift" && layout.pathLift) return layout.pathLift === "out_of_service" ? "absent" : layout.pathLift;
  if (t === "eskalator" && layout.pathEscalator) return layout.pathEscalator;
  return undefined;
}

interface ScoreInput {
  statusOf: (t: AmenityType) => AmenityStatus;
  /** Rincian fasilitas (sumber status fasilitas tambahan). */
  details: AmenityDetail[];
  /** Fasilitas inti yang tidak dibutuhkan pada jalur ini. */
  excluded: readonly AmenityType[];
  penalties?: ScorePenalty[];
}

/**
 * Skor 0–100 = bobot faktor yang terpenuhi dibagi bobot faktor yang dihitung, lalu dikurangi potongan.
 * - Fasilitas inti selalu dihitung. Yang tidak dibutuhkan (lift/eskalator pada jalur tanpa anak tangga) dianggap
 *   terpenuhi, agar stasiun yang memang punya lift tidak turun skornya.
 * - Fasilitas tambahan hanya dihitung bila statusnya sudah diisi, jadi stasiun yang belum disurvei tidak dirugikan.
 */
export function computeScore(input: ScoreInput, snap: ContentSnapshot): { score: number; factors: ScoreFactor[] } {
  const factors: ScoreFactor[] = CORE_AMENITIES.map((t) => ({
    type: t,
    weight: snap.weight(t),
    result: input.excluded.includes(t) ? "not_needed" : input.statusOf(t) === "available" ? "met" : "missing",
  }));
  for (const t of EXTRA_AMENITIES) {
    const d = input.details.find((x) => x.type === t);
    factors.push({ type: t, weight: snap.weight(t), result: !d || d.status === "unknown" ? "skipped" : d.status === "available" ? "met" : "missing" });
  }
  const counted = factors.filter((x) => x.result !== "skipped");
  const total = counted.reduce((sum, x) => sum + x.weight, 0);
  const got = counted.reduce((sum, x) => sum + (x.result === "missing" ? 0 : x.weight), 0);
  const penalty = (input.penalties ?? []).reduce((sum, p) => sum + p.points, 0);
  const score = Math.max(0, Math.round((total ? (got / total) * 100 : 0) - penalty));
  return { score, factors: factors.filter((x) => x.weight > 0) };
}

/** Jalur gate ke peron, dari yang paling mudah. Jalur tanpa anak tangga selalu lebih baik daripada yang pindah lantai. */
const VIA_RANK: Record<PlatformConnection, number> = { langsung: 0, crosswalk: 1, sebidang: 2, jpo: 3, terowongan: 3 };
const linkRank = (l: GatePlatformLink) => (isStepFree(l) ? 0 : 10) + VIA_RANK[l.via] - (l.dedicated ? 0.5 : 0);

export const VIA_LABEL: Record<AccessVia, string> = {
  langsung: "langsung",
  crosswalk: "lewat penyeberangan jalan (crosswalk)",
  sebidang: "lewat pelintasan sebidang (menyeberang rel)",
  jpo: "lewat JPO",
  terowongan: "lewat terowongan",
  concourse: "lewat concourse",
};

export const MEANS_LABEL: Record<SegmentMeans, string> = { datar: "datar", ramp: "ramp", lift: "lift", eskalator: "eskalator", tangga: "tangga" };

const meansText = (m: SegmentMeans[]) => (m.length ? m.map((x) => MEANS_LABEL[x]).join("/") : "belum diisi");

/** Cara mencapai peron, mis. "lewat JPO beramp tanpa anak tangga", "... khusus pengguna disabilitas", atau jalur lewat concourse. */
export function viaText(l: { via: AccessVia; stepFree?: boolean; dedicated?: boolean; concourse?: ConcourseRoute }): string {
  const c = l.concourse;
  const via = c ? `lewat concourse ${c.name ?? c.code} (gate ke concourse: ${meansText(c.toConcourse)}; concourse ke peron: ${meansText(c.toPlatform)})` : VIA_LABEL[l.via];
  return `${via}${l.stepFree ? " beramp tanpa anak tangga" : ""}${l.dedicated ? " khusus pengguna disabilitas" : ""}`;
}

const STATUS_RANK: Record<AmenityDetailStatus, number> = { out_of_service: 0, absent: 1, unknown: 2, available: 3 };

/** Ruas tanpa anak tangga: ada jalan datar atau ramp. */
export const segmentLevel = (s: Pick<AccessSegment, "means">) => s.means.includes("datar") || s.means.includes("ramp");

/** Status lift pada satu ruas: tidak ada bila "lift" tidak tercantum; tanpa status berarti berfungsi. */
export function segmentLift(s: AccessSegment): AmenityDetailStatus {
  if (!s.means.includes("lift") || s.lift?.count === 0) return "absent";
  return s.lift?.status ?? "available";
}

/** Eskalator pada satu ruas tersedia bila tercantum dan tidak semua kelompoknya sedang tidak berfungsi/tidak ada. */
export function segmentEscalator(s: AccessSegment): AmenityStatus {
  if (!s.means.includes("eskalator")) return "absent";
  const groups = s.escalators ?? [];
  return groups.length && groups.every((g) => g.status && g.status !== "available" && g.status !== "unknown") ? "absent" : "available";
}

/** Satu kemungkinan jalur dari satu gate ke satu peron. */
interface PathOption {
  gate: Entrance;
  via: AccessVia;
  level: boolean;
  /** Boleh dipakai walau gate tidak aksesibel: ada ruas khusus disabilitas. */
  dedicated?: boolean;
  stepFree?: boolean;
  concourse?: ConcourseRoute;
  pathLift?: AmenityDetailStatus;
  pathEscalator?: AmenityStatus;
  rank: number;
}

/**
 * Jalur gate → concourse → peron. Tanpa anak tangga bila kedua ruas datar/ramp. Bila ada ruas yang pindah lantai,
 * lift dan eskalator ruas itu (status terburuk) yang menentukan: jalur ber-lift lebih baik daripada jalur tangga saja.
 */
function concoursePath(gate: Entrance, toConcourse: AccessSegment, concourse: Concourse, toPlatform: AccessSegment): PathOption {
  const vertical = [toConcourse, toPlatform].filter((s) => !segmentLevel(s));
  const level = vertical.length === 0;
  const lift = level ? undefined : vertical.map(segmentLift).reduce((a, b) => (STATUS_RANK[b] < STATUS_RANK[a] ? b : a));
  const escalator: AmenityStatus | undefined = level ? undefined : vertical.every((s) => segmentEscalator(s) === "available") ? "available" : "absent";
  const dedicated = !!(toConcourse.dedicated || toPlatform.dedicated);
  // Concourse menambah satu perpindahan, jadi sedikit di bawah jalur langsung yang setara.
  const base = level ? 1 : lift === "available" ? 5 : lift === "unknown" ? 7 : 13;
  return {
    gate,
    via: "concourse",
    level,
    ...(dedicated ? { dedicated } : {}),
    concourse: { code: concourse.code, ...(concourse.name ? { name: concourse.name } : {}), toConcourse: toConcourse.means, toPlatform: toPlatform.means },
    ...(lift ? { pathLift: lift } : {}),
    ...(escalator ? { pathEscalator: escalator } : {}),
    rank: base - (dedicated ? 0.5 : 0),
  };
}

/** Semua jalur dari gate ke satu peron: langsung (platformLinks) dan lewat concourse (concourseLinks). */
export function platformPaths(entrances: Entrance[], code: string, concourses: Concourse[] = []): PathOption[] {
  const out: PathOption[] = [];
  const byCode = new Map(concourses.map((c) => [c.code, c]));
  for (const e of entrances) {
    for (const l of e.platformLinks ?? []) {
      if (l.platform !== code) continue;
      out.push({
        gate: e,
        via: l.via,
        level: isStepFree(l),
        ...(l.dedicated ? { dedicated: true } : {}),
        ...(l.stepFree && !LEVEL_CONNECTIONS.includes(l.via) ? { stepFree: true } : {}),
        rank: linkRank(l),
      });
    }
    for (const g of e.concourseLinks ?? []) {
      const c = byCode.get(g.concourse);
      if (!c) continue;
      for (const l of c.platformLinks) if (l.platform === code) out.push(concoursePath(e, g, c, l));
    }
  }
  return out;
}

/**
 * Jalur terbaik dari gate ke setiap peron (langsung atau lewat concourse), lalu yang terburuk di antaranya. Gate
 * yang tidak aksesibel dari jalan hanya dipakai bila tidak ada gate lain menuju peron itu; jalur khusus disabilitas
 * selalu boleh dipakai. undefined bila ada peron yang belum diketahui jalurnya. Tanpa concourse, hasilnya sama
 * dengan data lama (gate langsung ke peron).
 */
export function layoutAccess(entrances: Entrance[], codes: string[], concourses: Concourse[] = []): LayoutAccess | undefined {
  if (!codes.length) return undefined;
  const best: PathOption[] = [];
  for (const code of codes) {
    const paths = platformPaths(entrances, code, concourses);
    if (!paths.length) return undefined;
    const ok = paths.filter((x) => x.gate.accessible || x.dedicated);
    best.push((ok.length ? ok : paths).reduce((x, y) => (y.rank < x.rank ? y : x)));
  }
  const worst = best.reduce((x, y) => (y.rank > x.rank ? y : x));
  return {
    platforms: codes,
    level: worst.level,
    via: worst.via,
    gate: worst.gate.name,
    ...(worst.dedicated ? { dedicated: true } : {}),
    ...(worst.stepFree ? { stepFree: true } : {}),
    ...(worst.concourse ? { concourse: worst.concourse } : {}),
    ...(worst.pathLift ? { pathLift: worst.pathLift } : {}),
    ...(worst.pathEscalator ? { pathEscalator: worst.pathEscalator } : {}),
  };
}

const STATION_NOTE = "Jalur gate ke peron";
const JOURNEY_NOTE = "Skor perjalanan";

const LIFT_TEXT: Record<AmenityDetailStatus, string> = { available: "ada lift", absent: "tanpa lift", unknown: "lift belum ada datanya", out_of_service: "lift sedang tidak berfungsi" };

function layoutNote(prefix: string, where: string, l: LayoutAccess): string {
  const gate = l.gate ? ` dari gate ${l.gate}` : "";
  if (l.level) return `${prefix}: ${where} dicapai ${viaText(l)}${gate}, jadi lift dan eskalator tidak dibutuhkan.`;
  const lift = l.pathLift ? ` (${LIFT_TEXT[l.pathLift]} pada ruas yang pindah lantai)` : "";
  return `${prefix}: ${where} hanya dicapai ${viaText(l)}${gate}${lift}, jadi lift dan eskalator ${l.pathLift ? "di jalur itu " : ""}menentukan skor.`;
}

const penaltyNote = (p: ScorePenalty) => `${p.reason} (skor −${p.points}).`;

/** Potongan karena celah peron dengan kendaraan; diambil yang terbesar di antara peron yang dipakai. */
function gapPenalty(platforms: (Platform | undefined)[], snap: ContentSnapshot): ScorePenalty | undefined {
  const points = snap.gapPenalty();
  let worst: ScorePenalty | undefined;
  for (const p of platforms) {
    const g = p?.gap;
    if (!p || !g || g.level === "sejajar") continue;
    const base = g.level === "tangga" ? points.tangga : points.sedikit;
    const n = g.boardingAid ? Math.round(base / 2) : base;
    if (!n || (worst && worst.points >= n)) continue;
    const what = g.level === "tangga" ? `${g.steps ?? "beberapa"} anak tangga` : "beda tinggi kecil";
    worst = { reason: `Celah peron ${p.code}: ${what} antara peron dan kendaraan${g.boardingAid ? ", ada pelat/ramp dari petugas" : ""}`, points: n };
  }
  return worst;
}

/** Jalur satu gate ke peron-peron yang dipakai (jalur terburuk di antara jalur terbaik tiap peron); undefined bila belum didata. */
function gatePath(gate: Entrance, codes: string[], concourses: Concourse[]): PathOption | undefined {
  let worst: PathOption | undefined;
  for (const code of codes) {
    const paths = platformPaths([gate], code, concourses);
    if (!paths.length) return undefined;
    const best = paths.reduce((x, y) => (y.rank < x.rank ? y : x));
    if (!worst || best.rank > worst.rank) worst = best;
  }
  return worst;
}

/** Peringkat gate untuk peron yang dipakai: jalur (lebih kecil lebih baik), ditambah bila gate tidak aksesibel dari jalan. */
const gateRank = (gate: Entrance, path: PathOption) => path.rank + (gate.accessible || path.dedicated ? 0 : 4);

const LIFT_REASON: Record<AmenityDetailStatus, string> = { available: "", absent: "tanpa lift", unknown: "lift belum ada datanya", out_of_service: "lift sedang tidak berfungsi" };

/** Alasan singkat sebuah gate kurang aksesibel dibanding gate yang disarankan. */
function gateReason(gate: Entrance, path: PathOption, liftAt: AmenityDetailStatus | undefined): string {
  const parts: string[] = [];
  if (!path.level) {
    const lift = path.pathLift ?? liftAt;
    parts.push(`harus ${viaText(path).replace(/^lewat /, "lewat ")}${lift && lift !== "available" ? ` (${LIFT_REASON[lift]})` : ""}`);
  } else if (path.via === "sebidang" || path.via === "crosswalk") parts.push(`harus ${VIA_LABEL[path.via].replace(/^lewat /, "lewat ")}`);
  if (!gate.accessible && !path.dedicated) parts.push("pintunya belum ditandai aksesibel");
  return parts.join(" dan ") || "jalurnya lebih sulit";
}

/**
 * Pintu pilihan pengguna untuk masuk (asal) atau keluar (tujuan): skor memakai jalur pintu itu ke peron yang dipakai,
 * dan pintu lain yang jalurnya lebih mudah (tanpa pindah lantai, ber-lift, atau aksesibel dari jalan) disarankan.
 * Bila jalur pintu pilihan belum didata, skor memakai pintu terbaik dan pintu terbaik itu disarankan.
 */
export function gateChoice(d: Pick<StationDetail, "entrances" | "concourses">, codes: string[], chosenId: string, role: GateChoice["role"], liftAt?: AmenityDetailStatus): { choice: GateChoice; entrances?: Entrance[] } | undefined {
  const chosen = d.entrances.find((e) => e.id === chosenId);
  if (!chosen) return undefined;
  const concourses = d.concourses ?? [];
  const ranked = d.entrances
    .flatMap((g) => {
      const p = codes.length ? gatePath(g, codes, concourses) : undefined;
      return p ? [{ g, p, r: gateRank(g, p) }] : [];
    })
    .sort((a, b) => a.r - b.r);
  const mine = ranked.find((x) => x.g.id === chosenId);
  const best = ranked[0];
  const base: GateChoice = { role, chosenId, chosen: chosen.name, known: !!mine };
  // Disarankan bila jalur pintu lain jelas lebih mudah (selisih peringkat ≥ 2: mis. langsung vs JPO, gate aksesibel vs tidak).
  const better = best && best.g.id !== chosenId && (!mine || mine.r - best.r >= 2) ? best : undefined;
  const choice: GateChoice = better
    ? {
        ...base,
        recommendedId: better.g.id,
        recommended: better.g.name,
        reason: mine ? gateReason(chosen, mine.p, liftAt) : "jalurnya ke peron belum didata",
        recommendedVia: viaText(better.p).replace(/^lewat /, "lewat "),
      }
    : base;
  return { choice, ...(mine ? { entrances: [chosen] } : {}) };
}

/**
 * Skor stasiun untuk satu perjalanan. Bila semua peron yang dipakai dapat dicapai dari gate tanpa anak tangga
 * (langsung, crosswalk, pelintasan sebidang, atau JPO/terowongan beramp), lift dan eskalator tidak dibutuhkan sehingga
 * dianggap terpenuhi. Bila peron hanya dapat dicapai lewat JPO/terowongan bertangga, lift dan eskalator menentukan skor,
 * memakai fasilitas peron itu bila tim sudah mengisinya. Untuk gate yang menuju concourse dulu (gate → concourse → peron),
 * jalur tanpa anak tangga bila kedua ruas datar/ramp; bila ada ruas yang pindah lantai, lift dan eskalator ruas itu yang
 * dipakai (bukan status stasiun). Bila jalur ke salah satu peron belum diisi, faktor jalur
 * diabaikan (bobot fasilitas biasa). Celah peron yang dipakai memotong skor; celah peron lain di stasiun tidak.
 * Tanpa data jalur maupun celah peron, skor stasiun dipakai apa adanya.
 */
export function journeyAssessment(
  a: StationAssessment,
  d: StationDetail,
  codes: string[],
  snap: ContentSnapshot,
  gate?: { id: string; role: GateChoice["role"] },
): StationAssessment {
  if (!codes.length) return gate ? withGateOnly(a, d, gate) : a;
  // Pintu pilihan pengguna: jalur pintu itu yang dinilai (bila sudah didata).
  const chosen = gate ? gateChoice(d, codes, gate.id, gate.role, d.amenities.lift) : undefined;
  const layout = layoutAccess(chosen?.entrances ?? d.entrances, codes, d.concourses ?? []);
  const platforms = codes.map((c) => d.platforms.find((p) => p.code === c));
  const penalty = gapPenalty(platforms, snap);
  // Skor stasiun mungkin memuat jalur atau celah peron lain, jadi dihitung ulang dari peron yang dipakai.
  if (!layout && !penalty && !a.layout && !a.penalties?.length && !chosen) return a;
  const fromStation = new Set<AmenityType>();
  const statusOf = (t: AmenityType): AmenityStatus => {
    // Jalur lewat concourse yang pindah lantai: lift/eskalator ruas itu yang dipakai.
    const path = pathStatus(layout, t);
    if (path) return path;
    // Toilet dan fasilitas umum lain selalu dari data stasiun; fasilitas mobilitas dari peron bila sudah diisi.
    if (!(PLATFORM_AMENITIES as readonly string[]).includes(t)) return d.amenities[t];
    const own = platforms.map((p) => p?.amenities[t as PlatformAmenityType]);
    // Fasilitas peron dipakai bila tersedia untuk semua peron yang dipakai; status terburuk yang dihitung.
    if (own.every((x) => x)) return own.some((x) => x !== "available") ? (own.includes("unknown") ? "unknown" : "absent") : "available";
    // Detail peron belum ada: dihitung dari fasilitas umum stasiun.
    fromStation.add(t);
    return d.amenities[t];
  };
  const level = !!layout?.level;
  const excluded = level ? VERTICAL : [];
  const penalties = penalty ? [penalty] : [];
  const { score, factors } = computeScore({ statusOf, details: d.amenityDetails, excluded, penalties }, snap);
  const lift = level ? undefined : statusOf("lift");
  // Lift/eskalator yang tidak dibutuhkan tidak dicatat sebagai "dari data stasiun".
  const derived = [...fromStation].filter((t) => !excluded.includes(t));
  // Catatan jalur dan celah peron tingkat stasiun diganti dengan yang untuk peron yang dipakai.
  const stationPenalties = new Set((a.penalties ?? []).map(penaltyNote));
  const notes = (a.notes ?? []).filter((n) => !n.startsWith(STATION_NOTE) && !stationPenalties.has(n));
  if (layout) notes.push(layoutNote(JOURNEY_NOTE, `peron ${codes.join(", ")}`, layout));
  if (layout && !level && derived.some((t) => VERTICAL.includes(t))) notes.push(`Fasilitas peron ${codes.join(", ")} belum diisi tim; lift dan eskalator dihitung dari fasilitas umum stasiun.`);
  if (penalty) notes.push(penaltyNote(penalty));
  if (chosen && !chosen.choice.known) notes.push(`Jalur dari ${chosen.choice.chosen} ke peron ${codes.join(", ")} belum didata; skor memakai pintu dengan jalur terbaik.`);
  const { penalties: _, layout: __, ...rest } = a;
  return {
    ...rest,
    score,
    adequate: a.dataAvailable && score >= snap.settings.scoring.threshold,
    factors,
    ...(penalties.length ? { penalties } : {}),
    notes,
    ...(layout
      ? { journey: { ...layout, platforms: codes, excluded, ...(lift ? { lift } : {}), ...(derived.length ? { fromStation: derived } : {}), stationScore: a.score } }
      : {}),
    ...(chosen ? { gateChoice: chosen.choice } : {}),
  };
}

/** Pintu pilihan di stasiun yang peron perjalanannya tidak diketahui: dinilai terhadap semua peron stasiun. */
function withGateOnly(a: StationAssessment, d: StationDetail, gate: { id: string; role: GateChoice["role"] }): StationAssessment {
  const codes = a.layout?.platforms ?? d.platforms.map((p) => p.code);
  const chosen = gateChoice(d, codes, gate.id, gate.role, d.amenities.lift);
  return chosen ? { ...a, gateChoice: chosen.choice } : a;
}
