import Anthropic from "@anthropic-ai/sdk";
import { LlmError, type LlmClient, type LlmRequest } from "./LlmClient";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export class ClaudeClient implements LlmClient {
  readonly name = "claude";
  private client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string = DEFAULT_CLAUDE_MODEL,
    timeoutMs = 15000,
  ) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
  }

  async complete(req: LlmRequest): Promise<string> {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create({
        model: this.model,
        // Bila model utama menolak, server menjalankan ulang pada model cadangan yang sesuai.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        max_tokens: req.maxTokens,
        system: req.system,
        // Notifikasi singkat: penalaran ringan cukup dan menekan biaya serta latensi (Risiko #10).
        output_config: { effort: "low" },
        messages: [{ role: "user", content: req.prompt }],
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new LlmError("LLM: batas laju terlampaui");
      if (e instanceof Anthropic.AuthenticationError) throw new LlmError("LLM: kunci API tidak valid");
      if (e instanceof Anthropic.APIError) throw new LlmError(`LLM: galat API ${e.status ?? ""}`.trim());
      throw new LlmError(`LLM: ${(e as Error).message}`);
    }
    if (res.stop_reason === "refusal") throw new LlmError("LLM: permintaan ditolak");
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new LlmError("LLM: jawaban kosong");
    return text;
  }
}
