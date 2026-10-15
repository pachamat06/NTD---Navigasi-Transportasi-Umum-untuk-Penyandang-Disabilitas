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

export interface UpHubTransfer {
  from: UpStopRef;
  to: UpStopRef;
  distanceM: number;
  durationS?: number | null;
}

export interface UpHub {
  id: string;
  name: string;
  stations: UpStopRef[];
  transfers?: UpHubTransfer[];
}

export interface UpStopTime {
  stop: UpStopRef;
  arrivalAt?: string | null;
  departureAt?: string | null;
}

export interface UpLeg {
  type: "RIDE" | "TRANSFER";
  operator?: string;
  line?: string;
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
  getOperators(): Promise<UpOperator[]>;
  getLines(): Promise<UpLine[]>;
  getLine(operator: string, lineCode: string): Promise<UpLine | null>;
  /**
   * Jenis fasilitas inti yang dapat dinyatakan sumber ini. Jenis di luar daftar berstatus "data tidak tersedia",
   * bukan "tidak ada" (Tabel 3.4 no. 9). Tidak diisi = semua jenis inti.
   */
  readonly amenityCoverage?: readonly string[];
}
