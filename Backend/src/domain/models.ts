// Model Domain (Bab III, Gambar 3.5 dan Tabel 3.8).
// Bentuknya sengaja sama dengan Frontend/src/lib/types.ts agar GUI cukup mengganti mock-planner
// dengan panggilan ke backend. Field tambahan bersifat opsional sehingga tidak merusak GUI.

export type Mode = "RAIL" | "SUBWAY" | "TRAM" | "BUS" | "MONORAIL";

/** Status yang dipakai GUI. "absent" = tidak tercatat pada data, bukan pasti tidak ada. */
export type AmenityStatus = "available" | "absent" | "unknown";

/** Status rinci, termasuk informasi dari tim NTD yang tidak ada di dataset. */
export type AmenityDetailStatus = AmenityStatus | "out_of_service";

/** Jenis amenity inti yang dinilai skor (bobot dapat diatur dari halaman admin). */
export const CORE_AMENITIES = ["lift", "eskalator", "toilet", "ramp"] as const;
export type AmenityType = (typeof CORE_AMENITIES)[number];

/** Jenis tambahan yang tidak tersedia terstruktur di Commute Data API, diisi tim lewat admin. */
export const EXTRA_AMENITIES = [
  "guiding_block",
  "kursi_roda",
  "petugas_bantuan",
  "area_prioritas",
  "pintu_lebar",
  "informasi_audio",
  "informasi_visual",
] as const;
export type ExtraAmenityType = (typeof EXTRA_AMENITIES)[number];
export type AnyAmenityType = AmenityType | ExtraAmenityType;

export type DataSource = "dataset" | "ntd";

export interface AmenityDetail {
  type: AnyAmenityType;
  status: AmenityDetailStatus;
  source: DataSource;
  note?: string;
  /** Tanggal verifikasi lapangan oleh tim (ISO), hanya untuk source "ntd". */
  verifiedAt?: string;
}

export interface Operator {
  code: string;
  name: string;
  mode: Mode;
}

export interface Line {
  id: string;
  name: string;
  operator: string;
  mode: Mode;
  color: string;
  stationIds: string[];
}

export interface StationRef {
  operator: string;
  code: string;
}

export interface Station {
  id: string;
  name: string;
  operator: string;
  lineIds: string[];
  hubId?: string;
  codes: string[];
  /** Id stasiun pada Commute Data API (`{operator}-{code}`, mis. KCI-SUD); kunci posisi pada peta. */
  commuteIds?: string[];
  /** Koordinat dari dataset (bila ada); hanya dipakai backend untuk memilih stasiun transit alternatif. */
  lat?: number;
  lng?: number;
}

export interface Amenity {
  type: AnyAmenityType;
  description?: string;
}

export interface StationWithAmenities extends Station {
  amenities: Record<AmenityType, AmenityStatus>;
  amenityDetails: AmenityDetail[];
  /** false bila dataset tidak memuat amenity sama sekali dan tim belum mengisi. */
  dataAvailable: boolean;
}

export interface ExitRef {
  ref: string;
  name?: string | null;
  signs?: string[];
}

export interface HubWalk {
  from: string;
  to: string;
  distanceM: number;
  minutes: number | null;
  /** Petunjuk jalan dari dataset (mis. "Keluar lewat pintu B, lalu ..."). */
  notes?: string;
  fromExit?: ExitRef;
  toExit?: ExitRef;
}

export interface Hub {
  id: string;
  name: string;
  /** "integrated" = bagi penumpang satu tempat; "hub" = beberapa stasiun dalam satu kompleks. */
  kind?: "hub" | "integrated";
  memberIds: string[];
  walks: HubWalk[];
}

/** Fasilitas yang dibutuhkan pengguna saat pindah (mis. pengguna kursi roda butuh lift). */
export const TRANSFER_NEEDS = ["lift", "eskalator", "ramp"] as const;
export type TransferNeed = (typeof TRANSFER_NEEDS)[number];

/** Frekuensi kendaraan saat jadwal tidak tersedia (dari dataset, bukan jadwal dan bukan perkiraan dari jarak). */
export interface Frequency {
  /** Rata-rata jarak antarkendaraan (menit). Untuk pilihan gabungan: frekuensi gabungan semua lin. */
  headwayMinutes: number;
  /** "STOP" = diukur di pemberhentian naik, "LINE" = rata-rata se-lin. */
  source: "STOP" | "LINE";
  /** Jam operasional lin di hari itu, bila diketahui ("05:00–22:00" atau "24 jam"). */
  serviceHours?: string;
}

