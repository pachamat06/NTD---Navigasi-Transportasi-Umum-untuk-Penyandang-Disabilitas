// Konfigurasi agent pembaca yang diatur admin (akun yang dibaca, interval, anggaran) dan status pembacaan terakhir.
// Disimpan di server_config (di luar alur draft/publikasi). Token X hanya dari environment, tidak pernah lewat API.

import { z } from "zod";
import type { ServerConfigRepository } from "../../store/types";

export const READER_CONFIG_KEY = "ai.reader";
export const READER_STATE_KEY = "ai.reader.state";

/** Perkiraan harga X API pay-per-use (US$ per sumber daya yang dikembalikan); periksa console.x.com untuk tarif terkini. */
export const X_PRICE_USD = { post: 0.005, user: 0.01 };

const handle = z
  .string()
  .trim()
  .transform((h) => h.replace(/^@/, ""))
  .pipe(z.string().regex(/^[A-Za-z0-9_]{1,15}$/, "nama akun X: huruf, angka, garis bawah, maksimal 15 karakter"));

export const readerAccountSchema = z.object({
  handle,
  /** Nama operator, dicocokkan dengan operator lini bila informasi tidak menyebut stasiun/lini. */
  operator: z.string().trim().min(1).max(80),
  label: z.string().trim().max(80).optional(),
  enabled: z.boolean().default(true),
});
export type ReaderAccount = z.infer<typeof readerAccountSchema>;

const uniqueHandles = (accounts: { handle: string }[]) => new Set(accounts.map((a) => a.handle.toLowerCase())).size === accounts.length;

export const readerConfigInput = z.object({
  enabled: z.boolean().optional(),
  accounts: z.array(readerAccountSchema).max(20).refine(uniqueHandles, "akun tidak boleh dobel").optional(),
  intervalMinutes: z.number().int().min(5).max(240).optional(),
  maxPostsPerAccount: z.number().int().min(5).max(100).optional(),
  /** Postingan lebih tua dari ini (jam) dilewati, agar pembacaan pertama tidak memasukkan kabar lama. */
  maxAgeHours: z.number().int().min(1).max(72).optional(),
  /** Anggaran pembacaan postingan per bulan (kalender UTC); pembacaan berhenti bila tercapai. */
  monthlyPostBudget: z.number().int().min(0).max(100_000).optional(),
  /** Saring kata kunci layanan sebelum LLM (hemat biaya). */
  keywordFilter: z.boolean().optional(),
});
export type ReaderConfigInput = z.infer<typeof readerConfigInput>;

export interface ReaderConfig {
  /** Pembacaan otomatis. Bawaan mati agar tidak ada biaya X API tanpa disengaja. */
  enabled: boolean;
  accounts: ReaderAccount[];
  intervalMinutes: number;
  maxPostsPerAccount: number;
  maxAgeHours: number;
  monthlyPostBudget: number;
  keywordFilter: boolean;
}

export const DEFAULT_READER_CONFIG: ReaderConfig = {
  enabled: false,
  accounts: [],
  intervalMinutes: 15,
  maxPostsPerAccount: 10,
  maxAgeHours: 12,
  monthlyPostBudget: 3000,
  keywordFilter: true,
};

export interface PollReport {
  startedAt: string;
  finishedAt: string;
  trigger: string;
  /** Alasan pembacaan dilewati seluruhnya. */
  skipped?: string;
  fetched: number;
  duplicates: number;
  tooOld: number;
  irrelevant: number;
  /** Dinilai LLM tidak terkait layanan. */
  notService: number;
  created: number;
  errors: { account?: string; message: string }[];
  /** Perkiraan biaya X API pembacaan ini (US$). */
  approxCostUsd: number;
}

export interface ReaderState {
  /** Id postingan terbaru yang sudah diproses per akun (huruf kecil). */
  cursors: Record<string, string>;
  userIds: Record<string, string>;
  usage: { month: string; posts: number; users: number };
  lastPoll: PollReport | null;
}

export const monthKey = (d: Date) => d.toISOString().slice(0, 7);
export const emptyState = (now: Date): ReaderState => ({ cursors: {}, userIds: {}, usage: { month: monthKey(now), posts: 0, users: 0 }, lastPoll: null });

export class ReaderConfigService {
  constructor(private repo: ServerConfigRepository) {}

  async get(): Promise<ReaderConfig> {
    const e = await this.repo.get<Partial<ReaderConfig>>(READER_CONFIG_KEY);
    return { ...DEFAULT_READER_CONFIG, ...(e?.value ?? {}) };
  }

  async update(input: ReaderConfigInput, by: string): Promise<ReaderConfig> {
    const next: ReaderConfig = { ...(await this.get()) };
    for (const [k, v] of Object.entries(input)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    await this.repo.put(READER_CONFIG_KEY, next, by);
    return next;
  }

  async state(now = new Date()): Promise<ReaderState> {
    const e = await this.repo.get<ReaderState>(READER_STATE_KEY);
    const s = e?.value ?? emptyState(now);
    // Pemakaian direset tiap bulan baru.
    return s.usage.month === monthKey(now) ? s : { ...s, usage: { month: monthKey(now), posts: 0, users: 0 } };
  }

  async saveState(state: ReaderState): Promise<void> {
    await this.repo.put(READER_STATE_KEY, state, "pembaca");
  }
}
