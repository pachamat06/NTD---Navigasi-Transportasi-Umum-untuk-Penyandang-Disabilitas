import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { ClaudeVisionClient } from "../src/ai/vision/ClaudeVisionClient";
import { buildSuggestions, FLOOR_PLAN_JSON_SCHEMA, parseFloorPlan, sniffImage } from "../src/ai/vision/floorPlan";
import { OpenAiVisionClient } from "../src/ai/vision/OpenAiVisionClient";
import { VisionError, type VisionClient, type VisionRequest } from "../src/ai/vision/VisionClient";
import type { ResolvedVision } from "../src/ai/vision/VisionService";
import type { ContentItem } from "../src/store/types";
import { EDITOR, makeTestApp } from "./helpers";

// PNG 1x1 yang valid (cukup untuk pemeriksaan tanda tangan file).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]).toString("base64");

/** Jawaban AI untuk denah Stasiun Tanjung Barat (contoh uji dari tim). */
const TANJUNG_BARAT = {
  stationName: "Tanjung Barat",
  summary: "Stasiun dua lantai: concourse di Lantai 1, peron samping 1 dan 2 di lantai dasar.",
  levels: [
    { name: "Lantai 1", description: "Concourse, gate A1 dan A2, loket, musala, ruang laktasi, toilet." },
    { name: "Lantai Dasar & Peron", description: "Peron 1 dan 2, gate B." },
  ],
  facilities: [
    { type: "eskalator", status: "available", count: 4, location: "Antara concourse dan peron 1 serta 2", confidence: "tinggi", evidence: "Simbol eskalator di kedua sisi peron." },
    { type: "lift", status: "available", count: null, location: "Peron 1 dekat ujung timur", confidence: "sedang", evidence: "Simbol kursi roda di ujung peron 1." },
    { type: "lift", status: "available", count: null, location: "Gate B", confidence: "rendah", evidence: "Simbol lift dekat gate B." },
  ],
  platforms: [
    { code: "1", name: null, type: "side", tracks: ["1"], directions: ["Bogor/Nambo"], lift: "available", eskalator: "available", toilet: "unknown", ramp: "unknown", escalators: [{ count: 2, direction: "bergantian", connects: "Lantai 1 – Peron 1" }], liftCount: 1, note: null, confidence: "tinggi", evidence: "Nomor peron 1 tertulis." },
    { code: "2", name: null, type: "side", tracks: ["2"], directions: ["Jakarta Kota"], lift: "unknown", eskalator: "available", toilet: "unknown", ramp: "unknown", escalators: [{ count: 2, direction: "bergantian", connects: null }], liftCount: null, note: null, confidence: "tinggi", evidence: "Nomor peron 2 tertulis." },
  ],
  entrances: [
    { name: "Gate A1", exitRef: "A1", level: "Lantai 1", accessible: null, features: ["eskalator", "tangga"], platformLinks: [{ platform: "1", via: "jpo", note: null }, { platform: "2", via: "jpo", note: null }], escalators: [], liftCount: null, description: null, confidence: "tinggi", evidence: "Label A1." },
    { name: "Gate A2", exitRef: "A2", level: "Lantai 1", accessible: null, features: ["tangga", "terbang"], platformLinks: [], escalators: [], liftCount: null, description: null, confidence: "tinggi", evidence: "Label A2." },
    { name: "Gate B", exitRef: "B", level: "Lantai dasar", accessible: true, features: ["lift", "datar"], platformLinks: [{ platform: "2", via: "langsung", note: null }], escalators: [], liftCount: 1, description: null, confidence: "sedang", evidence: "Label B di ujung peron 2." },
  ],
  rooms: [
    { category: "musala", name: "Musala", location: "Lantai 1", confidence: "tinggi", evidence: "Simbol musala." },
    { category: "ruang_laktasi", name: "Ruang laktasi", location: "Lantai 1", confidence: "tinggi", evidence: "Simbol ruang laktasi." },
    { category: "toilet_wanita", name: "Toilet wanita", location: "Lantai 1", confidence: "tinggi", evidence: "Simbol toilet wanita." },
    { category: "toilet_pria", name: "Toilet pria", location: "Lantai 1", confidence: "tinggi", evidence: "Simbol toilet pria." },
    { category: "petugas_informasi", name: "Petugas informasi", location: "Lantai 1", confidence: "sedang", evidence: "Simbol petugas informasi." },
  ],
  connections: [
    { mode: "bus", code: "4B", route: "Universitas Indonesia – Stasiun Manggarai" },
    { mode: "angkot", code: "M03", route: "Terminal Depok – Pasar Minggu" },
  ],
  warnings: [],
};

