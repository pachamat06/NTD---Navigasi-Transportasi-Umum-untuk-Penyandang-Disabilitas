// Bentuk respons Commute Data API (api.commute.shiorilabs.id) sebagaimana dipakai NTD.
//
// PENTING: nama field di bawah disusun dari draf laporan (Bab III, Tabel 3.3: legs RIDE/TRANSFER,
// stops, distanceM, totalDistanceM, departureAt, arrivalAt, stopTimes, mode operator/lini, amenities)
// dan BELUM diverifikasi terhadap API sungguhan (kartu NTD-03). Bila hasil verifikasi berbeda,
// cukup ubah file ini dan pemetaan di HttpCommuteSource.ts; lapisan di atasnya tidak berubah.

import type { Mode } from "../../domain/models";

export interface UpStopRef {
  operator: string;
  code: string;
}

export interface UpAmenity {
  /** Contoh: ELEVATOR, ESCALATOR, ACCESSIBLE_TOILET, RAMP, TACTILE_PAVING. */
  type: string;
  name?: string;
  description?: string;
}

export interface UpStation extends UpStopRef {
  name: string;
  /** Kode lini (tanpa operator) yang melayani stasiun ini. */
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
}
