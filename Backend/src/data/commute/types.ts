// Kontrak data internal antara sumber data (HttpCommuteSource / FixtureCommuteSource) dan CommuteApiClient.
// Bentuk respons asli Commute Data API (OpenAPI 3.1, api.commute.shiorilabs.id/openapi.json) ada di
// HttpCommuteSource.ts dan dipetakan ke tipe di bawah, sehingga lapisan di atasnya tidak bergantung
// pada format upstream.

import type { Mode } from "../../domain/models";

export interface UpStopRef {
  operator: string;
  code: string;
}

export interface UpAmenity {
  /** Contoh upstream: ELEVATOR_PAID, ESCALATOR_UNPAID, TOILET_ACCESSIBLE. */
  type: string;
  name?: string;
  description?: string;
}

export interface UpStation extends UpStopRef {
  name: string;
  /** Nama versi operator (mis. "SUDIRMAN BARU" untuk BNI City); dipakai untuk pencocokan nama. */
  officialName?: string;
  /** Lini yang melayani stasiun ini: kode lini milik operator yang sama, atau kunci lengkap `OPERATOR:KODE`. */
  lines?: string[];
  hub?: string | null;
  /** null/kosong = data amenity tidak tersedia (bukan "fasilitas tidak ada"). */
  amenities?: UpAmenity[] | null;
  /** Indikator kepadatan dari API; TIDAK dipakai sebagai skor aksesibilitas (Tabel 3.4 no. 7). */
  score?: number | null;
  lat?: number | null;
  lng?: number | null;
}

export interface UpOperator {
  code: string;
  name: string;
  mode: Mode;
}

export interface UpLine {
  operator: string;
  code: string;
  name: string;
  color?: string;
  mode?: Mode;
  stations: UpStopRef[];
  /** Nomor stasiun pada lin ini (sejajar dengan `stations`), mis. "C12" atau "1-13"; dipakai untuk posisi di peta. */
  stationNumbers?: (string | null)[];
  /**
   * Ruas lin berurutan (batang utama dan cabang). `joinsAt` = stasiun tempat cabang berpisah dari batang utama.
   * Tidak diisi = `stations` adalah satu ruas lurus.
   */
  segments?: { stations: UpStopRef[]; joinsAt?: UpStopRef }[];
}

/** Pintu keluar stasiun (/stations/{op}/{code}/exits, rujukan pada transfer). */
export interface UpExitRef {
  /** Nama pintu persis seperti papan petunjuk, mis. "B". */
  ref: string;
  name?: string | null;
  /** Isi papan petunjuk pintu itu, urut seperti tercetak. */
  signs?: string[];
}

export interface UpHubTransfer {
  from: UpStopRef;
  to: UpStopRef;
  distanceM: number;
  durationS?: number | null;
  /** Petunjuk jalan dari sumber data, mis. "Keluar lewat pintu B, lalu ...". */
  notes?: string | null;
  fromExit?: UpExitRef;
  toExit?: UpExitRef;
}

export interface UpHub {
  id: string;
  name: string;
  /** "integrated" = bagi penumpang satu tempat; "hub" = beberapa stasiun dalam satu kompleks. */
  kind?: "hub" | "integrated";
  stations: UpStopRef[];
  transfers?: UpHubTransfer[];
}

/** Nomor peron untuk satu lin dan arah di satu stasiun (/stations/{op}/{code}/timetable/grouped). */
export interface UpPlatformService {
  operator: string;
  line: string;
  platformCode: string;
  /** Label arah seperti di papan keberangkatan, mis. "Arah Manggarai". */
  direction?: string;
}

/** Pintu keluar/gate stasiun (/stations/{op}/{code}/exits). */
export interface UpExit extends UpExitRef {
  /** FIELD = dicek di lokasi, OPERATOR = peta resmi operator, OSM = OpenStreetMap. */
  source?: string;
}

