// CommuteApiClient (Tabel 3.8): satu-satunya titik akses ke Commute Data API.
// - cache-first ber-TTL untuk data yang jarang berubah (stasiun, fasilitas, hub, lini, operator);
// - satu permintaan per kunci cache pada satu waktu (single-flight), dan data kedaluwarsa disajikan sambil
//   diperbarui di latar belakang (stale-while-revalidate) agar cache kosong tidak memicu ratusan permintaan;
// - rute/tarif selalu diminta langsung (tarif bergantung pada waktu `at`), tetapi salinan terakhir
//   disimpan sebagai cadangan bila API tidak dapat dihubungi (UC-01 E2);
// - memetakan respons upstream ke model internal (id NTD dari station-index).

import { markStale, type RequestContext } from "../../context";
import type { Amenity, AnyAmenityType, Entrance, ExitRef, Hub, HubWalk, Line, Mode, Operator, Platform, Station } from "../../domain/models";
import { UpstreamError } from "../../errors";
import type { CacheRepository } from "../../store/types";
import { directionLabel, jakartaDayHour } from "./HttpCommuteSource";
import { buildStationIndex, lineIdOf, liveIdsOf, type StationIndex } from "./station-index";
import type { CommuteSource, UpAmenity, UpExitRef, UpHubTransfer, UpLeg, UpStation } from "./types";

export const DEFAULT_TTL_SECONDS = 24 * 3600;
/** Data kedaluwarsa masih disajikan (sambil diperbarui) sampai umur ini; lebih tua dari itu ditunggu. */
export const MAX_STALE_SECONDS = 7 * 24 * 3600;
/** Frekuensi bergantung jam, jadi di-cache singkat (sama dengan Commute Data API: 10 menit). */
const HEADWAY_TTL_SECONDS = 600;

export interface LineHeadway {
  lineId: string;
  headwayMinutes: number | null;
  boundFor?: string;
  source: "STOP" | "LINE";
  serviceHours?: string;
}

export interface FareLeg {
  type: "RIDE" | "TRANSFER";
  lineId?: string;
  operator?: string;
  headsign?: string;
  /** Nomor peron naik dari dataset. */
  platform?: string;
  /** Lin paralel pada ruas yang sama (termasuk lin utama, paling depan). */
  serviceLines?: { lineId: string; headsign?: string }[];
  stops: string[];
  distanceM: number;
  fare: number;
  departureAt?: string;
  arrivalAt?: string;
}

export interface FareResult {
  fromId: string;
  toId: string;
  totalFare: number;
  totalDistanceM: number;
  legs: FareLeg[];
  /** Nama pemberhentian menurut sumber data, untuk stasiun yang tidak ada di daftar stasiun NTD. */
  stopNames: Record<string, string>;
}

const AMENITY_MAP: Record<string, AnyAmenityType> = {
  // Commute Data API (enum Amenity.type)
  ELEVATOR_PAID: "lift",
  ELEVATOR_UNPAID: "lift",
  ESCALATOR_PAID: "eskalator",
  ESCALATOR_UNPAID: "eskalator",
  TOILET_ACCESSIBLE: "toilet",
  // Nama lain (sumber offline dan kemungkinan penambahan jenis di API)
  ELEVATOR: "lift",
  LIFT: "lift",
  ESCALATOR: "eskalator",
  ACCESSIBLE_TOILET: "toilet",
  DISABLED_TOILET: "toilet",
  TOILET_DISABLED: "toilet",
  WHEELCHAIR_TOILET: "toilet",
  RAMP: "ramp",
  TACTILE_PAVING: "guiding_block",
  GUIDING_BLOCK: "guiding_block",
  WHEELCHAIR: "kursi_roda",
  WHEELCHAIR_RENTAL: "kursi_roda",
};

const AREA: Record<string, string> = { PAID: "area berbayar", UNPAID: "area umum" };

