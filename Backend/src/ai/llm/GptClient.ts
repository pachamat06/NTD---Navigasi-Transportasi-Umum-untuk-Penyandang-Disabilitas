import { LlmError, type LlmClient, type LlmRequest } from "./LlmClient";

/** Realisasi kedua LlmClient (Gambar 3.5) lewat endpoint Chat Completions. Model wajib diisi via LLM_MODEL. */
export class GptClient implements LlmClient {
  readonly name = "gpt";

  constructor(
    private apiKey: string,
    readonly model: string,
    private timeoutMs = 15000,
    private baseUrl = "https://api.openai.com/v1",
  ) {}

  async complete(req: LlmRequest): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_completion_tokens: req.maxTokens,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new LlmError(`LLM: ${(e as Error).message}`);
    }
    if (!res.ok) throw new LlmError(`LLM: galat API ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new LlmError("LLM: jawaban kosong");
    return text;
  }
}
