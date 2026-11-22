// Sumber postingan akun operator untuk agent pembaca. Antarmuka ini yang di-mock bila akses X belum ada:
//   - XApiPostSource: X API v2 resmi (Bearer Token app-only), berbayar per postingan yang dikembalikan.
//   - FixturePostSource: data dalam memori atau berkas JSON, untuk pengujian dan pengembangan tanpa X.
// Input manual admin tidak lewat sini (lihat ServiceInfoReaderAgent.ingest).

import { readFileSync } from "node:fs";

export interface SourcePost {
  /** Id postingan (angka dalam bentuk string, mis. id X). */
  id: string;
  text: string;
  /** ISO 8601. */
  createdAt: string;
  url: string;
  /** Akun penulis tanpa "@". */
  account: string;
}

export interface FetchQuery {
  /** Akun tanpa "@". */
  handle: string;
  /** Hanya postingan setelah id ini. */
  sinceId?: string;
  /** Id numerik akun bila sudah diketahui (menghindari pencarian ulang yang ditagih). */
  userId?: string;
  maxResults: number;
}

export interface FetchResult {
  /** Terlama dulu. */
  posts: SourcePost[];
  newestId?: string;
  userId?: string;
  /** Sumber daya yang ditagih (untuk anggaran). */
  reads: { posts: number; users: number };
}

export interface PostSource {
  readonly kind: "x" | "fixture";
  fetchNew(q: FetchQuery): Promise<FetchResult>;
}

export type SourceErrorCode = "auth" | "rate" | "credits" | "notfound" | "invalid" | "other";

export class SourceError extends Error {
  constructor(
    message: string,
    readonly code: SourceErrorCode = "other",
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Perbandingan id numerik (id X bisa melebihi 2^53). */
export const idGreater = (a: string, b: string) => {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a > b;
  }
};
const byIdAsc = (a: SourcePost, b: SourcePost) => (a.id === b.id ? 0 : idGreater(a.id, b.id) ? 1 : -1);

export class FixturePostSource implements PostSource {
  readonly kind = "fixture" as const;
  /** Untuk menguji penanganan galat sumber. */
  failWith?: SourceError;
  calls = 0;

  constructor(private posts: SourcePost[] = []) {}

  static fromFile(path: string): FixturePostSource {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error("Berkas fixture harus berupa array postingan.");
    return new FixturePostSource(
      raw.map((p) => {
        const x = p as Partial<SourcePost>;
        if (!x.id || !x.text || !x.createdAt || !x.account) throw new Error("Setiap postingan fixture butuh id, text, createdAt, dan account.");
        return { id: String(x.id), text: String(x.text), createdAt: String(x.createdAt), account: String(x.account).replace(/^@/, ""), url: x.url ?? `https://x.com/${String(x.account).replace(/^@/, "")}/status/${x.id}` };
      }),
    );
  }

  add(...posts: SourcePost[]): this {
    this.posts.push(...posts);
    return this;
  }

  async fetchNew(q: FetchQuery): Promise<FetchResult> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    const mine = this.posts
      .filter((p) => p.account.toLowerCase() === q.handle.toLowerCase() && (!q.sinceId || idGreater(p.id, q.sinceId)))
      .sort(byIdAsc);
    // Seperti X: bila lebih banyak dari max_results, yang terbaru yang dikembalikan.
    const posts = mine.slice(Math.max(0, mine.length - q.maxResults));
    return { posts, newestId: posts.length ? posts[posts.length - 1].id : undefined, userId: q.userId ?? `fixture-${q.handle.toLowerCase()}`, reads: { posts: posts.length, users: 0 } };
  }
}

export interface XApiOptions {
  bearerToken: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Untuk pengujian: fetch pengganti. */
  fetch?: typeof fetch;
}

interface XTimelineBody {
  data?: { id: string; text: string; created_at?: string }[];
  meta?: { newest_id?: string; result_count?: number };
  errors?: { detail?: string; title?: string }[];
}

