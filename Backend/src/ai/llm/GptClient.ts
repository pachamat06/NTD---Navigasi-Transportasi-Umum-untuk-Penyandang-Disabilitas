import { LlmError, toolOutput, type LlmClient, type LlmRequest, type LlmToolRequest, type LlmToolResult } from "./LlmClient";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** Realisasi kedua LlmClient (Gambar 3.5) lewat endpoint Chat Completions. Model wajib diisi via LLM_MODEL. */
export class GptClient implements LlmClient {
  readonly name = "gpt";

  constructor(
    private apiKey: string,
    readonly model: string,
    private timeoutMs = 15000,
    private baseUrl = "https://api.openai.com/v1",
  ) {}

  private async chat(body: Record<string, unknown>): Promise<{ message: ChatMessage }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, ...body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new LlmError(`LLM: ${(e as Error).message}`);
    }
    if (!res.ok) throw new LlmError(`LLM: galat API ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: ChatMessage }[] };
    const message = json.choices?.[0]?.message;
    if (!message) throw new LlmError("LLM: jawaban kosong");
    return { message };
  }

  async complete(req: LlmRequest): Promise<string> {
    const { message } = await this.chat({
      max_completion_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    });
    const text = message.content?.trim();
    if (!text) throw new LlmError("LLM: jawaban kosong");
    return text;
  }

  /** Loop tool-calling lewat `tools` Chat Completions; hasil tool dikirim kembali sebagai pesan `tool`. */
  async runTools(req: LlmToolRequest): Promise<LlmToolResult> {
    const messages: ChatMessage[] = [
      { role: "system", content: req.system },
      { role: "user", content: req.prompt },
    ];
    const tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    const calls: LlmToolResult["calls"] = [];
    for (let step = 1; step <= req.maxSteps; step++) {
      const { message } = await this.chat({ max_completion_tokens: req.maxTokens, messages, tools, tool_choice: "auto" });
      if (!message.tool_calls?.length) return { text: message.content?.trim() ?? "", steps: step, calls, stopped: false };
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
      let stopped = false;
      for (const call of message.tool_calls) {
        let content: string;
        let ok = true;
        try {
          const input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          content = toolOutput(await req.run(call.function.name, input));
        } catch (e) {
          ok = false;
          content = `galat: ${(e as Error).message.slice(0, 500)}`;
        }
        calls.push({ name: call.function.name, ok });
        messages.push({ role: "tool", tool_call_id: call.id, content });
        if (ok && call.function.name === req.stopAfter) stopped = true;
      }
      if (stopped) return { text: "", steps: step, calls, stopped: true };
    }
    return { text: "", steps: req.maxSteps, calls, stopped: false };
  }
}
