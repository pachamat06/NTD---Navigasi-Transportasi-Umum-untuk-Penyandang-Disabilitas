// Gate/pintu yang terhubung pada tautan transfer antarstasiun (di luar hub): tiap tautan boleh menyebut gate di stasiun
// asal dan gate di stasiun tujuan yang dilewati saat berpindah (opsional, boleh lebih dari satu). Mengikuti pola gate pada
// hub (hub-gate-tersimpan.test.ts): gate harus bertahan lewat draft lalu publikasi, tidak hilang saat tautan diubah lagi,
// dan tampil di perencana rute serta detail stasiun.

import request from "supertest";
import type { StationLinkContent } from "../src/domain/content";
import type { HubGate, Route, StationLink } from "../src/domain/models";
import { applyLinksToRoute, totals } from "../src/domain/RoutePlannerService";
import { applyLinks, legLink, linkGateAt, linkKey, linkViews } from "../src/domain/stationLinks";
import { makeTestApp } from "./helpers";

const A = "setiabudi-astra";
const B = "setiabudi-lrt";
const LINK = { fromId: A, toId: B, access: ["tangga", "lift"], distanceM: 150, minutes: 3, note: "lewat JPO" };
const GATE_A = { id: "astra-gate-utara", stationId: A, name: "Gate Utara", facilities: ["tangga"], accessible: false };
const GATE_A2 = { id: "astra-gate-selatan", stationId: A, name: "Gate Selatan", facilities: ["lift", "ramp"], accessible: true, openHours: "05.00–22.00" };
const GATE_B = { id: "lrt-pintu-b", stationId: B, name: "Pintu B", facilities: ["lift"], accessible: true, note: "dekat JPO" };

const gate = (o: Partial<HubGate>): HubGate => ({ id: "g", stationId: "a", name: "G", connectsTo: [], facilities: [], accessible: false, ...o });
const over = (o: Partial<StationLinkContent>): StationLinkContent => ({ id: "x", fromId: "a", toId: "b", access: [], gates: [], source: "manual", ...o });
const link = (o: Partial<StationLink>): StationLink => ({ id: linkKey(o.fromId ?? "a", o.toId ?? "b"), fromId: "a", toId: "b", distanceM: null, minutes: null, access: [], source: "admin", ...o });

type Content = { id: string; state: string; draft: Record<string, unknown> | null; published: Record<string, unknown> | null };

