// Klien HTTP ke Commute Data API (api.commute.shiorilabs.id). Lisensi data ODbL-1.0: atribusi
// wajib ditampilkan di antarmuka (lihat ATTRIBUTION di GroundingGuard).
//
// Path endpoint mengikuti Subbab 1.4 dan Tabel 3.10. Format parameter {from}/{to} dan bentuk envelope
// respons belum diverifikasi (NTD-03); keduanya diisolasi di stopParam() dan unwrap().

import { UpstreamError } from "../../errors";
import type { CommuteSource, UpFare, UpHub, UpLine, UpOperator, UpStation, UpStopRef } from "./types";

export interface HttpCommuteOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Format identitas pemberhentian pada path /fares/{from}/{to}. Sesuaikan setelah verifikasi NTD-03. */
export function stopParam(ref: UpStopRef): string {
  return encodeURIComponent(`${ref.operator}:${ref.code}`);
}

/** API dapat membungkus data dalam { data: ... } atau { status, data }; keduanya diterima. */
function unwrap<T>(body: unknown): T {
  if (body && typeof body === "object" && "data" in body) return (body as { data: T }).data;
  return body as T;
}

export class HttpCommuteSource implements CommuteSource {
  readonly name = "http";
  private fetchImpl: typeof fetch;

  constructor(private opts: HttpCommuteOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
    if (!res.ok) throw new UpstreamError(`Commute Data API membalas ${res.status} untuk ${url.pathname}`, res.status);
    try {
      return unwrap<T>(await res.json());
    } catch {
      throw new UpstreamError(`Respons Commute Data API bukan JSON yang valid (${url.pathname})`);
    }
  }

  async getStations() {
    return (await this.get<UpStation[]>("stations")) ?? [];
  }

  getStation(operator: string, code: string) {
    return this.get<UpStation>(`stations/${encodeURIComponent(operator)}/${encodeURIComponent(code)}`);
  }

  getFare(from: UpStopRef, to: UpStopRef, at?: string) {
    const q = at ? `?at=${encodeURIComponent(at)}` : "";
    return this.get<UpFare>(`fares/${stopParam(from)}/${stopParam(to)}${q}`);
  }

  async getHubs() {
    return (await this.get<UpHub[]>("hubs")) ?? [];
  }

  async getOperators() {
    return (await this.get<UpOperator[]>("operators")) ?? [];
  }

  async getLines() {
    return (await this.get<UpLine[]>("lines")) ?? [];
  }

  getLine(operator: string, lineCode: string) {
    return this.get<UpLine>(`lines/${encodeURIComponent(operator)}/${encodeURIComponent(lineCode)}`);
  }
}
