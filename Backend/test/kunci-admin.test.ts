// Kunci LLM dan token X yang diisi admin: terenkripsi di basis data, tidak pernah dikembalikan atau dicatat, berlaku tanpa
// restart, dan cadangan ke environment.

import request from "supertest";
import { ClaudeClient } from "../src/ai/llm/ClaudeClient";
import { GptClient } from "../src/ai/llm/GptClient";
import type { LlmClient } from "../src/ai/llm/LlmClient";
import type { ResolvedLlm } from "../src/ai/llm/LlmService";
import { FixturePostSource, type SourcePost } from "../src/ai/reader/PostSource";
import { SecretBox } from "../src/ai/secrets";
import { createMemoryStore } from "../src/store/memory";
import { EDITOR, FakeLlm, makeTestApp } from "./helpers";

const SECRET = "x".repeat(40);
const KEY = "sk-ant-RAHASIA-ABCD1234";
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAA-RAHASIA-TOKEN-WXYZ";

describe("SecretBox", () => {
  it("enkripsi bolak-balik, acak per penyimpanan, dan menolak secret lain atau data rusak", () => {
    const box = new SecretBox(SECRET);
    const a = box.seal(KEY);
    const b = box.seal(KEY);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain("RAHASIA");
    expect(box.open(a)).toBe(KEY);
    expect(new SecretBox("y".repeat(40)).open(a)).toBeNull();
    expect(box.open(a.slice(0, -4) + "AAAA")).toBeNull();
    expect(box.open("bukan-format")).toBeNull();
  });

  it("tanpa secret yang cukup panjang: tidak tersedia dan menolak menyimpan", () => {
    for (const s of [undefined, "", "pendek"]) {
      const box = new SecretBox(s);
      expect(box.available).toBe(false);
      expect(() => box.seal("rahasia")).toThrow(/ADMIN_TOKEN_SECRET/);
      expect(box.open("v1:a:b:c")).toBeNull();
    }
  });
});