describe("gate tautan: bentuk data dan pemilihan", () => {
  it("applyLinks membawa gate yang valid; connectsTo = stasiun di seberangnya; gate stasiun lain dibuang; isian lama tanpa gates tetap jalan", () => {
    const l = applyLinks([over({ gates: [gate({ id: "ga", stationId: "a", name: "Gate A" }), gate({ id: "gb", stationId: "b", name: "Gate B", connectsTo: ["a"] }), gate({ id: "gx", stationId: "z", name: "Salah" })] })]).find((x) => x.id === linkKey("a", "b"))!;
    expect(l.gates?.map((g) => [g.id, g.stationId, g.connectsTo])).toEqual([
      ["ga", "a", ["b"]],
      ["gb", "b", ["a"]],
    ]);
    // Isian tersimpan sebelum ada gate (tanpa field gates).
    const legacy = { id: "x", fromId: "a", toId: "b", access: ["lift"], source: "manual" } as unknown as StationLinkContent;
    expect(applyLinks([legacy]).find((x) => x.id === linkKey("a", "b"))?.gates).toBeUndefined();
    // Tautan bawaan NTD belum punya gate.
    expect(applyLinks([]).every((x) => !x.gates)).toBe(true);
  });

  it("linkGateAt: gate di stasiun yang diminta; beberapa gate → aksesibel dulu, lalu yang punya fasilitas dibutuhkan", () => {
    const l = link({
      gates: [
        gate({ id: "tangga", stationId: "a", name: "Tangga", facilities: ["tangga"] }),
        gate({ id: "ramp", stationId: "a", name: "Ramp", facilities: ["ramp"], accessible: true }),
        gate({ id: "lift", stationId: "a", name: "Lift", facilities: ["lift", "ramp"], accessible: true }),
        gate({ id: "b1", stationId: "b", name: "B1" }),
      ],
    });
    expect(linkGateAt(l, "a")?.id).toBe("lift"); // aksesibel + fasilitas terbanyak
    expect(linkGateAt(l, "a", ["ramp"])?.id).toBe("lift");
    expect(linkGateAt(l, "b")?.id).toBe("b1");
    expect(linkGateAt(l, "c")).toBeUndefined();
    expect(linkGateAt(link({}), "a")).toBeUndefined();
    // Bila yang lain tidak aksesibel, fasilitas yang dibutuhkan menentukan.
    const l2 = link({ gates: [gate({ id: "x", name: "X", facilities: ["ramp"] }), gate({ id: "y", name: "Y", facilities: ["lift"] })] });
    expect(linkGateAt(l2, "a", ["lift"])?.id).toBe("y");
    expect(linkGateAt(l2, "a", ["ramp"])?.id).toBe("x");
  });

  it("ruas pindah membawa gate keluar (stasiun asal ruas) dan gate masuk (stasiun tujuan ruas), juga bila ruas berarah sebaliknya", () => {
    const route: Route = totals([
      { type: "RIDE", lineId: "l1", stops: ["x", "b"], distanceM: 1000, minutes: 5, fare: 0 },
      { type: "TRANSFER", stops: ["b", "a"], distanceM: 300, minutes: null, fare: 0 },
      { type: "RIDE", lineId: "l2", stops: ["a", "y"], distanceM: 1000, minutes: 5, fare: 0 },
    ]);
    const gates = [gate({ id: "ga", stationId: "a", name: "Gate A", connectsTo: ["b"] }), gate({ id: "gb", stationId: "b", name: "Gate B", connectsTo: ["a"] })];
    const out = applyLinksToRoute(route, [link({ fromId: "a", toId: "b", gates })]);
    expect(out.legs[1]).toMatchObject({ fromGate: { id: "gb", stationId: "b" }, toGate: { id: "ga", stationId: "a" }, link: { gates: [{ id: "ga" }, { id: "gb" }] } });
    // Tautan tanpa gate: ruas tidak memuat gate.
    const plain = applyLinksToRoute(route, [link({ fromId: "a", toId: "b" })]);
    expect(plain.legs[1].fromGate).toBeUndefined();
    expect(plain.legs[1].toGate).toBeUndefined();
    expect(legLink(link({})).gates).toBeUndefined();
  });

  it("tampilan dari stasiun ini memuat gate kedua sisi", () => {
    const byId = new Map([["a", { id: "a", name: "A", operator: "X", lineIds: [], codes: [] }], ["b", { id: "b", name: "B", operator: "X", lineIds: [], codes: [] }]]);
    const l = link({ gates: [gate({ id: "ga", stationId: "a", name: "Gate A" }), gate({ id: "gb", stationId: "b", name: "Gate B" })] });
    expect(linkViews([l], "a", byId)[0].gates?.map((g) => g.id)).toEqual(["ga", "gb"]);
    expect(linkViews([link({})], "a", byId)[0].gates).toBeUndefined();
  });
});

