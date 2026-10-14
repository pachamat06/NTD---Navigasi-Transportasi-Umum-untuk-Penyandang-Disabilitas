/**
 * Konteks per permintaan. Diteruskan ke seluruh layanan agar:
 * - mode pratinjau (data draf dari admin) hanya aktif untuk admin yang terautentikasi;
 * - pemakaian data cache kedaluwarsa (Commute Data API tidak dapat dihubungi, UC-01 E2) tercatat.
 */
export interface RequestContext {
  preview: boolean;
  /** Waktu simpan data cache tertua yang terpaksa dipakai karena API tidak dapat dihubungi. */
  staleSince?: Date;
  now: Date;
  /** TTL cache data Commute Data API dari pengaturan admin. */
  cacheTtlSeconds?: number;
  /** Lewati LLM dan pakai template (uji coba otomatis). */
  skipLlm?: boolean;
}

export function newContext(opts: { preview?: boolean; now?: Date } = {}): RequestContext {
  return { preview: opts.preview ?? false, now: opts.now ?? new Date() };
}

export function markStale(ctx: RequestContext, storedAt: Date): void {
  if (!ctx.staleSince || storedAt < ctx.staleSince) ctx.staleSince = storedAt;
}
