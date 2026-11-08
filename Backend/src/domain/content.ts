// Konten yang tidak disediakan dataset dan dikelola tim lewat halaman admin:
// koreksi/tambahan fasilitas, pintu akses stasiun, pengumuman (sumber notifikasi), info lain,
// posisi pemberhentian dan bentuk jalur pada peta, serta pengaturan skor dan disclaimer. Validasi skema di sini dipakai bersama oleh endpoint admin.

import { z } from "zod";
import type { RequestContext } from "../context";
import type { ContentItem, ContentKind, ContentRepository } from "../store/types";
import { CORE_AMENITIES, EXTRA_AMENITIES, SEGMENT_MEANS, type AmenityDetail, type AmenityType, type AnyAmenityType, type Concourse, type Entrance, type ExtraAmenityType, type Notice, type Platform, type StationInfo } from "./models";

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "harus tanggal ISO 8601");

export const facilitySchema = z.object({
  type: z.enum([...CORE_AMENITIES, ...EXTRA_AMENITIES]),
  status: z.enum(["available", "absent", "unknown", "out_of_service"]),
  note: z.string().max(500).optional(),
  verifiedAt: isoDate.optional(),
  /** Untuk out_of_service: perkiraan selesai perbaikan. Setelah lewat, status kembali ke data asal. */
  until: isoDate.optional(),
});

const detailStatus = z.enum(["available", "absent", "unknown", "out_of_service"]);

/** Sekelompok eskalator di satu tempat: jumlah dan arah (naik/turun dilihat dari lantai bawah). */
export const escalatorSchema = z.object({
  count: z.number().int().min(1).max(20),
  direction: z.enum(["naik", "turun", "bergantian"]),
  connects: z.string().max(120).optional(),
  status: detailStatus.optional(),
});

export const liftSchema = z.object({
  count: z.number().int().min(0).max(20),
  connects: z.string().max(120).optional(),
  status: detailStatus.optional(),
});

/** Peron satu stasiun/halte hasil survei. Peron dengan `code` sama dengan dataset melengkapi/menimpa data itu. */
export const platformSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().max(120).optional(),
  type: z.enum(["island", "side", "bay"]).optional(),
  tracks: z.array(z.string().min(1).max(10)).max(6).optional(),
  serves: z.array(z.object({ lineId: z.string().min(1).max(80), direction: z.string().max(120).optional() })).max(20).optional(),
  amenities: z.object({ lift: detailStatus, eskalator: detailStatus, toilet: detailStatus, ramp: detailStatus }).partial().default({}),
  escalators: z.array(escalatorSchema).max(10).optional(),
  lift: liftSchema.optional(),
  gap: z
    .object({
      level: z.enum(["sejajar", "sedikit", "tangga"]),
      steps: z.number().int().min(1).max(10).optional(),
      horizontalCm: z.number().min(0).max(200).optional(),
      verticalCm: z.number().min(0).max(200).optional(),
      boardingAid: z.boolean().optional(),
      note: z.string().max(300).optional(),
    })
    .refine((g) => g.level !== "tangga" || !!g.steps, { message: "jumlah anak tangga wajib bila level 'tangga'", path: ["steps"] })
    .optional(),
  note: z.string().max(500).optional(),
});

/**
 * Satu ruas jalur di dalam stasiun (gate → concourse atau concourse → peron): cara berpindah yang tersedia
 * (datar/ramp tanpa anak tangga; lift/eskalator/tangga pindah lantai), lift dan eskalator di ruas itu.
 */
const segmentFields = {
  means: z.array(z.enum(SEGMENT_MEANS)).min(1, "isi minimal satu cara berpindah").max(SEGMENT_MEANS.length),
  lift: liftSchema.optional(),
  escalators: z.array(escalatorSchema).max(10).optional(),
  /** Ruas khusus pengguna disabilitas. */
  dedicated: z.boolean().optional(),
  note: z.string().max(200).optional(),
};

