// Abstraksi LLM (Tabel 3.4 no. 10): penyedia dan model dapat diganti tanpa mengubah NavigationAgent.

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

/** Definisi satu tool (JSON Schema) yang boleh dipanggil LLM pada `runTools`. */
export interface LlmToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties?: boolean };
}

export interface LlmToolRequest {
  system: string;
  prompt: string;
  tools: LlmToolSpec[];
  maxTokens: number;
  /** Batas jumlah putaran panggilan ke model (satu putaran = satu jawaban model, boleh memanggil beberapa tool). */
  maxSteps: number;
  /** Menjalankan satu tool. Galat yang dilempar dikembalikan ke model sebagai hasil tool berstatus galat. */
  run(name: string, input: unknown): Promise<unknown>;
  /** Loop berhenti sesudah tool ini dipanggil (mis. `pilih_rute`). */
  stopAfter?: string;
}

export interface LlmToolResult {
  /** Teks jawaban akhir model (kosong bila berhenti karena `stopAfter` atau batas langkah). */
  text: string;
  /** Jumlah putaran ke model. */
  steps: number;
  calls: { name: string; ok: boolean }[];
  /** true bila loop berhenti karena `stopAfter` dipanggil. */
  stopped: boolean;
}

export interface LlmClient {
  readonly name: string;
  readonly model: string;
  /** Mengembalikan teks jawaban. Melempar galat bila gagal, timeout, atau permintaan ditolak. */
  complete(req: LlmRequest): Promise<string>;
  /**
   * Loop tool-calling untuk agent (opsional: klien tanpa metode ini tidak dapat menjalankan agent navigasi LLM dan
   * pipeline LLM jatuh ke pemilihan rute default). Melempar galat bila gagal.
   */
  runTools?(req: LlmToolRequest): Promise<LlmToolResult>;
}

export class LlmError extends Error {}

/** Hasil tool dikirim ke model sebagai teks; dipotong agar satu hasil tidak menghabiskan konteks. */
export function toolOutput(value: unknown, max = 12_000): string {
  const text = JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max)}…(dipotong)` : text;
}
