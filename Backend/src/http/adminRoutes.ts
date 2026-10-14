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
import { ok, parse, rateLimit, requireAdmin } from "./middleware";

const kindSchema = z.enum(["facility", "entrance", "notice", "station_info"]);
const idParam = z.string().min(1).max(80);

/** Item yang terikat stasiun wajib punya stationId yang dikenal; pengumuman memakai targetId. */
const STATION_BOUND: ContentKind[] = ["facility", "entrance", "station_info"];

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
        return { ...st, facilities: count("facility"), entrances: count("entrance"), info: count("station_info"), pending: mine.filter((i) => i.draft !== null || i.draftDeleted).length };
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

  // ---------- Konten (fasilitas, pintu akses, pengumuman, info stasiun) ----------
  r.get("/content", async (req, res) => {
    const q = parse(z.object({ kind: kindSchema.optional(), stationId: z.string().max(80).optional() }), req.query);
    ok(res, (await s.store.content.list(q)).map(itemView));
  });

  const validateBody = async (kind: Exclude<ContentKind, "settings">, stationId: string | null, data: unknown) => {
    const parsed = parse(SCHEMAS[kind], data) as Record<string, unknown>;
    const known = new Set((await s.stations.list(newContext({ preview: true }))).map((x) => x.id));
    if (STATION_BOUND.includes(kind)) {
      if (!stationId || !known.has(stationId)) throw new AppError("INVALID", "stationId wajib diisi dengan stasiun yang dikenal.");
    }
    if (kind === "notice" && parsed.scope === "station" && !known.has(String(parsed.targetId))) throw new AppError("INVALID", "targetId harus id stasiun yang dikenal.");
    return parsed;
  };

  r.post("/content", async (req, res) => {
    const body = parse(z.object({ kind: kindSchema, stationId: z.string().max(80).nullable().optional(), data: z.unknown() }), req.body ?? {});
    const stationId = body.kind === "notice" ? null : (body.stationId ?? null);
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
    const data = await validateBody(prev.kind as Exclude<ContentKind, "settings">, prev.stationId, body.data);
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
    ok(res, {
      version: process.env.npm_package_version ?? "1.0.0",
      startedAt: s.startedAt,
      store: { kind: s.store.kind, ok: dbOk },
      commute: { source: s.commute.sourceName, baseUrl: s.config.commute.source === "http" ? s.config.commute.baseUrl : null, ...upstream },
      llm: s.llm ? { provider: s.llm.name, model: s.llm.model } : { provider: "none" },
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