/** Satu lin yang bisa dinaiki pada ruas yang sama (pemberhentian dan tarif sama). */
export interface RideOption {
  lineId: string;
  lineName?: string;
  headsign?: string;
  frequency?: Frequency;
}

/** Pemeriksaan fasilitas yang dibutuhkan pengguna di stasiun tempat pindah. */
export interface TransferAccess {
  stationId: string;
  need: TransferNeed;
  status: AmenityDetailStatus;
}

export interface StationAssessment {
  stationId: string;
  score: number;
  adequate: boolean;
  dataAvailable: boolean;
  notes?: string[];
}

export interface RouteLeg {
  type: "RIDE" | "TRANSFER";
  lineId?: string;
  lineName?: string;
  mode?: Mode;
  operator?: string;
  stops: string[];
  distanceM: number;
  /** null bila dataset tidak memiliki jadwal untuk ruas ini (tidak diperkirakan dari jarak). */
  minutes: number | null;
  fare: number;
  departureAt?: string;
  arrivalAt?: string;
  /** Ruas naik: tujuan akhir kendaraan. */
  headsign?: string;
  /** Ruas naik tanpa jadwal: frekuensi lin di pemberhentian naik. */
  frequency?: Frequency;
  /**
   * Ruas naik yang dilayani beberapa lin paralel (pemberhentian dan tarif sama), mis. TJ 4, 4D, 5, 5C:
   * naik yang mana pun sampai. Lin utama paling depan. `frequency` ruas = frekuensi gabungan.
   */
  options?: RideOption[];
  /** Ruas pindah: petunjuk jalan dan pintu keluar dari dataset. */
  notes?: string;
  fromExit?: ExitRef;
  toExit?: ExitRef;
  /** Ruas pindah: status fasilitas yang dibutuhkan pengguna di kedua ujung. */
  access?: TransferAccess[];
}

export interface Route {
  legs: RouteLeg[];
  totalDistanceM: number;
  totalMinutes: number | null;
  timeComplete: boolean;
  totalFare: number;
  transfers: number;
  /** Nama pemberhentian dari sumber data (dipakai untuk halte/stasiun yang tidak ada di daftar stasiun). */
  stopNames?: Record<string, string>;
  /** false = tarif sebagian ruas tidak tersedia di dataset (ruas disusun dari urutan stasiun lini). */
  fareComplete?: boolean;
}

export interface Alternative {
  hubId: string;
  viaStationId: string;
  replacesStationId: string;
  assessment: StationAssessment;
  /** Kompatibel dengan GUI: stasiun yang dihindari bila alternatif dipakai. */
  avoid: string[];
  route?: Route;
}

export interface Notification {
  text: string;
  source: "LLM" | "TEMPLATE";
  grounded: boolean;
}

export type NoticeSeverity = "info" | "warning" | "critical";
export type NoticeScope = "global" | "station" | "line" | "hub";

export interface Notice {
  id: string;
  scope: NoticeScope;
  targetId?: string;
  severity: NoticeSeverity;
  title: string;
  message: string;
  startsAt?: string;
  endsAt?: string;
}

export type EntranceFeature = "lift" | "ramp" | "eskalator" | "tangga" | "datar" | "guiding_block";

export interface Entrance {
  id: string;
  stationId: string;
  name: string;
  description?: string;
  accessible: boolean;
  features: EntranceFeature[];
  openHours?: string;
  note?: string;
  /** Posisi opsional pada Aset Peta Transit (satuan pt), bukan lintang-bujur. */
  mapPosition?: { x: number; y: number };
}

export interface StationInfo {
  id: string;
  stationId: string;
  category: "kontak" | "jam_operasional" | "layanan" | "catatan";
  title: string;
  body: string;
}

export interface StationDetail extends StationWithAmenities {
  assessment: StationAssessment;
  entrances: Entrance[];
  info: StationInfo[];
  notices: Notice[];
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
  /** Diisi bila sebagian data diambil dari cache karena Commute Data API tidak dapat dihubungi. */
  fromCache?: string;
  notices: Notice[];
  stations: StationDetail[];
  attribution: string;
  preview?: boolean;
}

export type ErrorCode =
  | "INVALID"
  | "NOT_FOUND"
  | "API_DOWN"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

export type ApiResponse<T> = { status: "ok"; data: T } | { status: "error"; code: ErrorCode; message: string; details?: unknown };
