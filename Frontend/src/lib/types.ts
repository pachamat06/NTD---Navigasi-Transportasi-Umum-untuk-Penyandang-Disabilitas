// Model data sisi frontend, mengikuti Model Domain pada Class Diagram (Bab III, Tabel 3.8)
// dan respons Backend (Backend/src/domain/models.ts).

export type Mode = "RAIL" | "SUBWAY" | "TRAM" | "BUS" | "MONORAIL";

export type AmenityStatus = "available" | "absent" | "unknown";

export type AmenityType = "lift" | "eskalator" | "toilet" | "ramp";

export interface Line {
  id: string;
  name: string;
  operator: string;
  mode: Mode;
  color: string;
  stationIds: string[];
}

export interface Station {
  id: string;
  name: string;
  operator: string;
  lineIds: string[];
  codes: string[];
  hubId?: string;
  /** Station id Commute (mis. "KCI-SUDB"), dipakai untuk posisi pada peta. */
  commuteIds?: string[];
}

/** Rincian fasilitas, termasuk informasi tim NTD yang tidak ada di dataset. */
export interface AmenityDetail {
  type: string;
  status: AmenityStatus | "out_of_service";
  source: "dataset" | "ntd";
  note?: string;
  verifiedAt?: string;
}

/** Stasiun beserta fasilitas dan penilaiannya, dari GET /api/network. */
export interface NetworkStation extends Station {
  amenities: Record<AmenityType, AmenityStatus>;
  amenityDetails: AmenityDetail[];
  dataAvailable: boolean;
  assessment: StationAssessment;
}

export interface ExitRef {
  ref: string;
  name?: string;
  signs?: string[];
}

export interface HubWalk {
  from: string;
  to: string;
  distanceM: number;
  minutes: number | null;
  notes?: string;
  fromExit?: ExitRef;
  toExit?: ExitRef;
}

export interface Hub {
  id: string;
  name: string;
  memberIds: string[];
  kind?: "hub" | "integrated";
  walks: HubWalk[];
}

/** Posisi pemberhentian yang ditetapkan admin, dalam koordinat peta (pt). */
export interface MapStop {
  stationId: string;
  x: number;
  y: number;
}

/** Bentuk jalur antara dua pemberhentian berurutan pada satu lini, ditetapkan admin. */
export interface MapTrack {
  lineId: string;
  fromStationId: string;
  toStationId: string;
  points: [number, number][];
}

export interface MapOverrides {
  stops: MapStop[];
  tracks: MapTrack[];
}

export interface Network {
  stations: NetworkStation[];
  lines: Line[];
  hubs: Hub[];
  map?: MapOverrides;
}

export interface Meta {
  disclaimer: string;
  attribution: string;
  scoring: { weights: Record<AmenityType, number>; threshold: number };
  amenityLabels: Record<string, string>;
  dataSource: string;
}

export interface StationAssessment {
  stationId: string;
  score: number;
  adequate: boolean;
  dataAvailable: boolean;
  notes?: string[];
}

export interface Notice {
  id: string;
  scope: "global" | "station" | "line" | "hub";
  targetId?: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  startsAt?: string;
  endsAt?: string;
}

export interface Entrance {
  id: string;
  stationId: string;
  name: string;
  description?: string;
  accessible: boolean;
  features: string[];
  openHours?: string;
  note?: string;
}

export interface StationInfo {
  id: string;
  stationId: string;
  category: "kontak" | "jam_operasional" | "layanan" | "catatan";
  title: string;
  body: string;
}

/** Detail stasiun dari GET /api/stations/:id. */
export interface StationDetailData extends NetworkStation {
  entrances: Entrance[];
  info: StationInfo[];
  notices: Notice[];
}

export interface RouteLeg {
  type: "RIDE" | "TRANSFER";
  lineId?: string;
  /** Moda ruas naik (dari Backend), juga untuk lini yang tidak ada di daftar lini. */
  mode?: Mode;
  stops: string[];
  distanceM: number;
  minutes: number | null;
  fare: number;
  /** Arah/tujuan akhir kendaraan. */
  headsign?: string;
  /** Frekuensi gabungan bila jadwal tidak tersedia (bukan jadwal). */
  frequency?: Frequency;
  /** Lin paralel yang melayani pemberhentian dan tarif yang sama; boleh naik yang mana saja. */
  options?: RideOption[];
  /** Petunjuk jalan kaki saat pindah. */
  notes?: string;
  fromExit?: ExitRef;
  toExit?: ExitRef;
  /** Status fasilitas yang dibutuhkan pengguna di kedua ujung perpindahan. */
  access?: TransferAccess[];
}

export type TransferNeed = "lift" | "eskalator" | "ramp";

export interface Frequency {
  headwayMinutes: number;
  source: "STOP" | "LINE";
  serviceHours?: string;
}

export interface RideOption {
  lineId: string;
  lineName?: string;
  headsign?: string;
  frequency?: Frequency;
}

export interface TransferAccess {
  stationId: string;
  need: TransferNeed;
  status: AmenityStatus | "out_of_service";
}

export interface Route {
  legs: RouteLeg[];
  totalDistanceM: number;
  totalMinutes: number | null;
  timeComplete: boolean;
  totalFare: number;
  transfers: number;
  /** Nama pemberhentian dari data rute, untuk halte/stasiun yang tidak ada di daftar stasiun. */
  stopNames?: Record<string, string>;
}

export interface Alternative {
  hubId: string;
  viaStationId: string;
  replacesStationId: string;
  assessment: StationAssessment;
  avoid: string[];
}

export interface Notification {
  text: string;
  source: "LLM" | "TEMPLATE";
  grounded: boolean;
}

export interface JourneyPlan {
  originId: string;
  destinationId: string;
  route: Route;
  assessments: StationAssessment[];
  alternatives: Alternative[];
  notification: Notification;
  warnings: string[];
  disclaimer: string;
  fromCache?: string;
  notices?: Notice[];
  attribution?: string;
}

export type ErrorCode = "NOT_FOUND" | "INVALID" | "API_DOWN" | "RATE_LIMITED" | "INTERNAL" | "NETWORK";

export type ApiResult<T> = { status: "ok"; data: T } | { status: "error"; code: ErrorCode; message: string };

export type PlanResponse = ApiResult<JourneyPlan>;
