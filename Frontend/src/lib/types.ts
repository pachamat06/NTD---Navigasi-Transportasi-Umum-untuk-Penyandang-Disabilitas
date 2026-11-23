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
  /** Stasiun sudah tidak beroperasi (ditandai tim NTD); tidak bisa dipakai untuk rute. */
  inactive?: boolean;
  inactiveNote?: string;
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

/** Gate/pintu anggota hub yang tersambung ke anggota lain, beserta fasilitas aksesibelnya (isian admin). */
export interface HubGate {
  id: string;
  stationId: string;
  name: string;
  /** Anggota hub yang dicapai lewat gate ini; kosong = semua anggota lain. */
  connectsTo: string[];
  facilities: ("lift" | "ramp" | "eskalator" | "datar" | "tangga" | "guiding_block" | "toilet" | "kursi_roda" | "petugas_bantuan")[];
  accessible: boolean;
  openHours?: string;
  note?: string;
}

export interface Hub {
  id: string;
  name: string;
  memberIds: string[];
  kind?: "hub" | "integrated";
  walks: HubWalk[];
  gates?: HubGate[];
}

/** Posisi pemberhentian yang ditetapkan admin, dalam koordinat peta (pt). */
export interface MapStop {
  stationId: string;
  x: number;
  y: number;
  /** Titik anak: posisi stasiun ini khusus untuk lini `lineId` (tidak diisi = posisi utama). */
  lineId?: string;
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
  /** Pilihan pipeline untuk pengguna: "llm" hanya ada bila admin menyalakan mode LLM dan klien LLM tersedia. */
  llm?: { available: boolean; pipelines: Pipeline[]; defaultPipeline: Pipeline; reason?: string };
}

/** "default" = algoritma NTD tanpa LLM; "llm" = agent navigasi LLM memilih rute dan LLM menyusun narasi. */
export type Pipeline = "default" | "llm";

/** Informasi layanan operator (gangguan, keterlambatan, penutupan). "approved" sudah diperiksa admin dan memengaruhi rute. */
export interface ServiceInfoItem {
  id: string;
  status: "approved" | "pending";
  verified: boolean;
  category: string;
  impact?: "info" | "delay" | "disruption" | "closure";
  summary: string;
  operator: string | null;
  stationIds: string[];
  lineIds: string[];
  source: { type: "x" | "manual"; account: string; url: string | null; postedAt: string };
  expiresAt: string;
}

export interface PipelineInfo {
  requested: Pipeline;
  used: Pipeline;
  navigation: Pipeline;
  narration: "template" | "llm";
  reason?: string;
  notes: string[];
  model?: string;
}

export interface StationAssessment {
  stationId: string;
  score: number;
  adequate: boolean;
  dataAvailable: boolean;
  notes?: string[];
  /** Potongan skor, mis. celah peron yang harus melewati anak tangga. */
  penalties?: { reason: string; points: number }[];
  /** Skor untuk perjalanan ini: jalur gate ke peron menentukan perlu tidaknya lift/eskalator. */
  journey?: {
    platforms: string[];
    level: boolean;
    via: AccessVia;
    gate?: string;
    /** Jalur/penyeberangan khusus pengguna disabilitas. */
    dedicated?: boolean;
    /** JPO/terowongan tanpa anak tangga (ramp landai). */
    stepFree?: boolean;
    /** Jalur lewat concourse (gate → concourse → peron). */
    concourse?: ConcourseRoute;
    /** Status lift pada ruas yang pindah lantai di jalur lewat concourse. */
    pathLift?: DetailStatus;
    excluded: AmenityType[];
    lift?: AmenityStatus;
    /** Fasilitas peron yang belum diisi tim sehingga dihitung dari fasilitas umum stasiun. */
    fromStation?: AmenityType[];
    stationScore: number;
  };
  /** Pintu masuk/keluar pilihan pengguna dan pintu yang disarankan bila fasilitasnya kurang. */
  gateChoice?: GateChoice;
}

export interface GateChoice {
  role: "masuk" | "keluar";
  chosenId: string;
  chosen: string;
  /** false = jalur pintu ini ke peron belum didata; skor memakai pintu terbaik. */
  known: boolean;
  recommendedId?: string;
  recommended?: string;
  reason?: string;
  recommendedVia?: string;
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
  escalators?: EscalatorGroup[];
  lift?: LiftInfo;
  /** Isi papan petunjuk pintu (dataset). */
  signs?: string[];
  /** "dataset" = pintu dari Commute (/exits), "ntd" = isian tim. */
  source?: "dataset" | "ntd";
  /** Peron yang dicapai langsung dari gate ini dan cara mencapainya. */
  platformLinks?: { platform: string; via: PlatformConnection; dedicated?: boolean; stepFree?: boolean; note?: string }[];
  /** Concourse yang dicapai dari gate ini (gate yang tidak langsung ke peron). */
  concourseLinks?: (AccessSegment & { concourse: string })[];
}

/** langsung/crosswalk/sebidang tidak pindah lantai; jpo/terowongan naik atau turun lantai. */
export type PlatformConnection = "langsung" | "crosswalk" | "sebidang" | "jpo" | "terowongan";

