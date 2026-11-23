import { Pool } from "pg";
import request from "supertest";
import { createMemoryStore } from "../src/store/memory";
import { createPgStore, migrate } from "../src/store/pg";
import type { Store } from "../src/store/types";
import { makeTestApp } from "./helpers";

const PG_URL = process.env.TEST_DATABASE_URL;

async function freshPg(): Promise<Store> {
  const pool = new Pool({ connectionString: PG_URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool);
  // Migrasi kedua tidak mengulang apa pun.
  expect(await migrate(pool)).toEqual([]);
  return createPgStore(pool);
}

const factories: [string, () => Promise<Store>][] = [["memory", async () => createMemoryStore()]];
if (PG_URL) factories.push(["postgres", freshPg]);
else console.warn("TEST_DATABASE_URL kosong: uji PostgreSQL dilewati.");

describe.each(factories)("Store %s", (_name, make) => {
  let store: Store;
  beforeEach(async () => {
    store = await make();
  });
  afterEach(async () => {
    await store.close();
  });

  it("cache ber-TTL", async () => {
    await store.cache.put("commute:v1:a", { x: 1 }, 60);
    await store.cache.put("commute:v1:b", [1, 2], -1);
    const a = await store.cache.get<{ x: number }>("commute:v1:a");
    expect(a?.value).toEqual({ x: 1 });
    expect(a!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await store.cache.stats()).toEqual({ entries: 2, expired: 1 });
    expect(await store.cache.purge("commute:v1:a")).toBe(1);
    expect(await store.cache.get("commute:v1:a")).toBeNull();
  });

  it("siklus draft → publish → hapus", async () => {
    const v0 = await store.content.version();
    const it1 = await store.content.saveDraft({ kind: "facility", stationId: "sudirman", data: { type: "lift", status: "available" }, by: "a" });
    expect(it1).toMatchObject({ published: null, draft: { type: "lift" } });
    expect(await store.content.pending()).toHaveLength(1);
    expect(await store.content.publish("all", "a")).toEqual({ published: 1, deleted: 0 });
    expect(await store.content.version()).toBe(v0 + 1);
    const after = (await store.content.get(it1.id))!;
    expect(after).toMatchObject({ draft: null, published: { type: "lift", status: "available" } });

    await store.content.saveDraft({ id: it1.id, kind: "facility", stationId: "sudirman", data: { type: "lift", status: "absent" }, by: "b" });
    await store.content.discardDraft(it1.id);
    expect((await store.content.get(it1.id))!.draft).toBeNull();

    await store.content.markDeleted(it1.id, "a");
    expect((await store.content.get(it1.id))!.draftDeleted).toBe(true);
    expect(await store.content.publish([it1.id], "a")).toEqual({ published: 0, deleted: 1 });
    expect(await store.content.get(it1.id)).toBeNull();

    // Item yang belum pernah terbit langsung hilang saat dihapus.
    const it2 = await store.content.saveDraft({ kind: "notice", stationId: null, data: { scope: "global" }, by: "a" });
    expect(await store.content.markDeleted(it2.id, "a")).toBeNull();
    expect(await store.content.list({ kind: "notice" })).toEqual([]);
  });

  it("admin, kasus uji, dan audit", async () => {
    const u = await store.admins.create({ email: "X@Y.id", name: "X", role: "editor", passwordHash: "h", active: true });
    expect((await store.admins.byEmail("x@y.id"))?.id).toBe(u.id);
    expect((await store.admins.update(u.id, { role: "admin" }))?.role).toBe("admin");
    const c = await store.tests.saveCase({ name: "t", request: { a: 1 }, expect: { status: "ok" }, enabled: true });
    expect((await store.tests.saveCase({ id: c.id, name: "t2", request: {}, expect: {}, enabled: false })).name).toBe("t2");
    await store.tests.addRun({ mode: "preview", startedAt: new Date(), finishedAt: new Date(), passed: 1, failed: 0, results: [], triggeredBy: "x" });
    expect(await store.tests.listRuns(5)).toHaveLength(1);
    expect(await store.tests.deleteCase(c.id)).toBe(true);
    await store.audit.add({ actor: "x", action: "a", detail: { n: 1 } });
    expect((await store.audit.list(5))[0]).toMatchObject({ actor: "x", action: "a", detail: { n: 1 } });
  });

  it("informasi layanan: buat, duplikat sumber, ubah, saring status dan masa berlaku", async () => {
    const mk = (postId: string | null, over: Record<string, unknown> = {}) => ({
      status: "pending" as const,
      source: { type: "x" as const, account: "KRLTest", postId, url: postId ? `https://x.com/KRLTest/status/${postId}` : null, postedAt: new Date(Date.now() - 60_000).toISOString(), text: "teks" },
      operator: "KAI Commuter",
      category: "gangguan" as const,
      impact: "disruption" as const,
      summary: "Gangguan sinyal.",
      stationIds: ["manggarai"],
      lineIds: ["krl-cikarang"],
      validFrom: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      extraction: { by: "llm" as const, model: "m", confidence: "tinggi" as const, unmatched: ["Atlantis"] },
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      ...over,
    });
    const a = await store.advisories.create(mk("111"));
    expect(a).toMatchObject({ status: "pending", stationIds: ["manggarai"], extraction: { by: "llm", unmatched: ["Atlantis"] }, source: { postId: "111" } });
    expect(new Date(a.createdAt).getTime()).toBeGreaterThan(0);
    expect(await store.advisories.get(a.id)).toMatchObject({ id: a.id, summary: "Gangguan sinyal." });
    expect(await store.advisories.get("tidak-ada")).toBeNull();
    // Postingan yang sama (akun tidak peka huruf besar/kecil) tidak masuk dua kali; tanpa id postingan boleh berulang.
    expect((await store.advisories.findBySource("x", "krltest", "111"))?.id).toBe(a.id);
    expect(await store.advisories.findBySource("x", "KRLTest", "999")).toBeNull();
    await expect(store.advisories.create(mk("111", { source: { ...mk("111").source, account: "krltest" } }))).rejects.toThrow();
    await store.advisories.create(mk(null));
    await store.advisories.create(mk(null));
    expect(await store.advisories.list()).toHaveLength(3);

    const up = await store.advisories.update(a.id, { status: "approved", impact: "closure", reviewedBy: "admin", reviewedAt: new Date().toISOString(), reviewNote: "ok", stationIds: ["duri", "manggarai"] });
    expect(up).toMatchObject({ status: "approved", impact: "closure", reviewedBy: "admin", stationIds: ["duri", "manggarai"], source: { postId: "111" } });
    expect(await store.advisories.update("tidak-ada", { status: "rejected" })).toBeNull();
    const expired = await store.advisories.create(mk("222", { expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const rejected = await store.advisories.create(mk("333", { status: "rejected" as const }));
    expect((await store.advisories.list({ status: "approved" })).map((x) => x.id)).toEqual([a.id]);
    const active = (await store.advisories.list({ activeAt: new Date() })).map((x) => x.id);
    expect(active).toContain(a.id);
    expect(active).not.toContain(expired.id);
    expect(active).not.toContain(rejected.id);
    expect(await store.advisories.list({ limit: 2 })).toHaveLength(2);
  });

  it("alur admin lewat HTTP", async () => {
    const { app, login } = await makeTestApp({ store });
    const auth = { Authorization: `Bearer ${await login()}` };
    await request(app).post("/api/admin/content").set(auth).send({ kind: "facility", stationId: "duri", data: { type: "lift", status: "available" } });
    expect((await request(app).get("/api/stations/duri")).body.data.dataAvailable).toBe(false);
    await request(app).post("/api/admin/publish").set(auth).send({});
    expect((await request(app).get("/api/stations/duri")).body.data.dataAvailable).toBe(true);
  });
});
