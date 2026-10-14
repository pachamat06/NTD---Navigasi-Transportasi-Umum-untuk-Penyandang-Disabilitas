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

export interface Hub {
  id: string;
  name: string;
  memberIds: string[];
  walks: { from: string; to: string; distanceM: number; minutes: number | null }[];
}

export interface Network {
  stations: NetworkStation[];
  lines: Line[];
  hubs: Hub[];
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
  stops: string[];
  distanceM: number;
  minutes: number | null;
  fare: number;
}

export interface Route {
  legs: RouteLeg[];
  totalDistanceM: number;
  totalMinutes: number | null;
  timeComplete: boolean;
  totalFare: number;
  transfers: number;
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