/** Concourse (area penghubung gate dan peron). Satu entri per kode per stasiun; gate merujuknya lewat `concourseLinks`. */
export const concourseSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().max(120).optional(),
  level: z.string().max(60).optional(),
  paid: z.boolean().optional(),
  platformLinks: z
    .array(z.object({ platform: z.string().min(1).max(20), ...segmentFields }))
    .max(20)
    .default([]),
  note: z.string().max(500).optional(),
});

export const entranceSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  accessible: z.boolean(),
  features: z.array(z.enum(["lift", "ramp", "eskalator", "tangga", "datar", "guiding_block"])).max(6).default([]),
  openHours: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
  mapPosition: z.object({ x: z.number(), y: z.number() }).optional(),
  escalators: z.array(escalatorSchema).max(10).optional(),
  lift: liftSchema.optional(),
  /** Nama pintu pada dataset (/exits, mis. "B") yang dilengkapi entri ini. */
  exitRef: z.string().max(40).optional(),
  /** Peron yang dicapai dari gate ini: langsung, menyeberang setinggi tanah/rel, atau lewat JPO/terowongan. */
  platformLinks: z
    .array(
      z.object({
        platform: z.string().min(1).max(20),
        via: z.enum(["langsung", "crosswalk", "sebidang", "jpo", "terowongan"]),
        /** Jalur/penyeberangan khusus pengguna disabilitas. */
        dedicated: z.boolean().optional(),
        /** JPO/terowongan tanpa anak tangga (ramp landai). */
        stepFree: z.boolean().optional(),
        note: z.string().max(200).optional(),
      }),
    )
    .max(20)
    .optional(),
  /** Concourse yang dicapai dari gate ini (gate yang tidak langsung ke peron), dengan cara berpindah ke sana. */
  concourseLinks: z
    .array(z.object({ concourse: z.string().min(1).max(40), ...segmentFields }))
    .max(10)
    .optional(),
});

export const noticeSchema = z
  .object({
    scope: z.enum(["global", "station", "line", "hub"]),
    targetId: z.string().min(1).optional(),
    severity: z.enum(["info", "warning", "critical"]),
    title: z.string().min(1).max(120),
    message: z.string().min(1).max(1000),
    startsAt: isoDate.optional(),
    endsAt: isoDate.optional(),
  })
  .refine((n) => n.scope === "global" || !!n.targetId, { message: "targetId wajib untuk scope selain global", path: ["targetId"] })
  .refine((n) => !n.startsAt || !n.endsAt || Date.parse(n.startsAt) < Date.parse(n.endsAt), { message: "endsAt harus setelah startsAt", path: ["endsAt"] });

export const stationInfoSchema = z.object({
  category: z.enum(["kontak", "jam_operasional", "layanan", "catatan"]),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(2000),
});

/** Titik pada Aset Peta Transit (satuan pt peta FDTJ 2026-08c, 9513.57 x 6726.88). */
const mapPoint = z.tuple([z.number().min(-500).max(10_500), z.number().min(-500).max(7_500)]);

/**
 * Posisi titik pemberhentian yang ditetapkan admin; menang atas posisi otomatis. Dengan `lineId`: titik anak
 * stasiun, yaitu posisi stasiun itu khusus untuk satu lini, agar garis beberapa lini yang berhenti di stasiun
 * yang sama (mis. Bundaran Senayan, Pulo Gadung) tidak bertumpuk di satu titik.
 */
export const mapStopSchema = z.object({
  x: z.number().min(-500).max(10_500),
  y: z.number().min(-500).max(7_500),
  lineId: z.string().min(1).max(80).optional(),
  note: z.string().max(500).optional(),
});

/** Bentuk jalur satu lini antara dua pemberhentian bersebelahan (titik belok di antaranya, urut dari `fromStationId`). */
export const mapTrackSchema = z
  .object({
    lineId: z.string().min(1).max(80),
    fromStationId: z.string().min(1).max(80),
    toStationId: z.string().min(1).max(80),
    points: z.array(mapPoint).max(300),
    note: z.string().max(500).optional(),
  })
  .refine((t) => t.fromStationId !== t.toStationId, { message: "fromStationId dan toStationId harus berbeda", path: ["toStationId"] });