describe("Kunci LLM dari admin", () => {
  const setup = async (opts: Parameters<typeof makeTestApp>[0] = {}) => {
    const seen: ResolvedLlm[] = [];
    const clients: FakeLlm[] = [];
    const t = await makeTestApp({
      ...opts,
      llmFactory: (r) => {
        seen.push(r);
        if (r.provider === "none" || !r.apiKey) return null;
        const c = new FakeLlm("Naik KAI Commuter Lin Bogor dari Jakarta Kota ke Manggarai.");
        clients.push(c);
        return Object.assign(c, { name: r.provider, model: r.model ?? "bawaan" }) as LlmClient as FakeLlm;
      },
    });
    const auth = { Authorization: `Bearer ${await t.login()}` };
    return { ...t, auth, seen, clients };
  };

  it("tersimpan terenkripsi, tidak pernah dikembalikan atau dicatat, dan berlaku tanpa restart", async () => {
    const { app, auth, store, seen, login } = await setup();
    const before = (await request(app).get("/api/admin/ai/llm").set(auth)).body.data;
    expect(before).toMatchObject({ provider: "none", ready: false, canStoreKey: true, key: { set: false, source: null } });
    expect((await request(app).get("/api/meta")).body.data.llm.available).toBe(false);

    // Editor hanya boleh melihat.
    const editor = { Authorization: `Bearer ${await login(EDITOR)}` };
    expect((await request(app).get("/api/admin/ai/llm").set(editor)).status).toBe(200);
    expect((await request(app).put("/api/admin/ai/llm").set(editor).send({ provider: "claude", apiKey: KEY })).status).toBe(403);

    const put = await request(app).put("/api/admin/ai/llm").set(auth).send({ provider: "claude", model: "claude-sonnet-5-5", apiKey: KEY });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5", ready: true, key: { set: true, source: "admin", hint: "…1234" }, client: { provider: "claude", model: "claude-sonnet-5-5" } });
    expect(JSON.stringify(put.body)).not.toContain("RAHASIA");
    expect(JSON.stringify((await request(app).get("/api/admin/ai/llm").set(auth)).body)).not.toContain("RAHASIA");

    // Di basis data: terenkripsi. Di log aktivitas: hanya penanda.
    const stored = (await store.serverConfig.get<{ apiKey: string }>("ai.llm"))!.value;
    expect(stored.apiKey).toMatch(/^v1:/);
    expect(JSON.stringify(stored)).not.toContain("RAHASIA");
    const audit = JSON.stringify((await request(app).get("/api/admin/audit").set(auth)).body);
    expect(audit).toContain("ai.llm.update");
    expect(audit).toContain("(diganti)");
    expect(audit).not.toContain("RAHASIA");

    // Berlaku tanpa restart: opsi LLM langsung tersedia dan pencarian memakai klien itu.
    expect(seen.at(-1)).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5", apiKey: KEY, keySource: "admin" });
    expect((await request(app).get("/api/meta")).body.data.llm).toMatchObject({ available: true, pipelines: ["default", "llm"] });
    const plan = await request(app).post("/api/plan").send({ originId: "jakarta-kota", destinationId: "manggarai", pipeline: "llm" });
    expect(plan.body.data.pipeline).toMatchObject({ requested: "llm", used: "llm", model: "claude-sonnet-5-5" });
  });

  it("mengganti kunci, mengganti model tanpa kehilangan kunci, dan menghapus kunci", async () => {
    const { app, auth, seen } = await setup();
    const put = (b: object) => request(app).put("/api/admin/ai/llm").set(auth).send(b);
    await put({ provider: "claude", apiKey: KEY });
    await put({ model: "claude-opus-5-5" });
    expect(seen.at(-1)).toMatchObject({ model: "claude-opus-5-5", apiKey: KEY });
    const swapped = await put({ apiKey: "sk-ant-KUNCI-BARU-9876" });
    expect(swapped.body.data.key).toMatchObject({ hint: "…9876", source: "admin" });
    expect(seen.at(-1)?.apiKey).toBe("sk-ant-KUNCI-BARU-9876");
    // Model kembali ke bawaan penyedia bila dikosongkan (null).
    expect((await put({ model: null })).body.data.model).toBe("claude-opus-5-5");
    const cleared = await put({ clearApiKey: true });
    expect(cleared.body.data).toMatchObject({ ready: false, key: { set: false, source: null } });
    expect(cleared.body.data.problem).toMatch(/Kunci API belum diisi/);
    expect((await request(app).get("/api/meta")).body.data.llm.available).toBe(false);
  });

  it("kunci tidak dikirim ke penyedia lain", async () => {
    const { app, auth, seen } = await setup();
    const put = (b: object) => request(app).put("/api/admin/ai/llm").set(auth).send(b);
    await put({ provider: "claude", apiKey: KEY });
    const gpt = await put({ provider: "gpt", model: "gpt-contoh" });
    expect(gpt.body.data).toMatchObject({ provider: "gpt", ready: false, key: { set: false } });
    expect(gpt.body.data.key.problem).toMatch(/penyedia lain/);
    expect(seen.at(-1)?.apiKey).toBeUndefined();
    // Kembali ke penyedia asal: kunci lama berlaku lagi.
    expect((await put({ provider: "claude" })).body.data).toMatchObject({ ready: true, key: { set: true, hint: "…1234" } });
  });

  it("validasi: penyedia none, kunci pendek atau berspasi, model dan batas waktu tidak valid", async () => {
    const { app, auth } = await setup();
    const put = (b: object) => request(app).put("/api/admin/ai/llm").set(auth).send(b);
    expect((await put({ apiKey: KEY })).status).toBe(400);
    expect((await put({ provider: "claude", apiKey: "pendek" })).status).toBe(400);
    expect((await put({ provider: "claude", apiKey: "kunci dengan spasi tengah" })).status).toBe(400);
    expect((await put({ provider: "claude", model: "model salah!" })).status).toBe(400);
    expect((await put({ provider: "claude", timeoutMs: 10 })).status).toBe(400);
    expect((await put({ provider: "bard" })).status).toBe(400);
  });

  it("cadangan ke environment: dipakai bila admin belum mengisi, dikalahkan kunci admin", async () => {
    const { app, auth, seen } = await setup({ env: { LLM_PROVIDER: "claude", LLM_API_KEY: "sk-env-ENVK0001", LLM_MODEL: "claude-env-model" } });
    const v = (await request(app).get("/api/admin/ai/llm").set(auth)).body.data;
    expect(v).toMatchObject({ provider: "claude", model: "claude-env-model", ready: true, key: { set: true, source: "env", hint: "…0001" }, sources: { provider: "env", model: "env" } });
    expect(seen.at(-1)?.apiKey).toBe("sk-env-ENVK0001");
    const put = await request(app).put("/api/admin/ai/llm").set(auth).send({ apiKey: KEY });
    expect(put.body.data.key).toMatchObject({ source: "admin", hint: "…1234" });
    expect(seen.at(-1)?.apiKey).toBe(KEY);
    await request(app).put("/api/admin/ai/llm").set(auth).send({ clearApiKey: true });
    expect((await request(app).get("/api/admin/ai/llm").set(auth)).body.data.key).toMatchObject({ source: "env", hint: "…0001" });
  });

  it("tanpa ADMIN_TOKEN_SECRET kunci tidak bisa disimpan dari admin", async () => {
    const { app, auth } = await setup({ env: { ADMIN_TOKEN_SECRET: "" } });
    expect((await request(app).get("/api/admin/ai/llm").set(auth)).body.data.canStoreKey).toBe(false);
    const put = await request(app).put("/api/admin/ai/llm").set(auth).send({ provider: "claude", apiKey: KEY });
    expect(put.status).toBe(409);
    expect(put.body.message).toMatch(/ADMIN_TOKEN_SECRET/);
  });

  it("ADMIN_TOKEN_SECRET berubah: kunci tersimpan tidak terbaca dan perlu diisi ulang", async () => {
    const store = createMemoryStore();
    const a = await setup({ store });
    await request(a.app).put("/api/admin/ai/llm").set(a.auth).send({ provider: "claude", apiKey: KEY });
    const b = await setup({ store, env: { ADMIN_TOKEN_SECRET: "z".repeat(40) } });
    const v = (await request(b.app).get("/api/admin/ai/llm").set(b.auth)).body.data;
    expect(v).toMatchObject({ provider: "claude", ready: false, key: { set: false } });
    expect(v.key.problem).toMatch(/tidak dapat dibaca/);
    expect((await request(b.app).get("/api/meta")).body.data.llm.available).toBe(false);
    // Isi ulang memulihkan.
    expect((await request(b.app).put("/api/admin/ai/llm").set(b.auth).send({ apiKey: "sk-ant-ULANG-5555" })).body.data).toMatchObject({ ready: true, key: { hint: "…5555" } });
  });

  it("uji koneksi: berhasil, gagal dengan pesan penyedia, dan tanpa klien", async () => {
    const { app, auth, clients, login } = await setup();
    const test = () => request(app).post("/api/admin/ai/llm/test").set(auth).send({});
    const none = await test();
    expect(none.body.data).toMatchObject({ ok: false });
    expect(none.body.data.error).toMatch(/LLM dimatikan/);
    await request(app).put("/api/admin/ai/llm").set(auth).send({ provider: "claude", model: "claude-sonnet-5-5", apiKey: KEY });
    clients[0].reply = "OK";
    expect((await test()).body.data).toMatchObject({ ok: true, provider: "claude", model: "claude-sonnet-5-5", reply: "OK" });
    clients[0].reply = new Error("LLM: galat API 404 (model: claude-sonnet-5.5)");
    const bad = await test();
    expect(bad.body.data).toMatchObject({ ok: false, error: "LLM: galat API 404 (model: claude-sonnet-5.5)" });
    expect(JSON.stringify(bad.body)).not.toContain("RAHASIA");
    expect((await request(app).post("/api/admin/ai/llm/test").set({ Authorization: `Bearer ${await login(EDITOR)}` }).send({})).status).toBe(403);
  });

  it("/ai/status memakai konfigurasi terkini", async () => {
    const { app, auth } = await setup();
    expect((await request(app).get("/api/admin/ai/status").set(auth)).body.data.llm.client).toBeNull();
    await request(app).put("/api/admin/ai/llm").set(auth).send({ provider: "gpt", model: "gpt-contoh", apiKey: "sk-gpt-KUNCI-0042" });
    expect((await request(app).get("/api/admin/ai/status").set(auth)).body.data.llm).toMatchObject({ client: { provider: "gpt", model: "gpt-contoh" }, availability: { available: true } });
    expect((await request(app).get("/api/admin/system").set(auth)).body.data.llm).toMatchObject({ provider: "gpt", model: "gpt-contoh" });
  });
});