/** Jalur akses yang dinilai: langsung dari gate, atau lewat concourse. */
export type AccessVia = PlatformConnection | "concourse";

/** Cara berpindah pada satu ruas di dalam stasiun; "datar" dan "ramp" tanpa anak tangga. */
export type SegmentMeans = "datar" | "ramp" | "lift" | "eskalator" | "tangga";

/** Satu ruas jalur (gate → concourse atau concourse → peron). */
export interface AccessSegment {
  means: SegmentMeans[];
  lift?: LiftInfo;
  escalators?: EscalatorGroup[];
  dedicated?: boolean;
  note?: string;
}

/** Concourse: area penghubung antara gate dan peron. */
export interface Concourse {
  id: string;
  code: string;
  name?: string;
  level?: string;
  /** Area berbayar (setelah gerbang tiket). */
  paid?: boolean;
  platformLinks: (AccessSegment & { platform: string })[];
  note?: string;
}

/** Jalur gate → concourse → peron yang dipakai pada skor perjalanan. */
export interface ConcourseRoute {
  code: string;
  name?: string;
  toConcourse: SegmentMeans[];
  toPlatform: SegmentMeans[];
}

export type DetailStatus = AmenityStatus | "out_of_service";

/** Sekelompok eskalator di satu tempat; arah dilihat dari lantai bawah. */
export interface EscalatorGroup {
  count: number;
  direction: "naik" | "turun" | "bergantian";
  connects?: string;
  status?: DetailStatus;
}

export interface LiftInfo {
  count: number;
  connects?: string;
  status?: DetailStatus;
}

/** Celah peron dengan kendaraan. */
export interface PlatformGap {
  level: "sejajar" | "sedikit" | "tangga";
  steps?: number;
  horizontalCm?: number;
  verticalCm?: number;
  boardingAid?: boolean;
  note?: string;
}

/** Peron: nomor dan arah dari dataset, fasilitas per peron dan celah dari survei tim NTD. */
export interface Platform {
  code: string;
  name?: string;
  type?: "island" | "side" | "bay";
  tracks?: string[];
  serves: { lineId: string; direction?: string }[];
  /** Fasilitas mobilitas di peron ini (lift, eskalator, ramp, guiding block). Toilet dll. adalah info umum stasiun. */
  amenities: Partial<Record<"lift" | "eskalator" | "ramp" | "guiding_block", DetailStatus>>;
  /** Akses dari peron ini ke pintu keluar tertentu. */
  exitAccess?: { gate: string; via: PlatformConnection; stepFree?: boolean; dedicated?: boolean; note?: string }[];
  escalators?: EscalatorGroup[];
  lift?: LiftInfo;
  gap?: PlatformGap;
  note?: string;
  source: "dataset" | "ntd";
  /** Sebagian isian peron ini terisi otomatis dari ruas concourse → peron. */
  accessFromConcourse?: { fields: ("lift" | "eskalator" | "ramp" | "liftInfo" | "escalators")[]; from: { concourse: string; name?: string; means: SegmentMeans[] }[] };
}

export interface StationInfo {
  id: string;
  stationId: string;
  category: "kontak" | "jam_operasional" | "layanan" | "catatan";
  title: string;
  body: string;
}

/** Detail stasiun dari GET /api/stations/:id. */
/** Stasiun/halte lain yang bisa dicapai dengan berjalan kaki di luar hub (tautan transfer), beserta akses jalannya. */
export interface StationLinkView {
  linkId: string;
  otherId: string;
  otherName: string;
  /** Jarak tautan; bila belum diisi, jarak garis lurus (`distanceEstimated`). */
  distanceM: number | null;
  distanceEstimated?: boolean;
  minutes: number | null;
  /** Akses di jalan itu (boleh lebih dari satu); kosong = belum diketahui. */
  access: SegmentMeans[];
  dedicated?: boolean;
  note?: string;
  oneWay?: boolean;
  source: "ntd" | "admin";
}

