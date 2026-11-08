// Modul Analisis Fasilitas (UC-04). Skor dihitung deterministik dengan bobot per jenis amenity
// (Tabel 3.4 no. 7), bukan oleh LLM, dan "data tidak tersedia" dibedakan dari "fasilitas tidak ada" (no. 9).

import type { RequestContext } from "../context";
import type { CommuteApiClient } from "../data/commute/CommuteApiClient";
import type { ContentSnapshot } from "./content";
import {
  CORE_AMENITIES,
  EXTRA_AMENITIES,
  LEVEL_CONNECTIONS,
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
  type GatePlatformLink,
  type LayoutAccess,
  type Platform,
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

    const amenities = {} as Record<AmenityType, AmenityStatus>;
    for (const t of CORE_AMENITIES) {
      const d = details.get(t);
      amenities[t] = !d ? "unknown" : d.status === "out_of_service" ? "absent" : d.status;
    }
    const dataAvailable = !!dataset || overrides.some((o) => (CORE_AMENITIES as readonly string[]).includes(o.type) && o.status !== "unknown");
    return { amenities, amenityDetails: [...details.values()], dataAvailable };
  }

  async assess(stationId: string, ctx: RequestContext, snap: ContentSnapshot): Promise<{ assessment: StationAssessment; facilities: StationFacilities }> {
    const f = await this.facilities(stationId, ctx, snap);
    // Jalur gate ke peron dan celah peron dari isian tim. Peron dataset ikut diperiksa, tetapi hanya untuk stasiun yang
    // sudah diisi tim, agar daftar stasiun tidak memicu permintaan peron untuk ratusan stasiun.
    const entrances = snap.entrancesOf(stationId);
    const concourses = snap.concoursesOf(stationId);
    const own = snap.platformsOf(stationId);
    const linked = [...entrances.flatMap((e) => (e.platformLinks ?? []).map((l) => l.platform)), ...concourses.flatMap((c) => c.platformLinks.map((l) => l.platform))];
    const surveyed = own.length > 0 || linked.length > 0;
    const dataset = surveyed ? await this.commute.getPlatforms(stationId, ctx).catch(() => [] as Platform[]) : [];
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
export function journeyAssessment(a: StationAssessment, d: StationDetail, codes: string[], snap: ContentSnapshot): StationAssessment {
  if (!codes.length) return a;
  const layout = layoutAccess(d.entrances, codes, d.concourses ?? []);
  const platforms = codes.map((c) => d.platforms.find((p) => p.code === c));
  const penalty = gapPenalty(platforms, snap);
  // Skor stasiun mungkin memuat jalur atau celah peron lain, jadi dihitung ulang dari peron yang dipakai.
  if (!layout && !penalty && !a.layout && !a.penalties?.length) return a;
  const statusOf = (t: AmenityType): AmenityStatus => {
    // Jalur lewat concourse yang pindah lantai: lift/eskalator ruas itu yang dipakai.
    const path = pathStatus(layout, t);
    if (path) return path;
    const own = platforms.map((p) => p?.amenities[t]);
    // Fasilitas peron dipakai bila tersedia untuk semua peron yang dipakai; status terburuk yang dihitung.
    if (own.every((x) => x)) return own.some((x) => x !== "available") ? (own.includes("unknown") ? "unknown" : "absent") : "available";
    return d.amenities[t];
  };
  const level = !!layout?.level;
  const excluded = level ? VERTICAL : [];
  const penalties = penalty ? [penalty] : [];
  const { score, factors } = computeScore({ statusOf, details: d.amenityDetails, excluded, penalties }, snap);
  // Catatan jalur dan celah peron tingkat stasiun diganti dengan yang untuk peron yang dipakai.
  const stationPenalties = new Set((a.penalties ?? []).map(penaltyNote));
  const notes = (a.notes ?? []).filter((n) => !n.startsWith(STATION_NOTE) && !stationPenalties.has(n));
  if (layout) notes.push(layoutNote(JOURNEY_NOTE, `peron ${codes.join(", ")}`, layout));
  if (penalty) notes.push(penaltyNote(penalty));
  const { penalties: _, layout: __, ...rest } = a;
  return {
    ...rest,
    score,
    adequate: a.dataAvailable && score >= snap.settings.scoring.threshold,
    factors,
    ...(penalties.length ? { penalties } : {}),
    notes,
    ...(layout ? { journey: { ...layout, platforms: codes, excluded, ...(level ? {} : { lift: statusOf("lift") }), stationScore: a.score } } : {}),
  };
}
