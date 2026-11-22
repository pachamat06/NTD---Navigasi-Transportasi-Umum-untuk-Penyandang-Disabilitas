// Pemilihan pipeline: "default" (algoritma deterministik + template, tanpa LLM) atau "llm" (agent navigasi LLM + narasi LLM).
// Sakelar induk adalah pengaturan admin `llmEnabled`; pengguna hanya dapat memilih bila sakelar menyala dan klien LLM ada.

import type { LlmClient } from "./llm/LlmClient";

export type PipelineChoice = "default" | "llm";

export interface PipelineAvailability {
  /** Pilihan LLM tersedia untuk pengguna. */
  available: boolean;
  pipelines: PipelineChoice[];
  defaultPipeline: PipelineChoice;
  /** Alasan bila tidak tersedia. */
  reason?: string;
}

export function llmAvailability(llmEnabled: boolean, llm: LlmClient | null): PipelineAvailability {
  if (!llmEnabled) return { available: false, pipelines: ["default"], defaultPipeline: "default", reason: "Mode LLM dimatikan oleh admin." };
  if (!llm) return { available: false, pipelines: ["default"], defaultPipeline: "default", reason: "LLM belum dikonfigurasi di server." };
  return { available: true, pipelines: ["default", "llm"], defaultPipeline: "default" };
}

/** Pipeline yang benar-benar dipakai untuk satu permintaan, beserta alasan bila permintaan LLM harus turun ke default. */
export function resolvePipeline(opts: { requested?: PipelineChoice; llmEnabled: boolean; llm: LlmClient | null; skipLlm?: boolean }): { use: PipelineChoice; reason?: string } {
  if ((opts.requested ?? "default") !== "llm") return { use: "default" };
  if (opts.skipLlm) return { use: "default", reason: "Uji coba otomatis tidak memakai LLM." };
  const a = llmAvailability(opts.llmEnabled, opts.llm);
  return a.available ? { use: "llm" } : { use: "default", reason: `${a.reason} Memakai pipeline default.` };
}
