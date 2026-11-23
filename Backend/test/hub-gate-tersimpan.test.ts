// Keluhan: di hub Manggarai, "gate terhubung" yang ditambahkan hilang setelah draft dipublikasikan. Akar masalah: backend
// cabang kerja tidak punya field `gates` pada skema hub, sehingga zod membuangnya diam-diam saat simpan draft dan
// isian terbit tidak pernah memuatnya. Tes ini meniru alurnya persis seperti admin: hub sudah terbit tanpa gate, lalu
// diubah (PUT) menambah gate, disimpan sebagai draft, dan diterbitkan.

import request from "supertest";
import type { Hub } from "../src/domain/models";
import { makeTestApp } from "./helpers";

const HUB = {
  hubId: "manggarai-uji",
  name: "Manggarai",
  kind: "hub",
  memberIds: ["manggarai", "tanah-abang"],
  walks: [
    { from: "manggarai", to: "tanah-abang", distanceM: 530, notes: "Jalan kaki lewat trotoar" },
    { from: "tanah-abang", to: "manggarai", distanceM: 530 },
  ],
  source: "gtfs",
  syncedAt: "2026-11-16T07:13:26.886Z",
};
const GATE = { id: "manggarai-gate-selatan", stationId: "manggarai", name: "Gate Selatan", connectsTo: ["tanah-abang"], facilities: ["lift", "ramp"], accessible: true };

type Content = { id: string; state: string; draft: Record<string, unknown> | null; published: Record<string, unknown> | null };

describe("gate hub tidak hilang saat draft disimpan dan diterbitkan", () => {
  it("hub yang sudah terbit tanpa gate: tambah gate → draft → terbit → gate tetap ada di semua tampilan", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const publish = () => request(app).post("/api/admin/publish").set(auth).send({});
    const publicHub = async () => (await request(app).get("/api/hubs")).body.data.find((h: Hub) => h.id === HUB.hubId) as Hub;

    // Keadaan nyata: hub Manggarai sudah terbit (hasil sinkron GTFS) dan belum punya gate.
    const created = await request(app).post("/api/admin/content").set(auth).send({ kind: "hub", data: HUB });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    await publish();
    expect((await publicHub()).gates ?? []).toEqual([]);

    // Admin membuka hub, menambah gate terhubung, lalu menyimpan (PUT = saveItem di admin).
    const saved = await request(app).put(`/api/admin/content/${id}`).set(auth).send({ data: { ...HUB, gates: [GATE] } });
    expect(saved.status).toBe(200);
    expect((saved.body.data as Content).draft?.gates).toEqual([expect.objectContaining({ id: GATE.id, connectsTo: ["tanah-abang"], facilities: ["lift", "ramp"], accessible: true })]);

    // Pratinjau admin (draft) sudah memuat gate.
    const preview = (await request(app).get("/api/admin/hubs").set(auth)).body.data.hubs.find((h: Hub) => h.id === HUB.hubId) as Hub;
    expect(preview.gates).toHaveLength(1);
    // Pengguna belum melihatnya sebelum terbit.
    expect((await publicHub()).gates ?? []).toEqual([]);

    // Terbit: gate harus ada pada isian terbit, di /api/hubs, dan di daftar konten admin.
    expect((await publish()).status).toBe(200);
    const item = ((await request(app).get("/api/admin/content?kind=hub").set(auth)).body.data as Content[]).find((c) => c.id === id)!;
    expect(item.state).toBe("terbit");
    expect(item.published?.gates).toEqual([expect.objectContaining({ id: GATE.id, stationId: "manggarai", name: "Gate Selatan" })]);
    expect((await publicHub()).gates).toEqual([expect.objectContaining({ id: GATE.id, connectsTo: ["tanah-abang"], accessible: true })]);

    // Mengubah hub lagi (admin memuat ulang dari isian terbit) tidak menghapus gate.
    const reopened = (item.published ?? {}) as Record<string, unknown>;
    expect((await request(app).put(`/api/admin/content/${id}`).set(auth).send({ data: { ...reopened, name: "Manggarai (Uji)" } })).status).toBe(200);
    await publish();
    const again = await publicHub();
    expect(again.name).toBe("Manggarai (Uji)");
    expect(again.gates).toHaveLength(1);
  });
});
