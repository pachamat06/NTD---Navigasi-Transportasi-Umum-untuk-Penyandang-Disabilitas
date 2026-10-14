// Konten yang tidak disediakan dataset dan dikelola tim lewat halaman admin:
// koreksi/tambahan fasilitas, pintu akses stasiun, pengumuman (sumber notifikasi), info lain,
// serta pengaturan skor dan disclaimer. Validasi skema di sini dipakai bersama oleh endpoint admin.

import { z } from "zod";
import type { RequestContext } from "../context";
import type { ContentItem, ContentKind, ContentRepository } from "../store/types";
import { CORE_AMENITIES, EXTRA_AMENITIES, type AmenityDetail, type AmenityType, type Entrance, type Notice, type StationInfo } from "./models";

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "harus tanggal ISO 8601");

export const facilitySchema = z.object({
  type: z.enum([...CORE_AMENITIES, ...EXTRA_AMENITIES]),
  status: z.enum(["available", "absent", "unknown", "out_of_service"]),
  note: z.string().max(500).optional(),
  verifiedAt: isoDate.optional(),
  /** Untuk out_of_service: perkiraan selesai perbaikan. Setelah lewat, status kembali ke data asal. */
  until: isoDate.optional(),
});

export const entranceSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  accessible: z.boolean(),
  features: z.array(z.enum(["lift", "ramp", "eskalator", "tangga", "datar", "guiding_block"])).max(6).default([]),
  openHours: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
  mapPosition: z.object({ x: z.number(), y: z.number() }).optional(),
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

export const DEFAULT_DISCLAIMER =
  "Informasi fasilitas berasal dari data statis dan bisa berbeda dengan kondisi di lapangan. Bukan status real-time.";

export const settingsSchema = z.object({
  scoring: z.object({
    weights: z.object({ lift: z.number().min(0).max(100), eskalator: z.number().min(0).max(100), toilet: z.number().min(0).max(100), ramp: z.number().min(0).max(100) }),
    threshold: z.number().min(0).max(100),
  }),
  disclaimer: z.string().min(10).max(500),
  llmEnabled: z.boolean(),
  cacheTtlSeconds: z.number().int().min(60).max(7 * 24 * 3600),
  requireTestsBeforePublish: z.boolean(),
});

export type FacilityOverride = z.infer<typeof facilitySchema>;
export type Settings = z.infer<typeof settingsSchema>;

/** Bobot awal mengikuti GUI basic; divalidasi dengan data riil pada Sprint 2 (Risiko #4). */
export const DEFAULT_SETTINGS: Settings = {
  scoring: { weights: { lift: 40, eskalator: 20, toilet: 25, ramp: 15 }, threshold: 70 },
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
  private info = new Map<string, StationInfo[]>();
  private noticeList: Notice[] = [];
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
          this.entrances.set(sid, [...(this.entrances.get(sid) ?? []), { ...(v as Omit<Entrance, "id" | "stationId">), id: it.id, stationId: sid }]);
          break;
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

  entrancesOf(stationId: string): Entrance[] {
    return this.entrances.get(stationId) ?? [];
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

  allNotices(): Notice[] {
    return [...this.noticeList];
  }

  weight(type: AmenityType): number {
    return this.settings.scoring.weights[type];
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