class FakeVision implements VisionClient {
  readonly name = "fake";
  readonly model = "fake-vision-1";
  requests: VisionRequest[] = [];
  constructor(public reply: string | Error = JSON.stringify(TANJUNG_BARAT)) {}
  async analyze(req: VisionRequest) {
    this.requests.push(req);
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

const item = (over: Partial<ContentItem>): ContentItem => ({
  id: "x",
  kind: "facility",
  stationId: "tanjung-barat",
  draft: null,
  published: null,
  draftDeleted: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  publishedAt: null,
  updatedBy: null,
  ...over,
});

describe("Pembacaan denah stasiun: pemetaan ke skema NTD", () => {
  it("mengurai JSON di dalam blok kode dan membuang entri yang rusak tanpa menggagalkan semuanya", () => {
    const raw = parseFloorPlan("Berikut hasilnya:\n```json\n" + JSON.stringify({ ...TANJUNG_BARAT, facilities: [...TANJUNG_BARAT.facilities, { type: "jetpack", status: "available" }] }) + "\n```");
    expect(raw.facilities).toHaveLength(3);
    expect(raw.platforms.map((p) => p.code)).toEqual(["1", "2"]);
    expect(() => parseFloorPlan("maaf, tidak bisa")).toThrow();
  });

  it("menyusun usulan fasilitas, peron, gate, dan info yang lolos validasi skema konten", () => {
    const r = buildSuggestions(parseFloorPlan(JSON.stringify(TANJUNG_BARAT)), [], { name: "Tanjung Barat" });
    expect(r.stationNameMatches).toBe(true);
    const by = (kind: string) => r.suggestions.filter((s) => s.kind === kind);
    expect(r.suggestions.filter((s) => s.issues.length)).toEqual([]);

    const fac = Object.fromEntries(by("facility").map((s) => [s.data.type, s]));
    expect(Object.keys(fac).sort()).toEqual(["eskalator", "lift", "petugas_bantuan", "toilet"]);
    // Dua temuan lift digabung; keyakinan tertinggi yang dipakai, lokasi keduanya dicatat.
    expect(fac.lift.confidence).toBe("sedang");
    expect(fac.lift.data.note).toMatch(/Peron 1.*Gate B/);
    expect(fac.eskalator.data).toMatchObject({ status: "available", note: expect.stringMatching(/^4 unit/) });

    const peron1 = by("platform").find((s) => s.data.code === "1")!;
    expect(peron1.data).toMatchObject({ type: "side", amenities: { lift: "available", eskalator: "available" }, lift: { count: 1 }, escalators: [{ count: 2, direction: "bergantian" }] });
    expect(peron1.data.note).toMatch(/Arah: Bogor\/Nambo/);

    const gates = Object.fromEntries(by("entrance").map((s) => [s.data.exitRef, s.data]));
    expect(gates.A1).toMatchObject({ name: "Gate A1", accessible: false, platformLinks: [{ platform: "1", via: "jpo" }, { platform: "2", via: "jpo" }] });
    expect(gates.A1.note).toMatch(/belum pasti/);
    expect(gates.A2.features).toEqual(["tangga"]); // fitur di luar daftar NTD dibuang
    expect(gates.B).toMatchObject({ accessible: true, lift: { count: 1 } });

    const info = by("station_info").map((s) => s.data.title);
    expect(info).toEqual(expect.arrayContaining(["Musala", "Ruang laktasi", "Angkutan lanjutan"]));
    expect(by("station_info").find((s) => s.data.title === "Angkutan lanjutan")!.data.body).toMatch(/Bus: 4B: Universitas Indonesia.*\nAngkot: M03/);
  });

  it("lift/eskalator dari peron atau gate ikut menjadi fasilitas; guiding block yang tidak yakin tidak dicentang", () => {
    const raw = parseFloorPlan(
      JSON.stringify({
        ...TANJUNG_BARAT,
        facilities: [{ type: "guiding_block", status: "available", count: 0, location: "", confidence: "sedang", evidence: "Mungkin ada." }],
        rooms: [],
      }),
    );
    const r = buildSuggestions(raw, [], { name: "Tanjung Barat" });
    const fac = Object.fromEntries(r.suggestions.filter((s) => s.kind === "facility").map((s) => [s.data.type, s]));
    expect(fac.lift.data).toMatchObject({ status: "available", note: expect.stringMatching(/Peron 1.*Gate B/) });
    expect(fac.eskalator.data.status).toBe("available");
    expect(fac.guiding_block.confidence).toBe("rendah");
    expect(fac.ramp).toBeUndefined();
  });

  it("menandai item tim yang sudah ada dan memperingatkan nama stasiun yang berbeda", () => {
    const existing = [
      item({ id: "f-lift", kind: "facility", published: { type: "lift", status: "absent" } }),
      item({ id: "p-1", kind: "platform", draft: { code: "1", amenities: {} } }),
      item({ id: "g-b", kind: "entrance", published: { name: "Pintu B", exitRef: "B", accessible: false, features: [] } }),
      item({ id: "hapus", kind: "facility", published: { type: "toilet", status: "available" }, draftDeleted: true }),
    ];
    const r = buildSuggestions(parseFloorPlan(JSON.stringify(TANJUNG_BARAT)), existing, { name: "Manggarai" });
    const ex = (kind: string, pred: (d: Record<string, unknown>) => boolean) => r.suggestions.find((s) => s.kind === kind && pred(s.data))!.existingId;
    expect(ex("facility", (d) => d.type === "lift")).toBe("f-lift");
    expect(ex("facility", (d) => d.type === "toilet")).toBeNull();
    expect(ex("platform", (d) => d.code === "1")).toBe("p-1");
    expect(ex("entrance", (d) => d.exitRef === "B")).toBe("g-b");
    expect(r.stationNameMatches).toBe(false);
    expect(r.warnings[0]).toMatch(/Tanjung Barat.*Manggarai/);
  });

  it("mengenali jenis gambar dari isinya, bukan dari nama file", () => {
    expect(sniffImage(PNG)).toMatchObject({ mediaType: "image/png" });
    expect(sniffImage(JPEG)).toMatchObject({ mediaType: "image/jpeg" });
    expect(sniffImage(Buffer.from("<svg>bukan gambar raster</svg>").toString("base64"))).toHaveProperty("error");
    expect(sniffImage("bukan base64!")).toHaveProperty("error");
  });

  it("skema keluaran AI memenuhi syarat structured output (objek tertutup, semua field wajib)", () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (n.type === "object") {
        expect(n.additionalProperties).toBe(false);
        expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as object).sort());
      }
      for (const v of Object.values(n)) walk(v);
    };
    walk(FLOOR_PLAN_JSON_SCHEMA);
    // API Claude menolak skema dengan terlalu banyak tipe gabungan (anyOf / type array).
    const text = JSON.stringify(FLOOR_PLAN_JSON_SCHEMA);
    expect(text).not.toMatch(/anyOf|"type":\[|"null"/);
  });