export function mapAmenity(a: UpAmenity): Amenity | null {
  const key = a.type?.toUpperCase().replace(/[\s-]+/g, "_");
  const type = AMENITY_MAP[key];
  if (!type) return null;
  // Lokasi fasilitas, mis. "Lift (area berbayar): Peron 1".
  const area = AREA[key.split("_").pop() ?? ""];
  const text = a.description ?? a.name;
  const description = [area, text].filter(Boolean).join(": ") || undefined;
  return { type, ...(description ? { description } : {}) };
}

export class CommuteApiClient {
  /** Kunci cache dipisah per sumber agar data fixture yang tersimpan tidak terbaca saat beralih ke API sungguhan. */
  private readonly prefix: string;

  constructor(
    private source: CommuteSource,
    private cache: CacheRepository,
  ) {
    this.prefix = `commute:v3:${source.name}:`;
  }

  get sourceName() {
    return this.source.name;
  }

  /** Jenis fasilitas inti yang dapat dinyatakan sumber data (lihat CommuteSource.amenityCoverage). */
  get amenityCoverage(): readonly string[] | undefined {
    return this.source.amenityCoverage;
  }

  private memo?: { raw: UpStation[]; index: StationIndex };

  /** Indeks slug NTD <-> kode upstream, dibangun dari daftar stasiun (cache) sumber data. */
  async index(ctx: RequestContext): Promise<StationIndex> {
    const raw = await this.rawStations(ctx);
    if (this.memo?.raw !== raw) this.memo = { raw, index: buildStationIndex(raw) };
    return this.memo.index;
  }

  private rawLines(ctx: RequestContext) {
    return this.cached("lines", ctx, this.ttl(ctx), () => this.source.getLines());
  }

  private rawStations(ctx: RequestContext): Promise<UpStation[]> {
    return this.cached("stations", ctx, this.ttl(ctx), () => this.source.getStations());
  }

  /** Permintaan ke sumber data yang sedang berjalan, per kunci cache (single-flight). */
  private inflight = new Map<string, Promise<unknown>>();