describe("gate tautan tersimpan lewat admin: draft lalu publikasi", () => {
  it("tautan sudah terbit tanpa gate → tambah gate → draft → terbit → gate tetap ada di semua tampilan, juga setelah diubah lagi", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const publish = () => request(app).post("/api/admin/publish").set(auth).send({});
    const publicLinks = async (id: string) => (await request(app).get(`/api/station-links?stationId=${id}`)).body.data as { otherId: string; gates?: HubGate[] }[];

    // Keadaan nyata: tautan sudah terbit dan belum punya gate.
    const created = await request(app).post("/api/admin/content").set(auth).send({ kind: "station_link", data: LINK });
    expect(created.status).toBe(201);
    expect((created.body.data as Content).draft?.gates).toEqual([]);
    const id = created.body.data.id as string;
    await publish();
    expect((await publicLinks(A))[0].gates ?? []).toEqual([]);

    // Admin membuka tautan, menambah gate di kedua sisi, lalu menyimpan (PUT = saveItem di admin).
    const saved = await request(app).put(`/api/admin/content/${id}`).set(auth).send({ data: { ...LINK, gates: [GATE_A, GATE_A2, GATE_B] } });
    expect(saved.status).toBe(200);
    expect((saved.body.data as Content).draft?.gates).toEqual([
      expect.objectContaining({ id: GATE_A.id, stationId: A, name: "Gate Utara", accessible: false }),
      expect.objectContaining({ id: GATE_A2.id, stationId: A, name: "Gate Selatan", facilities: ["lift", "ramp"], accessible: true, openHours: "05.00–22.00" }),
      expect.objectContaining({ id: GATE_B.id, stationId: B, name: "Pintu B", note: "dekat JPO" }),
    ]);

    // Pratinjau admin (draft) sudah memuat gate; pengguna belum melihatnya sebelum terbit.
    const preview = (await request(app).get(`/api/admin/station-links?stationId=${A}`).set(auth)).body.data;
    expect(preview.links[0].gates).toHaveLength(3);
    expect(preview.forStation[0].gates.map((g: HubGate) => g.id)).toEqual([GATE_A.id, GATE_A2.id, GATE_B.id]);
    expect((await publicLinks(A))[0].gates ?? []).toEqual([]);

    // Terbit: gate ada pada isian terbit, di /api/station-links (dari kedua sisi), dan di detail stasiun.
    expect((await publish()).status).toBe(200);
    const item = ((await request(app).get("/api/admin/content?kind=station_link").set(auth)).body.data as Content[]).find((c) => c.id === id)!;
    expect(item.state).toBe("terbit");
    expect(item.published?.gates).toHaveLength(3);
    expect((await publicLinks(A))[0].gates).toEqual([
      expect.objectContaining({ id: GATE_A.id, connectsTo: [B] }),
      expect.objectContaining({ id: GATE_A2.id, connectsTo: [B], accessible: true }),
      expect.objectContaining({ id: GATE_B.id, connectsTo: [A], accessible: true }),
    ]);
    expect((await publicLinks(B))[0].gates).toHaveLength(3);
    expect((await request(app).get(`/api/stations/${A}`)).body.data.links[0].gates).toHaveLength(3);

    // Mengubah tautan lagi (admin memuat ulang dari isian terbit) tidak menghapus gate.
    const reopened = (item.published ?? {}) as Record<string, unknown>;
    expect((await request(app).put(`/api/admin/content/${id}`).set(auth).send({ data: { ...reopened, minutes: 5 } })).status).toBe(200);
    await publish();
    const again = (await publicLinks(A))[0] as { gates?: HubGate[]; minutes?: number };
    expect(again.minutes).toBe(5);
    expect(again.gates).toHaveLength(3);

    // Menghapus gate satu per satu juga tersimpan.
    expect((await request(app).put(`/api/admin/content/${id}`).set(auth).send({ data: { ...reopened, gates: [GATE_B] } })).status).toBe(200);
    await publish();
    expect((await publicLinks(A))[0].gates?.map((g) => g.id)).toEqual([GATE_B.id]);
  });

  it("validasi: gate harus milik salah satu stasiun tautan, id unik, tersambung hanya ke ujung tautan", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const post = (gates: unknown, data: Record<string, unknown> = LINK) => request(app).post("/api/admin/content").set(auth).send({ kind: "station_link", data: { ...data, gates } });

    expect((await post([{ ...GATE_A, stationId: "juanda" }])).status).toBe(400);
    expect((await post([GATE_A, { ...GATE_B, id: GATE_A.id }])).status).toBe(400);
    expect((await post([{ ...GATE_A, connectsTo: ["juanda"] }])).status).toBe(400);
    expect((await post([{ ...GATE_A, connectsTo: [A] }])).status).toBe(400);
    expect((await post([{ ...GATE_A, name: "" }])).status).toBe(400);
    expect((await post([{ ...GATE_A, facilities: ["teleportasi"] }])).status).toBe(400);
    expect((await post([{ ...GATE_A, id: "ID Salah" }])).status).toBe(400);
    // Gate tanpa field opsional dan dengan connectsTo yang sah diterima.
    const ok = await post([{ id: "a1", stationId: A, name: "Pintu 1" }, { id: "b1", stationId: B, name: "Pintu 2", connectsTo: [A] }]);
    expect(ok.status).toBe(201);
    expect((ok.body.data as Content).draft?.gates).toEqual([
      { id: "a1", stationId: A, name: "Pintu 1", connectsTo: [], facilities: [], accessible: false },
      { id: "b1", stationId: B, name: "Pintu 2", connectsTo: [A], facilities: [], accessible: false },
    ]);
    // Tautan tanpa gate sama sekali tetap sah (opsional).
    expect((await request(app).post("/api/admin/content").set(auth).send({ kind: "station_link", data: { fromId: "gondangdia", toId: "juanda", access: [] } })).status).toBe(201);
  });
});

