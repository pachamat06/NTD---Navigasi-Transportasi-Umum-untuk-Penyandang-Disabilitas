// Model data sisi frontend, mengikuti Model Domain pada Class Diagram (Bab III, Tabel 3.8).

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
  /** Jarak antarpemberhentian berurutan, dalam meter. */
  segmentDistanceM: number[];
  /** Waktu tempuh antarpemberhentian dalam menit; null bila tidak ada jadwal. */
  segmentMinutes: (number | null)[];
}

export interface Station {
  id: string;
  name: string;
  operator: string;
  lineIds: string[];
  amenities: Record<AmenityType, AmenityStatus>;
  hubId?: string;
}

export interface Hub {
  id: string;
  name: string;
  memberIds: string[];
  /** Jalan kaki antaranggota hub: [dari, ke, meter, menit|null]. */
  walks: [string, string, number, number | null][];
}

export interface StationAssessment {
  stationId: string;
  score: number;
  adequate: boolean;
  dataAvailable: boolean;
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
}

export type PlanResponse =
  | { status: "ok"; data: JourneyPlan }
  | { status: "error"; code: "NOT_FOUND" | "INVALID" | "API_DOWN"; message: string };
