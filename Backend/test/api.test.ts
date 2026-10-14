import request from "supertest";
import { EDITOR, FakeLlm, makeTestApp } from "./helpers";

const plan = (app: Parameters<typeof request>[0], body: object, headers: Record<string, string> = {}) =>
  request(app).post("/api/plan").set(headers).send(body);

describe("API publik", () => {
  it("GET /health", async () => {
    const { app } = await makeTestApp();
    expect((await request(app).get("/health")).body).toEqual({ status: "ok" });
  });

  it("autocomplete stasiun tanpa agen", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/api/stations?q=mang");
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual(["mangga-besar", "manggarai"]);
    expect((await request(app).get("/api/stations")).body.data).toHaveLength(20);
  });

  it("detail stasiun memuat fasilitas dan penilaian", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/api/stations/sudirman");
    expect(res.body.data).toMatchObject({ id: "sudirman", amenities: { lift: "absent" }, assessment: { score: 45, adequate: false } });
    expect((await request(app).get("/api/stations/tidak-ada")).status).toBe(404);
  });

  it("GET /api/network memuat semua stasiun dengan skor, lini, dan hub untuk GUI", async () => {
    const { app } = await makeTestApp();
    const d = (await request(app).get("/api/network")).body.data;
    expect(d.stations).toHaveLength(20);
    expect(d.stations.find((s: { id: string }) => s.id === "sudirman")).toMatchObject({ amenities: { lift: "absent" }, assessment: { score: 45 } });
    expect(d.lines.map((l: { id: string }) => l.id)).toContain("mrt-ns");
    expect(d.hubs[0]).toMatchObject({ id: "dukuh-atas" });
  });

  it("POST /api/plan menghasilkan JourneyPlan dengan bentuk yang dipakai GUI", async () => {
    const { app } = await makeTestApp();
    const res = await plan(app, { originId: "tanah-abang", destinationId: "dukuh-atas-mrt" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    const d = res.body.data;
    for (const k of ["originId", "destinationId", "route", "assessments", "alternatives", "notification", "warnings", "disclaimer"]) expect(d).toHaveProperty(k);
    expect(d.route.legs[0]).toMatchObject({ type: "RIDE", lineId: "krl-cikarang", stops: ["tanah-abang", "bni-city"], fare: 3000 });
    expect(d.notification).toMatchObject({ source: "TEMPLATE", grounded: true });
    expect(d.attribution).toMatch(/ODbL/);
  });

  it("merekomendasikan alternatif bila titik transfer tidak memadai", async () => {
    const { app } = await makeTestApp();
    // Jakarta Kota → Dukuh Atas BNI: rute dasar transfer di Sudirman (lift tidak tercatat).
    const res = await plan(app, { originId: "jakarta-kota", destinationId: "dukuh-atas-mrt" });
    const d = res.body.data;
    const transfers = d.route.legs.filter((l: { type: string }) => l.type === "TRANSFER").flatMap((l: { stops: string[] }) => l.stops);
    expect(transfers).toContain("sudirman");
    expect(d.alternatives[0]).toMatchObject({ hubId: "dukuh-atas", viaStationId: "bni-city", replacesStationId: "sudirman", avoid: ["sudirman"] });
    expect(d.alternatives[0].route.legs.length).toBeGreaterThan(1);

    // GUI memilih alternatif dengan mengirim avoid.
    const again = await plan(app, { originId: "jakarta-kota", destinationId: "dukuh-atas-mrt", avoid: ["sudirman"] });
    const t2 = again.body.data.route.legs.filter((l: { type: string }) => l.type === "TRANSFER").flatMap((l: { stops: string[] }) => l.stops);
    expect(t2).not.toContain("sudirman");
    expect(t2).toContain("bni-city");
  });

  it("galat INVALID dan NOT_FOUND", async () => {
    const { app } = await makeTestApp();
    expect((await plan(app, { originId: "tanah-abang" })).body).toMatchObject({ status: "error", code: "INVALID" });
    expect((await plan(app, { originId: "tanah-abang", destinationId: "tanah-abang" })).body.code).toBe("INVALID");
    expect((await plan(app, { originId: "tanah-abang", destinationId: "zzz" })).body.code).toBe("INVALID");
    const bad = await request(app).post("/api/plan").set("content-type", "application/json").send("{bukan json");
    expect(bad.status).toBe(400);
  });

  it("memakai cache bila Commute Data API tidak dapat dihubungi, dan API_DOWN bila cache kosong", async () => {
    const { app, source } = await makeTestApp();
    source.failing = true;
    const down = await plan(app, { originId: "tanah-abang", destinationId: "manggarai" });
    expect(down.status).toBe(503);
    expect(down.body.code).toBe("API_DOWN");

    source.failing = false;
    await plan(app, { originId: "tanah-abang", destinationId: "manggarai" });
    source.failing = true;
    // Paksa cache stasiun kedaluwarsa agar jalur "stale" ikut teruji.
    const cached = await plan(app, { originId: "tanah-abang", destinationId: "manggarai" });
    expect(cached.status).toBe(200);
    expect(cached.body.data.fromCache).toMatch(/WIB$/);
    expect(cached.body.data.warnings.join(" ")).toMatch(/salinan tersimpan/);
  });

  it("mode pratinjau ditolak tanpa token admin", async () => {
    const { app } = await makeTestApp();
    const res = await plan(app, { originId: "tanah-abang", destinationId: "manggarai" }, { "X-NTD-Preview": "1" });
    expect(res.status).toBe(401);
  });

  it("CORS hanya untuk origin yang diizinkan", async () => {
    const { app } = await makeTestApp({ env: { CORS_ORIGINS: "https://ntd.example", ADMIN_ORIGINS: "https://admin.ntd.example" } });
    const okRes = await request(app).get("/api/meta").set("Origin", "https://ntd.example");
    expect(okRes.headers["access-control-allow-origin"]).toBe("https://ntd.example");
    const bad = await request(app).get("/api/meta").set("Origin", "https://jahat.example");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    const adminFromPublic = await request(app).options("/api/admin/auth/me").set("Origin", "https://ntd.example").set("Access-Control-Request-Method", "GET");
    expect(adminFromPublic.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("Notifikasi LLM dan Grounding Guard", () => {
  it("memakai teks LLM bila lolos validasi", async () => {
    const llm = new FakeLlm("Naik Lin Cikarang dari Tanah Abang ke Sudirman Baru BNI City, lalu berjalan kaki ke Dukuh Atas BNI. Lift tercatat tersedia di Dukuh Atas BNI.");
    const { app } = await makeTestApp({ llm });
    const res = await plan(app, { originId: "tanah-abang", destinationId: "dukuh-atas-mrt" });
    expect(res.body.data.notification).toEqual({ text: llm.reply, source: "LLM", grounded: true });
    expect(llm.calls).toBe(1);
  });

  it("beralih ke template bila LLM berhalusinasi atau gagal", async () => {
    const llm = new FakeLlm("Transit di Manggarai, lift tersedia di Sudirman. Perjalanan 45 menit.");
    const { app } = await makeTestApp({ llm });
    const res = await plan(app, { originId: "tanah-abang", destinationId: "dukuh-atas-mrt" });
    expect(res.body.data.notification.source).toBe("TEMPLATE");

    llm.reply = new Error("timeout");
    expect((await plan(app, { originId: "tanah-abang", destinationId: "dukuh-atas-mrt" })).body.data.notification.source).toBe("TEMPLATE");
  });
});

describe("API admin", () => {
  it("login, token salah, dan peran", async () => {
    const { app, login } = await makeTestApp();
    expect((await request(app).post("/api/admin/auth/login").send({ email: "admin@ntd.test", password: "salah-sekali" })).status).toBe(401);
    expect((await request(app).get("/api/admin/auth/me")).status).toBe(401);
    expect((await request(app).get("/api/admin/auth/me").set("Authorization", "Bearer abc.def")).status).toBe(401);
    const token = await login();
    const me = await request(app).get("/api/admin/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.data).toMatchObject({ email: "admin@ntd.test", role: "admin" });
    expect(me.body.data.passwordHash).toBeUndefined();
    const editor = await login(EDITOR);
    expect((await request(app).post("/api/admin/publish").set("Authorization", `Bearer ${editor}`).send({})).status).toBe(403);
  });

  it("draft hanya terlihat di pratinjau sampai dipublikasikan", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const create = await request(app)
      .post("/api/admin/content")
      .set(auth)
      .send({ kind: "facility", stationId: "bni-city", data: { type: "lift", status: "out_of_service", note: "Lift pintu utara dalam perbaikan" } });
    expect(create.status).toBe(201);
    expect(create.body.data.state).toBe("baru");

    const pub = await request(app).get("/api/stations/bni-city");
    expect(pub.body.data.amenities.lift).toBe("available");
    const prev = await request(app).get("/api/stations/bni-city").set(auth).set("X-NTD-Preview", "1");
    expect(prev.body.data.amenities.lift).toBe("absent");
    expect(prev.body.data.assessment.notes[0]).toMatch(/perbaikan/);

    expect((await request(app).get("/api/admin/pending").set(auth)).body.data).toHaveLength(1);
    const p = await request(app).post("/api/admin/publish").set(auth).send({});
    expect(p.body.data).toMatchObject({ published: 1, deleted: 0 });
    expect((await request(app).get("/api/stations/bni-city")).body.data.amenities.lift).toBe("absent");

    // Hapus → tetap terlihat sampai publikasi berikutnya.
    await request(app).delete(`/api/admin/content/${create.body.data.id}`).set(auth);
    expect((await request(app).get("/api/stations/bni-city")).body.data.amenities.lift).toBe("absent");
    await request(app).post("/api/admin/publish").set(auth).send({});
    expect((await request(app).get("/api/stations/bni-city")).body.data.amenities.lift).toBe("available");

    const audit = await request(app).get("/api/admin/audit").set(auth);
    expect(audit.body.data.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(["content.create", "publish", "content.delete"]));
  });

  it("validasi konten", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const bad = await request(app).post("/api/admin/content").set(auth).send({ kind: "facility", stationId: "bni-city", data: { type: "teleport", status: "available" } });
    expect(bad.status).toBe(400);
    expect(bad.body.details[0].path).toBe("type");
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "entrance", stationId: "zzz", data: { name: "A", accessible: true } })).status).toBe(400);
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "notice", data: { scope: "station", severity: "info", title: "x", message: "y" } })).status).toBe(400);
  });

  it("pintu akses, info stasiun, dan pengumuman sampai ke pengguna", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    await request(app)
      .post("/api/admin/content")
      .set(auth)
      .send({ kind: "entrance", stationId: "bni-city", data: { name: "Pintu Selatan (Jl. Kendal)", accessible: true, features: ["lift", "datar"], openHours: "05.00–23.00" } });
    await request(app).post("/api/admin/content").set(auth).send({ kind: "station_info", stationId: "bni-city", data: { category: "kontak", title: "Layanan pelanggan", body: "Tersedia di dekat gerbang utara." } });
    const notice = await request(app)
      .post("/api/admin/content")
      .set(auth)
      .send({ kind: "notice", data: { scope: "line", targetId: "krl-cikarang", severity: "warning", title: "Gangguan Lin Cikarang", message: "Perjalanan terlambat sekitar 15 menit." } });
    await request(app).post("/api/admin/publish").set(auth).send({});

    const st = (await request(app).get("/api/stations/bni-city")).body.data;
    expect(st.entrances[0]).toMatchObject({ name: "Pintu Selatan (Jl. Kendal)", accessible: true, features: ["lift", "datar"] });
    expect(st.info[0].category).toBe("kontak");
    expect(st.notices.map((n: { id: string }) => n.id)).toEqual([notice.body.data.id]);

    const p = (await plan(app, { originId: "tanah-abang", destinationId: "dukuh-atas-mrt" })).body.data;
    expect(p.notices[0].title).toBe("Gangguan Lin Cikarang");
    expect(p.warnings.join(" ")).toMatch(/Gangguan Lin Cikarang/);
    expect(p.notification.text).toMatch(/pengumuman/);
    expect((await request(app).get("/api/notices?lineId=krl-cikarang")).body.data).toHaveLength(1);
  });

  it("uji coba API terhadap draft dan gerbang publikasi", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const tc = await request(app)
      .post("/api/admin/tests")
      .set(auth)
      .send({ name: "BNI City memadai", request: { originId: "tanah-abang", destinationId: "dukuh-atas-mrt" }, expect: { status: "ok", adequateAt: ["bni-city"], maxTransfers: 1 } });
    expect(tc.status).toBe(201);
    let run = await request(app).post("/api/admin/tests/run").set(auth).send({ mode: "preview" });
    expect(run.body.data).toMatchObject({ passed: 1, failed: 0 });

    // Wajibkan uji sebelum publikasi, lalu buat draft yang membuat uji gagal.
    const settings = (await request(app).get("/api/admin/settings").set(auth)).body.data.published;
    await request(app).put("/api/admin/settings").set(auth).send({ data: { ...settings, requireTestsBeforePublish: true } });
    await request(app).post("/api/admin/publish").set(auth).send({});
    await request(app).post("/api/admin/content").set(auth).send({ kind: "facility", stationId: "bni-city", data: { type: "lift", status: "out_of_service" } });

    run = await request(app).post("/api/admin/tests/run").set(auth).send({ mode: "preview" });
    expect(run.body.data.failed).toBe(1);
    expect(run.body.data.results[0].failures[0]).toMatch(/bni-city tidak memadai/);
    expect((await request(app).post("/api/admin/tests/run").set(auth).send({ mode: "published" })).body.data.failed).toBe(0);

    const blocked = await request(app).post("/api/admin/publish").set(auth).send({});
    expect(blocked.status).toBe(409);
    expect((await request(app).get("/api/stations/bni-city")).body.data.amenities.lift).toBe("available");
    const forced = await request(app).post("/api/admin/publish").set(auth).send({ force: true });
    expect(forced.body.data.published).toBe(1);

    const adhoc = await request(app).post("/api/admin/tests/adhoc").set(auth).send({ request: { originId: "tanah-abang", destinationId: "tanah-abang" }, expect: { status: "error", errorCode: "INVALID" } });
    expect(adhoc.body.data.passed).toBe(true);
    expect((await request(app).get("/api/admin/tests/runs").set(auth)).body.data.length).toBeGreaterThanOrEqual(3);
  });

  it("pengaturan dan sistem", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const sys = await request(app).get("/api/admin/system").set(auth);
    expect(sys.body.data).toMatchObject({ store: { kind: "memory", ok: true }, commute: { source: "fixture", ok: true }, llm: { provider: "none" } });
    expect((await request(app).put("/api/admin/settings").set(auth).send({ data: { disclaimer: "x" } })).status).toBe(400);
    const s = (await request(app).get("/api/admin/settings").set(auth)).body.data.defaults;
    await request(app).put("/api/admin/settings").set(auth).send({ data: { ...s, disclaimer: "Disclaimer baru untuk pengujian NTD." } });
    expect((await request(app).get("/api/meta")).body.data.disclaimer).toBe(s.disclaimer);
    expect((await request(app).get("/api/meta").set(auth).set("X-NTD-Preview", "1")).body.data.disclaimer).toBe("Disclaimer baru untuk pengujian NTD.");
    expect((await request(app).post("/api/admin/cache/purge").set(auth).send({})).status).toBe(200);
  });

  it("manajemen pengguna admin", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const u = await request(app).post("/api/admin/users").set(auth).send({ email: "baru@ntd.test", name: "Baru", role: "editor", password: "pendek" });
    expect(u.status).toBe(400);
    const ok = await request(app).post("/api/admin/users").set(auth).send({ email: "baru@ntd.test", name: "Baru", role: "editor", password: "cukup-panjang-1" });
    expect(ok.status).toBe(201);
    expect((await request(app).post("/api/admin/users").set(auth).send({ email: "baru@ntd.test", name: "B", role: "editor", password: "cukup-panjang-1" })).status).toBe(409);
    await request(app).patch(`/api/admin/users/${ok.body.data.id}`).set(auth).send({ active: false });
    expect((await request(app).post("/api/admin/auth/login").send({ email: "baru@ntd.test", password: "cukup-panjang-1" })).status).toBe(401);
  });
});
