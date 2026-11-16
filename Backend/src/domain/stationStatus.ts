// Status operasional stasiun. Dataset Commute masih mencantumkan sebagian stasiun yang sudah tidak beroperasi (mis.
// Karet); stasiun itu ditandai nonaktif agar pencarian rute memberi pesan "Stasiun X sudah tidak beroperasi" dan
// tidak dipakai sebagai titik pindah. Sumbernya: daftar bawaan NTD (BUILTIN_INACTIVE) dan isian admin (jenis konten
// "station_status", satu per stasiun) yang menang atas daftar bawaan, termasuk untuk mengaktifkan kembali.

import type { RequestContext } from "../context";

export interface StationStatusContent {
  stationId: string;
  inactive: boolean;
  /** Keterangan untuk pengguna, mis. "Layanan dipindahkan ke Stasiun BNI City." */
  note?: string;
}

/** Status stasiun yang berlaku untuk satu stasiun nonaktif. */
export interface InactiveStatus {
  note?: string;
  source: "ntd" | "admin";
}

export type StationStatusProvider = (ctx: RequestContext) => Promise<StationStatusContent[]>;

/** Stasiun dataset yang sudah tidak beroperasi menurut tim NTD. */
export const BUILTIN_INACTIVE: Record<string, string | undefined> = {
  // KRL Karet (KCI-KAT): masih tercantum di Commute Data API, tetapi sudah tidak melayani penumpang.
  "kci:kat": undefined,
};

/** Stasiun nonaktif yang berlaku: daftar bawaan, lalu isian admin (nonaktif = ditambah, aktif = dihapus dari daftar). */
export function inactiveStations(overrides: StationStatusContent[]): Map<string, InactiveStatus> {
  const out = new Map<string, InactiveStatus>();
  for (const [id, note] of Object.entries(BUILTIN_INACTIVE)) out.set(id, { source: "ntd", ...(note ? { note } : {}) });
  for (const o of overrides) {
    if (o.inactive) out.set(o.stationId, { source: "admin", ...(o.note ? { note: o.note } : {}) });
    else out.delete(o.stationId);
  }
  return out;
}

/** Pesan untuk pengguna yang memilih stasiun nonaktif. */
export function inactiveMessage(name: string, status: InactiveStatus): string {
  return `Stasiun ${name} sudah tidak beroperasi.${status.note ? ` ${status.note.trim().replace(/([^.!?])$/, "$1.")}` : ""} Pilih stasiun lain.`;
}
