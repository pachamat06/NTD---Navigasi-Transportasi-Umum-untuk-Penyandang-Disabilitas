// Klien HTTP ke Commute Data API (api.commute.shiorilabs.id, OpenAPI 3.1 di /openapi.json). Lisensi data
// ODbL-1.0: atribusi wajib ditampilkan di antarmuka (lihat ATTRIBUTION di GroundingGuard).
//
// Respons API dibungkus `{ status, data }` (gagal: `{ status, error: { code, message } }`) dan diterjemahkan
// ke tipe internal di ./types. Endpoint yang dipakai:
//   /stations, /stations/{operator}/{code}, /hubs, /operators, /lines/{operator}/{lineCode}, /fares/{from}/{to}
// Id stasiun API berbentuk `{operator}-{code}` (mis. KCI-SUD); kunci lin `OPERATOR:KODE` (mis. KCI:C).

import { UpstreamError } from "../../errors";
import type { Mode } from "../../domain/models";
import type { CommuteSource, UpFare, UpHub, UpLeg, UpLine, UpOperator, UpStation, UpStopRef } from "./types";

export interface HttpCommuteOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  /** Operator yang dipakai. Bawaan semua operator, termasuk TransJakarta karena rute /fares bisa melewatinya. */
  operators?: string[];
  /** Wilayah (regionCode) yang dipakai. Bawaan CGK (Jabodetabek). */
  regions?: string[];
  fetchImpl?: typeof fetch;
}

export const DEFAULT_OPERATORS = ["KCI", "MRTJ", "LRTJ", "LRTJBDB", "APCGK", "TJ"];
export const DEFAULT_REGIONS = ["CGK"];

// --- Bentuk respons API (hanya field yang dipakai) ---------------------------------------------

interface ApiAmenity {
  type: string;
  text?: string;
}

interface ApiStation {
  id: string;
  name: string;
  officialName?: string;
  code: string;
  operator: string;
  regionCode?: string;
  lines?: string[];
  amenities?: ApiAmenity[];
  latitude?: number | null;
  longitude?: number | null;
  score?: number | null;
}

interface ApiStationRef {
  id: string;
  code: string;
  operator: string;
}

interface ApiHub {
  id: string;
  slug: string;
  name: string;
  members: ApiStationRef[];
}

interface ApiOperator {
  code: string;
  name: string;
  mode?: Mode;
  lines?: { name: string; lineCode: string; colorCode?: string; mode?: Mode; searchable?: boolean }[];
}

interface ApiLineDetail {
  segments?: { kind?: string; joinsAtCode?: string | null; stations?: { id: string; code: string; stationNumber?: string }[] }[];
}

interface ApiFareStation {
  id: string;
  name?: string;
}

interface ApiStopTime {
  id?: string;
  stationId?: string;
  arrivalAt?: string | null;
  departureAt?: string | null;
}

type ApiFareLeg =
  | {
      type: "RIDE";
      line: string;
      operator: string;
      from: ApiFareStation;
      to: ApiFareStation;
      stops?: ApiFareStation[];
      distanceM: number;
      departureAt?: string | null;
      arrivalAt?: string | null;
      stopTimes?: ApiStopTime[];
    }
  | { type: "TRANSFER"; from: ApiFareStation; to: ApiFareStation; distanceM: number; fare?: number | null };

interface ApiFare {
  from: ApiFareStation;
  to: ApiFareStation;
  legs: ApiFareLeg[];
  segments?: { operator: string; from: ApiFareStation; to: ApiFareStation; fare: number | null }[];
  totalFare: number | null;
  totalDistanceM: number;
}

// --- Konversi id ----------------------------------------------------------------------------

/** Id stasiun API untuk path /fares/{from}/{to}: `{operator}-{code}`. */
export function stopParam(ref: UpStopRef): string {
  return encodeURIComponent(`${ref.operator}-${ref.code}`);
}

/** Kebalikan stopParam. Kode operator tidak memuat tanda hubung, jadi dipisah pada tanda hubung pertama. */
export function refOfId(id: string): UpStopRef {
  const i = id.indexOf("-");
  return i < 0 ? { operator: "", code: id } : { operator: id.slice(0, i), code: id.slice(i + 1) };
}

export class HttpCommuteSource implements CommuteSource {
  readonly name = "http";
  /** API tidak punya jenis fasilitas ramp; status ramp karenanya "data tidak tersedia", bukan "tidak ada". */
  readonly amenityCoverage = ["lift", "eskalator", "toilet"] as const;
  private fetchImpl: typeof fetch;
  private operators: Set<string>;
  private regions: Set<string>;

