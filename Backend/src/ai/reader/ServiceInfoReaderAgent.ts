// Agent pembaca (agent LLM kedua): membaca postingan akun X operator, mengekstrak informasi layanan (gangguan,
// keterlambatan, penutupan, ...), dan menaruhnya di antrean persetujuan admin sebagai `pending`.
// Batasan keselamatan: teks postingan adalah data tak tepercaya; stasiun/lini dicocokkan deterministik pada teks;
// hasilnya hanya berupa data terstruktur dan tidak mengubah navigasi sebelum admin menyetujui.

import { newContext } from "../../context";
import type { ContentService } from "../../domain/content";
import { AppError } from "../../errors";
import type { StationService } from "../../domain/StationService";
import { ServiceAdvisoryService, type AdvisoryIngest } from "../../domain/serviceAdvisory";
import type { NewServiceAdvisory, ServiceAdvisory } from "../../store/types";
import type { LlmClient } from "../llm/LlmClient";
import type { LlmSource } from "../llm/LlmService";
import { excerpt, EXTRACTION_SYSTEM, extractionPrompt, groundSummary, looksLikeServiceInfo, mentionedIds, nameResolves, parseExtraction, resolveExpiry, type ExtractedItem } from "./extraction";
import type { SourcePost } from "./PostSource";
import type { PostSourceProvider } from "./PostSourceService";
import { ReaderConfigService, X_PRICE_USD, type PollReport } from "./ReaderConfig";

export interface ReaderLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface ReaderDeps {
  /** Sumber postingan (X API atau fixture), dibaca saat dipakai. */
  sources: PostSourceProvider;
  config: ReaderConfigService;
  advisories: ServiceAdvisoryService;
  /** Sumber klien LLM, dibaca saat dipakai. */
  llm: LlmSource;
  stations: StationService;
  content: ContentService;
  log?: ReaderLogger;
  now?: () => Date;
}

interface Entities {
  stations: { name: string; id: string }[];
  lines: { name: string; id: string }[];
}

interface Candidate {
  type: "x" | "manual";
  account: string;
  postId: string | null;
  url: string | null;
  text: string;
  postedAt: string;
}

export class ServiceInfoReaderAgent {
  private running = false;
  private now: () => Date;
  private log: ReaderLogger;

  constructor(private d: ReaderDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? { warn: () => {} };
  }

  /** Mode LLM menyala (pengaturan admin terbit) dan klien LLM tersedia? */
  async llmReady(): Promise<{ ok: boolean; problem?: string }> {
    const snap = await this.d.content.snapshot(newContext({ now: this.now() }));
    if (!snap.settings.llmEnabled) return { ok: false, problem: "Mode LLM dimatikan oleh admin (Pengaturan)." };
    if (!(await this.d.llm.client())) return { ok: false, problem: "Klien LLM belum dikonfigurasi (isi kunci API di Pengaturan admin atau LLM_API_KEY di .env)." };
    return { ok: true };
  }

  /** Alasan pembacaan otomatis belum bisa jalan, atau null bila siap. */
  async problem(): Promise<string | null> {
    const llm = await this.llmReady();
    if (!llm.ok) return llm.problem!;
    if (!(await this.d.sources.source())) return "Sumber postingan belum dikonfigurasi (isi token X di Pengaturan admin, atau SERVICE_INFO_SOURCE di .env).";
    const cfg = await this.d.config.get();
    if (!cfg.enabled) return "Pembacaan otomatis dimatikan di pengaturan pembaca.";
    if (!cfg.accounts.some((a) => a.enabled)) return "Belum ada akun yang diaktifkan untuk dibaca.";
    return null;
  }

  private async entities(): Promise<Entities> {
    const ctx = newContext({ now: this.now() });
    const [stations, lines] = await Promise.all([this.d.stations.list(ctx), this.d.stations.lines(ctx)]);
    return { stations: stations.map((s) => ({ name: s.name, id: s.id })), lines: lines.map((l) => ({ name: l.name, id: l.id })) };
  }