  it("nilai 'tidak tahu' dari skema tanpa null diubah menjadi kosong", () => {
    const raw = parseFloorPlan(
      JSON.stringify({
        ...TANJUNG_BARAT,
        stationName: "",
        platforms: [{ ...TANJUNG_BARAT.platforms[0], type: "tidak_tahu", liftCount: 0, name: "" }],
        entrances: [{ ...TANJUNG_BARAT.entrances[0], accessible: "tidak_tahu", exitRef: "" }, { ...TANJUNG_BARAT.entrances[2], accessible: "ya" }],
      }),
    );
    expect(raw.stationName).toBeNull();
    expect(raw.platforms[0]).toMatchObject({ type: null, liftCount: null, name: null });
    expect(raw.entrances.map((e) => [e.accessible, e.exitRef])).toEqual([[null, null], [true, "B"]]);
    const r = buildSuggestions(raw, [], { name: "Tanjung Barat" });
    expect(r.stationNameMatches).toBeNull();
    expect(r.suggestions.filter((x) => x.issues.length)).toEqual([]);
    expect(r.suggestions.find((x) => x.kind === "platform")!.data).not.toHaveProperty("lift");
  });
});

describe("Endpoint admin /stations/:id/floor-plan", () => {
  it("mengirim gambar ke AI lewat backend dan mengembalikan usulan tanpa menyimpan apa pun", async () => {
    const fake = new FakeVision();
    const { app, login, store } = await makeTestApp({ visionFactory: () => fake });
    const token = await login(EDITOR);
    const before = (await store.content.list()).length;
    const res = await request(app)
      .post("/api/admin/stations/sudirman/floor-plan")
      .set("authorization", `Bearer ${token}`)
      .send({ images: [{ data: `data:image/jpeg;base64,${PNG}`, name: "denah.jpg" }, { data: JPEG }] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stationId: "sudirman", provider: "fake", model: "fake-vision-1", stationNameMatches: false });
    expect(res.body.data.suggestions.length).toBeGreaterThan(5);
    // Jenis gambar diambil dari isi file; prompt menyebut stasiun yang sedang diisi.
    expect(fake.requests[0].images.map((i) => i.mediaType)).toEqual(["image/png", "image/jpeg"]);
    expect(fake.requests[0].prompt).toMatch(/Sudirman/);
    expect(fake.requests[0].schema).toBe(FLOOR_PLAN_JSON_SCHEMA);
    expect((await store.content.list()).length).toBe(before);
    const log = await store.audit.list(5);
    expect(log[0]).toMatchObject({ action: "ai.floor_plan", target: "sudirman" });

    // Usulan dapat disimpan apa adanya sebagai draft lewat endpoint konten.
    const s = res.body.data.suggestions.find((x: { kind: string }) => x.kind === "entrance");
    const saved = await request(app).post("/api/admin/content").set("authorization", `Bearer ${token}`).send({ kind: s.kind, stationId: "sudirman", data: s.data });
    expect(saved.status).toBe(201);
    expect(saved.body.data).toMatchObject({ state: "baru", draft: { name: "Gate A1" } });
  });

  it("menolak tanpa sesi admin, tanpa membaca body besar", async () => {
    const { app } = await makeTestApp({ visionFactory: () => new FakeVision() });
    const big = "A".repeat(300_000);
    const res = await request(app).post("/api/admin/stations/sudirman/floor-plan").send({ images: [{ data: big }] });
    expect(res.status).toBe(413);
    const small = await request(app).post("/api/admin/stations/sudirman/floor-plan").send({ images: [{ data: PNG }] });
    expect(small.status).toBe(401);
  });

  it("memvalidasi gambar dan stasiun", async () => {
    const { app, login } = await makeTestApp({ visionFactory: () => new FakeVision() });
    const auth = { authorization: `Bearer ${await login()}` };
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>").toString("base64");
    expect((await request(app).post("/api/admin/stations/sudirman/floor-plan").set(auth).send({ images: [{ data: svg, name: "denah.svg" }] })).body.message).toMatch(/denah\.svg.*JPEG, PNG/);
    expect((await request(app).post("/api/admin/stations/sudirman/floor-plan").set(auth).send({ images: [] })).status).toBe(400);
    expect((await request(app).post("/api/admin/stations/sudirman/floor-plan").set(auth).send({ images: Array(5).fill({ data: PNG }) })).status).toBe(400);
    expect((await request(app).post("/api/admin/stations/tidak-ada/floor-plan").set(auth).send({ images: [{ data: PNG }] })).status).toBe(404);
  });

  it("memberi tahu bila AI belum dikonfigurasi atau gagal", async () => {
    const none = await makeTestApp();
    const t1 = await none.login();
    const res = await request(none.app).post("/api/admin/stations/sudirman/floor-plan").set("authorization", `Bearer ${t1}`).send({ images: [{ data: PNG }] });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Kunci API Claude belum diisi/);

    const failing = await makeTestApp({ visionFactory: () => new FakeVision(new VisionError("AI: kunci API Claude tidak valid.", true)) });
    const t2 = await failing.login();
    const bad = await request(failing.app).post("/api/admin/stations/sudirman/floor-plan").set("authorization", `Bearer ${t2}`).send({ images: [{ data: PNG }] });
    expect(bad.status).toBe(409);
    expect(bad.body.message).toMatch(/tidak valid/);

    const garbage = await makeTestApp({ visionFactory: () => new FakeVision("ini bukan json") });
    const t3 = await garbage.login();
    expect((await request(garbage.app).post("/api/admin/stations/sudirman/floor-plan").set("authorization", `Bearer ${t3}`).send({ images: [{ data: PNG }] })).status).toBe(503);
  });
});

