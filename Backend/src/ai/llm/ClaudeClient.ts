import Anthropic from "@anthropic-ai/sdk";
import { LlmError, toolOutput, type LlmClient, type LlmRequest, type LlmToolRequest, type LlmToolResult } from "./LlmClient";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export class ClaudeClient implements LlmClient {
  readonly name = "claude";
  private client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string = DEFAULT_CLAUDE_MODEL,
    timeoutMs = 15000,
    /** Untuk pengujian: fetch pengganti agar tidak memanggil API sungguhan. */
    opts: { fetch?: typeof fetch; baseURL?: string } = {},
  ) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  }

  private async create(params: { system: string; maxTokens: number; messages: Anthropic.Beta.BetaMessageParam[]; tools?: Anthropic.Beta.BetaToolUnion[] }): Promise<Anthropic.Beta.BetaMessage> {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create({
        model: this.model,
        // Bila model utama menolak, server menjalankan ulang pada model cadangan yang sesuai.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        max_tokens: params.maxTokens,
        system: params.system,
        // Notifikasi singkat: penalaran ringan cukup dan menekan biaya serta latensi (Risiko #10).
        output_config: { effort: "low" },
        messages: params.messages,
        ...(params.tools ? { tools: params.tools } : {}),
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new LlmError("LLM: batas laju terlampaui");
      if (e instanceof Anthropic.AuthenticationError) throw new LlmError("LLM: kunci API tidak valid");
      if (e instanceof Anthropic.APIError) {
        // Pesan penyedia (mis. "model: nama-salah") membantu admin memperbaiki konfigurasi; tidak memuat kunci API.
        const detail = (e.error as { error?: { message?: string } } | undefined)?.error?.message;
        throw new LlmError(`LLM: galat API ${e.status ?? ""}${detail ? ` (${detail.slice(0, 160)})` : ""}`.trim());
      }
      throw new LlmError(`LLM: ${(e as Error).message}`);
    }
    if (res.stop_reason === "refusal") throw new LlmError("LLM: permintaan ditolak");
    return res;
  }

  private static text(res: Anthropic.Beta.BetaMessage): string {
    return res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  async complete(req: LlmRequest): Promise<string> {
    const res = await this.create({ system: req.system, maxTokens: req.maxTokens, messages: [{ role: "user", content: req.prompt }] });
    const text = ClaudeClient.text(res);
    if (!text) throw new LlmError("LLM: jawaban kosong");
    return text;
  }

  /** Loop tool-calling manual: model memanggil tool, hasilnya dikembalikan sebagai tool_result, sampai selesai atau batas langkah. */
  async runTools(req: LlmToolRequest): Promise<LlmToolResult> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: req.prompt }];
    const tools = req.tools as unknown as Anthropic.Beta.BetaToolUnion[];
    const calls: LlmToolResult["calls"] = [];
    for (let step = 1; step <= req.maxSteps; step++) {
      const res = await this.create({ system: req.system, maxTokens: req.maxTokens, messages, tools });
      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!uses.length) return { text: ClaudeClient.text(res), steps: step, calls, stopped: false };
      messages.push({ role: "assistant", content: res.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      let stopped = false;
      for (const use of uses) {
        try {
          results.push({ type: "tool_result", tool_use_id: use.id, content: toolOutput(await req.run(use.name, use.input)) });
          calls.push({ name: use.name, ok: true });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: (e as Error).message.slice(0, 500) });
          calls.push({ name: use.name, ok: false });
        }
        if (use.name === req.stopAfter && calls[calls.length - 1].ok) stopped = true;
      }
      if (stopped) return { text: "", steps: step, calls, stopped: true };
      messages.push({ role: "user", content: results });
    }
    return { text: "", steps: req.maxSteps, calls, stopped: false };
  }
}
