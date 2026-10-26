// Modul Analisis Fasilitas (UC-04). Skor dihitung deterministik dengan bobot per jenis amenity
// (Tabel 3.4 no. 7), bukan oleh LLM, dan "data tidak tersedia" dibedakan dari "fasilitas tidak ada" (no. 9).

import type { RequestContext } from "../context";
import type { CommuteApiClient } from "../data/commute/CommuteApiClient";
import type { ContentSnapshot } from "./content";
import {
  CORE_AMENITIES,
  LEVEL_CONNECTIONS,
  type AmenityDetail,
  type AmenityStatus,
  type AmenityType,
  type PlatformConnection,
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

  score(f: StationFacilities, snap: ContentSnapshot): number {
    return CORE_AMENITIES.reduce((s, t) => s + (f.amenities[t] === "available" ? snap.weight(t) : 0), 0);
  }

  async assess(stationId: string, ctx: RequestContext, snap: ContentSnapshot): Promise<{ assessment: StationAssessment; facilities: StationFacilities }> {
    const f = await this.facilities(stationId, ctx, snap);
    const total = CORE_AMENITIES.reduce((s, t) => s + snap.weight(t), 0) || 1;
    // Skor dinormalisasi ke 0–100 agar bobot dapat diatur bebas dari halaman admin.
    const score = Math.round((this.score(f, snap) / total) * 100);
    const notes: string[] = [];
    if (!f.dataAvailable) notes.push("Data fasilitas belum tersedia; belum terverifikasi.");
    for (const d of f.amenityDetails) {
      if (d.source !== "ntd") continue;
      const label = AMENITY_LABEL[d.type] ?? d.type;
      if (d.status === "out_of_service") notes.push(`${label} sedang tidak berfungsi${d.note ? `: ${d.note.replace(/[.\s]+$/, "")}` : ""}.`);
      else if (d.note) notes.push(`${label}: ${d.note}`);
    }
    return {
      assessment: {
        stationId,
        score,
        adequate: f.dataAvailable && score >= snap.settings.scoring.threshold,
        dataAvailable: f.dataAvailable,
        ...(notes.length ? { notes } : {}),
      },
      facilities: f,
    };
  }
}

/** Jalur gate ke peron, dari yang paling mudah. */
const VIA_RANK: Record<PlatformConnection, number> = { langsung: 0, crosswalk: 1, sebidang: 2, jpo: 3, terowongan: 3 };
export const VIA_LABEL: Record<PlatformConnection, string> = {
  langsung: "langsung dari gate",
  crosswalk: "lewat penyeberangan jalan (crosswalk)",
  sebidang: "lewat pelintasan sebidang (menyeberang rel)",
  jpo: "lewat JPO",
  terowongan: "lewat terowongan",
};
const VERTICAL: AmenityType[] = ["lift", "eskalator"];

/**
 * Skor stasiun untuk satu perjalanan. Bila semua peron yang dipakai dapat dicapai dari gate tanpa pindah lantai
 * (langsung, crosswalk, pelintasan sebidang), lift dan eskalator tidak dibutuhkan sehingga tidak ikut dihitung.
 * Bila peron hanya dapat dicapai lewat JPO/terowongan, lift dan eskalator menentukan skor, memakai fasilitas peron
 * itu bila tim sudah mengisinya. Tanpa data hubungan gate dengan peron, skor stasiun dipakai apa adanya.
 */
export function journeyAssessment(a: StationAssessment, d: StationDetail, codes: string[], snap: ContentSnapshot): StationAssessment {
  if (!codes.length) return a;
  const best: { code: string; via: PlatformConnection; gate: string }[] = [];
  for (const code of codes) {
    const links = d.entrances.flatMap((e) => (e.platformLinks ?? []).filter((l) => l.platform === code).map((l) => ({ e, l })));
    if (!links.length) return a;
    // Gate yang tidak aksesibel dari jalan hanya dipakai bila tidak ada gate lain menuju peron ini.
    const usable = links.some((x) => x.e.accessible) ? links.filter((x) => x.e.accessible) : links;
    const pick = usable.reduce((x, y) => (VIA_RANK[y.l.via] < VIA_RANK[x.l.via] ? y : x));
    best.push({ code, via: pick.l.via, gate: pick.e.name });
  }
  const worst = best.reduce((x, y) => (VIA_RANK[y.via] > VIA_RANK[x.via] ? y : x));
  const level = LEVEL_CONNECTIONS.includes(worst.via);
  const excluded = level ? VERTICAL : [];
  const platforms = codes.map((c) => d.platforms.find((p) => p.code === c));
  const statusOf = (t: AmenityType): AmenityStatus => {
    const own = platforms.map((p) => p?.amenities[t]);
    // Fasilitas peron dipakai bila tersedia untuk semua peron yang dipakai; status terburuk yang dihitung.
    if (own.every((x) => x)) return own.some((x) => x !== "available") ? (own.includes("unknown") ? "unknown" : "absent") : "available";
    return d.amenities[t];
  };
  const counted = CORE_AMENITIES.filter((t) => !excluded.includes(t));
  const total = counted.reduce((sum, t) => sum + snap.weight(t), 0) || 1;
  const score = Math.round((counted.reduce((sum, t) => sum + (statusOf(t) === "available" ? snap.weight(t) : 0), 0) / total) * 100);
  const where = best.length === 1 ? `peron ${worst.code}` : `peron ${codes.join(", ")}`;
  const note = level
    ? `Skor perjalanan: ${where} dicapai ${VIA_LABEL[worst.via]} (${worst.gate}), jadi lift dan eskalator tidak dihitung.`
    : `Skor perjalanan: ${where} hanya dicapai ${VIA_LABEL[worst.via]} (${worst.gate}), jadi lift dan eskalator menentukan skor.`;
  return {
    ...a,
    score,
    adequate: a.dataAvailable && score >= snap.settings.scoring.threshold,
    notes: [...(a.notes ?? []), note],
    journey: { platforms: codes, level, via: worst.via, gate: worst.gate, excluded, ...(level ? {} : { lift: statusOf("lift") }), stationScore: a.score },
  };
}