describe("Pengaturan penyedia AI pembaca denah", () => {
  it("bawaan Claude claude-sonnet-5-5; kunci tidak pernah dikirim ke browser; hanya peran admin yang dapat mengubah", async () => {
    const resolved: ResolvedVision[] = [];
    const { app, login, store } = await makeTestApp({
      visionFactory: (r) => {
        resolved.push(r);
        return r.apiKey ? new FakeVision() : null;
      },
    });
    const admin = { authorization: `Bearer ${await login()}` };
    const editor = { authorization: `Bearer ${await login(EDITOR)}` };

    const initial = (await request(app).get("/api/admin/ai/vision").set(editor)).body.data;
    expect(initial).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5", ready: false, key: { set: false } });

    expect((await request(app).put("/api/admin/ai/vision").set(editor).send({ apiKey: "sk-ant-rahasia-1234" })).status).toBe(403);
    const set = await request(app).put("/api/admin/ai/vision").set(admin).send({ apiKey: "sk-ant-rahasia-1234", model: "claude-opus-5-5" });
    expect(set.status).toBe(200);
    expect(set.body.data).toMatchObject({ ready: true, model: "claude-opus-5-5", sources: { model: "admin" }, key: { set: true, source: "admin", hint: "…1234" } });
    expect(JSON.stringify(set.body)).not.toMatch(/rahasia/);
    expect(JSON.stringify((await request(app).get("/api/admin/ai/vision").set(editor)).body)).not.toMatch(/rahasia/);
    expect(JSON.stringify(await store.audit.list(10))).not.toMatch(/rahasia/);

    await request(app).post("/api/admin/stations/sudirman/floor-plan").set(editor).send({ images: [{ data: PNG }] }).expect(200);
    expect(resolved.at(-1)).toMatchObject({ provider: "claude", model: "claude-opus-5-5", apiKey: "sk-ant-rahasia-1234" });

    // Ganti ke penyedia lain: kunci Claude tidak ikut terkirim ke endpoint baru.
    const sw = await request(app).put("/api/admin/ai/vision").set(admin).send({ provider: "openai", model: "gpt-vision", baseUrl: "https://ai.contoh.id/v1/" });
    expect(sw.body.data).toMatchObject({ provider: "openai", baseUrl: "https://ai.contoh.id/v1", ready: true, key: { set: false, storedForOtherProvider: true } });
    await request(app).post("/api/admin/stations/sudirman/floor-plan").set(editor).send({ images: [{ data: PNG }] }).expect(409);
    expect(resolved.at(-1)).toMatchObject({ provider: "openai", apiKey: undefined });

    // Kembali ke nilai environment.
    const reset = await request(app).put("/api/admin/ai/vision").set(admin).send({ provider: null, model: null, baseUrl: null, clearApiKey: true });
    expect(reset.body.data).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5", sources: { provider: "env" }, key: { set: false, storedForOtherProvider: false } });
    expect((await request(app).put("/api/admin/ai/vision").set(admin).send({ baseUrl: "file:///etc/passwd" })).status).toBe(400);
  });

  it("kunci dari environment hanya dipakai untuk penyedia dan endpoint environment", async () => {
    const resolved: ResolvedVision[] = [];
    const { app, login } = await makeTestApp({
      env: { LLM_PROVIDER: "claude", LLM_API_KEY: "sk-ant-dari-env-9999" },
      visionFactory: (r) => (resolved.push(r), new FakeVision()),
    });
    const admin = { authorization: `Bearer ${await login()}` };
    expect((await request(app).get("/api/admin/ai/vision").set(admin)).body.data).toMatchObject({ ready: true, key: { set: true, source: "env", hint: "…9999" } });
    await request(app).put("/api/admin/ai/vision").set(admin).send({ baseUrl: "https://proxy.contoh.id" });
    expect((await request(app).get("/api/admin/ai/vision").set(admin)).body.data).toMatchObject({ ready: false, key: { set: false } });
    const sys = await request(app).get("/api/admin/system").set(admin);
    expect(sys.body.data.vision).toMatchObject({ provider: "claude", ready: false });
  });
});

