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
  /** Status diambil dari peron ini (bukan stasiun keseluruhan). */
  platform?: string;
  /**
   * Lift/eskalator tidak dibutuhkan karena peron ini dicapai dari gate tanpa anak tangga (jalur yang dipakai di sini).
   * `status` tetap diisi apa adanya.
   */
  notNeeded?: Pick<LayoutAccess, "via" | "gate" | "dedicated" | "stepFree" | "concourse">;
}

/**
 * Rincian satu faktor skor. `met` = terpenuhi, `missing` = tidak ada/tidak tercatat, `not_needed` = tidak dibutuhkan
 * pada jalur ini (dihitung terpenuhi), `skipped` = fasilitas tambahan yang belum diisi tim (tidak ikut dihitung).
 */
export interface ScoreFactor {
  type: AnyAmenityType;
  weight: number;
  result: "met" | "missing" | "not_needed" | "skipped";
}

/** Potongan skor di luar bobot fasilitas, mis. celah peron yang harus melewati anak tangga. */
export interface ScorePenalty {
  reason: string;
  points: number;
}

/** Jalur gate → concourse → peron yang dipakai, dengan cara berpindah tiap ruas. */
export interface ConcourseRoute {
  /** Kode/nama concourse seperti diisi tim, mis. "Utara" atau "B1". */
  code: string;
  name?: string;
  /** Cara dari gate ke concourse. */
  toConcourse: SegmentMeans[];
  /** Cara dari concourse ke peron. */
  toPlatform: SegmentMeans[];
}

/** Rincian jalur akses yang sama untuk skor stasiun dan skor perjalanan. */
interface AccessPath {
  /** true bila semua peron itu dapat dicapai tanpa anak tangga, sehingga lift dan eskalator tidak dibutuhkan. */
  level: boolean;
  /** Jalur terburuk di antara jalur terbaik tiap peron. "concourse" = gate ke concourse dulu, lalu ke peron. */
  via: AccessVia;
  gate?: string;
  /** Jalur itu adalah jalur/penyeberangan khusus pengguna disabilitas. */
  dedicated?: boolean;
  /** JPO/terowongan yang tanpa anak tangga (ramp landai). */
  stepFree?: boolean;
  /** Jalur lewat concourse: concourse dan cara berpindah tiap ruasnya. */
  concourse?: ConcourseRoute;
  /**
   * Jalur lewat concourse yang pindah lantai: status lift pada ruas yang pindah lantai (terburuk di antara ruas itu).
   * Menggantikan status lift stasiun/peron pada skor karena lebih spesifik.
   */
  pathLift?: AmenityDetailStatus;
  /** Sama dengan `pathLift` untuk eskalator. */
  pathEscalator?: AmenityStatus;
}

/** Jalur dari gate ke peron yang menentukan perlu tidaknya lift dan eskalator. */
export interface LayoutAccess extends AccessPath {
  /** Peron yang dinilai (semua peron yang dikenal untuk skor stasiun, atau peron yang dipakai untuk skor perjalanan). */
  platforms: string[];
}

export interface StationAssessment {
  stationId: string;
  score: number;
  adequate: boolean;
  dataAvailable: boolean;
  notes?: string[];
  /** Rincian bobot yang membentuk skor. */
  factors?: ScoreFactor[];
  penalties?: ScorePenalty[];
  /** Jalur gate ke peron untuk skor stasiun (dari isian tim), bila diketahui untuk semua peron. */
  layout?: LayoutAccess;
  /** Skor dihitung untuk perjalanan ini: jalur gate ke peron yang dipakai menentukan perlu tidaknya lift/eskalator. */
  journey?: JourneyAccess;
}

export interface JourneyAccess extends AccessPath {
  /** Peron yang dipakai di stasiun ini pada perjalanan. */
  platforms: string[];
  /** Jenis fasilitas yang tidak dibutuhkan pada jalur ini, sehingga dianggap terpenuhi pada skor. */
  excluded: AmenityType[];
  /** Status lift untuk jalur ini bila harus pindah lantai (dari peron bila diisi tim). */
  lift?: AmenityStatus;
  /** Skor stasiun sebelum disesuaikan dengan jalur perjalanan. */
  stationScore: number;
}