/**
 * X API v2 resmi. Dua panggilan:
 *  - GET /2/users/by/username/:username (sekali per akun, id disimpan oleh pemanggil; ditagih sebagai baca pengguna);
 *  - GET /2/users/:id/tweets?since_id=… (ditagih per postingan yang dikembalikan; tanpa data baru tidak ditagih).
 * Belum diuji ke X sungguhan; nama parameter bidang mencoba `post.fields` (dokumentasi terkini) lalu `tweet.fields`.
 */
export class XApiPostSource implements PostSource {
  readonly kind = "x" as const;
  private fieldsParam = "post.fields";
  private baseUrl: string;
  private timeoutMs: number;
  private doFetch: typeof fetch;

  constructor(private opts: XApiOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.x.com").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.doFetch = opts.fetch ?? fetch;
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.doFetch(url, { headers: { authorization: `Bearer ${this.opts.bearerToken}`, accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new SourceError(`X API tidak dapat dihubungi: ${(e as Error).message}`);
    }
    if (res.ok) return (await res.json()) as T;
    const body = (await res.json().catch(() => ({}))) as { detail?: string; title?: string; errors?: { message?: string }[] };
    const detail = body.detail ?? body.title ?? body.errors?.[0]?.message ?? "";
    if (res.status === 401 || res.status === 403) throw new SourceError(`Token X ditolak atau tidak punya akses (${res.status}). ${detail}`.trim(), "auth", res.status);
    if (res.status === 402) throw new SourceError(`Kredit X API habis atau pembayaran dibutuhkan (402). ${detail}`.trim(), "credits", res.status);
    if (res.status === 429) {
      const reset = res.headers.get("x-rate-limit-reset");
      throw new SourceError(`Batas laju X API terlampaui (429)${reset ? `; reset ${new Date(Number(reset) * 1000).toISOString()}` : ""}.`, "rate", res.status);
    }
    throw new SourceError(`X API galat ${res.status}. ${detail}`.trim(), res.status === 400 ? "invalid" : "other", res.status);
  }

  async fetchNew(q: FetchQuery): Promise<FetchResult> {
    let userId = q.userId;
    let users = 0;
    if (!userId) {
      const r = await this.get<{ data?: { id: string }; errors?: unknown[] }>(`/2/users/by/username/${encodeURIComponent(q.handle)}`);
      userId = r.data?.id;
      if (!userId) throw new SourceError(`Akun @${q.handle} tidak ditemukan di X.`, "notfound");
      users = 1;
    }
    const base: Record<string, string> = { max_results: String(Math.min(100, Math.max(5, q.maxResults))), exclude: "retweets,replies", ...(q.sinceId ? { since_id: q.sinceId } : {}) };
    const timeline = `/2/users/${userId}/tweets`;
    let body: XTimelineBody;
    try {
      body = await this.get<XTimelineBody>(timeline, { ...base, [this.fieldsParam]: "created_at" });
    } catch (e) {
      // Dokumentasi lama memakai tweet.fields; coba sekali dengan nama itu dan ingat yang berhasil.
      if (!(e instanceof SourceError) || e.code !== "invalid") throw e;
      const other = this.fieldsParam === "post.fields" ? "tweet.fields" : "post.fields";
      body = await this.get<XTimelineBody>(timeline, { ...base, [other]: "created_at" });
      this.fieldsParam = other;
    }
    const posts = (body.data ?? [])
      .map((t): SourcePost => ({ id: t.id, text: t.text, createdAt: t.created_at ?? new Date().toISOString(), url: `https://x.com/${q.handle}/status/${t.id}`, account: q.handle }))
      .sort(byIdAsc)
      .slice(-q.maxResults);
    return { posts, newestId: body.meta?.newest_id ?? (posts.length ? posts[posts.length - 1].id : undefined), userId, reads: { posts: (body.data ?? []).length, users } };
  }
}
