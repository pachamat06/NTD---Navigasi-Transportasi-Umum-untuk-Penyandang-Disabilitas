// Abstraksi LLM (Tabel 3.4 no. 10): penyedia dan model dapat diganti tanpa mengubah NavigationAgent.

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface LlmClient {
  readonly name: string;
  readonly model: string;
  /** Mengembalikan teks jawaban. Melempar galat bila gagal, timeout, atau permintaan ditolak. */
  complete(req: LlmRequest): Promise<string>;
}

export class LlmError extends Error {}
