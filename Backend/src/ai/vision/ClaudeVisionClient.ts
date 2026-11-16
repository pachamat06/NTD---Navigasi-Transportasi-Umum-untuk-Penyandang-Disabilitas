import Anthropic from "@anthropic-ai/sdk";
import { promptWithSchema, VisionError, type VisionClient, type VisionRequest } from "./VisionClient";

export const DEFAULT_VISION_MODEL = "claude-sonnet-5-5";

/** Model yang menerima `fallbacks: "default"` (cadangan sisi server bila model utama menolak). */
const SERVER_FALLBACK = /^claude-(fable-5-1|mythos-5-1|opus-5|opus-5-5|sonnet-5-5)$/;
/** Model lama yang belum mengenal `output_config.effort`. */
const NO_EFFORT = /claude-(3|haiku-4|sonnet-4-5|opus-4-1|opus-4-0|sonnet-4-0)/;

export class ClaudeVisionClient implements VisionClient {
  readonly name = "claude";
  private client: Anthropic;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; timeoutMs?: number }) {
    this.model = opts.model || DEFAULT_VISION_MODEL;
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl || undefined, timeout: opts.timeoutMs ?? 120_000, maxRetries: 1 });
  }

  readonly model: string;

  async analyze(req: VisionRequest): Promise<string> {
    const fallback = SERVER_FALLBACK.test(this.model);
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        system: req.system,
        // Denah padat simbol: penalaran sedang cukup teliti tanpa biaya dan latensi berlebih. Skema keluaran
        // ditulis di prompt, bukan output_config.format: grammar skema denah melebihi batas structured output.
        ...(NO_EFFORT.test(this.model) ? {} : { output_config: { effort: "medium" as const } }),
        messages: [
          {
            role: "user",
            content: [
              ...req.images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType, data: img.data } })),
              { type: "text" as const, text: promptWithSchema(req.prompt, req.schema) },
            ],
          },
        ],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new VisionError("AI: kunci API Claude tidak valid.", true);
      if (e instanceof Anthropic.PermissionDeniedError) throw new VisionError("AI: kunci API tidak punya akses ke model ini.", true);
      if (e instanceof Anthropic.NotFoundError) throw new VisionError(`AI: model "${this.model}" tidak ditemukan.`, true);
      if (e instanceof Anthropic.RateLimitError) throw new VisionError("AI: batas laju terlampaui, coba lagi sebentar lagi.");
      if (e instanceof Anthropic.BadRequestError) throw new VisionError(`AI: permintaan ditolak (${e.message.slice(0, 500)}).`, true);
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new VisionError("AI: waktu tunggu habis. Coba gambar yang lebih kecil atau naikkan batas waktu.");
      if (e instanceof Anthropic.APIError) throw new VisionError(`AI: galat API ${e.status ?? ""}`.trim());
      throw new VisionError(`AI: ${(e as Error).message}`);
    }
    if (res.stop_reason === "refusal") throw new VisionError("AI: model menolak memproses gambar ini.");
    if (res.stop_reason === "max_tokens") throw new VisionError("AI: jawaban terpotong (batas token). Coba unggah lebih sedikit gambar sekaligus.");
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new VisionError("AI: jawaban kosong.");
    return text;
  }
}