describe("Klien penyedia AI", () => {
  let server: Server;
  let base: string;
  const seen: { url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];
  let reply: (url: string, body: Record<string, unknown>) => { status: number; json: unknown } = () => ({ status: 500, json: {} });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body = JSON.parse(data || "{}");
        seen.push({ url: req.url ?? "", headers: req.headers, body });
        const r = reply(req.url ?? "", body);
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
  beforeEach(() => (seen.length = 0));

  const req: VisionRequest = { system: "sistem", prompt: "baca denah", images: [{ mediaType: "image/png", data: PNG }], schema: FLOOR_PLAN_JSON_SCHEMA, maxTokens: 1000 };

  it("Claude: model bawaan claude-sonnet-5-5, gambar base64, skema di prompt, dan cadangan sisi server", async () => {
    reply = () => ({
      status: 200,
      json: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: '{"ok":true}' }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const c = new ClaudeVisionClient({ apiKey: "sk-ant-uji", baseUrl: base, timeoutMs: 5000 });
    expect(await c.analyze(req)).toBe('{"ok":true}');
    const { body, headers, url } = seen[0];
    expect(url).toMatch(/^\/v1\/messages/);
    expect(headers["x-api-key"]).toBe("sk-ant-uji");
    expect(String(headers["anthropic-beta"])).toMatch(/server-side-fallback-2026-07-01/);
    expect(body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 1000,
      system: "sistem",
      fallbacks: "default",
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }, { type: "text" }] }],
    });
    const text = (body.messages as { content: { text?: string }[] }[])[0].content[1].text!;
    expect(text).toMatch(/^baca denah\n\nJawab HANYA dengan satu objek JSON/);
    // Skema tidak dikirim sebagai grammar (structured output): API menolaknya karena terlalu besar.
    expect((body.output_config as Record<string, unknown>).format).toBeUndefined();
    expect(text).toContain('"platformLinks"');
  });

  it("Claude: penolakan dan kunci salah menjadi pesan yang jelas", async () => {
    reply = () => ({ status: 200, json: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: "refusal", usage: { input_tokens: 1, output_tokens: 0 } } });
    const c = new ClaudeVisionClient({ apiKey: "k", model: "claude-haiku-4-5", baseUrl: base, timeoutMs: 5000 });
    await expect(c.analyze(req)).rejects.toThrow(/menolak/);
    // Model tanpa dukungan cadangan/effort tidak dikirimi parameter itu.
    expect(seen[0].body.fallbacks).toBeUndefined();
    expect(seen[0].body.output_config).toBeUndefined();
    reply = () => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } });
    await expect(c.analyze(req)).rejects.toMatchObject({ message: expect.stringMatching(/tidak valid/), config: true });
  });

  it("Kompatibel OpenAI: data URL gambar, response_format json_schema, dan ulang tanpa format bila tidak didukung", async () => {
    reply = (_u, body) =>
      body.response_format ? { status: 400, json: { error: { message: "response_format tidak didukung" } } } : { status: 200, json: { choices: [{ message: { content: '{"ok":1}' }, finish_reason: "stop" }] } };
    const c = new OpenAiVisionClient({ model: "llava", baseUrl: `${base}/v1/`, timeoutMs: 5000 });
    expect(await c.analyze(req)).toBe('{"ok":1}');
    expect(seen).toHaveLength(2);
    expect(seen[0].url).toBe("/v1/chat/completions");
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].body).toMatchObject({ model: "llava", response_format: { type: "json_schema" } });
    const content = (seen[0].body.messages as { content: unknown }[])[1].content as { type: string; image_url?: { url: string } }[];
    expect(content[1].image_url!.url).toBe(`data:image/png;base64,${PNG}`);
    expect(seen[1].body.response_format).toBeUndefined();
    const retry = (seen[1].body.messages as { content: { type: string; text?: string }[] }[])[1].content;
    expect(retry[0].text).toMatch(/JSON Schema/);
    expect(retry[1].type).toBe("image_url");
  });
});
