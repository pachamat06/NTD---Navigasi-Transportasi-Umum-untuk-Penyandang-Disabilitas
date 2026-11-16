import { promptWithSchema, VisionError, type VisionClient, type VisionRequest } from "./VisionClient";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Penyedia lain lewat endpoint yang kompatibel dengan OpenAI Chat Completions (OpenAI, Gemini, OpenRouter,
 * Ollama/LM Studio lokal, dll.). Model wajib diisi; endpoint default api.openai.com.
 */
export class OpenAiVisionClient implements VisionClient {
  readonly name = "openai";
  readonly model: string;
  private baseUrl: string;

  constructor(private opts: { apiKey?: string; model: string; baseUrl?: string; timeoutMs?: number }) {
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  }

  async analyze(req: VisionRequest): Promise<string> {
    const body = {
      model: this.model,
      max_completion_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        {
          role: "user",
          content: [
            { type: "text", text: req.prompt },
            ...req.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}`, detail: "high" } })),
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: { name: "denah_stasiun", strict: true, schema: req.schema } },
    };
    let res = await this.post(body);
    // Sebagian server kompatibel belum mengenal json_schema (atau menolak skema sebesar ini): ulangi sekali
    // tanpa batasan format, dengan skema ditulis di prompt.
    if (res.status === 400) {
      const { response_format: _drop, messages, ...plain } = body;
      const user = { ...messages[1], content: [{ type: "text", text: promptWithSchema(req.prompt, req.schema) }, ...messages[1].content.slice(1)] };
      res = await this.post({ ...plain, messages: [messages[0], user], max_tokens: req.maxTokens });
    }
    if (res.status === 401 || res.status === 403) throw new VisionError("AI: kunci API ditolak oleh penyedia.", true);
    if (res.status === 404) throw new VisionError(`AI: endpoint atau model "${this.model}" tidak ditemukan.`, true);
    if (res.status === 429) throw new VisionError("AI: batas laju terlampaui, coba lagi sebentar lagi.");
    if (!res.ok) throw new VisionError(`AI: galat API ${res.status}${res.text ? ` (${res.text.slice(0, 200)})` : ""}`, res.status === 400);
    let parsed: { choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[] };
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new VisionError("AI: jawaban penyedia bukan JSON.");
    }
    const choice = parsed.choices?.[0];
    if (choice?.message?.refusal) throw new VisionError("AI: model menolak memproses gambar ini.");
    if (choice?.finish_reason === "length") throw new VisionError("AI: jawaban terpotong (batas token). Coba unggah lebih sedikit gambar sekaligus.");
    const text = choice?.message?.content?.trim();
    if (!text) throw new VisionError("AI: jawaban kosong.");
    return text;
  }

  private async post(body: unknown): Promise<{ ok: boolean; status: number; text: string }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    try {
      const r = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      });
      return { ok: r.ok, status: r.status, text: await r.text() };
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError") throw new VisionError("AI: waktu tunggu habis. Coba gambar yang lebih kecil atau naikkan batas waktu.");
      throw new VisionError(`AI: endpoint tidak dapat dihubungi (${err.message}).`);
    }
  }
}