  constructor(private opts: HttpCommuteOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.operators = new Set((opts.operators?.length ? opts.operators : DEFAULT_OPERATORS).map((s) => s.toUpperCase()));
    this.regions = new Set((opts.regions?.length ? opts.regions : DEFAULT_REGIONS).map((s) => s.toUpperCase()));
  }

  /** GET dengan timeout. 404 dikembalikan sebagai null; galat jaringan/5xx menjadi UpstreamError. */
  private async get<T>(path: string): Promise<T | null> {
    const url = new URL(path, this.opts.baseUrl.endsWith("/") ? this.opts.baseUrl : this.opts.baseUrl + "/");
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "NTD-backend/1.0" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (e) {
      throw new UpstreamError(`Commute Data API tidak dapat dihubungi: ${(e as Error).message}`);
    }
    if (res.status === 404) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (!res.ok) throw new UpstreamError(`Commute Data API membalas ${res.status} untuk ${url.pathname}`, res.status);
      throw new UpstreamError(`Respons Commute Data API bukan JSON yang valid (${url.pathname})`);
    }
    if (!res.ok) {
      const msg = (body as { error?: { code?: string; message?: string } })?.error;
      throw new UpstreamError(`Commute Data API membalas ${res.status} untuk ${url.pathname}${msg ? ` (${msg.code}: ${msg.message})` : ""}`, res.status);
    }
    return body && typeof body === "object" && "data" in body ? (body as { data: T }).data : (body as T);
  }

  private allowed(operator: string) {
    return this.operators.has(operator.toUpperCase());
  }

  async getStations(): Promise<UpStation[]> {
    const [stations, hubs] = await Promise.all([this.get<ApiStation[]>("stations"), this.get<ApiHub[]>("hubs")]);
    const hubOf = new Map<string, string>();
    for (const h of hubs ?? []) for (const m of h.members ?? []) if (!hubOf.has(m.id)) hubOf.set(m.id, h.slug);
    return (stations ?? [])
      .filter((s) => this.allowed(s.operator) && (!s.regionCode || this.regions.has(s.regionCode)))
      .map((s) => mapStation(s, hubOf.get(s.id) ?? null));
  }

  async getStation(operator: string, code: string): Promise<UpStation | null> {
    const s = await this.get<ApiStation>(`stations/${encodeURIComponent(operator)}/${encodeURIComponent(code)}`);
    return s ? mapStation(s, null) : null;
  }

  async getFare(from: UpStopRef, to: UpStopRef): Promise<UpFare | null> {
    // Nama parameter waktu keberangkatan belum terdokumentasi pada sampel OpenAPI, jadi tarif dan jadwal
    // memakai waktu sekarang menurut API.
    const f = await this.get<ApiFare>(`fares/${stopParam(from)}/${stopParam(to)}`);
    return f ? mapFare(f) : null;
  }

  async getHubs(): Promise<UpHub[]> {
    const hubs = (await this.get<ApiHub[]>("hubs")) ?? [];
    return hubs
      .map((h) => ({
        // slug dipakai sebagai id karena GUI (indeks posisi peta) mengenal hub dengan slug, mis. "dukuh-atas".
        id: h.slug,
        name: h.name,
        stations: (h.members ?? []).filter((m) => this.allowed(m.operator)).map((m) => ({ operator: m.operator, code: m.code })),
        // Jarak jalan kaki antarstasiun tidak tersedia pada /hubs.
        transfers: [],
      }))
      .filter((h) => h.stations.length > 1);
  }

  private async apiOperators(): Promise<ApiOperator[]> {
    return ((await this.get<ApiOperator[]>("operators")) ?? []).filter((o) => this.allowed(o.code));
  }

  async getOperators(): Promise<UpOperator[]> {
    return (await this.apiOperators()).map((o) => ({ code: o.code, name: o.name, mode: o.mode ?? "RAIL" }));
  }

  async getLines(): Promise<UpLine[]> {
    const ops = await this.apiOperators();
    const metas = ops.flatMap((o) => (o.lines ?? []).filter((l) => l.searchable !== false).map((l) => ({ o, l })));
    // Dibatasi beberapa permintaan sekaligus karena TransJakarta punya banyak lin.
    const lines = await mapLimit(
      metas,
      6,
      async ({ o, l }) => {
        const detail = await this.get<ApiLineDetail>(`lines/${encodeURIComponent(o.code)}/${encodeURIComponent(l.lineCode)}`);
        return {
          operator: o.code,
          code: l.lineCode,
          name: l.name,
          color: l.colorCode,
          mode: l.mode ?? o.mode,
          ...lineStations(o.code, detail),
        } satisfies UpLine;
      },
    );
    return lines;
  }

  async getLine(operator: string, lineCode: string): Promise<UpLine | null> {
    const op = (await this.apiOperators()).find((o) => o.code === operator);
    const meta = op?.lines?.find((l) => l.lineCode === lineCode);
    const detail = await this.get<ApiLineDetail>(`lines/${encodeURIComponent(operator)}/${encodeURIComponent(lineCode)}`);
    if (!detail && !meta) return null;
    return { operator, code: lineCode, name: meta?.name ?? lineCode, color: meta?.colorCode, mode: meta?.mode ?? op?.mode, ...lineStations(operator, detail) };
  }
}