/** Frekuensi kendaraan satu lin di satu pemberhentian (/stations/{op}/{code}/headway). BUKAN jadwal. */
export interface UpHeadway {
  operator: string;
  line: string;
  /** Rata-rata jarak antarkendaraan (detik); null = lin tidak jalan pada hari itu. */
  headwayS: number | null;
  /** Tujuan akhir arah ini, bila dua arah berbeda frekuensinya. */
  boundFor?: string;
  /** "STOP" = diukur di pemberhentian ini, "LINE" = rata-rata se-lin. */
  source?: "STOP" | "LINE";
  serviceHours?: { start: string; end: string } | { allDay: true };
}

export interface UpStopTime {
  stop: UpStopRef;
  arrivalAt?: string | null;
  departureAt?: string | null;
}

/** Lin yang melayani ruas yang sama (jalur dipakai bersama), mis. TJ 4, 4D, 5, 5C dari Matraman ke Kesatrian. */
export interface UpServiceLine {
  operator: string;
  line: string;
  headsign?: string | null;
}

export interface UpLeg {
  type: "RIDE" | "TRANSFER";
  operator?: string;
  line?: string;
  /** Tujuan akhir kendaraan pada ruas naik. */
  headsign?: string | null;
  /** Nomor peron naik, bila diketahui dataset. */
  platformCode?: string | null;
  /** Lin lain yang berhenti di pemberhentian yang sama sepanjang ruas ini (termasuk lin utama, paling depan). */
  serviceLines?: UpServiceLine[];
  stops: UpStopRef[];
  /** Nama tampilan tiap pemberhentian (sejajar dengan `stops`), bila sumber menyediakannya. */
  stopNames?: string[];
  distanceM: number;
  fare?: number;
  departureAt?: string | null;
  arrivalAt?: string | null;
  stopTimes?: UpStopTime[];
}

export interface UpFare {
  from: UpStopRef;
  to: UpStopRef;
  at?: string;
  currency?: string;
  totalFare: number;
  totalDistanceM: number;
  legs: UpLeg[];
}

/** Satu-satunya kontrak sumber data. HttpCommuteSource (API sungguhan) dan FixtureCommuteSource (offline). */
export interface CommuteSource {
  readonly name: string;
  getStations(): Promise<UpStation[]>;
  getStation(operator: string, code: string): Promise<UpStation | null>;
  /** null bila rute tidak ditemukan. */
  getFare(from: UpStopRef, to: UpStopRef, at?: string): Promise<UpFare | null>;
  getHubs(): Promise<UpHub[]>;
  /** Transfer jalan kaki dari satu stasiun (jarak, petunjuk, pintu). Tidak diisi = sumber tidak menyediakan. */
  getTransfers?(operator: string, code: string): Promise<UpHubTransfer[] | null>;
  /** Frekuensi lin di satu pemberhentian pada waktu `at` (default sekarang). Tidak diisi = sumber tidak menyediakan. */
  getHeadways?(operator: string, code: string, at?: string): Promise<UpHeadway[] | null>;
  /** Nomor peron tiap lin dan arah di satu stasiun. Tidak diisi = sumber tidak menyediakan. */
  getPlatforms?(operator: string, code: string): Promise<UpPlatformService[] | null>;
  /** Pintu keluar/gate satu stasiun. Tidak diisi = sumber tidak menyediakan. */
  getExits?(operator: string, code: string): Promise<UpExit[] | null>;
  getOperators(): Promise<UpOperator[]>;
  getLines(): Promise<UpLine[]>;
  getLine(operator: string, lineCode: string): Promise<UpLine | null>;
  /**
   * Jenis fasilitas inti yang dapat dinyatakan sumber ini. Jenis di luar daftar berstatus "data tidak tersedia",
   * bukan "tidak ada" (Tabel 3.4 no. 9). Tidak diisi = semua jenis inti.
   */
  readonly amenityCoverage?: readonly string[];
}