describe("gate tautan di perencana rute", () => {
  // Bendungan Hilir (MRT) → Rasuna Said (LRT) lewat tautan Setiabudi Astra ↔ Setiabudi LRT (lihat tautan-stasiun.test.ts).
  const publish = async (data: unknown) => {
    const t = await makeTestApp();
    const auth = { Authorization: `Bearer ${await t.login()}` };
    expect((await request(t.app).post("/api/admin/content").set(auth).send({ kind: "station_link", data })).status).toBe(201);
    expect((await request(t.app).post("/api/admin/publish").set(auth).send({})).status).toBe(200);
    return t;
  };
  const plan = async (app: Parameters<typeof request>[0], needs?: string[]) =>
    (await request(app).post("/api/plan").send({ originId: "bendungan-hilir", destinationId: "rasuna-said", ...(needs ? { needs } : {}) })).body.data;
  const linkLeg = (p: { options: { route: Route }[] }) => p.options.map((o) => o.route.legs.find((l) => l.link)).find((l) => !!l);

  it("hasil rute memuat gate keluar di stasiun asal ruas dan gate masuk di stasiun tujuan ruas", async () => {
    const { app } = await publish({ ...LINK, gates: [GATE_A, GATE_B] });
    const leg = linkLeg(await plan(app));
    expect(leg).toBeDefined();
    expect(leg).toMatchObject({
      stops: [A, B],
      fromGate: { id: GATE_A.id, stationId: A, name: "Gate Utara" },
      toGate: { id: GATE_B.id, stationId: B, name: "Pintu B", accessible: true },
      link: { access: ["tangga", "lift"], source: "admin" },
    });
  });

  it("beberapa gate di satu sisi: yang aksesibel dipilih; pengguna butuh lift dipilihkan gate yang punya lift", async () => {
    const stairs = { ...GATE_A, id: "astra-tangga", name: "Pintu Tangga", accessible: true, facilities: ["ramp"] };
    const lift = { ...GATE_A2, id: "astra-lift", name: "Pintu Lift", accessible: true, facilities: ["lift"] };
    const { app } = await publish({ ...LINK, gates: [GATE_A, stairs, lift, GATE_B] });
    // Tanpa kebutuhan khusus: aksesibel dulu (pintu tangga tidak aksesibel dan kalah).
    expect(linkLeg(await plan(app))?.fromGate?.accessible).toBe(true);
    // Butuh lift: gate dengan lift.
    expect(linkLeg(await plan(app, ["lift"]))?.fromGate?.name).toBe("Pintu Lift");
    // Bila rute dilengkapi (annotate) dengan kebutuhan, gate dipilih ulang menurut kebutuhan itu.
    const t = await publish({ ...LINK, gates: [stairs, lift, GATE_B] });
    const base = (await plan(t.app)).route as Route;
    expect(base).toBeDefined();
    const annotated = await t.services.planner.annotate(
      { ...base, legs: [{ type: "TRANSFER", stops: [A, B], distanceM: 150, minutes: 3, fare: 0, link: { access: ["tangga", "lift"], source: "admin", gates: [stairs, lift, GATE_B].map((g) => ({ ...g, connectsTo: [g.stationId === A ? B : A] })) as HubGate[] } }] },
      (await import("../src/context")).newContext(),
      undefined,
      { needs: ["ramp"] },
    );
    expect(annotated.legs[0].fromGate?.name).toBe("Pintu Tangga");
    expect(annotated.legs[0].toGate?.name).toBe("Pintu B");
  });

  it("tautan tanpa gate: ruas pindah tidak memuat gate (tampilan lama tetap)", async () => {
    const { app } = await publish(LINK);
    const leg = linkLeg(await plan(app));
    expect(leg).toBeDefined();
    expect(leg?.fromGate).toBeUndefined();
    expect(leg?.toGate).toBeUndefined();
  });
});
