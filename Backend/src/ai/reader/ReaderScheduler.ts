// Penjadwal pembacaan berkala. Interval dibaca dari pengaturan admin pada setiap siklus. Hanya dijalankan oleh
// index.ts (bukan saat pengujian). Satu instance server saja yang dianggap menjalankannya (cukup untuk Render/Railway).

import type { ReaderConfigService } from "./ReaderConfig";
import type { ServiceInfoReaderAgent } from "./ServiceInfoReaderAgent";

export class ReaderScheduler {
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private lastSkip?: string;

  constructor(
    private agent: ServiceInfoReaderAgent,
    private config: ReaderConfigService,
    private log: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void },
    /** Jeda sebelum siklus pertama setelah server menyala. */
    private firstDelayMs = 30_000,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.firstDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const r = await this.agent.poll("jadwal");
      // Alasan dilewati hanya dicatat saat berubah agar log tidak penuh pengulangan.
      if (r.skipped) {
        if (r.skipped !== this.lastSkip) this.log.info("pembaca dilewati", { alasan: r.skipped });
        this.lastSkip = r.skipped;
      } else {
        this.lastSkip = undefined;
        this.log.info("pembaca selesai", { ambil: r.fetched, dibuat: r.created, galat: r.errors.length, biayaPerkiraanUsd: r.approxCostUsd });
      }
    } catch (e) {
      this.log.warn("pembaca gagal", { error: (e as Error).message });
    }
    const minutes = await this.config.get().then((c) => c.intervalMinutes).catch(() => 15);
    if (!this.stopped) this.schedule(Math.max(5, minutes) * 60_000);
  }
}
