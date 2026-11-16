// Abstraksi model AI yang bisa membaca gambar (denah stasiun). Penyedia diganti lewat konfigurasi tanpa
// mengubah FloorPlanAnalyzer: Claude (bawaan) atau endpoint yang kompatibel dengan OpenAI Chat Completions.

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface VisionImage {
  mediaType: ImageMediaType;
  /** Isi gambar dalam base64 tanpa awalan data URL. */
  data: string;
}

export interface VisionRequest {
  system: string;
  prompt: string;
  images: VisionImage[];
  /** JSON Schema keluaran; penyedia yang mendukung structured output memakainya untuk membatasi jawaban. */
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface VisionClient {
  readonly name: string;
  readonly model: string;
  /** Mengembalikan teks jawaban (diharapkan JSON). Melempar VisionError bila gagal. */
  analyze(req: VisionRequest): Promise<string>;
}

/**
 * Prompt dengan skema keluaran tertulis. Dipakai bila penyedia tidak membatasi jawaban dengan grammar
 * (skema denah terlalu besar untuk structured output Claude); jawaban tetap divalidasi di backend.
 */
export function promptWithSchema(prompt: string, schema: Record<string, unknown>): string {
  return `${prompt}\n\nJawab HANYA dengan satu objek JSON (tanpa teks lain, tanpa blok kode) yang mengikuti JSON Schema berikut. Semua field wajib ada.\n${JSON.stringify(schema)}`;
}

export class VisionError extends Error {
  constructor(
    message: string,
    /** Galat karena konfigurasi (kunci salah, model tidak ada) dan bukan gangguan sementara. */
    readonly config = false,
  ) {
    super(message);
  }
}
