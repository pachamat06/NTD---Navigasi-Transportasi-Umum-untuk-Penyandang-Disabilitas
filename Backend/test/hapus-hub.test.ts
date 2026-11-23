// Hapus hub transfer dari admin: hub buatan admin dihapus, hub dataset dinonaktifkan, keduanya lewat draft dan
// baru berlaku setelah publikasi; dampak (pengumuman hub) dilaporkan; dataset yang disinkron ulang tidak
// menghidupkannya kembali.

import request from "supertest";
import type { Hub } from "../src/domain/models";
import { makeTestApp } from "./helpers";

const ids = (b: { data: Hub[] }) => b.data.map((h) => h.id);

describe("hapus hub transfer", () => {
  it("hub dataset dinonaktifkan lewat draft, baru hilang setelah terbit, dan tidak kembali saat sinkron ulang", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };

    const impact = (await request(app).get("/api/admin/hubs/dukuh-atas/impact").set(auth)).body.data;
    expect(impact).toMatchObject({ hubId: "dukuh-atas", source: "commute", method: "disable", active: true, alreadyDisabled: false, notices: [] });

    const res = await request(app).post("/api/admin/hubs/dukuh-atas/remove").set(auth).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ method: "disable", item: { state: "baru", draft: { hubId: "dukuh-atas", disabled: true } } });
    expect(res.body.data.item.draft.memberIds.length).toBeGreaterThanOrEqual(2);

    // Pratinjau admin sudah tanpa hub itu; pengguna baru melihatnya hilang setelah publikasi.
    expect((await request(app).get("/api/admin/hubs").set(auth)).body.data.hubs.map((h: Hub) => h.id)).not.toContain("dukuh-atas");
    expect(ids((await request(app).get("/api/hubs")).body)).toContain("dukuh-atas");
    await request(app).post("/api/admin/publish").set(auth).send({});
    expect(ids((await request(app).get("/api/hubs")).body)).not.toContain("dukuh-atas");
    const stations = (await request(app).get("/api/stations")).body.data;
    expect(stations.find((x: { id: string }) => x.id === "sudirman").hubId).toBeUndefined();

    // Sinkron ulang dari Commute tidak menghidupkannya lagi; daftar dasar admin tetap memuatnya agar bisa dipulihkan.
    await request(app).post("/api/admin/dataset/refresh").set(auth).send({ parts: ["hubs"] });
    expect(ids((await request(app).get("/api/hubs")).body)).not.toContain("dukuh-atas");
    expect((await request(app).get("/api/admin/hubs").set(auth)).body.data.base.map((h: Hub) => h.id)).toContain("dukuh-atas");

    // Sudah nonaktif: tidak bisa dihapus dua kali.
    expect((await request(app).post("/api/admin/hubs/dukuh-atas/remove").set(auth).send({})).status).toBe(409);
    expect((await request(app).get("/api/admin/hubs/dukuh-atas/impact").set(auth)).body.data).toMatchObject({ active: false, alreadyDisabled: true });
  });

  it("membatalkan draft penghapusan mengembalikan hub dataset", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const res = await request(app).post("/api/admin/hubs/dukuh-atas/remove").set(auth).send({});
    expect(res.status).toBe(200);
    expect((await request(app).get("/api/admin/hubs").set(auth)).body.data.hubs.map((h: Hub) => h.id)).not.toContain("dukuh-atas");
    await request(app).post(`/api/admin/content/${res.body.data.item.id}/discard`).set(auth);
    expect((await request(app).get("/api/admin/hubs").set(auth)).body.data.hubs.map((h: Hub) => h.id)).toContain("dukuh-atas");
  });

  it("hub buatan admin dihapus: isian baru langsung hilang, isian terbit hilang setelah publikasi", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const data = { hubId: "manggarai-tanah-abang", name: "Uji", memberIds: ["manggarai", "tanah-abang"], walks: [] };
    const made = (await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data })).body.data;
    expect((await request(app).get("/api/admin/hubs/manggarai-tanah-abang/impact").set(auth)).body.data).toMatchObject({ source: "admin", method: "delete", active: true });

    // Belum pernah terbit: isian langsung dibuang.
    const r1 = await request(app).post("/api/admin/hubs/manggarai-tanah-abang/remove").set(auth).send({});
    expect(r1.body.data).toMatchObject({ method: "delete", item: null });
    expect((await request(app).get(`/api/admin/content?kind=hub`).set(auth)).body.data).toEqual([]);

    // Sudah terbit: ditandai dihapus, hilang setelah publikasi.
    await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data });
    await request(app).post("/api/admin/publish").set(auth).send({});
    expect(ids((await request(app).get("/api/hubs")).body)).toContain("manggarai-tanah-abang");
    const r2 = await request(app).post("/api/admin/hubs/manggarai-tanah-abang/remove").set(auth).send({});
    expect(r2.body.data.item.state).toBe("akan_dihapus");
    expect(ids((await request(app).get("/api/hubs")).body)).toContain("manggarai-tanah-abang");
    await request(app).post("/api/admin/publish").set(auth).send({});
    expect(ids((await request(app).get("/api/hubs")).body)).not.toContain("manggarai-tanah-abang");
    expect(made.id).toBeTruthy();
  });

  it("hub dataset yang isian adminnya menggantikan dataset: dihapus berarti dinonaktifkan, bukan dikembalikan ke dataset", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const over = { hubId: "dukuh-atas", name: "Dukuh Atas (survei)", memberIds: ["sudirman", "bni-city"], walks: [{ from: "sudirman", to: "bni-city", distanceM: 150 }] };
    await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data: over });
    await request(app).post("/api/admin/publish").set(auth).send({});
    const r = await request(app).post("/api/admin/hubs/dukuh-atas/remove").set(auth).send({});
    expect(r.status).toBe(200);
    expect(r.body.data.item).toMatchObject({ state: "diubah", draft: { name: "Dukuh Atas (survei)", disabled: true, walks: [expect.objectContaining({ distanceM: 150 })] } });
    await request(app).post("/api/admin/publish").set(auth).send({});
    expect(ids((await request(app).get("/api/hubs")).body)).not.toContain("dukuh-atas");
  });

  it("dampak: pengumuman yang menargetkan hub dilaporkan; hub tak dikenal 404; wajib login admin", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    await request(app).post("/api/admin/content").set(auth).send({ kind: "notice", data: { title: "Pengumuman Dukuh Atas", message: "Uji", severity: "info", scope: "hub", targetId: "dukuh-atas" } });
    const impact = (await request(app).get("/api/admin/hubs/dukuh-atas/impact").set(auth)).body.data;
    expect(impact.notices).toEqual([expect.objectContaining({ title: "Pengumuman Dukuh Atas" })]);
    expect((await request(app).get("/api/admin/hubs/tidak-ada/impact").set(auth)).status).toBe(404);
    expect((await request(app).post("/api/admin/hubs/tidak-ada/remove").set(auth).send({})).status).toBe(404);
    expect((await request(app).post("/api/admin/hubs/dukuh-atas/remove").send({})).status).toBe(401);
  });
});
