// Modul Analisis Fasilitas (UC-04). Skor dihitung deterministik dengan bobot per jenis amenity
// (Tabel 3.4 no. 7), bukan oleh LLM, dan "data tidak tersedia" dibedakan dari "fasilitas tidak ada" (no. 9).

import type { RequestContext } from "../context";
import type { CommuteApiClient } from "../data/commute/CommuteApiClient";
import type { ContentSnapshot } from "./content";
import {
  CORE_AMENITIES,
  type AmenityDetail,
  type AmenityStatus,
  type AmenityType,
  type StationAssessment,
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
      for (const t of CORE_AMENITIES) details.set(t, { type: t, status: listed.has(t) ? "available" : "absent", source: "dataset" });
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
