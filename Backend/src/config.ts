// Konfigurasi dari environment variable. Rahasia (kunci LLM, URL basis data, secret admin)
// tidak boleh masuk repositori (Subbab 2.12.1); lihat .env.example.

export interface Config {
  port: number;
  nodeEnv: string;
  /** Origin yang boleh memanggil API publik (frontend). */
  corsOrigins: string[];
  /** Origin halaman admin (proyek terpisah). */
  adminOrigins: string[];
  databaseUrl?: string;
  commute: {
    source: "http" | "fixture";
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
    operators: string[];
    regions: string[];
  };
  llm: {
    provider: "none" | "claude" | "gpt";
    apiKey?: string;
    model?: string;
    timeoutMs: number;
  };
  /**
   * AI pembaca denah stasiun (admin: isi fasilitas dari gambar). Nilai di sini adalah bawaan dari environment;
   * admin dapat menimpanya lewat Pengaturan (disimpan di server, kunci tidak pernah dikirim ke browser).
   */
  vision: {
    provider: VisionProvider;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    timeoutMs: number;
  };
  admin: {
    enabled: boolean;
    tokenSecret?: string;
    tokenTtlMinutes: number;
    bootstrapEmail?: string;
    bootstrapPassword?: string;
  };
  rateLimit: { windowMs: number; max: number };
}

export const VISION_PROVIDERS = ["claude", "openai", "none"] as const;
export type VisionProvider = (typeof VISION_PROVIDERS)[number];

const list = (v: string | undefined, fallback: string[]) =>
  v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = (env.LLM_PROVIDER ?? (env.LLM_API_KEY ? "claude" : "none")) as Config["llm"]["provider"];
  if (!["none", "claude", "gpt"].includes(provider)) throw new Error(`LLM_PROVIDER tidak dikenal: ${provider}`);
  const source = (env.COMMUTE_SOURCE ?? "fixture") as Config["commute"]["source"];
  if (!["http", "fixture"].includes(source)) throw new Error(`COMMUTE_SOURCE tidak dikenal: ${source}`);

  const visionProvider = (env.AI_VISION_PROVIDER || "claude") as VisionProvider;
  if (!VISION_PROVIDERS.includes(visionProvider)) throw new Error(`AI_VISION_PROVIDER tidak dikenal: ${visionProvider}`);
  // Tanpa kunci khusus, penyedia Claude memakai kunci LLM notifikasi bila penyedianya juga Claude.
  const visionKey =
    env.AI_VISION_API_KEY ||
    (visionProvider === "claude" && provider === "claude" ? env.LLM_API_KEY : undefined) ||
    (visionProvider === "claude" ? env.ANTHROPIC_API_KEY : undefined) ||
    undefined;

  const tokenSecret = env.ADMIN_TOKEN_SECRET;
  const adminEnabled = env.ADMIN_ENABLED !== "false";
  if (adminEnabled && env.NODE_ENV === "production" && (!tokenSecret || tokenSecret.length < 32)) {
    throw new Error("ADMIN_TOKEN_SECRET wajib diisi (minimal 32 karakter) di production.");
  }

  return {
    port: Number(env.PORT) || 4000,
    nodeEnv: env.NODE_ENV ?? "development",
    corsOrigins: list(env.CORS_ORIGINS, ["http://localhost:3000"]),
    adminOrigins: list(env.ADMIN_ORIGINS, ["http://localhost:5173"]),
    databaseUrl: env.DATABASE_URL || undefined,
    commute: {
      source,
      baseUrl: env.COMMUTE_API_BASE_URL ?? "https://api.commute.shiorilabs.id",
      apiKey: env.COMMUTE_API_KEY || undefined,
      timeoutMs: Number(env.COMMUTE_TIMEOUT_MS) || 8000,
      operators: list(env.COMMUTE_OPERATORS, []),
      regions: list(env.COMMUTE_REGIONS, []),
    },
    llm: {
      provider,
      apiKey: env.LLM_API_KEY || undefined,
      model: env.LLM_MODEL || undefined,
      timeoutMs: Number(env.LLM_TIMEOUT_MS) || 15000,
    },
    vision: {
      provider: visionProvider,
      apiKey: visionKey,
      model: env.AI_VISION_MODEL || undefined,
      baseUrl: env.AI_VISION_BASE_URL || undefined,
      timeoutMs: Number(env.AI_VISION_TIMEOUT_MS) || 120_000,
    },
    admin: {
      enabled: adminEnabled,
      // Di luar production, secret acak per proses: token admin hilang saat server restart.
      tokenSecret: tokenSecret || undefined,
      tokenTtlMinutes: Number(env.ADMIN_TOKEN_TTL_MINUTES) || 480,
      bootstrapEmail: env.ADMIN_BOOTSTRAP_EMAIL || undefined,
      bootstrapPassword: env.ADMIN_BOOTSTRAP_PASSWORD || undefined,
    },
    rateLimit: {
      windowMs: Number(env.RATE_LIMIT_WINDOW_MS) || 60_000,
      max: Number(env.RATE_LIMIT_MAX) || 60,
    },
  };
}