export type MapStop = z.infer<typeof mapStopSchema> & { stationId: string };

/** Satu pemberhentian pada urutan rute: waktu tempuh dari pemberhentian sebelumnya (menit; null = belum diketahui). */
export const routeStopSchema = z.object({
  stationId: z.string().min(1).max(80),
  minutes: z.number().min(0).max(240).nullable().optional(),
  note: z.string().max(200).optional(),
});

/**
 * Pengaturan rute satu lini untuk satu arah (0 atau 1): urutan pemberhentian, waktu tempuh antarpemberhentian,
 * dan tujuan akhir. Menggantikan urutan bawaan (Commute Data API / GTFS) untuk peta, pencarian rute topologi,
 * lin paralel, dan waktu tempuh yang tidak tersedia di dataset.
 */
export const routePatternSchema = z
  .object({
    lineId: z.string().min(1).max(80),
    direction: z.union([z.literal(0), z.literal(1)]),
    headsign: z.string().max(120).optional(),
    stops: z.array(routeStopSchema).min(2).max(200),
    /** Asal data terakhir: diisi sendiri, atau hasil sinkron dari GTFS / Commute Data API. */
    source: z.enum(["manual", "gtfs", "commute"]).default("manual"),
    syncedAt: isoDate.optional(),
    /** Frekuensi rata-rata (menit) bila dataset tidak punya. */
    headwayMinutes: z.number().min(1).max(240).optional(),
    serviceHours: z.string().max(60).optional(),
    note: z.string().max(500).optional(),
  })
  .refine((p) => p.stops.every((s, i) => i === 0 || s.stationId !== p.stops[i - 1].stationId), {
    message: "dua pemberhentian berurutan tidak boleh sama",
    path: ["stops"],
  });

export type RoutePattern = z.infer<typeof routePatternSchema> & { id: string };
export type MapTrack = z.infer<typeof mapTrackSchema> & { id: string };

export const DEFAULT_DISCLAIMER =
  "Informasi fasilitas berasal dari data statis dan bisa berbeda dengan kondisi di lapangan. Bukan status real-time.";

const weight = z.number().min(0).max(100);

export const settingsSchema = z.object({
  scoring: z.object({
    weights: z.object({ lift: weight, eskalator: weight, toilet: weight, ramp: weight }),
    /** Bobot fasilitas tambahan; hanya dihitung bila tim sudah mengisi statusnya (belum diisi tidak mengurangi skor). */
    extraWeights: z.object(Object.fromEntries(EXTRA_AMENITIES.map((t) => [t, weight])) as Record<ExtraAmenityType, typeof weight>).optional(),
    /** Potongan skor perjalanan karena celah peron dengan kendaraan; dipotong setengah bila petugas menyediakan pelat/ramp. */
    gapPenalty: z.object({ tangga: weight, sedikit: weight }).optional(),
    threshold: weight,
  }),
  disclaimer: z.string().min(10).max(500),
  llmEnabled: z.boolean(),
  cacheTtlSeconds: z.number().int().min(60).max(7 * 24 * 3600),
  requireTestsBeforePublish: z.boolean(),
});

export type FacilityOverride = z.infer<typeof facilitySchema>;
export type Settings = z.infer<typeof settingsSchema>;

/** Bobot awal mengikuti GUI basic; divalidasi dengan data riil pada Sprint 2 (Risiko #4). */
export const DEFAULT_EXTRA_WEIGHTS: Record<ExtraAmenityType, number> = {
  guiding_block: 10,
  petugas_bantuan: 10,
  kursi_roda: 5,
  pintu_lebar: 5,
  area_prioritas: 5,
  informasi_audio: 5,
  informasi_visual: 5,
};
export const DEFAULT_GAP_PENALTY = { tangga: 15, sedikit: 5 };

export const DEFAULT_SETTINGS: Settings = {
  scoring: {
    weights: { lift: 40, eskalator: 20, toilet: 25, ramp: 15 },
    extraWeights: DEFAULT_EXTRA_WEIGHTS,
    gapPenalty: DEFAULT_GAP_PENALTY,
    threshold: 70,
  },
  disclaimer: DEFAULT_DISCLAIMER,
  llmEnabled: true,
  cacheTtlSeconds: 24 * 3600,
  requireTestsBeforePublish: false,
};

