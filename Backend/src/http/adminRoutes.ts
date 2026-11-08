// Endpoint admin (/api/admin/*), dipakai oleh halaman admin NTD (proyek terpisah, closed source).
// Semua endpoint selain /auth/login wajib token admin. Perubahan konten selalu masuk ke draft;
// pengguna baru melihatnya setelah dipublikasikan.

import { Router } from "express";
import { z } from "zod";
import { hashPassword, PASSWORD_MIN, publicUser, verifyPassword } from "../admin/auth";
import { testCaseSchema, testExpectSchema, testRequestSchema } from "../admin/TestRunner";
import { newContext } from "../context";
import { DEFAULT_SETTINGS, SCHEMAS, SETTINGS_ID, settingsSchema, type Settings } from "../domain/content";
import { AppError } from "../errors";
import type { ContentItem, ContentKind } from "../store/types";
import type { Services } from "../services";
import { lineRefOf } from "../data/commute/station-index";
import { defaultsFromGtfs, defaultsFromSequences } from "../domain/routePatterns";
import { buildSuggestions, FLOOR_PLAN_JSON_SCHEMA, FLOOR_PLAN_SYSTEM, floorPlanPrompt, MAX_IMAGES, parseFloorPlan, sniffImage, type FloorPlanResult } from "../ai/vision/floorPlan";
import { VisionError } from "../ai/vision/VisionClient";
import { visionSettingsInput } from "../ai/vision/VisionService";
import { ok, parse, rateLimit, requireAdmin } from "./middleware";

const kindSchema = z.enum(["facility", "entrance", "notice", "station_info", "platform", "concourse", "map_stop", "map_track", "route_pattern"]);
const idParam = z.string().min(1).max(80);

/** Item yang terikat stasiun wajib punya stationId yang dikenal; pengumuman memakai targetId. */
const STATION_BOUND: ContentKind[] = ["facility", "entrance", "station_info", "platform", "concourse", "map_stop"];

function itemView(i: ContentItem) {
  const state = i.draftDeleted ? "akan_dihapus" : i.published === null ? "baru" : i.draft !== null ? "diubah" : "terbit";
  return { ...i, state };
}

