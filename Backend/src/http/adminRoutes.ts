// Endpoint admin (/api/admin/*), dipakai oleh halaman admin NTD (proyek terpisah, closed source).
// Semua endpoint selain /auth/login wajib token admin. Perubahan konten selalu masuk ke draft;
// pengguna baru melihatnya setelah dipublikasikan.

import { Router } from "express";
import { z } from "zod";
import { hashPassword, PASSWORD_MIN, publicUser, verifyPassword } from "../admin/auth";
import { testCaseSchema, testExpectSchema, testRequestSchema } from "../admin/TestRunner";
import { newContext } from "../context";
import { DEFAULT_SETTINGS, SCHEMAS, SETTINGS_ID, settingsSchema, stationIdSchema, type Settings } from "../domain/content";
import { diffDataset, gtfsHalteNear, gtfsHubSuggestions, gtfsLineCandidates, gtfsStationCandidates, gtfsStationDifferences, stalePatterns, type StationCandidate } from "../domain/datasetSync";
import type { DatasetPart } from "../data/commute/CommuteApiClient";
import { AppError } from "../errors";
import type { ContentItem, ContentKind } from "../store/types";
import type { Services } from "../services";
import { applyHubs } from "../domain/hubs";
import { applyLinks, linkKey, linkViews, suggestLinks } from "../domain/stationLinks";
import type { DefaultPattern } from "../domain/routePatterns";
import type { SyncSource } from "../domain/routeSync";
import { buildSuggestions, FLOOR_PLAN_JSON_SCHEMA, FLOOR_PLAN_SYSTEM, floorPlanPrompt, MAX_IMAGES, parseFloorPlan, sniffImage, type FloorPlanResult } from "../ai/vision/floorPlan";
import { llmAvailability } from "../ai/pipeline";
import { llmSettingsInput } from "../ai/llm/LlmService";
import { xTokenInput } from "../ai/reader/PostSourceService";
import { readerConfigInput, X_PRICE_USD } from "../ai/reader/ReaderConfig";
import { advisoryEditSchema, advisoryIngestSchema } from "../domain/serviceAdvisory";
import { VisionError } from "../ai/vision/VisionClient";
import { visionSettingsInput } from "../ai/vision/VisionService";
import { ok, parse, rateLimit, requireAdmin } from "./middleware";

const kindSchema = z.enum(["facility", "entrance", "notice", "station_info", "platform", "concourse", "map_stop", "map_track", "route_pattern", "hub", "station_link", "station_status", "station", "line"]);
const idParam = z.string().min(1).max(80);

/** Item yang terikat stasiun wajib punya stationId yang dikenal; pengumuman memakai targetId. */
const STATION_BOUND: ContentKind[] = ["facility", "entrance", "station_info", "platform", "concourse", "map_stop", "station_status"];