export const SETTINGS_ID = "settings";

export const SCHEMAS: Record<Exclude<ContentKind, "settings">, z.ZodType> = {
  facility: facilitySchema,
  entrance: entranceSchema,
  notice: noticeSchema,
  station_info: stationInfoSchema,
  platform: platformSchema,
  concourse: concourseSchema,
  map_stop: mapStopSchema,
  map_track: mapTrackSchema,
  route_pattern: routePatternSchema,
};

/** Konten yang terlihat: published untuk pengguna; draft (bila ada) untuk mode pratinjau admin. */
export function effective<T>(item: ContentItem, preview: boolean): T | null {
  if (!preview) return item.published as T | null;
  if (item.draftDeleted) return null;
  return (item.draft ?? item.published) as T | null;
}

export class ContentSnapshot {
  private facilities = new Map<string, AmenityDetail[]>();
  private entrances = new Map<string, Entrance[]>();
  private platforms = new Map<string, Platform[]>();
  private concourses = new Map<string, Concourse[]>();
  private info = new Map<string, StationInfo[]>();
  private noticeList: Notice[] = [];
  private stops = new Map<string, MapStop>();
  private tracks: MapTrack[] = [];
  private patterns = new Map<string, RoutePattern>();
  readonly settings: Settings;

  constructor(items: ContentItem[], preview: boolean, now: Date) {
    let settings: Settings = DEFAULT_SETTINGS;
    for (const it of items) {
      const v = effective<Record<string, unknown>>(it, preview);
      if (!v) continue;
      const sid = it.stationId ?? "";
      switch (it.kind) {
        case "facility": {
          const f = v as FacilityOverride;
          // Gangguan sementara yang sudah lewat masa berlakunya diabaikan: kembali ke data asal.
          if (f.status === "out_of_service" && f.until && Date.parse(f.until) < now.getTime()) break;
          const list = this.facilities.get(sid) ?? [];
          // Satu entri per jenis amenity; entri terbaru menang.
          const next = list.filter((x) => x.type !== f.type);
          next.push({ type: f.type, status: f.status, source: "ntd", note: f.note, verifiedAt: f.verifiedAt });
          this.facilities.set(sid, next);
          break;
        }
        case "entrance":
          this.entrances.set(sid, [...(this.entrances.get(sid) ?? []), { ...(v as Omit<Entrance, "id" | "stationId">), id: it.id, stationId: sid, source: "ntd" }]);
          break;
        case "platform": {
          // Satu entri per nomor peron; entri terbaru menang.
          const p = v as z.infer<typeof platformSchema>;
          const list = (this.platforms.get(sid) ?? []).filter((x) => x.code !== p.code);
          list.push({ ...p, serves: p.serves ?? [], amenities: p.amenities ?? {}, source: "ntd" });
          this.platforms.set(sid, list);
          break;
        }
        case "concourse": {
          // Satu entri per kode concourse; entri terbaru menang.
          const c = v as z.infer<typeof concourseSchema>;
          const list = (this.concourses.get(sid) ?? []).filter((x) => x.code !== c.code);
          list.push({ ...c, platformLinks: c.platformLinks ?? [], id: it.id, stationId: sid, source: "ntd" });
          this.concourses.set(sid, list);
          break;
        }
        case "station_info":
          this.info.set(sid, [...(this.info.get(sid) ?? []), { ...(v as Omit<StationInfo, "id" | "stationId">), id: it.id, stationId: sid }]);
          break;
        case "notice": {
          const n = v as Omit<Notice, "id">;
          if (n.endsAt && Date.parse(n.endsAt) < now.getTime()) break;
          if (n.startsAt && Date.parse(n.startsAt) > now.getTime()) break;
          this.noticeList.push({ ...n, id: it.id });
          break;
        }
        case "map_stop": {
          // Satu posisi per pemberhentian (dan per lini untuk titik anak); entri terbaru menang.
          const m = v as z.infer<typeof mapStopSchema>;
          this.stops.set(`${sid}|${m.lineId ?? ""}`, { ...m, stationId: sid });
          break;
        }
        case "route_pattern": {
          // Satu pengaturan per lini dan arah; entri terbaru menang.
          const p = v as z.infer<typeof routePatternSchema>;
          this.patterns.set(`${p.lineId}|${p.direction}`, { ...p, id: it.id });
          break;
        }
        case "map_track":
          this.tracks.push({ ...(v as z.infer<typeof mapTrackSchema>), id: it.id });
          break;
        case "settings":
          settings = { ...DEFAULT_SETTINGS, ...(v as Partial<Settings>) };
          break;
      }
    }
    this.settings = settings;
  }