export interface RouteLeg {
  type: "RIDE" | "TRANSFER";
  lineId?: string;
  lineName?: string;
  mode?: Mode;
  operator?: string;
  stops: string[];
  distanceM: number;
  /**
   * null bila tidak ada jadwal untuk ruas ini (tidak diperkirakan dari jarak). Ruas TransJakarta koridor BRT
   * yang tidak punya jadwal di dataset diisi waktu jadwal GTFS Transjakarta dan ditandai `minutesEstimated`.
   */
  minutes: number | null;
  /** true = `minutes` adalah perkiraan dari jadwal GTFS Transjakarta, bukan waktu dari dataset rute. */
  minutesEstimated?: boolean;
  fare: number;
  departureAt?: string;
  arrivalAt?: string;
  /** Ruas naik: tujuan akhir kendaraan. */
  headsign?: string;
  /** Ruas naik: nomor peron naik dari dataset, mis. "2" (hanya untuk sebagian stasiun). */
  platform?: string;
  /** Ruas naik: peron naik beserta fasilitas dan celahnya, bila peronnya dapat dipastikan. */
  boardAt?: Platform;
  /** Ruas naik tanpa jadwal: frekuensi lin di pemberhentian naik. */
  frequency?: Frequency;
  /**
   * Ruas naik yang dilayani beberapa lin paralel (pemberhentian dan tarif sama), mis. TJ 4, 4D, 5, 5C:
   * naik yang mana pun sampai. Lin utama paling depan. `frequency` ruas = frekuensi gabungan.
   */
  options?: RideOption[];
  /**
   * Ruas pindah: berbalik arah di halte TransJakarta karena bus arah semula tidak berhenti di halte tujuan atau
   * halte arah itu tidak punya fasilitas yang dibutuhkan. Petunjuknya di `notes`.
   */
  turnaround?: boolean;
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
  /** true = sebagian waktu tempuh adalah perkiraan dari jadwal GTFS Transjakarta (lihat RouteLeg.minutesEstimated). */
  timeEstimated?: boolean;
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

/** Arah eskalator: naik/turun dilihat dari lantai bawah; "bergantian" = arah diubah petugas sesuai jam sibuk. */
export type EscalatorDirection = "naik" | "turun" | "bergantian";

/** Sekelompok eskalator di satu tempat, mis. "2 eskalator naik dari peron ke concourse". */
export interface EscalatorGroup {
  count: number;
  direction: EscalatorDirection;
  /** Lantai/area yang dihubungkan, mis. "Peron 1 - concourse". */
  connects?: string;
  status?: AmenityDetailStatus;
}

export interface LiftInfo {
  count: number;
  connects?: string;
  status?: AmenityDetailStatus;
}

/**
 * Celah antara peron dan pintu kendaraan. `level`: "sejajar" = rata dengan lantai kendaraan,
 * "sedikit" = beda tinggi kecil tanpa anak tangga, "tangga" = harus naik/turun anak tangga.
 */
export interface PlatformGap {
  level: "sejajar" | "sedikit" | "tangga";
  /** Jumlah anak tangga dari peron ke lantai kendaraan (level "tangga"). */
  steps?: number;
  /** Celah horizontal dan beda tinggi (cm), bila diukur. */
  horizontalCm?: number;
  verticalCm?: number;
  /** Tersedia pelat/ramp portabel dari petugas. */
  boardingAid?: boolean;
  note?: string;
}

export type PlatformType = "island" | "side" | "bay";

/**
 * Peron satu stasiun/halte. Bawaan dari dataset (nomor peron dan arah yang dilayani, /timetable/grouped);
 * jenis, fasilitas per peron, eskalator, lift, dan celah peron diisi tim NTD bila dataset tidak memuatnya.
 */
export interface Platform {
  /** Nomor peron seperti di papan, mis. "1", "1/2", "A". */
  code: string;
  name?: string;
  type?: PlatformType;
  /** Nomor jalur rel/lajur di sisi peron ini. */
  tracks?: string[];
  /** Lin dan arah yang berhenti di peron ini. */
  serves: { lineId: string; direction?: string }[];
  /** Status fasilitas inti di peron ini (bukan stasiun keseluruhan). */
  amenities: Partial<Record<AmenityType, AmenityDetailStatus>>;
  escalators?: EscalatorGroup[];
  lift?: LiftInfo;
  gap?: PlatformGap;
  note?: string;
  source: DataSource;
}

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
  /** Eskalator dan lift di pintu/gate ini (jumlah dan arah). */
  escalators?: EscalatorGroup[];
  lift?: LiftInfo;
  /** Isi papan petunjuk pintu (dataset /exits). */
  signs?: string[];
  /** "dataset" = pintu dari /exits Commute; "ntd" = diisi tim. */
  source?: DataSource;
  /** Pintu dataset (nama di papan) yang dilengkapi entri tim ini. */
  exitRef?: string;
  /** Peron yang dicapai langsung dari pintu/gate ini dan cara mencapainya. */
  platformLinks?: GatePlatformLink[];
  /**
   * Concourse (area penghubung) yang dicapai dari gate ini. Dipakai untuk stasiun yang gate-nya tidak langsung ke
   * peron: gate → concourse → peron. Gate boleh punya keduanya (sebagian peron langsung, sebagian lewat concourse).
   */
  concourseLinks?: GateConcourseLink[];
}