function mapStation(s: ApiStation, hub: string | null): UpStation {
  return {
    operator: s.operator,
    code: s.code,
    name: s.name,
    ...(s.officialName ? { officialName: s.officialName } : {}),
    lines: s.lines ?? [],
    hub,
    // Daftar kosong berarti data fasilitas belum ada (bukan "tidak ada fasilitas").
    amenities: s.amenities?.length ? s.amenities.map((a) => ({ type: a.type, ...(a.text ? { description: a.text } : {}) })) : null,
    score: s.score ?? null,
    lat: s.latitude ?? null,
    lng: s.longitude ?? null,
  };
}

/** Stasiun sebuah lin, urut dari stasiun awal; cabang (loop, ramp) ditambahkan setelah batang utama. */
function lineStations(operator: string, detail: ApiLineDetail | null): Pick<UpLine, "stations" | "stationNumbers" | "segments"> {
  const seen = new Set<string>();
  const stations: UpStopRef[] = [];
  const stationNumbers: (string | null)[] = [];
  const segments: NonNullable<UpLine["segments"]> = [];
  for (const seg of detail?.segments ?? []) {
    const refs: UpStopRef[] = [];
    for (const st of seg.stations ?? []) {
      const ref = st.code ? { operator, code: st.code } : refOfId(st.id);
      refs.push(ref);
      const key = `${ref.operator}:${ref.code}`;
      if (!seen.has(key)) {
        seen.add(key);
        stations.push(ref);
        stationNumbers.push(st.stationNumber || null);
      }
    }
    if (refs.length) segments.push({ stations: refs, ...(seg.joinsAtCode ? { joinsAt: { operator, code: seg.joinsAtCode } } : {}) });
  }
  return { stations, stationNumbers, segments };
}

function mapFare(f: ApiFare): UpFare {
  const segments = [...(f.segments ?? [])];
  const legs: UpLeg[] = f.legs.map((l) => {
    if (l.type === "TRANSFER") {
      return { type: "TRANSFER", stops: [refOfId(l.from.id), refOfId(l.to.id)], stopNames: [l.from.name ?? l.from.id, l.to.name ?? l.to.id], distanceM: l.distanceM, fare: l.fare ?? 0 };
    }
    const [lineOp, lineCode] = l.line.includes(":") ? l.line.split(":", 2) : [l.operator, l.line];
    const stops = l.stops?.length ? l.stops : [l.from, l.to];
    // Tarif ditagih per segmen operator; segmen dibebankan ke leg pertama yang berangkat dari titik awalnya.
    const si = segments.findIndex((s) => s.operator === l.operator && s.from.id === l.from.id);
    const fare = si >= 0 ? (segments.splice(si, 1)[0].fare ?? 0) : 0;
    return {
      type: "RIDE",
      operator: lineOp,
      line: lineCode,
      stops: stops.map((s) => refOfId(s.id)),
      stopNames: stops.map((s) => s.name ?? s.id),
      distanceM: l.distanceM,
      fare,
      departureAt: l.departureAt ?? null,
      arrivalAt: l.arrivalAt ?? null,
    };
  });
  // Segmen yang tidak cocok dengan leg mana pun dibebankan ke leg naik terakhir operator yang sama.
  for (const s of segments) {
    const leg = [...legs].reverse().find((l) => l.type === "RIDE" && l.operator === s.operator);
    if (leg && s.fare) leg.fare = (leg.fare ?? 0) + s.fare;
  }
  const sum = legs.reduce((t, l) => t + (l.fare ?? 0), 0);
  return {
    from: refOfId(f.from.id),
    to: refOfId(f.to.id),
    currency: "IDR",
    totalFare: f.totalFare ?? sum,
    totalDistanceM: f.totalDistanceM,
    legs,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