  facilityOverrides(stationId: string): AmenityDetail[] {
    return this.facilities.get(stationId) ?? [];
  }

  platformsOf(stationId: string): Platform[] {
    return this.platforms.get(stationId) ?? [];
  }

  entrancesOf(stationId: string): Entrance[] {
    return this.entrances.get(stationId) ?? [];
  }

  concoursesOf(stationId: string): Concourse[] {
    return this.concourses.get(stationId) ?? [];
  }

  infoOf(stationId: string): StationInfo[] {
    return this.info.get(stationId) ?? [];
  }

  /** Pengumuman aktif yang relevan untuk sekumpulan stasiun, lini, dan hub (plus yang global). */
  notices(scope: { stationIds?: string[]; lineIds?: string[]; hubIds?: string[] } = {}): Notice[] {
    const rank = { critical: 0, warning: 1, info: 2 };
    return this.noticeList
      .filter(
        (n) =>
          n.scope === "global" ||
          (n.scope === "station" && scope.stationIds?.includes(n.targetId!)) ||
          (n.scope === "line" && scope.lineIds?.includes(n.targetId!)) ||
          (n.scope === "hub" && scope.hubIds?.includes(n.targetId!)),
      )
      .sort((a, b) => rank[a.severity] - rank[b.severity]);
  }

  /** Posisi dan bentuk jalur yang ditetapkan admin pada peta. */
  mapOverrides(): { stops: MapStop[]; tracks: MapTrack[] } {
    return { stops: [...this.stops.values()], tracks: [...this.tracks] };
  }

  /** Pengaturan rute per lini dan arah dari admin. */
  routePatterns(): RoutePattern[] {
    return [...this.patterns.values()];
  }

  allNotices(): Notice[] {
    return [...this.noticeList];
  }

  /** Bobot fasilitas inti atau tambahan. Pengaturan lama tanpa bobot tambahan memakai bobot bawaan. */
  weight(type: AnyAmenityType): number {
    const { weights, extraWeights } = this.settings.scoring;
    return type in weights ? weights[type as AmenityType] : (extraWeights?.[type as ExtraAmenityType] ?? DEFAULT_EXTRA_WEIGHTS[type as ExtraAmenityType] ?? 0);
  }

  gapPenalty(): { tangga: number; sedikit: number } {
    return this.settings.scoring.gapPenalty ?? DEFAULT_GAP_PENALTY;
  }
}

/** Membaca konten sekali per permintaan. Snapshot published di-cache sampai ada publikasi baru. */
export class ContentService {
  private cached?: { version: number; at: number; items: ContentItem[] };

  constructor(private repo: ContentRepository) {}

  async snapshot(ctx: RequestContext): Promise<ContentSnapshot> {
    if (ctx.preview) return new ContentSnapshot(await this.repo.list(), true, ctx.now);
    const version = await this.repo.version();
    // Batas waktu 60 dtk agar pengumuman berjadwal (startsAt/endsAt) tetap ter-evaluasi meski tidak ada publikasi.
    if (!this.cached || this.cached.version !== version || Date.now() - this.cached.at > 60_000) {
      this.cached = { version, at: Date.now(), items: await this.repo.list() };
    }
    return new ContentSnapshot(this.cached.items, false, ctx.now);
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