/** Cara berpindah pada satu ruas di dalam stasiun. "datar" dan "ramp" tanpa anak tangga; selainnya pindah lantai. */
export const SEGMENT_MEANS = ["datar", "ramp", "lift", "eskalator", "tangga"] as const;
export type SegmentMeans = (typeof SEGMENT_MEANS)[number];

/** Satu ruas jalur di dalam stasiun (gate → concourse, atau concourse → peron) beserta fasilitas aksesibilitasnya. */
export interface AccessSegment {
  /** Cara yang tersedia pada ruas ini (boleh lebih dari satu, mis. tangga + eskalator + lift). */
  means: SegmentMeans[];
  /** Lift pada ruas ini (jumlah dan status); tanpa isian, lift dianggap berfungsi bila "lift" ada di `means`. */
  lift?: LiftInfo;
  escalators?: EscalatorGroup[];
  /** Ruas ini adalah jalur khusus pengguna disabilitas. */
  dedicated?: boolean;
  note?: string;
}

export interface GateConcourseLink extends AccessSegment {
  /** Kode concourse yang dicapai. */
  concourse: string;
}

export interface ConcoursePlatformLink extends AccessSegment {
  platform: string;
}

/**
 * Concourse: area penghubung antara gate dan peron (umumnya lantai atas/bawah tempat gerbang tiket), diisi tim NTD.
 * Ruas concourse ke peron beserta lift/eskalator/tangga/ramp-nya menentukan perlu tidaknya lift pada skor.
 */
export interface Concourse {
  id: string;
  stationId: string;
  /** Kode/nama singkat concourse, dirujuk oleh gate, mis. "Utara", "B1", "Concourse 2". */
  code: string;
  name?: string;
  /** Lantai concourse, mis. "Lantai 2" atau "B1". */
  level?: string;
  /** Area berbayar (setelah gerbang tiket). */
  paid?: boolean;
  /** Peron yang dicapai dari concourse ini dan caranya. */
  platformLinks: ConcoursePlatformLink[];
  note?: string;
  source: DataSource;
}

/**
 * Cara gate mencapai peron. `langsung`: gate berada di peron. `crosswalk`: menyeberang jalan/zebra cross.
 * `sebidang`: menyeberang rel lewat pelintasan sebidang. `jpo`/`terowongan`: naik atau turun lantai.
 */
export type PlatformConnection = "langsung" | "crosswalk" | "sebidang" | "jpo" | "terowongan";

/** Jalur akses yang dinilai: penyeberangan langsung dari gate, atau lewat concourse. */
export type AccessVia = PlatformConnection | "concourse";

export interface GatePlatformLink {
  platform: string;
  via: PlatformConnection;
  /**
   * Jalur atau penyeberangan khusus pengguna disabilitas (mis. pelintasan sebidang khusus di stasiun yang umumnya
   * memakai JPO). Dipakai walau gate-nya tidak ditandai aksesibel, karena jalur itu memang disediakan untuk mereka.
   */
  dedicated?: boolean;
  /** JPO/terowongan yang dapat dilalui tanpa anak tangga (ramp landai), sehingga lift tidak dibutuhkan. */
  stepFree?: boolean;
  note?: string;
}

/** Penyeberangan yang tidak berpindah lantai, sehingga lift dan eskalator tidak dibutuhkan. */
export const LEVEL_CONNECTIONS: readonly PlatformConnection[] = ["langsung", "crosswalk", "sebidang"];

/** Jalur gate ke peron yang dapat dilalui tanpa anak tangga, sehingga lift dan eskalator tidak dibutuhkan. */
export function isStepFree(link: Pick<GatePlatformLink, "via" | "stepFree">): boolean {
  return LEVEL_CONNECTIONS.includes(link.via) || !!link.stepFree;
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
  /** Peron: dataset digabung dengan isian tim (nomor peron yang sama digabung, isian tim menang). */
  platforms: Platform[];
  entrances: Entrance[];
  /** Concourse isian tim (kosong/tidak ada untuk stasiun yang gate-nya langsung ke peron). */
  concourses?: Concourse[];
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