  /** Satu siklus pembacaan semua akun yang aktif. Tidak pernah melempar galat; hasilnya dicatat di status pembaca. */
  async poll(trigger = "manual"): Promise<PollReport> {
    const startedAt = this.now();
    const report: PollReport = { startedAt: startedAt.toISOString(), finishedAt: startedAt.toISOString(), trigger, fetched: 0, duplicates: 0, tooOld: 0, irrelevant: 0, notService: 0, created: 0, errors: [], approxCostUsd: 0 };
    if (this.running) return { ...report, skipped: "Pembacaan sebelumnya masih berjalan." };
    this.running = true;
    try {
      const why = await this.problem();
      const state = await this.d.config.state(startedAt);
      if (why) {
        report.skipped = why;
      } else {
        const cfg = await this.d.config.get();
        const ents = await this.entities();
        const source = (await this.d.sources.source())!;
        const llm = (await this.d.llm.client())!;
        for (const account of cfg.accounts.filter((a) => a.enabled)) {
          const key = account.handle.toLowerCase();
          const remaining = cfg.monthlyPostBudget - state.usage.posts;
          if (remaining < 5) {
            report.errors.push({ account: account.handle, message: "Anggaran pembacaan bulanan tercapai; pembacaan dihentikan sampai bulan berikutnya atau anggaran dinaikkan." });
            break;
          }
          let posts: SourcePost[];
          try {
            const r = await source.fetchNew({ handle: account.handle, sinceId: state.cursors[key], userId: state.userIds[key], maxResults: Math.min(cfg.maxPostsPerAccount, remaining) });
            posts = r.posts;
            state.usage.posts += r.reads.posts;
            state.usage.users += r.reads.users;
            report.approxCostUsd += r.reads.posts * X_PRICE_USD.post + r.reads.users * X_PRICE_USD.user;
            if (r.userId) state.userIds[key] = r.userId;
            if (r.newestId) state.cursors[key] = r.newestId;
          } catch (e) {
            report.errors.push({ account: account.handle, message: (e as Error).message });
            this.log.warn("pembaca: gagal mengambil postingan", { account: account.handle, error: (e as Error).message });
            continue;
          }
          report.fetched += posts.length;
          const fresh: SourcePost[] = [];
          for (const p of posts) {
            if (await this.d.advisories.findBySource("x", account.handle, p.id)) report.duplicates++;
            else if (startedAt.getTime() - Date.parse(p.createdAt) > cfg.maxAgeHours * 3_600_000) report.tooOld++;
            else if (cfg.keywordFilter && !looksLikeServiceInfo(p.text)) report.irrelevant++;
            else fresh.push(p);
          }
          if (fresh.length) await this.extractBatch(llm, account.handle, account.operator, fresh, ents, report);
        }
        report.approxCostUsd = Math.round(report.approxCostUsd * 1000) / 1000;
      }
      report.finishedAt = this.now().toISOString();
      await this.d.config.saveState({ ...state, lastPoll: report });
      return report;
    } finally {
      this.running = false;
    }
  }

  private async extractBatch(llm: LlmClient, account: string, operator: string, posts: SourcePost[], ents: Entities, report: PollReport): Promise<void> {
    const now = this.now();
    let items: ExtractedItem[] = [];
    try {
      const raw = await llm.complete({
        system: EXTRACTION_SYSTEM,
        prompt: extractionPrompt(posts.map((p, i) => ({ ref: i + 1, waktu: p.createdAt, teks: p.text.slice(0, 1000) })), account, operator, now),
        maxTokens: 1200 + 300 * posts.length,
      });
      items = parseExtraction(raw);
    } catch (e) {
      // Ekstraksi gagal: postingan tetap masuk antrean dengan ringkasan cadangan (info saja) agar tidak hilang.
      report.errors.push({ account, message: `Ekstraksi LLM gagal (${(e as Error).message}); memakai ringkasan cadangan.` });
      this.log.warn("pembaca: ekstraksi LLM gagal", { account, error: (e as Error).message });
    }
    for (const [i, p] of posts.entries()) {
      const item = items.find((x) => x.ref === i + 1) ?? null;
      if (item && !item.relevan) {
        report.notService++;
        continue;
      }
      const adv = this.build({ type: "x", account, postId: p.id, url: p.url, text: p.text, postedAt: new Date(p.createdAt).toISOString() }, operator, item, ents, "llm", llm.model);
      if (Date.parse(adv.expiresAt) <= now.getTime()) {
        report.tooOld++;
        continue;
      }
      try {
        await this.d.advisories.create(adv);
        report.created++;
      } catch (e) {
        report.duplicates++;
        this.log.warn("pembaca: gagal menyimpan", { account, postId: p.id, error: (e as Error).message });
      }
    }
  }

