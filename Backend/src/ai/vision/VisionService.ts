// Penyedia AI pembaca denah: konfigurasi (environment + timpaan admin) dan pemanggilan analisis.
// Kunci API hanya hidup di backend: tidak pernah dikembalikan ke browser, hanya petunjuk 4 karakter terakhir.

import { z } from "zod";
import type { Config, VisionProvider } from "../../config";
import { VISION_PROVIDERS } from "../../config";
import type { ServerConfigRepository } from "../../store/types";
import { ClaudeVisionClient, DEFAULT_VISION_MODEL } from "./ClaudeVisionClient";
import { DEFAULT_OPENAI_BASE_URL, OpenAiVisionClient } from "./OpenAiVisionClient";
import type { VisionClient } from "./VisionClient";

export const VISION_CONFIG_KEY = "ai.vision";

/** Nilai yang disimpan admin. Field kosong/null berarti memakai nilai environment. */
interface StoredVision {
  provider?: VisionProvider;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  apiKey?: string;
  /** Penyedia dan endpoint tempat kunci di atas berlaku. Kunci tidak dikirim ke penyedia/endpoint lain. */
  apiKeyFor?: { provider: VisionProvider; baseUrl: string | null };
}

const urlSchema = z
  .string()
  .trim()
  .max(300)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "harus diawali http:// atau https://");

export const visionSettingsInput = z.object({
  provider: z.enum(VISION_PROVIDERS).nullable().optional(),
  model: z.string().trim().min(1).max(120).regex(/^[\w.:/@-]+$/, "hanya huruf, angka, dan . : / @ - _").nullable().optional(),
  baseUrl: urlSchema.nullable().optional(),
  timeoutMs: z.number().int().min(10_000).max(600_000).nullable().optional(),
  /** Kunci baru. Tidak pernah dikembalikan; kosongkan field untuk mempertahankan kunci lama. */
  apiKey: z.string().trim().min(8).max(500).optional(),
  clearApiKey: z.boolean().optional(),
});
export type VisionSettingsInput = z.infer<typeof visionSettingsInput>;

export interface ResolvedVision {
  provider: VisionProvider;
  model: string | null;
  baseUrl: string | null;
  timeoutMs: number;
  apiKey?: string;
  keySource: "admin" | "env" | null;
}

export interface VisionSettingsView {
  provider: VisionProvider;
  model: string | null;
  baseUrl: string | null;
  timeoutMs: number;
  /** Nilai yang tampil diambil dari pengaturan admin atau dari environment server. */
  sources: Record<"provider" | "model" | "baseUrl" | "timeoutMs", "admin" | "env">;
  key: { set: boolean; source: "admin" | "env" | null; hint: string | null; storedForOtherProvider: boolean };
  ready: boolean;
  problem: string | null;
  env: { provider: VisionProvider; model: string | null; baseUrl: string | null; timeoutMs: number; keySet: boolean };
  defaults: Record<VisionProvider, { model: string | null; baseUrl: string | null }>;
  updatedAt: Date | null;
  updatedBy: string | null;
}

const DEFAULTS: VisionSettingsView["defaults"] = {
  claude: { model: DEFAULT_VISION_MODEL, baseUrl: "https://api.anthropic.com" },
  openai: { model: null, baseUrl: DEFAULT_OPENAI_BASE_URL },
  none: { model: null, baseUrl: null },
};

const hint = (k?: string) => (k ? `…${k.slice(-4)}` : null);

export type VisionClientFactory = (r: ResolvedVision) => VisionClient | null;

export const defaultVisionFactory: VisionClientFactory = (r) => {
  if (r.provider === "none") return null;
  if (r.provider === "claude") return r.apiKey ? new ClaudeVisionClient({ apiKey: r.apiKey, model: r.model ?? undefined, baseUrl: r.baseUrl ?? undefined, timeoutMs: r.timeoutMs }) : null;
  if (!r.model) return null;
  // Endpoint OpenAI resmi wajib berkunci; endpoint lain (mis. server lokal) boleh tanpa kunci.
  if (!r.apiKey && (!r.baseUrl || r.baseUrl.replace(/\/+$/, "") === DEFAULT_OPENAI_BASE_URL)) return null;
  return new OpenAiVisionClient({ apiKey: r.apiKey, model: r.model, baseUrl: r.baseUrl ?? undefined, timeoutMs: r.timeoutMs });
};

export class VisionService {
  private cached?: { sig: string; client: VisionClient | null };

  constructor(
    private env: Config["vision"],
    private repo: ServerConfigRepository,
    private factory: VisionClientFactory = defaultVisionFactory,
  ) {}