export interface StationDetailData extends NetworkStation {
  /** Terhubung ke stasiun lain lewat jalan kaki (tautan transfer di luar hub). */
  links?: StationLinkView[];
  platforms?: Platform[];
  entrances: Entrance[];
  /** Concourse isian tim (stasiun yang gate-nya tidak langsung ke peron). */
  concourses?: Concourse[];
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
  /** true = waktu tempuh perkiraan dari jadwal GTFS Transjakarta (koridor BRT), bukan dari dataset rute. */
  minutesEstimated?: boolean;
  /** Waktu tempuh dan jam dari jadwal keberangkatan Commute (moda rel). */
  fromTimetable?: boolean;
  /** Ruas pindah: waktu sudah termasuk menunggu kereta berikutnya. */
  includesWait?: boolean;
  /** Nomor perjalanan kereta yang dipakai untuk jam berangkat/tiba. */
  tripNumber?: string;
  /** Jam berangkat dan tiba (ISO) bila jadwal diketahui. */
  departureAt?: string;
  arrivalAt?: string;
  /** true = jam berangkat/tiba perkiraan (TransJakarta: rata-rata waktu tunggu + waktu GTFS). */
  scheduleEstimated?: boolean;
  /** Perkiraan menunggu kendaraan (menit) di pemberhentian naik. */
  waitMinutes?: number;
  /** Kereta pertama berakhir di stasiun ini; ganti ke kereta sambungan yang berangkat `changeDepartureAt`. */
  changeAt?: string;
  changeDepartureAt?: string;
  /** Layanan hari itu sudah habis pada waktu berangkat; dipakai keberangkatan pertama keesokan harinya. */
  nextDayService?: boolean;
  fare: number;
  /** Arah/tujuan akhir kendaraan. */
  headsign?: string;
  /** Nomor peron naik dari dataset. */
  platform?: string;
  /** Peron naik beserta fasilitas dan celahnya, bila dapat dipastikan. */
  boardAt?: Platform;
  /** Frekuensi gabungan bila jadwal tidak tersedia (bukan jadwal). */
  frequency?: Frequency;
  /** Lin paralel yang melayani pemberhentian dan tarif yang sama; boleh naik yang mana saja. */
  options?: RideOption[];
  /** Pindah ke bus arah sebaliknya (berbalik arah) di halte TransJakarta; petunjuk di `notes`. */
  turnaround?: boolean;
  /** Petunjuk jalan kaki saat pindah. */
  notes?: string;
  fromExit?: ExitRef;
  toExit?: ExitRef;
  /** Ruas pindah antarstasiun hub: gate keluar dan gate masuk dari isian admin. */
  fromGate?: HubGate;
  toGate?: HubGate;
  /** Status fasilitas yang dibutuhkan pengguna di kedua ujung perpindahan. */
  access?: TransferAccess[];
  /** Ruas pindah antarstasiun lewat tautan transfer di luar hub: akses yang tersedia di jalan itu. */
  link?: { access: SegmentMeans[]; dedicated?: boolean; source: "ntd" | "admin" };
}

export type TransferNeed = "lift" | "eskalator" | "ramp";

export interface Frequency {
  headwayMinutes: number;
  /** "TIMETABLE" = dihitung dari jadwal keberangkatan Commute (moda rel). */
  source: "STOP" | "LINE" | "TIMETABLE";
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
  /** Status diambil dari peron ini. */
  platform?: string;
  /** Pemeriksaan untuk jalan kaki antara dua stasiun lewat tautan transfer (`stationId` = asal jalan itu). */
  link?: { toId: string; means: SegmentMeans[] };
  /** Kebutuhan eskalator dianggap terpenuhi oleh lift. */
  substitute?: "lift";
  /** Lift/eskalator tidak dibutuhkan karena peron dicapai dari gate tanpa anak tangga. */
  notNeeded?: { via: AccessVia; gate?: string; dedicated?: boolean; stepFree?: boolean; concourse?: ConcourseRoute };
}

export interface Route {
  legs: RouteLeg[];
  totalDistanceM: number;
  totalMinutes: number | null;
  timeComplete: boolean;
  /** Sebagian waktu tempuh adalah perkiraan dari jadwal GTFS Transjakarta. */
  timeEstimated?: boolean;
  totalFare: number;
  /** false = tarif sebagian ruas tidak ada di dataset. */
  fareComplete?: boolean;
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

export type RouteOptionKind = "aksesibel" | "moderat" | "tercepat";

export interface RouteOption {
  kinds: RouteOptionKind[];
  origin: "dataset" | "alternatif" | "variasi";
  route: Route;
  assessments: StationAssessment[];
  warnings: string[];
  summary: {
    accessScore: number;
    minScore: number;
    minutes: number | null;
    departureAt?: string;
    arrivalAt?: string;
    transfers: number;
    unmetNeeds: number;
    usesAvoidedModes: boolean;
    /** Dampak informasi layanan yang disetujui admin pada rute ini. */
    advisoryImpact?: "delay" | "disruption" | "closure";
  };
  notification: Notification;
  alternatives: Alternative[];
  /** "llm" = dipilih agent navigasi LLM; `llmReason` alasannya. */
  pickedBy?: "llm";
  llmReason?: string;
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
  /** Waktu berangkat yang dipakai menghitung jadwal (ISO). */
  departAt?: string;
  /** "now" = berangkat sekarang; "at" = waktu tertentu pilihan pengguna. */
  departMode?: "now" | "at";
  /** Pilihan rute: paling aksesibel (sama dengan `route`), moderat, tercepat, lalu rute lain. */
  options?: RouteOption[];
  /** Pipeline yang diminta dan yang dipakai Backend. */
  pipeline?: PipelineInfo;
  /** Informasi layanan operator yang relevan dengan rute. */
  serviceInfo?: ServiceInfoItem[];
}

export type ErrorCode = "NOT_FOUND" | "INVALID" | "API_DOWN" | "RATE_LIMITED" | "INTERNAL" | "NETWORK";

export type ApiResult<T> = { status: "ok"; data: T } | { status: "error"; code: ErrorCode; message: string };

export type PlanResponse = ApiResult<JourneyPlan>;