  /** Menyusun isian informasi. Stasiun dan lini selalu dari pencocokan deterministik pada teks postingan. */
  private build(c: Candidate, operator: string | null, item: ExtractedItem | null, ents: Entities, by: "llm" | "manual", model?: string): Omit<NewServiceAdvisory, "status" | "reviewedBy" | "reviewedAt" | "reviewNote"> {
    const stationIds = mentionedIds(c.text, ents.stations);
    const lineIds = mentionedIds(c.text, ents.lines);
    const category = item?.kategori ?? "lainnya";
    // "Kembali normal" tidak pernah mengubah navigasi.
    const impact = item && category !== "normal" ? item.dampak : "info";
    const grounded = item ? groundSummary(item.ringkasan, c.text) : null;
    const unmatched = item ? [...item.stasiun.filter((n) => !nameResolves(n, c.text, ents.stations)), ...item.lini.filter((n) => !nameResolves(n, c.text, ents.lines))] : [];
    return {
      source: { type: c.type, account: c.account, postId: c.postId, url: c.url, postedAt: c.postedAt, text: c.text.slice(0, 600) },
      operator,
      category,
      impact,
      summary: grounded ?? excerpt(c.text),
      stationIds,
      lineIds,
      validFrom: null,
      expiresAt: resolveExpiry(item?.berlakuSampai ?? null, c.postedAt, impact),
      extraction: {
        by: item && grounded ? "llm" : item || by === "llm" ? "fallback" : "manual",
        ...(item && model ? { model } : {}),
        ...(item ? { confidence: item.keyakinan, proposedImpact: item.dampak } : {}),
        ...(unmatched.length ? { unmatched } : {}),
      },
    };
  }

  /**
   * Input manual admin: menempel teks postingan (mis. bila akses X belum ada). Lewat jalur yang sama sampai antrean
   * persetujuan. Memakai LLM bila tersedia; selain itu dampak `info` dan admin melengkapi isian saat menyetujui.
   */
  async ingest(input: AdvisoryIngest): Promise<ServiceAdvisory> {
    const now = this.now();
    const account = input.account?.replace(/^@/, "") ?? "manual";
    const postedAt = new Date(input.postedAt ?? now).toISOString();
    if (input.postId && (await this.d.advisories.findBySource("manual", account, input.postId))) throw new AppError("CONFLICT", "Postingan ini sudah ada di antrean.");
    const ents = await this.entities();
    let item: ExtractedItem | null = null;
    const llm = (await this.llmReady()).ok ? await this.d.llm.client() : null;
    if (llm) {
      try {
        const raw = await llm.complete({ system: EXTRACTION_SYSTEM, prompt: extractionPrompt([{ ref: 1, waktu: postedAt, teks: input.text.slice(0, 1000) }], account, input.operator ?? "-", now), maxTokens: 1500 });
        item = parseExtraction(raw).find((x) => x.ref === 1) ?? null;
      } catch (e) {
        this.log.warn("pembaca: ekstraksi manual gagal", { error: (e as Error).message });
      }
    }
    // Admin sengaja menempelkan teks ini: tetap masuk antrean walau LLM menilainya bukan informasi layanan.
    const adv = this.build({ type: "manual", account, postId: input.postId ?? null, url: input.url ?? null, text: input.text, postedAt }, input.operator ?? null, item?.relevan ? item : null, ents, "manual", llm?.model);
    if (Date.parse(adv.expiresAt) <= now.getTime()) throw new AppError("INVALID", "Masa berlaku bawaan postingan ini sudah lewat; isi postedAt dengan waktu yang lebih baru.");
    return this.d.advisories.create(adv);
  }
}