  /** Panggil `load` sekali untuk semua pemanggil kunci yang sama, lalu simpan hasilnya. */
  private refresh<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = (async () => {
      try {
        const value = await load();
        // null (404) tidak di-cache lama agar data baru segera terlihat.
        await this.cache.put(this.prefix + key, value, value === null ? 300 : ttlSeconds);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /**
   * Ambil dari cache bila masih segar. Bila kedaluwarsa tetapi belum terlalu tua, sajikan salinan itu dan
   * perbarui di latar belakang. Bila tidak ada salinan, tunggu API; bila API gagal, pakai cache kedaluwarsa.
   */
  private async cached<T>(key: string, ctx: RequestContext, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.cache.get<T>(this.prefix + key);
    if (hit && hit.expiresAt > ctx.now) return hit.value;
    if (hit && ctx.now.getTime() - hit.expiresAt.getTime() < MAX_STALE_SECONDS * 1000) {
      // Galat pembaruan latar belakang diabaikan: salinan lama tetap dipakai sampai pembaruan berhasil.
      this.refresh(key, ttlSeconds, load).catch(() => {});
      return hit.value;
    }
    try {
      return await this.refresh(key, ttlSeconds, load);
    } catch (e) {
      if (e instanceof UpstreamError && hit) {
        markStale(ctx, new Date(hit.storedAt));
        return hit.value;
      }
      throw e;
    }
  }

  private ttl(ctx: RequestContext) {
    return ctx.cacheTtlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async getOperators(ctx: RequestContext): Promise<Operator[]> {
    const ops = await this.cached("operators", ctx, this.ttl(ctx), () => this.source.getOperators());
    return ops.map((o) => ({ code: o.code, name: o.name, mode: o.mode }));
  }

  async getLines(ctx: RequestContext): Promise<Line[]> {
    const [lines, ops, idx] = await Promise.all([
      this.rawLines(ctx),
      this.getOperators(ctx),
      this.index(ctx),
    ]);
    // Beberapa lin upstream bisa dipetakan ke satu lini NTD (mis. LRT Jabodebek); stasiunnya digabung.
    const out = new Map<string, Line>();
    for (const l of lines) {
      const id = lineIdOf(l.operator, l.code);
      const stationIds = l.stations.map((r) => idx.idOf(r));
      const prev = out.get(id);
      if (prev) {
        prev.stationIds = dedupe([...prev.stationIds, ...stationIds]);
        continue;
      }
      const op = ops.find((o) => o.code === l.operator);
      out.set(id, {
        id,
        name: l.name,
        operator: op?.name ?? l.operator,
        mode: (l.mode ?? op?.mode ?? "RAIL") as Mode,
        color: l.color ?? "#555555",
        stationIds: dedupe(stationIds),
      });
    }
    return [...out.values()];
  }

  /**
   * Urutan stasiun tiap lini per ruas (batang utama dan cabang, id NTD), untuk mencari rute di atas topologi
   * lini (filter moda). Cabang disambungkan ke stasiun percabangannya pada ujung ruas yang lebih dekat.
   */
  async getLineSequences(ctx: RequestContext): Promise<{ lineId: string; sequences: string[][] }[]> {
    const [lines, idx, raw] = await Promise.all([this.rawLines(ctx), this.index(ctx), this.rawStations(ctx)]);
    const coord = new Map(raw.filter((s) => typeof s.lat === "number" && typeof s.lng === "number").map((s) => [idx.idOf(s), { lat: s.lat!, lng: s.lng! }]));
    const far = (a: string, b: string) => {
      const p = coord.get(a);
      const q = coord.get(b);
      return p && q ? (p.lat - q.lat) ** 2 + (p.lng - q.lng) ** 2 : Number.POSITIVE_INFINITY;
    };
    return lines.map((l) => {
      const segments = l.segments?.length ? l.segments : [{ stations: l.stations }];
      const sequences = segments.map((seg) => {
        const ids = seg.stations.map((r) => idx.idOf(r));
        if (!seg.joinsAt || !ids.length) return ids;
        const j = idx.idOf(seg.joinsAt);
        if (ids.includes(j)) return ids;
        return far(j, ids[ids.length - 1]) < far(j, ids[0]) ? [...ids, j] : [j, ...ids];
      });
      return { lineId: lineIdOf(l.operator, l.code), sequences: sequences.filter((x) => x.length > 1) };
    });
  }

  async getStations(ctx: RequestContext): Promise<Station[]> {
    const [raw, ops, idx, upLines] = await Promise.all([this.rawStations(ctx), this.getOperators(ctx), this.index(ctx), this.rawLines(ctx)]);
    // Nomor stasiun dari /lines (mis. C12, 1-13) dipakai GUI untuk menemukan posisi di peta.
    const numbers = new Map<string, string[]>();
    for (const l of upLines)
      l.stations.forEach((r, i) => {
        const n = l.stationNumbers?.[i];
        if (!n) return;
        const id = idx.idOf(r);
        numbers.set(id, dedupe([...(numbers.get(id) ?? []), n]));
      });
    const merged = new Map<string, Station>();
    for (const s of raw) {
      const id = idx.idOf(s);
      const opName = ops.find((o) => o.code === s.operator)?.name ?? s.operator;
      const lineIds = (s.lines ?? []).map((l) => {
        const [op, code] = l.includes(":") ? l.split(":", 2) : [s.operator, l];
        return lineIdOf(op, code);
      });
      const prev = merged.get(id);
      if (!prev) {
        const curated = idx.codesOf(id, "");
        const codes = curated[0] ? curated : (numbers.get(id) ?? [s.code]);
        merged.set(id, {
          id,
          name: s.name,
          operator: opName,
          lineIds: dedupe(lineIds),
          hubId: s.hub ?? undefined,
          codes,
          commuteIds: commuteIdsOf(id, idx),
          ...(typeof s.lat === "number" && typeof s.lng === "number" ? { lat: s.lat, lng: s.lng } : {}),
        });
      } else {
        if (!prev.operator.split(" · ").includes(opName)) prev.operator += ` · ${opName}`;
        prev.lineIds = dedupe([...prev.lineIds, ...lineIds]);
        prev.hubId ??= s.hub ?? undefined;
      }
    }
    return [...merged.values()];
  }

  /**
   * Amenity sebuah stasiun dari dataset (gabungan seluruh kode operator pada stasiun itu).
   * null = dataset tidak memuat data amenity untuk stasiun ini (UC-01 E3: "data tidak tersedia").
   */
  async getStationAmenities(stationId: string, ctx: RequestContext): Promise<Amenity[] | null> {
    const [idx, raw] = await Promise.all([this.index(ctx), this.rawStations(ctx)]);
    const refs = idx.refsOf(stationId);
    // Daftar stasiun sudah memuat amenity; detail per stasiun hanya diminta bila daftar tidak memuatnya.
    const records = await Promise.all(
      refs.map((r) => {
        const listed = raw.find((s) => s.operator === r.operator && s.code === r.code);
        if (listed && listed.amenities !== undefined) return listed;
        return this.cached<UpStation | null>(`station:${r.operator}:${r.code}`, ctx, this.ttl(ctx), () => this.source.getStation(r.operator, r.code));
      }),
    );
    // Daftar kosong dianggap "data tidak tersedia", bukan "tidak ada fasilitas" (UC-01 E3).
    const lists = records.filter((r): r is UpStation => !!r && Array.isArray(r.amenities) && r.amenities.length > 0);
    if (!lists.length) return null;
    const out = new Map<string, Amenity>();
    for (const rec of lists)
      for (const a of rec.amenities!) {
        const am = mapAmenity(a);
        if (!am) continue;
        const prev = out.get(am.type);
        if (!prev) out.set(am.type, am);
        else if (am.description && !prev.description?.includes(am.description)) prev.description = [prev.description, am.description].filter(Boolean).join("; ");
      }
    return [...out.values()];
  }

  async getHubs(ctx: RequestContext): Promise<Hub[]> {
    const [hubs, idx] = await Promise.all([this.cached("hubs", ctx, this.ttl(ctx), () => this.source.getHubs()), this.index(ctx)]);
    return hubs.map((h) => ({
      id: h.id,
      name: h.name,
      ...(h.kind ? { kind: h.kind } : {}),
      memberIds: dedupe(h.stations.map((r) => idx.idOf(r))),
      // Satu stasiun NTD bisa memuat beberapa kode operator; jalan "ke dirinya sendiri" tidak dipakai.
      walks: (h.transfers ?? []).map((t) => mapWalk(t, idx)).filter((w) => w.from !== w.to),
    }));
  }

  /**
   * Jalan kaki dari stasiun `fromId` ke `toId` menurut dataset (jarak, petunjuk, pintu keluar), dari
   * /stations/{op}/{code}/transfers. undefined = dataset tidak mencatat perpindahan itu.
   */
  async getWalk(fromId: string, toId: string, ctx: RequestContext): Promise<HubWalk | undefined> {
    const getTransfers = this.source.getTransfers?.bind(this.source);
    if (!getTransfers || fromId === toId) return undefined;
    const idx = await this.index(ctx);
    for (const r of idx.refsOf(fromId)) {
      const list = await this.cached(`transfers:${r.operator}:${r.code}`, ctx, this.ttl(ctx), () => getTransfers(r.operator, r.code));
      const hit = (list ?? []).map((t) => mapWalk(t, idx)).find((w) => w.to === toId);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Frekuensi tiap lin di pemberhentian `stationId` pada waktu `at`. [] = dataset tidak menyediakan. */
  async getHeadways(stationId: string, ctx: RequestContext, at?: string): Promise<LineHeadway[]> {
    const getHeadways = this.source.getHeadways?.bind(this.source);
    if (!getHeadways) return [];
    const idx = await this.index(ctx);
    const when = at ?? ctx.now.toISOString();
    const { day, hour } = jakartaDayHour(new Date(when));
    const out: LineHeadway[] = [];
    for (const r of idx.refsOf(stationId)) {
      const rows = await this.cached(`headway:${r.operator}:${r.code}:${day}:${hour}`, ctx, HEADWAY_TTL_SECONDS, () => getHeadways(r.operator, r.code, when)).catch((e) => {
        // Frekuensi hanya pelengkap; rute tetap ditampilkan tanpa frekuensi bila API gagal.
        if (e instanceof UpstreamError) return null;
        throw e;
      });
      for (const h of rows ?? [])
        out.push({
          lineId: lineIdOf(h.operator, h.line),
          headwayMinutes: h.headwayS === null ? null : Math.max(1, Math.round(h.headwayS / 60)),
          ...(h.boundFor ? { boundFor: h.boundFor } : {}),
          source: h.source ?? "LINE",
          ...(h.serviceHours ? { serviceHours: "allDay" in h.serviceHours ? "24 jam" : `${h.serviceHours.start}–${h.serviceHours.end}` } : {}),
        });
    }
    return out;
  }

  /**
   * Peron menurut dataset: nomor peron dan lin/arah yang dilayaninya. Dataset belum memuat jenis peron,
   * fasilitas per peron, atau celah peron; itu diisi tim lewat admin. [] = dataset tidak mencatat.
   */
  async getPlatforms(stationId: string, ctx: RequestContext): Promise<Platform[]> {
    const getPlatforms = this.source.getPlatforms?.bind(this.source);
    if (!getPlatforms) return [];
    const idx = await this.index(ctx);
    const byCode = new Map<string, Platform>();
    for (const r of idx.refsOf(stationId)) {
      const rows = await this.cached(`platforms:${r.operator}:${r.code}`, ctx, this.ttl(ctx), () => getPlatforms(r.operator, r.code)).catch(supplementary);
      for (const p of rows ?? []) {
        const pl = byCode.get(p.platformCode) ?? { code: p.platformCode, serves: [], amenities: {}, source: "dataset" as const };
        pl.serves.push({ lineId: lineIdOf(p.operator, p.line), ...(directionLabel(p.direction) ? { direction: directionLabel(p.direction) } : {}) });
        byCode.set(p.platformCode, pl);
      }
    }
    return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code, "id", { numeric: true }));
  }

  /** Pintu keluar/gate menurut dataset (/exits). [] = belum dicatat, bukan berarti tidak ada pintu. */
  async getExits(stationId: string, ctx: RequestContext): Promise<Entrance[]> {
    const getExits = this.source.getExits?.bind(this.source);
    if (!getExits) return [];
    const idx = await this.index(ctx);
    const out: Entrance[] = [];
    for (const r of idx.refsOf(stationId)) {
      const rows = await this.cached(`exits:${r.operator}:${r.code}`, ctx, this.ttl(ctx), () => getExits(r.operator, r.code)).catch(supplementary);
      for (const e of rows ?? [])
        out.push({
          id: `${r.operator}-${r.code}:${e.ref}`,
          stationId,
          name: e.name ? `Pintu ${e.ref} (${e.name})` : `Pintu ${e.ref}`,
          // Dataset tidak menyatakan aksesibilitas pintu; tim melengkapinya lewat admin.
          accessible: false,
          features: [],
          ...(e.signs?.length ? { signs: e.signs } : {}),
          source: "dataset",
        });
    }
    return out;
  }

  /** Rute dari dataset. null = rute tidak ditemukan. */
  async getFare(fromId: string, toId: string, ctx: RequestContext, at?: string): Promise<FareResult | null> {
    const idx = await this.index(ctx);
    const [from] = idx.refsOf(fromId);
    const [to] = idx.refsOf(toId);
    if (!from || !to) return null;
    const key = `${this.prefix}fare:${fromId}:${toId}`;
    let up;
    try {
      up = await this.source.getFare(from, to, at);
      if (up) await this.cache.put(key, up, 7 * 24 * 3600);
    } catch (e) {
      const hit = e instanceof UpstreamError ? await this.cache.get<typeof up>(key) : null;
      if (!hit) throw e;
      markStale(ctx, new Date(hit.storedAt));
      up = hit.value;
    }
    if (!up || !up.legs?.length) return null;
    return {
      fromId,
      toId,
      totalFare: up.totalFare,
      totalDistanceM: up.totalDistanceM,
      legs: up.legs.map((l) => mapLeg(l, idx)),
      stopNames: Object.fromEntries(up.legs.flatMap((l) => (l.stopNames ?? []).map((n, i) => [idx.idOf(l.stops[i]), n]))),
    };
  }

  /** Cek kesehatan Commute Data API tanpa cache (dipakai halaman admin). */
  async ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const t = Date.now();
    try {
      await this.source.getOperators();
      return { ok: true, latencyMs: Date.now() - t };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t, error: (e as Error).message };
    }
  }
}

function mapLeg(l: UpLeg, idx: StationIndex): FareLeg {
  const firstTime = l.stopTimes?.[0];
  const lastTime = l.stopTimes?.[l.stopTimes.length - 1];
  return {
    type: l.type,
    lineId: l.line && l.operator ? lineIdOf(l.operator, l.line) : undefined,
    operator: l.operator,
    ...(l.headsign ? { headsign: l.headsign } : {}),
    ...(l.platformCode ? { platform: l.platformCode } : {}),
    ...(l.serviceLines?.length ? { serviceLines: l.serviceLines.map((x) => ({ lineId: lineIdOf(x.operator, x.line), ...(x.headsign ? { headsign: x.headsign } : {}) })) } : {}),
    stops: l.stops.map((r) => idx.idOf(r)),
    distanceM: l.distanceM,
    fare: l.fare ?? 0,
    departureAt: l.departureAt ?? firstTime?.departureAt ?? firstTime?.arrivalAt ?? undefined,
    arrivalAt: l.arrivalAt ?? lastTime?.arrivalAt ?? lastTime?.departureAt ?? undefined,
  };
}

/** Data pelengkap: galat API tidak menggagalkan permintaan, data dianggap belum ada. */
function supplementary(e: unknown): null {
  if (e instanceof UpstreamError) return null;
  throw e;
}

function mapExit(e: UpExitRef): ExitRef {
  return { ref: e.ref, ...(e.name ? { name: e.name } : {}), ...(e.signs?.length ? { signs: e.signs } : {}) };
}

function mapWalk(t: UpHubTransfer, idx: StationIndex): HubWalk {
  return {
    from: idx.idOf(t.from),
    to: idx.idOf(t.to),
    distanceM: t.distanceM,
    minutes: t.durationS === null || t.durationS === undefined ? null : Math.round(t.durationS / 60),
    ...(t.notes ? { notes: t.notes } : {}),
    ...(t.fromExit ? { fromExit: mapExit(t.fromExit) } : {}),
    ...(t.toExit ? { toExit: mapExit(t.toExit) } : {}),
  };
}

/** Id Commute Data API sebuah stasiun NTD: kode dari sumber data, ditambah id yang dikurasi di station-index. */
function commuteIdsOf(stationId: string, idx: StationIndex): string[] {
  const live = liveIdsOf(stationId);
  return live.length ? live : dedupe(idx.refsOf(stationId).map((r) => `${r.operator}-${r.code}`));
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
