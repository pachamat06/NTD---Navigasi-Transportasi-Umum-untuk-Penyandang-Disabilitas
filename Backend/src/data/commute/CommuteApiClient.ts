// CommuteApiClient (Tabel 3.8): satu-satunya titik akses ke Commute Data API.
// - cache-first ber-TTL untuk data yang jarang berubah (stasiun, fasilitas, hub, lini, operator);
// - rute/tarif selalu diminta langsung (tarif bergantung pada waktu `at`), tetapi salinan terakhir
//   disimpan sebagai cadangan bila API tidak dapat dihubungi (UC-01 E2);
// - memetakan respons upstream ke model internal (id NTD dari station-index).

import { markStale, type RequestContext } from "../../context";
import type { Amenity, AnyAmenityType, Hub, Line, Mode, Operator, Station } from "../../domain/models";
import { UpstreamError } from "../../errors";
import type { CacheRepository } from "../../store/types";
import { buildStationIndex, lineIdOf, type StationIndex } from "./station-index";
import type { CommuteSource, UpAmenity, UpLeg, UpStation } from "./types";

export const DEFAULT_TTL_SECONDS = 24 * 3600;

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

  /** Ambil dari cache bila masih segar; bila tidak, panggil API; bila API gagal, pakai cache kedaluwarsa. */
  private async cached<T>(key: string, ctx: RequestContext, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.cache.get<T>(this.prefix + key);
    if (hit && hit.expiresAt > ctx.now) return hit.value;
    try {
      const value = await load();
      // null (404) tidak di-cache lama agar data baru segera terlihat.
      await this.cache.put(this.prefix + key, value, value === null ? 300 : ttlSeconds);
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
      memberIds: dedupe(h.stations.map((r) => idx.idOf(r))),
      walks: (h.transfers ?? []).map((t) => ({
        from: idx.idOf(t.from),
        to: idx.idOf(t.to),
        distanceM: t.distanceM,
        minutes: t.durationS === null || t.durationS === undefined ? null : Math.round(t.durationS / 60),
      })),
    }));
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
    stops: l.stops.map((r) => idx.idOf(r)),
    distanceM: l.distanceM,
    fare: l.fare ?? 0,
    departureAt: l.departureAt ?? firstTime?.departureAt ?? firstTime?.arrivalAt ?? undefined,
    arrivalAt: l.arrivalAt ?? lastTime?.arrivalAt ?? lastTime?.departureAt ?? undefined,
  };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