/** Isian pengaturan rute hasil sinkron: data dataset, dengan catatan admin dan catatan pemberhentian yang sama dipertahankan. */
function syncedPattern(lineId: string, p: DefaultPattern, source: SyncSource, at: string, prev: Record<string, unknown> | null) {
  const prevStops = (prev?.stops as { stationId: string; note?: string }[] | undefined) ?? [];
  const noteOf = new Map(prevStops.filter((x) => x.note).map((x) => [x.stationId, x.note!]));
  const headsign = p.headsign ?? (prev?.headsign as string | undefined);
  const headway = p.headwayMinutes ?? (prev?.headwayMinutes as number | undefined);
  const hours = p.serviceHours ?? (prev?.serviceHours as string | undefined);
  return {
    lineId,
    direction: p.direction,
    ...(headsign ? { headsign } : {}),
    stops: p.stops.map((x, i) => ({ stationId: x.stationId, ...(i > 0 && typeof x.minutes === "number" ? { minutes: Math.min(240, x.minutes) } : {}), ...(noteOf.has(x.stationId) ? { note: noteOf.get(x.stationId) } : {}) })),
    source,
    syncedAt: at,
    ...(headway ? { headwayMinutes: headway } : {}),
    ...(hours ? { serviceHours: hours.slice(0, 60) } : {}),
    ...(p.branches?.length ? { branches: p.branches.slice(0, 20) } : {}),
    ...(prev?.note ? { note: prev.note } : {}),
  };
}

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

  // Lini yang berlaku di pratinjau (dataset + rute tambahan/koreksi admin + urutan dari pengaturan rute).
  r.get("/lines", async (_req, res) => ok(res, await s.stations.lines(newContext({ preview: true }))));

  // ---------- Sinkron dataset: stasiun, rute, dan hub ----------
  // Muat ulang daftar stasiun, lini, dan hub dari Commute Data API sekarang juga (tanpa menunggu cache kedaluwarsa)
  // dan laporkan perubahannya: stasiun/lini/hub baru dan hilang, stasiun yang bertambah di lini (mis. stasiun yang
  // baru beroperasi), serta pengaturan rute admin yang tertinggal dari dataset.
  r.post("/dataset/refresh", requireAdmin("admin"), async (req, res) => {
    const { parts } = parse(z.object({ parts: z.array(z.enum(["stations", "lines", "hubs"])).min(1).default(["stations", "lines", "hubs"]) }), req.body ?? {});
    const view = async () => {
      const ctx = newContext({ preview: true });
      const [stations, lines, hubs] = await Promise.all([s.commute.getStations(ctx), s.commute.getLines(ctx), s.commute.getHubs(ctx)]);
      return { stations, lines, hubs };
    };
    const before = await view();
    await s.commute.refreshDataset(parts as DatasetPart[], newContext({ preview: true }));
    const after = await view();
    const ctx = newContext({ preview: true });
    const [base, snap, lineOnly] = await Promise.all([s.commute.getLineSequences(ctx), s.content.snapshot(ctx), s.commute.lineOnlyStations(ctx)]);
    const stale = stalePatterns(base, snap.routePatterns(), new Set(after.stations.map((x) => x.id)));
    const diff = diffDataset(before, after);
    await audit(req, "dataset.refresh", null, { parts, stations: diff.stations.added.length, lines: diff.lines.added.length, hubs: diff.hubs.added.length });
    ok(res, { parts, refreshedAt: new Date().toISOString(), diff, stalePatterns: stale, lineOnlyStations: lineOnly.length });
  });

  // Usulan stasiun dari sumber data yang belum ada di NTD:
  // - commute: stasiun yang tercantum di lin (/lines) tetapi belum ada di /stations (mis. stasiun perpanjangan);
  // - gtfs: halte koridor BRT di GTFS Transjakarta yang belum ada, serta halte yang nama/koordinatnya berbeda.
  r.get("/stations/candidates", async (req, res) => {
    const { source } = parse(z.object({ source: z.enum(["commute", "gtfs"]).default("commute") }), req.query);
    const ctx = newContext({ preview: true });
    if (source === "gtfs") {
      const [idx, stations] = await Promise.all([s.commute.index(ctx), s.commute.getStations(ctx)]);
      return ok(res, { source, candidates: gtfsStationCandidates(s.gtfs, idx, stations), differences: gtfsStationDifferences(s.gtfs, idx, stations) });
    }
    const [lineOnly, lines, ops] = await Promise.all([s.commute.lineOnlyStations(ctx), s.commute.getLines(ctx), s.commute.getOperators(ctx)]);
    const lineName = new Map(lines.map((l) => [l.id, l.name]));
    const opName = (code: string) => ops.find((o) => o.code === code)?.name ?? code;
    const candidates: StationCandidate[] = lineOnly.map((x) => ({
      id: x.id,
      name: x.name,
      operator: opName(x.operator),
      codes: x.number ? [x.number] : [],
      lineIds: x.lineIds,
      source: "commute",
      reason: `tercantum di ${x.lineIds.map((id) => lineName.get(id) ?? id).join(", ")}${x.number ? ` (${x.number})` : ""}, belum ada di daftar stasiun Commute`,
    }));
    ok(res, { source, candidates, differences: [] });
  });

  // Isian stasiun dari sumber data untuk satu stasiun (tambah manual: "Isi dari API Commute" / "Isi dari GTFS").
  r.get("/stations/defaults", async (req, res) => {
    const q = parse(z.object({ stationId: stationIdSchema, source: z.enum(["commute", "gtfs"]).default("commute") }), req.query);
    const ctx = newContext({ preview: true });
    const idx = await s.commute.index(ctx);
    if (q.source === "gtfs") {
      const codes = idx.refsOf(q.stationId).filter((x) => x.operator.toUpperCase() === "TJ").map((x) => x.code);
      const stops = codes.map((c) => s.gtfs.stop(c)).filter((x) => !!x);
      if (!stops.length) throw new AppError("NOT_FOUND", "Halte ini tidak ada di data GTFS Transjakarta NTD (koridor BRT).");
      const g = stops[0]!;
      const lineIds = [...new Set(stops.flatMap((x) => s.gtfs.routesAt(x!.code)).map((c) => `tj:${c.toLowerCase()}`))];
      const known = new Set((await s.stations.lines(ctx)).map((l) => l.id));
      return ok(res, { stationId: q.stationId, source: "gtfs", data: { name: stops.length > 1 ? (idx.nameOf?.(q.stationId) ?? g.name) : g.name, operator: "TransJakarta", codes: stops.map((x) => x!.code), lineIds: lineIds.filter((x) => known.has(x)), lat: g.lat, lng: g.lng } });
    }
    const st = (await s.commute.datasetStations(ctx)).find((x) => x.id === q.stationId);
    if (st) return ok(res, { stationId: q.stationId, source: "commute", data: { name: st.name, operator: st.operator, codes: st.codes, lineIds: st.lineIds, ...(st.lat !== undefined ? { lat: st.lat, lng: st.lng } : {}) } });
    const lineOnly = (await s.commute.lineOnlyStations(ctx)).find((x) => x.id === q.stationId);
    if (!lineOnly) throw new AppError("NOT_FOUND", "Stasiun ini tidak ada di Commute Data API (daftar stasiun maupun lin).");
    const ops = await s.commute.getOperators(ctx);
    ok(res, { stationId: q.stationId, source: "commute", data: { name: lineOnly.name, operator: ops.find((o) => o.code === lineOnly.operator)?.name ?? lineOnly.operator, codes: lineOnly.number ? [lineOnly.number] : [], lineIds: lineOnly.lineIds } });
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

  // ---------- Mode LLM dengan dua agent: status, pembaca akun X, dan antrean persetujuan informasi layanan ----------
  // Sakelar mode LLM = `llmEnabled` pada /settings (draft, lalu /publish). Agent navigasi dipilih pengguna lewat `pipeline`
  // pada /api/plan; agent pembaca membaca akun operator dan mengisi antrean `service-info` (status pending). Hanya yang
  // disetujui di sini yang mengubah navigasi.
  const readerView = async () => {
    const [config, state, problem, src] = await Promise.all([s.readerConfig.get(), s.readerConfig.state(), s.reader.problem(), s.postSource.view()]);
    return {
      config,
      source: { kind: src.kind, configured: src.configured },
      /** Token X (tidak pernah dikembalikan; hanya petunjuk empat karakter terakhir). */
      xToken: { ...src.token, canStore: src.canStoreToken, updatedAt: src.updatedAt, updatedBy: src.updatedBy },
      problem,
      usage: { month: state.usage.month, posts: state.usage.posts, users: state.usage.users, budget: config.monthlyPostBudget, approxCostUsd: Math.round((state.usage.posts * X_PRICE_USD.post + state.usage.users * X_PRICE_USD.user) * 1000) / 1000 },
      prices: X_PRICE_USD,
      lastPoll: state.lastPoll,
    };
  };

  r.get("/ai/status", async (_req, res) => {
    const published = (await s.content.snapshot(newContext())).settings.llmEnabled;
    const draft = ((await s.store.content.get(SETTINGS_ID))?.draft as Partial<Settings> | null | undefined)?.llmEnabled ?? null;
    const client = await s.llm.client().then((c) => (c ? { provider: c.name, model: c.model, toolCalling: typeof c.runTools === "function" } : null));
    ok(res, {
      llm: {
        enabled: published,
        /** Nilai pada draft pengaturan yang belum dipublikasikan (null = tidak ada perubahan). */
        draftEnabled: draft,
        client,
        availability: llmAvailability(published, await s.llm.client()),
      },
      reader: await readerView(),
      pendingAdvisories: (await s.advisories.list({ status: "pending", limit: 500 })).length,
    });
  });

  r.get("/ai/reader", async (_req, res) => ok(res, await readerView()));

  r.put("/ai/reader", requireAdmin("admin"), async (req, res) => {
    const body = parse(readerConfigInput.extend(xTokenInput.shape), req.body ?? {});
    const { xBearerToken, clearXToken, ...config } = body;
    await s.readerConfig.update(config, actor(req));
    // Token X dienkripsi di server; tidak pernah dikembalikan dan tidak masuk log aktivitas.
    await s.postSource.update({ xBearerToken, clearXToken }, actor(req));
    await audit(req, "ai.reader.update", null, { ...config, xToken: xBearerToken ? "(diganti)" : clearXToken ? "(dihapus)" : undefined });
    ok(res, await readerView());
  });

  // Kunci dan model LLM diatur admin di sini (berlaku langsung, tanpa restart). Kunci dienkripsi di server dan tidak pernah
  // dikembalikan; kosongkan field kunci untuk mempertahankan yang lama. Nilai kosong memakai environment (LLM_*).
  r.get("/ai/llm", async (_req, res) => ok(res, await s.llm.view()));

  r.put("/ai/llm", requireAdmin("admin"), async (req, res) => {
    const body = parse(llmSettingsInput, req.body ?? {});
    const view = await s.llm.update(body, actor(req));
    const { apiKey, ...rest } = body;
    await audit(req, "ai.llm.update", null, { ...rest, apiKey: apiKey ? "(diganti)" : undefined });
    ok(res, view);
  });

  // Uji koneksi LLM: satu panggilan singkat dengan konfigurasi yang berlaku. Dibatasi laju karena memakai kuota API.
  const llmTestLimiter = rateLimit({ windowMs: 5 * 60_000, max: 10 });
  r.post("/ai/llm/test", requireAdmin("admin"), llmTestLimiter, async (req, res) => {
    const result = await s.llm.probe();
    await audit(req, "ai.llm.test", null, { ok: result.ok, provider: result.provider, model: result.model, error: result.error });
    ok(res, result);
  });

  /** Stasiun dan lini pada isian informasi layanan harus dikenal sistem. */
  const checkAdvisoryScope = async (patch: { stationIds?: string[]; lineIds?: string[] }) => {
    const ctx = newContext({ preview: true });
    const [stations, lines] = await Promise.all([s.stations.list(ctx), s.stations.lines(ctx)]);
    const badStations = (patch.stationIds ?? []).filter((id) => !stations.some((x) => x.id === id));
    const badLines = (patch.lineIds ?? []).filter((id) => !lines.some((x) => x.id === id));
    if (badStations.length) throw new AppError("INVALID", `stationIds tidak dikenal: ${badStations.join(", ")}.`);
    if (badLines.length) throw new AppError("INVALID", `lineIds tidak dikenal: ${badLines.join(", ")}.`);
  };

  r.get("/service-info", async (req, res) => {
    const q = parse(z.object({ status: z.enum(["pending", "approved", "rejected"]).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    ok(res, await s.advisories.list(q));
  });

  // Tempel postingan operator secara manual (mis. bila akses X belum ada). Memakai LLM bila tersedia; hasilnya `pending`.
  const ingestLimiter = rateLimit({ windowMs: 10 * 60_000, max: 30 });
  r.post("/service-info/ingest", requireAdmin("admin"), ingestLimiter, async (req, res) => {
    const body = parse(advisoryIngestSchema, req.body ?? {});
    const a = await s.reader.ingest(body);
    await audit(req, "service_info.ingest", a.id, { account: a.source.account, by: a.extraction.by });
    ok(res, a, 201);
  });

  // Jalankan pembacaan akun operator sekarang (di luar jadwal).
  const pollLimiter = rateLimit({ windowMs: 60_000, max: 6 });
  r.post("/service-info/poll", requireAdmin("admin"), pollLimiter, async (req, res) => {
    const report = await s.reader.poll(`admin:${actor(req)}`);
    await audit(req, "service_info.poll", null, { skipped: report.skipped, fetched: report.fetched, created: report.created, errors: report.errors.length });
    ok(res, report);
  });

  r.get("/service-info/:id", async (req, res) => ok(res, await s.advisories.get(parse(idParam, req.params.id))));

  r.patch("/service-info/:id", async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(advisoryEditSchema, req.body ?? {});
    await checkAdvisoryScope(body);
    const a = await s.advisories.edit(id, body, actor(req));
    await audit(req, "service_info.edit", id, body);
    ok(res, a);
  });

  r.post("/service-info/:id/approve", requireAdmin("admin"), async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(advisoryEditSchema, req.body ?? {});
    await checkAdvisoryScope(body);
    const a = await s.advisories.approve(id, body, actor(req));
    await audit(req, "service_info.approve", id, { impact: a.impact, stationIds: a.stationIds, lineIds: a.lineIds, expiresAt: a.expiresAt });
    ok(res, a);
  });

  r.post("/service-info/:id/reject", requireAdmin("admin"), async (req, res) => {
    const id = parse(idParam, req.params.id);
    const { note } = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body ?? {});
    const a = await s.advisories.reject(id, note, actor(req));
    await audit(req, "service_info.reject", id, { note });
    ok(res, a);
  });

  r.post("/service-info/:id/expire", requireAdmin("admin"), async (req, res) => {
    const id = parse(idParam, req.params.id);
    const a = await s.advisories.expire(id, actor(req));
    await audit(req, "service_info.expire", id);
    ok(res, a);
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
      const unknown = [...(parsed.stops as { stationId: string }[]), ...(((parsed.branches as string[][] | undefined) ?? []).flat().map((stationId) => ({ stationId })))].filter((x) => !known.has(x.stationId));
      if (unknown.length) throw new AppError("INVALID", `stationId tidak dikenal: ${[...new Set(unknown.map((x) => x.stationId))].join(", ")}.`);
      // Satu pengaturan per lini dan arah.
      const same = (await s.store.content.list({ kind: "route_pattern" })).find((it) => {
        const v = (it.draft ?? it.published) as { lineId?: string; direction?: number } | null;
        return it.id !== selfId && !it.draftDeleted && v?.lineId === parsed.lineId && v?.direction === parsed.direction;
      });
      if (same) throw new AppError("CONFLICT", "Pengaturan rute untuk lini dan arah ini sudah ada; ubah entri yang ada.", { id: same.id });
    }
    if (kind === "station") {
      // Stasiun baru (tambah manual/impor) boleh belum dikenal; id harus slug NTD atau `operator:kode`.
      parse(stationIdSchema, stationId ?? "");
      const lines = new Set((await s.stations.lines(newContext({ preview: true }))).map((l) => l.id));
      const unknown = ((parsed.lineIds as string[] | undefined) ?? []).filter((x) => !lines.has(x));
      if (unknown.length) throw new AppError("INVALID", `lineId tidak dikenal: ${unknown.join(", ")}.`);
      // Satu isian per stasiun.
      const same = (await s.store.content.list({ kind: "station", stationId: stationId ?? undefined })).find((it) => it.id !== selfId && !it.draftDeleted);
      if (same) throw new AppError("CONFLICT", "Isian untuk stasiun ini sudah ada; ubah entri yang ada.", { id: same.id });
    }
    if (kind === "line") {
      // Satu isian per lini.
      const same = (await s.store.content.list({ kind: "line" })).find((it) => {
        const v = (it.draft ?? it.published) as { lineId?: string } | null;
        return it.id !== selfId && !it.draftDeleted && v?.lineId === parsed.lineId;
      });
      if (same) throw new AppError("CONFLICT", "Isian untuk rute ini sudah ada; ubah entri yang ada.", { id: same.id });
    }
    if (kind === "station_status") {
      // Satu status per stasiun.
      const same = (await s.store.content.list({ kind: "station_status", stationId: stationId ?? undefined })).find((it) => it.id !== selfId && !it.draftDeleted);
      if (same) throw new AppError("CONFLICT", "Status stasiun ini sudah ada; ubah entri yang ada.", { id: same.id });
    }
    if (kind === "station_link") {
      const unknown = [parsed.fromId, parsed.toId].filter((x) => !known.has(String(x)));
      if (unknown.length) throw new AppError("INVALID", `Stasiun tidak dikenal: ${unknown.join(", ")}.`);
      // Satu isian per pasangan stasiun (urutan tidak berpengaruh).
      const key = linkKey(String(parsed.fromId), String(parsed.toId));
      const same = (await s.store.content.list({ kind: "station_link" })).find((it) => {
        const v = (it.draft ?? it.published) as { fromId?: string; toId?: string } | null;
        return it.id !== selfId && !it.draftDeleted && !!v?.fromId && !!v.toId && linkKey(v.fromId, v.toId) === key;
      });
      if (same) throw new AppError("CONFLICT", "Tautan untuk pasangan stasiun ini sudah ada; ubah entri yang ada.", { id: same.id });
    }
    if (kind === "hub") {
      const unknown = (parsed.memberIds as string[]).filter((x) => !known.has(x));
      if (unknown.length) throw new AppError("INVALID", `Anggota hub tidak dikenal: ${[...new Set(unknown)].join(", ")}.`);
      // Satu isian per id hub.
      const same = (await s.store.content.list({ kind: "hub" })).find((it) => {
        const v = (it.draft ?? it.published) as { hubId?: string } | null;
        return it.id !== selfId && !it.draftDeleted && v?.hubId === parsed.hubId;
      });
      if (same) throw new AppError("CONFLICT", "Isian untuk hub ini sudah ada; ubah entri yang ada.", { id: same.id });
    }
    return parsed;
  };

  r.post("/content", async (req, res) => {
    const body = parse(z.object({ kind: kindSchema, stationId: z.string().max(80).nullable().optional(), data: z.unknown() }), req.body ?? {});
    const stationId = body.kind === "notice" || body.kind === "map_track" || body.kind === "route_pattern" || body.kind === "hub" || body.kind === "station_link" || body.kind === "line" ? null : (body.stationId ?? null);
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
    const [base, effective, snap, stations] = await Promise.all([s.commute.getLineSequences(ctx), s.planner.sequences(ctx), s.content.snapshot(ctx), s.stations.list(ctx)]);
    const baseBy = new Map(base.map((b) => [b.lineId, b.sequences]));
    // Stasiun dataset (yang sudah dikenal NTD) yang belum masuk pengaturan rute admin: perlu sinkron ulang.
    const missing = new Map(stalePatterns(base, snap.routePatterns(), new Set(stations.filter((x) => !x.inactive).map((x) => x.id))).map((x) => [x.lineId, x.missing]));
    ok(
      res,
      effective.map((e) => ({ lineId: e.lineId, sequences: e.sequences, directed: !!e.directed, base: baseBy.get(e.lineId) ?? [], ...(missing.has(e.lineId) ? { missing: missing.get(e.lineId) } : {}) })),
    );
  });

  // Rute di sumber data yang belum ada di NTD, untuk "Tambah rute": koridor BRT GTFS Transjakarta yang belum menjadi
  // lini NTD. Semua lin Commute Data API sudah otomatis menjadi lini NTD.
  r.get("/routes/candidates", async (req, res) => {
    const { source } = parse(z.object({ source: z.enum(["gtfs", "commute"]).default("gtfs") }), req.query);
    const lines = await s.stations.lines(newContext({ preview: true }));
    ok(res, { source, candidates: source === "gtfs" ? gtfsLineCandidates(s.gtfs, lines) : [] });
  });

  // Rute bawaan dua arah untuk sinkron ulang: dari GTFS Transjakarta (urutan halte, waktu jadwal, frekuensi, jam
  // layanan) atau dari Commute Data API (urutan stasiun lin; waktu, frekuensi, dan jam layanan dari jadwal untuk moda
  // rel, dari GTFS dan /headway untuk TransJakarta). Hasilnya diisikan ke editor, lalu disimpan sebagai draft.
  r.get("/routes/:lineId/defaults", async (req, res) => {
    const lineId = parse(idParam, req.params.lineId);
    const { source } = parse(z.object({ source: z.enum(["gtfs", "commute"]).default("commute") }), req.query);
    const ctx = newContext({ preview: true });
    if (!(await s.stations.lines(ctx)).some((l) => l.id === lineId)) throw new AppError("NOT_FOUND", `Lini "${lineId}" tidak ditemukan.`);
    if (source === "gtfs" && s.routeSync.autoSource(lineId) !== "gtfs") throw new AppError("NOT_FOUND", "Data GTFS hanya tersedia untuk koridor BRT TransJakarta yang tercantum di NTD.");
    ok(res, await s.routeSync.defaults(lineId, source, ctx));
  });

  // Sinkron banyak rute sekaligus: tiap lini diisi dari dataset (otomatis = GTFS untuk koridor BRT yang ada di data
  // GTFS, selain itu Commute) lalu disimpan sebagai draft kedua arah. Catatan admin dan catatan pemberhentian yang
  // stasiunnya sama dipertahankan. Dikirim bertahap dari admin (paling banyak 10 lini per permintaan).
  r.post("/routes/sync", async (req, res) => {
    const body = parse(z.object({ lineIds: z.array(idParam).min(1).max(10), source: z.enum(["auto", "gtfs", "commute"]).default("auto") }), req.body ?? {});
    const ctx = newContext({ preview: true });
    const lines = new Map((await s.stations.lines(ctx)).map((l) => [l.id, l]));
    const items = (await s.store.content.list({ kind: "route_pattern" })).filter((it) => !it.draftDeleted);
    const itemOf = (lineId: string, direction: number) =>
      items.find((it) => {
        const v = (it.draft ?? it.published) as { lineId?: string; direction?: number } | null;
        return v?.lineId === lineId && v?.direction === direction;
      });
    const results = [];
    for (const lineId of [...new Set(body.lineIds)]) {
      if (!lines.has(lineId)) {
        results.push({ lineId, ok: false, saved: [], notes: [`Lini "${lineId}" tidak ditemukan.`] });
        continue;
      }
      const source: SyncSource = body.source === "auto" ? s.routeSync.autoSource(lineId) : body.source;
      try {
        const d = await s.routeSync.defaults(lineId, source, ctx);
        if (!d.patterns.length) {
          results.push({ lineId, ok: false, source, saved: [], notes: d.notes.length ? d.notes : ["Dataset tidak memuat rute lini ini."] });
          continue;
        }
        const saved: number[] = [];
        const errors: string[] = [];
        const at = new Date().toISOString();
        for (const p of d.patterns) {
          const it = itemOf(lineId, p.direction);
          const prev = (it ? (it.draft ?? it.published) : null) as Record<string, unknown> | null;
          try {
            const data = await validateBody("route_pattern", null, syncedPattern(lineId, p, source, at, prev), it?.id);
            const item = await s.store.content.saveDraft({ id: it?.id, kind: "route_pattern", stationId: null, data, by: actor(req) });
            if (!it) items.push(item);
            saved.push(p.direction);
          } catch (e) {
            errors.push(`Arah ${p.direction + 1}: ${(e as Error).message}`);
          }
        }
        await audit(req, "routes.sync", lineId, { source, saved });
        results.push({ lineId, ok: saved.length > 0, source, saved, notes: [...d.notes, ...errors] });
      } catch (e) {
        results.push({ lineId, ok: false, source, saved: [], notes: [(e as Error).message] });
      }
    }
    ok(res, results);
  });

  // ---------- Hub transfer ----------
  // Hub yang berlaku di pratinjau (Commute + hub bawaan NTD + isian admin) dan hub bawaan sebelum isian admin.
  r.get("/hubs", async (_req, res) => {
    const ctx = newContext({ preview: true });
    const [effective, base, stations] = await Promise.all([s.stations.hubs(ctx), s.commute.getHubs(ctx), s.stations.list(ctx)]);
    ok(res, { hubs: effective, base: applyHubs(base, [], new Set(stations.map((x) => x.id))) });
  });

  // Data Commute untuk satu hub: anggota dan jalan kaki bila hub itu ada di /hubs, ditambah jalan kaki antaranggota
  // `members` dari /stations/{op}/{code}/transfers (untuk hub buatan admin).
  r.get("/hubs/defaults", async (req, res) => {
    const q = parse(z.object({ hubId: z.string().max(60).optional(), members: z.string().max(2000).optional(), source: z.enum(["commute", "gtfs"]).default("commute"), radius: z.coerce.number().min(50).max(600).default(300) }), req.query);
    const ctx = newContext({ preview: true });
    if (q.source === "gtfs") {
      // Halte koridor BRT (GTFS Transjakarta) di sekitar anggota hub; jarak garis lurus, perlu dicek di lapangan.
      const [idx, stations, hubs] = await Promise.all([s.commute.index(ctx), s.stations.list(ctx), s.stations.hubs(ctx)]);
      const byId = new Map(stations.map((x) => [x.id, x]));
      const hub = q.hubId ? hubs.find((h) => h.id === q.hubId) : undefined;
      const start = [...new Set([...(hub?.memberIds ?? []), ...(q.members ?? "").split(",").map((x) => x.trim()).filter(Boolean)])].slice(0, 20);
      const nearby = new Map<string, { stationId: string; name: string; distanceM: number; nearId: string }>();
      for (const id of start) {
        const st = byId.get(id);
        if (!st) continue;
        for (const h of gtfsHalteNear(s.gtfs, idx, byId, st, q.radius)) {
          if (start.includes(h.stationId)) continue;
          const prev = nearby.get(h.stationId);
          if (!prev || prev.distanceM > h.distanceM) nearby.set(h.stationId, { ...h, nearId: id });
        }
      }
      const added = [...nearby.values()].sort((a, b) => a.distanceM - b.distanceM);
      return ok(res, { hub: null, memberIds: [...start, ...added.map((x) => x.stationId)].slice(0, 20), walks: [], nearby: added, source: "gtfs" });
    }
    const hub = q.hubId ? (await s.commute.getHubs(ctx)).find((h) => h.id === q.hubId) : undefined;
    const members = [...new Set([...(hub?.memberIds ?? []), ...(q.members ?? "").split(",").map((x) => x.trim()).filter(Boolean)])].slice(0, 20);
    const walks = [...(hub?.walks ?? [])];
    for (const a of members)
      for (const b of members) {
        if (a === b || walks.some((w) => w.from === a && w.to === b)) continue;
        const w = await s.commute.getWalk(a, b, ctx).catch(() => undefined);
        if (w) walks.push(w);
      }
    ok(res, { hub: hub ?? null, memberIds: members, walks: walks.map(({ from, to, distanceM, minutes, notes }) => ({ from, to, distanceM, minutes, ...(notes ? { notes: notes.slice(0, 300) } : {}) })) });
  });

  // Usulan hub dari GTFS Transjakarta: halte koridor BRT di dekat stasiun rel yang belum satu hub dengannya.
  r.get("/hubs/suggestions", async (req, res) => {
    const q = parse(z.object({ source: z.enum(["gtfs"]).default("gtfs"), radius: z.coerce.number().min(50).max(600).default(250) }), req.query);
    const ctx = newContext({ preview: true });
    const [idx, stations, hubs] = await Promise.all([s.commute.index(ctx), s.stations.list(ctx), s.stations.hubs(ctx)]);
    ok(res, { source: q.source, radius: q.radius, suggestions: gtfsHubSuggestions(s.gtfs, idx, stations, hubs, q.radius) });
  });

  // ---------- Tautan transfer antar stasiun (di luar hub) ----------
  // Tautan yang berlaku di pratinjau (bawaan NTD + isian admin, draf ikut) dan tautan bawaan sebelum isian admin. Dengan
  // `stationId`, hanya tautan yang menyentuh stasiun itu, dilihat dari stasiun itu. Isian admin disunting lewat /content
  // (jenis "station_link"), jadi ikut alur draf lalu publikasi.
  r.get("/station-links", async (req, res) => {
    const q = parse(z.object({ stationId: z.string().max(80).optional() }), req.query);
    const ctx = newContext({ preview: true });
    const [effective, stations] = await Promise.all([s.planner.links(ctx), s.stations.list(ctx)]);
    const byId = new Map(stations.map((x) => [x.id, x]));
    const base = applyLinks([], new Set(byId.keys()));
    ok(res, { links: effective, base, ...(q.stationId ? { forStation: linkViews(effective, q.stationId, byId) } : {}) });
  });

  // Usulan tautan dari dataset: stasiun/halte yang berdekatan tetapi belum satu hub dan belum bertaut (jarak garis lurus).
  // Dengan `stationId`, hanya pasangan untuk stasiun itu, dilengkapi jarak/waktu/petunjuk dari Commute (/transfers) bila ada.
  // Hanya usulan: tidak ada yang disimpan sampai admin menyimpannya sebagai draf lalu mempublikasikannya.
  r.get("/station-links/suggestions", async (req, res) => {
    const q = parse(z.object({ stationId: z.string().max(80).optional(), radius: z.coerce.number().min(50).max(1000).default(300), limit: z.coerce.number().int().min(1).max(100).default(40) }), req.query);
    const ctx = newContext({ preview: true });
    const [stations, hubs, links] = await Promise.all([s.stations.list(ctx), s.stations.hubs(ctx), s.planner.links(ctx)]);
    const byId = new Map(stations.map((x) => [x.id, x]));
    const found = suggestLinks(stations, hubs, links, { radiusM: q.radius, ...(q.stationId ? { stationId: q.stationId } : {}) }).slice(0, q.limit);
    const suggestions = await Promise.all(
      found.map(async (x) => {
        const walk = q.stationId ? ((await s.commute.getWalk(x.fromId, x.toId, ctx).catch(() => undefined)) ?? (await s.commute.getWalk(x.toId, x.fromId, ctx).catch(() => undefined))) : undefined;
        return {
          ...x,
          fromName: byId.get(x.fromId)?.name ?? x.fromId,
          toName: byId.get(x.toId)?.name ?? x.toId,
          ...(walk ? { walk: { distanceM: walk.distanceM, minutes: walk.minutes, ...(walk.notes ? { notes: walk.notes.slice(0, 300) } : {}) } } : {}),
        };
      }),
    );
    ok(res, { radius: q.radius, suggestions });
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
      llm: await s.llm.client().then((c) => (c ? { provider: c.name, model: c.model } : { provider: "none" })),
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