  private async stored() {
    return this.repo.get<StoredVision>(VISION_CONFIG_KEY);
  }

  private resolve(s: StoredVision | undefined): ResolvedVision & { storedForOther: boolean } {
    const provider = s?.provider ?? this.env.provider;
    const baseUrl = s?.baseUrl ?? (provider === this.env.provider ? this.env.baseUrl : undefined) ?? null;
    const model = s?.model ?? (provider === this.env.provider ? this.env.model : undefined) ?? (provider === "claude" ? DEFAULT_VISION_MODEL : null);
    const timeoutMs = s?.timeoutMs ?? this.env.timeoutMs;
    // Kunci hanya dipakai pada penyedia dan endpoint tempat ia dikonfigurasi.
    const adminKeyOk = !!s?.apiKey && s.apiKeyFor?.provider === provider && (s.apiKeyFor.baseUrl ?? null) === baseUrl;
    const envKeyOk = !!this.env.apiKey && provider === this.env.provider && (this.env.baseUrl ?? null) === baseUrl;
    const apiKey = adminKeyOk ? s!.apiKey : envKeyOk ? this.env.apiKey : undefined;
    return { provider, model, baseUrl, timeoutMs, apiKey, keySource: adminKeyOk ? "admin" : envKeyOk ? "env" : null, storedForOther: !!s?.apiKey && !adminKeyOk };
  }

  async view(): Promise<VisionSettingsView> {
    const entry = await this.stored();
    const s = entry?.value;
    const r = this.resolve(s);
    const problem =
      r.provider === "none"
        ? "Penyedia AI dimatikan."
        : r.provider === "claude" && !r.apiKey
          ? "Kunci API Claude belum diisi."
          : r.provider === "openai" && !r.model
            ? "Model wajib diisi untuk penyedia kompatibel OpenAI."
            : r.provider === "openai" && !r.apiKey && (!r.baseUrl || r.baseUrl.replace(/\/+$/, "") === DEFAULT_OPENAI_BASE_URL)
              ? "Kunci API wajib diisi untuk endpoint OpenAI."
              : null;
    return {
      provider: r.provider,
      model: r.model,
      baseUrl: r.baseUrl,
      timeoutMs: r.timeoutMs,
      sources: {
        provider: s?.provider ? "admin" : "env",
        model: s?.model ? "admin" : "env",
        baseUrl: s?.baseUrl ? "admin" : "env",
        timeoutMs: s?.timeoutMs ? "admin" : "env",
      },
      key: { set: !!r.apiKey, source: r.keySource, hint: hint(r.apiKey), storedForOtherProvider: r.storedForOther },
      ready: problem === null,
      problem,
      env: { provider: this.env.provider, model: this.env.model ?? null, baseUrl: this.env.baseUrl ?? null, timeoutMs: this.env.timeoutMs, keySet: !!this.env.apiKey },
      defaults: DEFAULTS,
      updatedAt: entry?.updatedAt ?? null,
      updatedBy: entry?.updatedBy ?? null,
    };
  }

  async update(input: VisionSettingsInput, by: string): Promise<VisionSettingsView> {
    const prev = (await this.stored())?.value ?? {};
    const next: StoredVision = { ...prev };
    const apply = <K extends "provider" | "model" | "baseUrl" | "timeoutMs">(k: K, v: StoredVision[K] | null | undefined) => {
      if (v === undefined) return;
      if (v === null) delete next[k];
      else next[k] = v;
    };
    apply("provider", input.provider);
    apply("model", input.model);
    apply("baseUrl", input.baseUrl?.replace(/\/+$/, "") ?? input.baseUrl);
    apply("timeoutMs", input.timeoutMs);
    const r = this.resolve(next);
    if (input.clearApiKey) {
      delete next.apiKey;
      delete next.apiKeyFor;
    }
    if (input.apiKey) {
      next.apiKey = input.apiKey;
      next.apiKeyFor = { provider: r.provider, baseUrl: r.baseUrl };
    }
    await this.repo.put(VISION_CONFIG_KEY, next, by);
    this.cached = undefined;
    return this.view();
  }

  /** Klien untuk konfigurasi yang berlaku saat ini; null bila belum siap (lihat `view().problem`). */
  async client(): Promise<VisionClient | null> {
    const r = this.resolve((await this.stored())?.value);
    const sig = JSON.stringify([r.provider, r.model, r.baseUrl, r.timeoutMs, r.apiKey]);
    if (this.cached?.sig !== sig) this.cached = { sig, client: this.factory(r) };
    return this.cached.client;
  }
}
