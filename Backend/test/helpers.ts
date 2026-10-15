import request from "supertest";
import { hashPassword } from "../src/admin/auth";
import type { LlmClient } from "../src/ai/llm/LlmClient";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { FixtureCommuteSource } from "../src/data/commute/FixtureCommuteSource";
import type { CommuteSource } from "../src/data/commute/types";
import { silentLogger } from "../src/http/middleware";
import { createServices } from "../src/services";
import { createMemoryStore } from "../src/store/memory";
import type { Store } from "../src/store/types";

export const ADMIN = { email: "admin@ntd.test", password: "rahasia-panjang-123" };
export const EDITOR = { email: "editor@ntd.test", password: "rahasia-editor-123" };

export class FakeLlm implements LlmClient {
  readonly name = "fake";
  readonly model = "fake-1";
  calls = 0;
  constructor(public reply: string | Error = "Naik Lin Cikarang.") {}
  async complete() {
    this.calls++;
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

export async function makeTestApp(opts: { store?: Store; llm?: LlmClient | null; env?: Record<string, string>; source?: CommuteSource } = {}) {
  const store = opts.store ?? createMemoryStore();
  const config = loadConfig({ RATE_LIMIT_MAX: "10000", ADMIN_TOKEN_SECRET: "x".repeat(40), ...opts.env } as NodeJS.ProcessEnv);
  const source = opts.source ?? new FixtureCommuteSource();
  const services = createServices({ config, store, log: silentLogger, source, llm: opts.llm ?? null });
  if ((await store.admins.count()) === 0) {
    await store.admins.create({ email: ADMIN.email, name: "Admin", role: "admin", passwordHash: await hashPassword(ADMIN.password), active: true });
    await store.admins.create({ email: EDITOR.email, name: "Editor", role: "editor", passwordHash: await hashPassword(EDITOR.password), active: true });
  }
  const app = createApp(services);
  const login = async (who = ADMIN) => {
    const res = await request(app).post("/api/admin/auth/login").send(who);
    if (res.status !== 200) throw new Error(`login gagal: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data.token as string;
  };
  return { app, store, services, source, login };
}