export function adminRoutes(s: Services): Router {
  const r = Router();
  const actor = (req: { admin?: { email: string } }) => req.admin?.email ?? "unknown";
  const audit = (req: { admin?: { email: string } }, action: string, target?: string | null, detail?: unknown) =>
    s.store.audit.add({ actor: actor(req), action, target, detail });

  // ---------- Autentikasi ----------
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10 });
  r.post("/auth/login", loginLimiter, async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body ?? {});
    const user = await s.auth.login(email, password);
    if (!user) throw new AppError("UNAUTHORIZED", "Email atau kata sandi salah.");
    await s.store.audit.add({ actor: user.email, action: "login" });
    ok(res, { ...s.auth.sign(user), user: publicUser(user) });
  });

  r.use(requireAdmin());

  r.get("/auth/me", (req, res) => ok(res, publicUser(req.admin!)));

  r.post("/auth/password", async (req, res) => {
    const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string(), newPassword: z.string().min(PASSWORD_MIN).max(200) }), req.body ?? {});
    if (!(await verifyPassword(currentPassword, req.admin!.passwordHash))) throw new AppError("INVALID", "Kata sandi saat ini salah.");
    await s.store.admins.update(req.admin!.id, { passwordHash: await hashPassword(newPassword) });
    await audit(req, "password.change", req.admin!.id);
    ok(res, { changed: true });
  });

  // ---------- Pengguna admin ----------
  r.get("/users", requireAdmin("admin"), async (_req, res) => ok(res, (await s.store.admins.list()).map(publicUser)));

  r.post("/users", requireAdmin("admin"), async (req, res) => {
    const body = parse(
      z.object({ email: z.string().email(), name: z.string().min(1).max(80), role: z.enum(["admin", "editor"]), password: z.string().min(PASSWORD_MIN).max(200) }),
      req.body ?? {},
    );
    if (await s.store.admins.byEmail(body.email)) throw new AppError("CONFLICT", "Email sudah terdaftar.");
    const u = await s.store.admins.create({ email: body.email, name: body.name, role: body.role, passwordHash: await hashPassword(body.password), active: true });
    await audit(req, "user.create", u.id, { email: u.email, role: u.role });
    ok(res, publicUser(u), 201);
  });

  r.patch("/users/:id", requireAdmin("admin"), async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(
      z.object({ name: z.string().min(1).max(80).optional(), role: z.enum(["admin", "editor"]).optional(), active: z.boolean().optional(), password: z.string().min(PASSWORD_MIN).max(200).optional() }),
      req.body ?? {},
    );
    if (id === req.admin!.id && (body.active === false || body.role === "editor")) throw new AppError("INVALID", "Tidak dapat menonaktifkan atau menurunkan peran akun sendiri.");
    const u = await s.store.admins.update(id, { name: body.name, role: body.role, active: body.active, passwordHash: body.password ? await hashPassword(body.password) : undefined });
    if (!u) throw new AppError("NOT_FOUND", "Pengguna tidak ditemukan.");
    await audit(req, "user.update", id, { ...body, password: body.password ? "(diubah)" : undefined });
    ok(res, publicUser(u));
  });

  // ---------- Stasiun: data dataset + konten tim ----------
  r.get("/stations", async (req, res) => {
    const ctx = newContext({ preview: true });
    const [stations, items] = await Promise.all([s.stations.list(ctx), s.store.content.list()]);
    ok(
      res,
      stations.map((st) => {
        const mine = items.filter((i) => i.stationId === st.id);
        const count = (k: ContentKind) => mine.filter((i) => i.kind === k && !i.draftDeleted).length;
        return { ...st, facilities: count("facility"), entrances: count("entrance"), platforms: count("platform"), concourses: count("concourse"), info: count("station_info"), pending: mine.filter((i) => i.draft !== null || i.draftDeleted).length };
      }),
    );
  });

  r.get("/stations/:id", async (req, res) => {
    const id = parse(idParam, req.params.id);
    const ctx = newContext({ preview: true });
    const snap = await s.content.snapshot(ctx);
    const [preview, dataset, items] = await Promise.all([
      s.stations.detail(id, ctx, snap),
      s.commute.getStationAmenities(id, ctx),
      s.store.content.list({ stationId: id }),
    ]);
    if (!preview) throw new AppError("NOT_FOUND", `Stasiun "${id}" tidak ditemukan.`);
    const pub = await s.stations.detail(id, newContext(), await s.content.snapshot(newContext()));
    ok(res, { preview, published: pub, datasetAmenities: dataset, items: items.map(itemView) });
  });

  // ---------- Isi fasilitas dari gambar denah (AI) ----------
  // Gambar dikirim ke penyedia AI dari backend (kunci API tidak pernah ke browser). Hasilnya hanya usulan:
  // tidak ada yang disimpan; admin memeriksa, menyunting, lalu menyimpan lewat POST/PUT /content.
  const floorPlanLimiter = rateLimit({ windowMs: 10 * 60_000, max: 20 });
  r.post("/stations/:id/floor-plan", floorPlanLimiter, async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(
      z.object({
        images: z
          .array(z.object({ data: z.string().min(16).max(8_000_000), name: z.string().max(200).optional() }))
          .min(1, "unggah minimal satu gambar")
          .max(MAX_IMAGES, `maksimal ${MAX_IMAGES} gambar sekaligus`),
      }),
      req.body ?? {},
    );
    const images = body.images.map((img, i) => {
      const data = img.data.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
      const sniff = sniffImage(data);
      if ("error" in sniff) throw new AppError("INVALID", `Gambar ${img.name ?? i + 1}: ${sniff.error}.`);
      return { mediaType: sniff.mediaType, data };
    });

    const ctx = newContext({ preview: true });
    const snap = await s.content.snapshot(ctx);
    const [station, lines, items] = await Promise.all([s.stations.detail(id, ctx, snap), s.stations.lines(ctx), s.store.content.list({ stationId: id })]);
    if (!station) throw new AppError("NOT_FOUND", `Stasiun "${id}" tidak ditemukan.`);

    const client = await s.vision.client();
    if (!client) {
      const v = await s.vision.view();
      throw new AppError("CONFLICT", `AI pembaca denah belum siap: ${v.problem ?? "konfigurasi belum lengkap"} Atur di Pengaturan → AI pembaca denah.`);
    }

    const started = Date.now();
    let text: string;
    try {
      text = await client.analyze({
        system: FLOOR_PLAN_SYSTEM,
        prompt: floorPlanPrompt(
          {
            id: station.id,
            name: station.name,
            operator: station.operator,
            codes: station.codes,
            lines: lines.filter((l) => station.lineIds.includes(l.id)).map((l) => `${l.name} (${l.id})`),
            platformCodes: station.platforms.map((p) => p.code),
            exits: station.entrances.map((e) => e.name),
            concourses: (station.concourses ?? []).map((c) => c.code),
          },
          images.length,
        ),
        images,
        schema: FLOOR_PLAN_JSON_SCHEMA,
        maxTokens: 16_000,
      });
    } catch (e) {
      const msg = e instanceof VisionError ? e.message : `AI: ${(e as Error).message}`;
      s.log.warn("floor-plan", { stationId: id, provider: client.name, model: client.model, error: msg });
      await audit(req, "ai.floor_plan.error", id, { provider: client.name, model: client.model, images: images.length, error: msg });
      throw new AppError(e instanceof VisionError && e.config ? "CONFLICT" : "API_DOWN", msg);
    }

    let raw;
    try {
      raw = parseFloorPlan(text);
    } catch (e) {
      await audit(req, "ai.floor_plan.error", id, { provider: client.name, model: client.model, error: (e as Error).message });
      throw new AppError("API_DOWN", "Jawaban AI tidak dapat dibaca. Coba lagi atau gunakan model lain.");
    }
    const result: FloorPlanResult = {
      stationId: id,
      ...buildSuggestions(raw, items, station),
      provider: client.name,
      model: client.model,
      durationMs: Date.now() - started,
    };
    await audit(req, "ai.floor_plan", id, { provider: client.name, model: client.model, images: images.length, suggestions: result.suggestions.length });
    ok(res, result);
  });

  r.get("/ai/vision", async (_req, res) => ok(res, await s.vision.view()));

  r.put("/ai/vision", requireAdmin("admin"), async (req, res) => {
    const body = parse(visionSettingsInput, req.body ?? {});
    const view = await s.vision.update(body, actor(req));
    const { apiKey, ...rest } = body;
    await audit(req, "ai.vision.update", null, { ...rest, apiKey: apiKey ? "(diganti)" : undefined });
    ok(res, view);
  });

  // ---------- Konten (fasilitas, pintu akses, pengumuman, info stasiun) ----------
  r.get("/content", async (req, res) => {
    const q = parse(z.object({ kind: kindSchema.optional(), stationId: z.string().max(80).optional() }), req.query);
    ok(res, (await s.store.content.list(q)).map(itemView));
  });

  const validateBody = async (kind: Exclude<ContentKind, "settings">, stationId: string | null, data: unknown, selfId?: string) => {
    const parsed = parse(SCHEMAS[kind], data) as Record<string, unknown>;
    const known = new Set((await s.stations.list(newContext({ preview: true }))).map((x) => x.id));
    if (STATION_BOUND.includes(kind)) {
      if (!stationId || !known.has(stationId)) throw new AppError("INVALID", "stationId wajib diisi dengan stasiun yang dikenal.");
    }
    if (kind === "notice" && parsed.scope === "station" && !known.has(String(parsed.targetId))) throw new AppError("INVALID", "targetId harus id stasiun yang dikenal.");
    if (kind === "platform") {
      const lines = new Set((await s.stations.lines(newContext({ preview: true }))).map((l) => l.id));
      const unknown = ((parsed.serves as { lineId: string }[] | undefined) ?? []).filter((x) => !lines.has(x.lineId));
      if (unknown.length) throw new AppError("INVALID", `lineId tidak dikenal: ${unknown.map((x) => x.lineId).join(", ")}.`);
    }
    if (kind === "map_track") {
      if (!known.has(String(parsed.fromStationId)) || !known.has(String(parsed.toStationId))) throw new AppError("INVALID", "fromStationId dan toStationId harus id stasiun yang dikenal.");
      const lines = new Set((await s.stations.lines(newContext({ preview: true }))).map((l) => l.id));
      if (!lines.has(String(parsed.lineId))) throw new AppError("INVALID", "lineId harus id lini yang dikenal.");
    }
    if (kind === "map_stop" && parsed.lineId !== undefined) {
      const lines = new Set((await s.stations.lines(newContext({ preview: true }))).map((l) => l.id));
      if (!lines.has(String(parsed.lineId))) throw new AppError("INVALID", "lineId titik anak harus id lini yang dikenal.");
    }
    if (kind === "route_pattern") {
      const lines = new Set((await s.stations.lines(newContext({ preview: true }))).map((l) => l.id));
      if (!lines.has(String(parsed.lineId))) throw new AppError("INVALID", "lineId harus id lini yang dikenal.");
      const unknown = (parsed.stops as { stationId: string }[]).filter((x) => !known.has(x.stationId));
      if (unknown.length) throw new AppError("INVALID", `stationId tidak dikenal: ${[...new Set(unknown.map((x) => x.stationId))].join(", ")}.`);
      // Satu pengaturan per lini dan arah.
      const same = (await s.store.content.list({ kind: "route_pattern" })).find((it) => {
        const v = (it.draft ?? it.published) as { lineId?: string; direction?: number } | null;
        return it.id !== selfId && !it.draftDeleted && v?.lineId === parsed.lineId && v?.direction === parsed.direction;
      });
      if (same) throw new AppError("CONFLICT", "Pengaturan rute untuk lini dan arah ini sudah ada; ubah entri yang ada.", { id: same.id });
    }
    return parsed;
  };

  r.post("/content", async (req, res) => {
    const body = parse(z.object({ kind: kindSchema, stationId: z.string().max(80).nullable().optional(), data: z.unknown() }), req.body ?? {});
    const stationId = body.kind === "notice" || body.kind === "map_track" || body.kind === "route_pattern" ? null : (body.stationId ?? null);
    const data = await validateBody(body.kind, stationId, body.data);
    const item = await s.store.content.saveDraft({ kind: body.kind, stationId, data, by: actor(req) });
    await audit(req, "content.create", item.id, { kind: body.kind, stationId });
    ok(res, itemView(item), 201);
  });

  r.put("/content/:id", async (req, res) => {
    const id = parse(idParam, req.params.id);
    const prev = await s.store.content.get(id);
    if (!prev || prev.kind === "settings") throw new AppError("NOT_FOUND", "Konten tidak ditemukan.");
    const body = parse(z.object({ data: z.unknown() }), req.body ?? {});
    const data = await validateBody(prev.kind as Exclude<ContentKind, "settings">, prev.stationId, body.data, id);
    const item = await s.store.content.saveDraft({ id, kind: prev.kind, stationId: prev.stationId, data, by: actor(req) });
    await audit(req, "content.update", id, { kind: prev.kind });
    ok(res, itemView(item));
  });

  r.delete("/content/:id", async (req, res) => {
    const id = parse(idParam, req.params.id);
    const prev = await s.store.content.get(id);
    if (!prev || prev.kind === "settings") throw new AppError("NOT_FOUND", "Konten tidak ditemukan.");
    const item = await s.store.content.markDeleted(id, actor(req));
    await audit(req, "content.delete", id, { kind: prev.kind });
    ok(res, item ? itemView(item) : { id, removed: true });
  });

  r.post("/content/:id/discard", async (req, res) => {
    const id = parse(idParam, req.params.id);
    const item = await s.store.content.discardDraft(id);
    await audit(req, "content.discard", id);
    ok(res, item ? itemView(item) : { id, removed: true });
  });

  // ---------- Rute per lini dan arah ----------
  // Urutan stasiun tiap lini yang berlaku di pratinjau (bawaan + pengaturan admin), termasuk ruas cabang/ramp
  // satu arah (mis. putaran Kota Tua dan Blok M koridor 1), untuk editor rute dan editor peta.
  r.get("/routes", async (_req, res) => {
    const ctx = newContext({ preview: true });
    const [base, effective] = await Promise.all([s.commute.getLineSequences(ctx), s.planner.sequences(ctx)]);
    const baseBy = new Map(base.map((b) => [b.lineId, b.sequences]));
    ok(
      res,
      effective.map((e) => ({ lineId: e.lineId, sequences: e.sequences, directed: !!e.directed, base: baseBy.get(e.lineId) ?? [] })),
    );
  });

  // Rute bawaan dua arah untuk sinkron ulang: dari GTFS Transjakarta (urutan halte dan waktu jadwal) atau dari
  // Commute Data API (urutan stasiun lin; tanpa waktu tempuh). Hasilnya diisikan ke editor, lalu disimpan sebagai draft.
  r.get("/routes/:lineId/defaults", async (req, res) => {
    const lineId = parse(idParam, req.params.lineId);
    const { source } = parse(z.object({ source: z.enum(["gtfs", "commute"]).default("commute") }), req.query);
    const ctx = newContext({ preview: true });
    if (!(await s.stations.lines(ctx)).some((l) => l.id === lineId)) throw new AppError("NOT_FOUND", `Lini "${lineId}" tidak ditemukan.`);
    if (source === "gtfs") {
      const ref = lineRefOf(lineId);
      if (ref?.operator !== "TJ" || !s.gtfs.hasRoute(ref.code)) throw new AppError("NOT_FOUND", "Data GTFS hanya tersedia untuk koridor BRT TransJakarta yang tercantum di NTD.");
      const idx = await s.commute.index(ctx);
      const patterns = defaultsFromGtfs(s.gtfs, ref.code, (code) => idx.idOf({ operator: "TJ", code }));
      return ok(res, { source, patterns, branches: [] });
    }
    const seq = (await s.commute.getLineSequences(ctx)).find((x) => x.lineId === lineId);
    ok(res, { source, ...defaultsFromSequences(seq) });
  });

  // ---------- Pengaturan (bobot skor, ambang, disclaimer, LLM, TTL cache) ----------
  r.get("/settings", async (_req, res) => {
    const item = await s.store.content.get(SETTINGS_ID);
    ok(res, {
      defaults: DEFAULT_SETTINGS,
      published: { ...DEFAULT_SETTINGS, ...((item?.published as Partial<Settings>) ?? {}) },
      draft: item?.draft ? { ...DEFAULT_SETTINGS, ...(item.draft as Partial<Settings>) } : null,
    });
  });

  r.put("/settings", async (req, res) => {
    const data = parse(settingsSchema, (req.body ?? {}).data);
    const item = await s.store.content.saveDraft({ id: SETTINGS_ID, kind: "settings", stationId: null, data, by: actor(req) });
    await audit(req, "settings.update", SETTINGS_ID);
    ok(res, itemView(item));
  });

  // ---------- Publikasi ----------
  r.get("/pending", async (_req, res) => ok(res, (await s.store.content.pending()).map(itemView)));

  r.post("/publish", requireAdmin("admin"), async (req, res) => {
    const body = parse(z.object({ ids: z.array(idParam).min(1).optional(), force: z.boolean().optional() }), req.body ?? {});
    const snap = await s.content.snapshot(newContext({ preview: true }));
    let testRun = null;
    if (snap.settings.requireTestsBeforePublish || (await s.content.snapshot(newContext())).settings.requireTestsBeforePublish) {
      testRun = await s.tests.runAll("preview", actor(req));
      if (testRun.failed > 0 && !body.force) {
        throw new AppError("CONFLICT", `${testRun.failed} kasus uji gagal pada data draft. Perbaiki atau publikasikan paksa.`, { testRunId: testRun.id });
      }
    }
    const result = await s.store.content.publish(body.ids ?? "all", actor(req));
    s.content.invalidate();
    await audit(req, "publish", null, { ...result, ids: body.ids ?? "all", forced: !!body.force, testRunId: testRun?.id });
    ok(res, { ...result, testRun });
  });

  // ---------- Uji coba API ----------
  r.get("/tests", async (_req, res) => ok(res, await s.store.tests.listCases()));

  r.post("/tests", async (req, res) => {
    const body = parse(testCaseSchema, req.body ?? {});
    const c = await s.store.tests.saveCase(body);
    await audit(req, "test.create", c.id, { name: c.name });
    ok(res, c, 201);
  });

  r.put("/tests/:id", async (req, res) => {
    const id = parse(idParam, req.params.id);
    if (!(await s.store.tests.getCase(id))) throw new AppError("NOT_FOUND", "Kasus uji tidak ditemukan.");
    const c = await s.store.tests.saveCase({ id, ...parse(testCaseSchema, req.body ?? {}) });
    await audit(req, "test.update", id);
    ok(res, c);
  });

  r.delete("/tests/:id", async (req, res) => {
    const id = parse(idParam, req.params.id);
    if (!(await s.store.tests.deleteCase(id))) throw new AppError("NOT_FOUND", "Kasus uji tidak ditemukan.");
    await audit(req, "test.delete", id);
    ok(res, { id, removed: true });
  });

  const modeSchema = z.object({ mode: z.enum(["preview", "published"]).default("preview") });

  r.post("/tests/run", async (req, res) => {
    const { mode } = parse(modeSchema, req.body ?? {});
    ok(res, await s.tests.runAll(mode, actor(req)));
  });

  r.post("/tests/:id/run", async (req, res) => {
    const id = parse(idParam, req.params.id);
    const c = await s.store.tests.getCase(id);
    if (!c) throw new AppError("NOT_FOUND", "Kasus uji tidak ditemukan.");
    const { mode } = parse(modeSchema, req.body ?? {});
    ok(res, await s.tests.runCase(c, mode));
  });

  /** Uji sekali jalan tanpa menyimpan kasus. */
  r.post("/tests/adhoc", async (req, res) => {
    const body = parse(z.object({ request: testRequestSchema, expect: testExpectSchema.default({ status: "ok" }), mode: z.enum(["preview", "published"]).default("preview") }), req.body ?? {});
    ok(res, await s.tests.runCase({ id: "adhoc", name: "adhoc", request: body.request, expect: body.expect }, body.mode));
  });

  r.get("/tests/runs", async (req, res) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
    ok(res, await s.store.tests.listRuns(limit));
  });

  // ---------- Sistem ----------
  r.get("/system", async (_req, res) => {
    const [dbOk, upstream, cache, pending, admins] = await Promise.all([
      s.store.ping(),
      s.commute.ping(),
      s.store.cache.stats(),
      s.store.content.pending(),
      s.store.admins.count(),
    ]);
    // Stasiun pada tabel slug (station-index.ts) yang tidak dikenali pada sumber data: perlu dicek tim.
    const mapping = await s.commute
      .index(newContext())
      .then((idx) => ({ unmatched: idx.unmatched }))
      .catch((e: Error) => ({ unmatched: [] as string[], error: e.message }));
    ok(res, {
      version: process.env.npm_package_version ?? "1.0.0",
      startedAt: s.startedAt,
      store: { kind: s.store.kind, ok: dbOk },
      commute: { source: s.commute.sourceName, baseUrl: s.config.commute.source === "http" ? s.config.commute.baseUrl : null, ...upstream, mapping },
      llm: s.llm ? { provider: s.llm.name, model: s.llm.model } : { provider: "none" },
      vision: await s.vision.view().then((v) => ({ provider: v.provider, model: v.model, ready: v.ready })),
      cache,
      pendingChanges: pending.length,
      admins,
    });
  });

  r.post("/cache/purge", requireAdmin("admin"), async (req, res) => {
    const { prefix } = parse(z.object({ prefix: z.string().max(80).optional() }), req.body ?? {});
    const removed = await s.store.cache.purge(prefix);
    await audit(req, "cache.purge", prefix ?? null, { removed });
    ok(res, { removed });
  });

  r.get("/audit", async (req, res) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    ok(res, await s.store.audit.list(limit));
  });

  return r;
}
