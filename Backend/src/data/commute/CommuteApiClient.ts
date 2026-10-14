// CommuteApiClient (Tabel 3.8): satu-satunya titik akses ke Commute Data API.
// - cache-first ber-TTL untuk data yang jarang berubah (stasiun, fasilitas, hub, lini, operator);
// - rute/tarif selalu diminta langsung (tarif bergantung pada waktu `at`), tetapi salinan terakhir
//   disimpan sebagai cadangan bila API tidak dapat dihubungi (UC-01 E2);
// - memetakan respons upstream ke model internal (id NTD dari station-index).

import { markStale, type RequestContext } from "../../context";
import type { Amenity, AnyAmenityType, Hub, Line, Mode, Operator, Station } from "../../domain/models";
import { UpstreamError } from "../../errors";
import type { CacheRepository } from "../../store/types";
import { codesOf, lineIdOf, refsOf, stationIdOf } from "./station-index";
import type { CommuteSource, UpAmenity, UpLeg, UpStation } from "./types";

export const DEFAULT_TTL_SECONDS = 24 * 3600;
const PREFIX = "commute:v1:";

export interface FareLeg {
  type: "RIDE" | "TRANSFER";
  lineId?: string;
  operator?: string;
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
}

const AMENITY_MAP: Record<string, AnyAmenityType> = {
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

export function mapAmenity(a: UpAmenity): Amenity | null {
  const type = AMENITY_MAP[a.type?.toUpperCase().replace(/[\s-]+/g, "_")];
  return type ? { type, description: a.description ?? a.name } : null;
}

export class CommuteApiClient {
  constructor(
    private source: CommuteSource,
    private cache: CacheRepository,
  ) {}

  get sourceName() {
    return this.source.name;
  }

  /** Ambil dari cache bila masih segar; bila tidak, panggil API; bila API gagal, pakai cache kedaluwarsa. */
  private async cached<T>(key: string, ctx: RequestContext, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.cache.get<T>(PREFIX + key);
    if (hit && hit.expiresAt > ctx.now) return hit.value;
    try {
      const value = await load();
      // null (404) tidak di-cache lama agar data baru segera terlihat.
      await this.cache.put(PREFIX + key, value, value === null ? 300 : ttlSeconds);
      return value;
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
    const [lines, ops] = await Promise.all([
      this.cached("lines", ctx, this.ttl(ctx), () => this.source.getLines()),
      this.getOperators(ctx),
    ]);
    return lines.map((l) => {
      const op = ops.find((o) => o.code === l.operator);
      return {
        id: lineIdOf(l.operator, l.code),
        name: l.name,
        operator: op?.name ?? l.operator,
        mode: (l.mode ?? op?.mode ?? "RAIL") as Mode,
        color: l.color ?? "#555555",
        stationIds: dedupe(l.stations.map(stationIdOf)),
      };
    });
  }

  async getStations(ctx: RequestContext): Promise<Station[]> {
    const [raw, ops] = await Promise.all([this.cached("stations", ctx, this.ttl(ctx), () => this.source.getStations()), this.getOperators(ctx)]);
    const merged = new Map<string, Station>();
    for (const s of raw) {
      const id = stationIdOf(s);
      const opName = ops.find((o) => o.code === s.operator)?.name ?? s.operator;
      const lineIds = (s.lines ?? []).map((l) => lineIdOf(s.operator, l));
      const prev = merged.get(id);
      if (!prev) {
        merged.set(id, { id, name: s.name, operator: opName, lineIds, hubId: s.hub ?? undefined, codes: codesOf(id, s.code) });
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
    const refs = refsOf(stationId);
    const records = await Promise.all(
      refs.map((r) => this.cached<UpStation | null>(`station:${r.operator}:${r.code}`, ctx, this.ttl(ctx), () => this.source.getStation(r.operator, r.code))),
    );
    const lists = records.filter((r): r is UpStation => !!r && Array.isArray(r.amenities) && r.amenities.length > 0);
    if (!lists.length) return null;
    const out = new Map<string, Amenity>();
    for (const rec of lists) for (const a of rec.amenities!) {
      const m = mapAmenity(a);
      if (m && !out.has(m.type)) out.set(m.type, m);
    }
    return [...out.values()];
  }

  async getHubs(ctx: RequestContext): Promise<Hub[]> {
    const hubs = await this.cached("hubs", ctx, this.ttl(ctx), () => this.source.getHubs());
    return hubs.map((h) => ({
      id: h.id,
      name: h.name,
      memberIds: dedupe(h.stations.map(stationIdOf)),
      walks: (h.transfers ?? []).map((t) => ({
        from: stationIdOf(t.from),
        to: stationIdOf(t.to),
        distanceM: t.distanceM,
        minutes: t.durationS === null || t.durationS === undefined ? null : Math.round(t.durationS / 60),
      })),
    }));
  }

  /** Rute dari dataset. null = rute tidak ditemukan. */
  async getFare(fromId: string, toId: string, ctx: RequestContext, at?: string): Promise<FareResult | null> {
    const [from] = refsOf(fromId);
    const [to] = refsOf(toId);
    if (!from || !to) return null;
    const key = `${PREFIX}fare:${fromId}:${toId}`;
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
      legs: up.legs.map(mapLeg),
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

function mapLeg(l: UpLeg): FareLeg {
  const firstTime = l.stopTimes?.[0];
  const lastTime = l.stopTimes?.[l.stopTimes.length - 1];
  return {
    type: l.type,
    lineId: l.line && l.operator ? lineIdOf(l.operator, l.line) : undefined,
    operator: l.operator,
    stops: l.stops.map(stationIdOf),
    distanceM: l.distanceM,
    fare: l.fare ?? 0,
    departureAt: l.departureAt ?? firstTime?.departureAt ?? firstTime?.arrivalAt ?? undefined,
    arrivalAt: l.arrivalAt ?? lastTime?.arrivalAt ?? lastTime?.departureAt ?? undefined,
  };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
