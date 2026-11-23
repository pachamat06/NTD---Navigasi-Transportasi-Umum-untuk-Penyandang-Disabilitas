// Konfigurasi LLM yang dapat diubah admin tanpa restart: penyedia, model, batas waktu, dan kunci API (terenkripsi di
// server_config). Nilai kosong memakai environment (LLM_*). Kunci tidak pernah dikembalikan ke browser, hanya petunjuk
// empat karakter terakhir. Klien dibuat ulang otomatis saat konfigurasi berubah.

import { z } from "zod";
import type { Config } from "../../config";
import { AppError } from "../../errors";
import type { ServerConfigRepository } from "../../store/types";
import { keyHint, SecretBox } from "../secrets";
import { ClaudeClient, DEFAULT_CLAUDE_MODEL } from "./ClaudeClient";
import { GptClient } from "./GptClient";
import type { LlmClient } from "./LlmClient";

export const LLM_CONFIG_KEY = "ai.llm";
export const LLM_PROVIDERS = ["claude", "gpt", "none"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** Sumber klien LLM bagi agent: selalu membaca konfigurasi terkini. */
export interface LlmSource {
  client(): Promise<LlmClient | null>;
}

interface Stored {
  provider?: LlmProvider;
  model?: string;
  timeoutMs?: number;
  /** Kunci terenkripsi (SecretBox). */
  apiKey?: string;
  apiKeyHint?: string;
  /** Penyedia tempat kunci berlaku; tidak dikirim ke penyedia lain. */
  apiKeyFor?: LlmProvider;
}

export const llmSettingsInput = z.object({
  provider: z.enum(LLM_PROVIDERS).nullable().optional(),
  model: z.string().trim().min(1).max(120).regex(/^[\w.:/@-]+$/, "hanya huruf, angka, dan . : / @ - _").nullable().optional(),
  timeoutMs: z.number().int().min(5_000).max(300_000).nullable().optional(),
  /** Kunci baru. Tidak pernah dikembalikan; kosongkan untuk mempertahankan kunci lama. */
  apiKey: z.string().trim().min(8).max(500).regex(/^\S+$/, "kunci tidak boleh memuat spasi").optional(),
  clearApiKey: z.boolean().optional(),
});
export type LlmSettingsInput = z.infer<typeof llmSettingsInput>;

export interface ResolvedLlm {
  provider: LlmProvider;
  model: string | null;
  timeoutMs: number;
  apiKey?: string;
  keySource: "admin" | "env" | null;
  /** Kunci tersimpan ada tetapi tidak dapat dibaca atau untuk penyedia lain. */
  storedProblem: "unreadable" | "other_provider" | null;
}

export type LlmClientFactory = (r: ResolvedLlm) => LlmClient | null;

export const defaultLlmFactory: LlmClientFactory = (r) => {
  if (r.provider === "none" || !r.apiKey) return null;
  if (r.provider === "claude") return new ClaudeClient(r.apiKey, r.model ?? undefined, r.timeoutMs);
  return r.model ? new GptClient(r.apiKey, r.model, r.timeoutMs) : null;
};

export interface LlmSettingsView {
  provider: LlmProvider;
  model: string | null;
  timeoutMs: number;
  sources: Record<"provider" | "model" | "timeoutMs", "admin" | "env">;
  key: { set: boolean; source: "admin" | "env" | null; hint: string | null; problem: string | null };
  /** Kunci dapat disimpan dari admin (ADMIN_TOKEN_SECRET tersedia). */
  canStoreKey: boolean;
  ready: boolean;
  problem: string | null;
  client: { provider: string; model: string; toolCalling: boolean } | null;
  env: { provider: LlmProvider; model: string | null; timeoutMs: number; keySet: boolean };
  defaults: Record<LlmProvider, { model: string | null }>;
  updatedAt: Date | null;
  updatedBy: string | null;
}

const DEFAULTS: LlmSettingsView["defaults"] = { claude: { model: DEFAULT_CLAUDE_MODEL }, gpt: { model: null }, none: { model: null } };

export class LlmService implements LlmSource {
  private cached?: { sig: string; client: LlmClient | null };

  constructor(
    private env: Config["llm"],
    private repo: ServerConfigRepository,
    private box: SecretBox,
    private opts: { factory?: LlmClientFactory; /** Untuk pengujian: klien tetap, mengabaikan konfigurasi. */ fixed?: LlmClient | null } = {},
  ) {}

  private async stored() {
    return this.repo.get<Stored>(LLM_CONFIG_KEY);
  }

  private resolve(s: Stored | undefined): ResolvedLlm {
    const provider = s?.provider ?? this.env.provider;
    const model = s?.model ?? (provider === this.env.provider ? this.env.model : undefined) ?? (provider === "claude" ? DEFAULT_CLAUDE_MODEL : null);
    const timeoutMs = s?.timeoutMs ?? this.env.timeoutMs;
    let adminKey: string | null = null;
    let storedProblem: ResolvedLlm["storedProblem"] = null;
    if (s?.apiKey) {
      if (s.apiKeyFor !== provider) storedProblem = "other_provider";
      else {
        adminKey = this.box.open(s.apiKey);
        if (!adminKey) storedProblem = "unreadable";
      }
    }
    const envKey = provider === this.env.provider ? this.env.apiKey : undefined;
    const apiKey = adminKey ?? envKey;
    return { provider, model, timeoutMs, apiKey, keySource: adminKey ? "admin" : envKey ? "env" : null, storedProblem };
  }

  async client(): Promise<LlmClient | null> {
    if (this.opts.fixed !== undefined) return this.opts.fixed;
    const r = this.resolve((await this.stored())?.value);
    const sig = JSON.stringify([r.provider, r.model, r.timeoutMs, r.apiKey]);
    if (this.cached?.sig !== sig) this.cached = { sig, client: (this.opts.factory ?? defaultLlmFactory)(r) };
    return this.cached.client;
  }

  async view(): Promise<LlmSettingsView> {
    const entry = await this.stored();
    const s = entry?.value;
    const r = this.resolve(s);
    const client = await this.client();
    const keyProblem = r.storedProblem === "unreadable" ? "Kunci tersimpan tidak dapat dibaca (ADMIN_TOKEN_SECRET berubah?). Isi ulang kunci." : r.storedProblem === "other_provider" ? "Kunci tersimpan untuk penyedia lain dan tidak dipakai. Isi kunci untuk penyedia ini." : null;
    const problem =
      this.opts.fixed !== undefined
        ? this.opts.fixed
          ? null
          : "LLM dimatikan."
        : r.provider === "none"
          ? "LLM dimatikan (penyedia: none)."
          : !r.apiKey
            ? (keyProblem ?? "Kunci API belum diisi.")
            : r.provider === "gpt" && !r.model
              ? "Model wajib diisi untuk penyedia GPT."
              : null;
    return {
      provider: this.opts.fixed ? (this.opts.fixed.name as LlmProvider) : r.provider,
      model: this.opts.fixed ? this.opts.fixed.model : r.model,
      timeoutMs: r.timeoutMs,
      sources: { provider: s?.provider ? "admin" : "env", model: s?.model ? "admin" : "env", timeoutMs: s?.timeoutMs ? "admin" : "env" },
      key: { set: !!r.apiKey, source: r.keySource, hint: r.keySource === "admin" ? (s?.apiKeyHint ?? null) : r.apiKey ? keyHint(r.apiKey) : null, problem: keyProblem },
      canStoreKey: this.box.available,
      ready: problem === null && client !== null,
      problem,
      client: client ? { provider: client.name, model: client.model, toolCalling: typeof client.runTools === "function" } : null,
      env: { provider: this.env.provider, model: this.env.model ?? null, timeoutMs: this.env.timeoutMs, keySet: !!this.env.apiKey },
      defaults: DEFAULTS,
      updatedAt: entry?.updatedAt ?? null,
      updatedBy: entry?.updatedBy ?? null,
    };
  }

  async update(input: LlmSettingsInput, by: string): Promise<LlmSettingsView> {
    const next: Stored = { ...((await this.stored())?.value ?? {}) };
    const apply = <K extends "provider" | "model" | "timeoutMs">(k: K, v: Stored[K] | null | undefined) => {
      if (v === undefined) return;
      if (v === null) delete next[k];
      else next[k] = v;
    };
    apply("provider", input.provider);
    apply("model", input.model);
    apply("timeoutMs", input.timeoutMs);
    if (input.clearApiKey) {
      delete next.apiKey;
      delete next.apiKeyHint;
      delete next.apiKeyFor;
    }
    if (input.apiKey) {
      const provider = this.resolve(next).provider;
      if (provider === "none") throw new AppError("INVALID", "Pilih penyedia (Claude atau GPT) sebelum mengisi kunci.");
      next.apiKey = this.box.seal(input.apiKey);
      next.apiKeyHint = keyHint(input.apiKey);
      next.apiKeyFor = provider;
    }
    await this.repo.put(LLM_CONFIG_KEY, next, by);
    this.cached = undefined;
    return this.view();
  }

  /** Uji koneksi: satu panggilan singkat. Galat dikembalikan sebagai teks (tanpa kunci). */
  async probe(): Promise<{ ok: boolean; ms: number; provider?: string; model?: string; reply?: string; error?: string }> {
    const client = await this.client();
    if (!client) return { ok: false, ms: 0, error: (await this.view()).problem ?? "Klien LLM belum siap." };
    const t = Date.now();
    try {
      const reply = await client.complete({ system: "Anda asisten uji koneksi. Jawab sangat singkat.", prompt: "Balas dengan satu kata: OK", maxTokens: 20 });
      return { ok: true, ms: Date.now() - t, provider: client.name, model: client.model, reply: reply.slice(0, 80) };
    } catch (e) {
      return { ok: false, ms: Date.now() - t, provider: client.name, model: client.model, error: (e as Error).message.slice(0, 300) };
    }
  }
}