/** Sumber tiruan yang melaporkan dirinya sebagai X API (kind "x"). */
const asX = (s: FixturePostSource) => Object.defineProperty(s, "kind", { value: "x" });

describe("Token X dari admin", () => {
  const post: SourcePost = { id: "9001", text: "Gangguan sinyal di Stasiun Manggarai, perjalanan KRL terlambat.", createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), url: "https://x.com/KRLTest/status/9001", account: "KRLTest" };
  const extraction = JSON.stringify([{ ref: 1, relevan: true, kategori: "gangguan", dampak: "disruption", ringkasan: "Perjalanan KRL terlambat karena gangguan sinyal di Stasiun Manggarai.", stasiun: ["Manggarai"], lini: [], berlakuSampai: null, keyakinan: "tinggi" }]);

  it("tersimpan terenkripsi, tidak dikembalikan, dan langsung dipakai pembaca tanpa restart", async () => {
    const tokens: string[] = [];
    const source = new FixturePostSource([post]);
    const { app, login, services, store } = await makeTestApp({
      llm: new FakeLlm(extraction),
      xFactory: (t) => {
        tokens.push(t);
        return asX(source);
      },
    });
    const auth = { Authorization: `Bearer ${await login()}` };
    await services.readerConfig.update({ enabled: true, accounts: [{ handle: "KRLTest", operator: "KAI Commuter", enabled: true }] }, "tes");
    const start = (await request(app).get("/api/admin/ai/reader").set(auth)).body.data;
    expect(start.source).toEqual({ kind: "none", configured: false });
    expect(start.xToken).toMatchObject({ set: false, canStore: true });
    expect(start.problem).toMatch(/token X di Pengaturan admin/);

    // Hanya admin; token pendek ditolak.
    const editor = { Authorization: `Bearer ${await login(EDITOR)}` };
    expect((await request(app).put("/api/admin/ai/reader").set(editor).send({ xBearerToken: TOKEN })).status).toBe(403);
    expect((await request(app).put("/api/admin/ai/reader").set(auth).send({ xBearerToken: "pendek" })).status).toBe(400);

    const put = await request(app).put("/api/admin/ai/reader").set(auth).send({ xBearerToken: TOKEN });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ source: { kind: "x", configured: true }, problem: null, xToken: { set: true, source: "admin", hint: "…WXYZ" } });
    expect(JSON.stringify(put.body)).not.toContain("RAHASIA");
    const stored = (await store.serverConfig.get<{ token: string }>("ai.x"))!.value;
    expect(stored.token).toMatch(/^v1:/);
    expect(JSON.stringify(stored)).not.toContain("RAHASIA");
    const audit = JSON.stringify((await request(app).get("/api/admin/audit").set(auth)).body);
    expect(audit).toContain("(diganti)");
    expect(audit).not.toContain("RAHASIA");

    // Berlaku tanpa restart: pembacaan memakai sumber dengan token itu dan menghasilkan informasi pending.
    const poll = await request(app).post("/api/admin/service-info/poll").set(auth).send({});
    expect(poll.body.data).toMatchObject({ created: 1, fetched: 1 });
    expect(tokens).toEqual([TOKEN]);

    // Mengisi konfigurasi lain tanpa token tidak menghapus token.
    await request(app).put("/api/admin/ai/reader").set(auth).send({ keywordFilter: false });
    expect((await request(app).get("/api/admin/ai/reader").set(auth)).body.data.xToken).toMatchObject({ set: true, hint: "…WXYZ" });

    const cleared = await request(app).put("/api/admin/ai/reader").set(auth).send({ clearXToken: true });
    expect(cleared.body.data).toMatchObject({ source: { kind: "none", configured: false }, xToken: { set: false } });
    expect(cleared.body.data.problem).toMatch(/token X di Pengaturan admin/);
  });

  it("cadangan ke environment dan tanpa ADMIN_TOKEN_SECRET", async () => {
    const env = await makeTestApp({ env: { X_API_BEARER_TOKEN: "ENV-TOKEN-AAAAAAAAAAAAAAAAAAAA-0007" }, xFactory: () => asX(new FixturePostSource([])) });
    const authEnv = { Authorization: `Bearer ${await env.login()}` };
    expect((await request(env.app).get("/api/admin/ai/reader").set(authEnv)).body.data).toMatchObject({ source: { kind: "x" }, xToken: { set: true, source: "env", hint: "…0007" } });
    const none = await makeTestApp({ env: { ADMIN_TOKEN_SECRET: "" } });
    const authNone = { Authorization: `Bearer ${await none.login()}` };
    const put = await request(none.app).put("/api/admin/ai/reader").set(authNone).send({ xBearerToken: TOKEN });
    expect(put.status).toBe(409);
    expect(put.body.message).toMatch(/ADMIN_TOKEN_SECRET/);
  });
});

describe("Pesan galat penyedia membantu memperbaiki konfigurasi", () => {
  it("Claude menyertakan pesan penyedia (mis. nama model salah) tanpa kunci", async () => {
    const f = (async () => new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: claude-sonnet-5.5" } }), { status: 404, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const c = new ClaudeClient("sk-ant-RAHASIA", "claude-sonnet-5.5", 5000, { fetch: f, baseURL: "http://claude.test" });
    await expect(c.complete({ system: "s", prompt: "p", maxTokens: 10 })).rejects.toThrow("LLM: galat API 404 (model: claude-sonnet-5.5)");
    await c.complete({ system: "s", prompt: "p", maxTokens: 10 }).catch((e: Error) => expect(e.message).not.toContain("RAHASIA"));
  });

  it("GPT menyertakan pesan penyedia", async () => {
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { message: "The model `xyz` does not exist" } }), { status: 404 }));
    await expect(new GptClient("sk", "xyz").complete({ system: "s", prompt: "p", maxTokens: 10 })).rejects.toThrow("LLM: galat API 404 (The model `xyz` does not exist)");
    spy.mockRestore();
  });
});
