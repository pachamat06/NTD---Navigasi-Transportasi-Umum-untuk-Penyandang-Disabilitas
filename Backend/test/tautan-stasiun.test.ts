// Tautan transfer antar stasiun di luar hub: bawaan NTD (Bali Mester – Stasiun Jatinegara, Matraman Baru – Stasiun
// Matraman), isian admin (draf lalu publikasi), usulan dari dataset, akses (tangga, eskalator, lift, ramp, datar) terhadap
// kebutuhan pengguna, dan pemakaiannya oleh perencana rute.

import request from "supertest";
import { newContext } from "../src/context";
import type { StationLinkContent } from "../src/domain/content";
import type { Hub, Route, Station, StationLink } from "../src/domain/models";
import { applyLinksToRoute, findRides, totals } from "../src/domain/RoutePlannerService";
import { applyLinks, CURATED_LINKS, linkBetween, linkFailsNeeds, linkKey, linkNeedStatus, linksOf, suggestLinks } from "../src/domain/stationLinks";
import { makeTestApp } from "./helpers";

const over = (o: Partial<StationLinkContent>): StationLinkContent => ({ id: "x", fromId: "a", toId: "b", access: [], source: "manual", ...o });
const link = (o: Partial<StationLink>): StationLink => ({ id: linkKey(o.fromId ?? "a", o.toId ?? "b"), fromId: "a", toId: "b", distanceM: null, minutes: null, access: [], source: "admin", ...o });
const st = (id: string, o: Partial<Station> = {}): Station => ({ id, name: id, operator: "X", lineIds: [], codes: [], ...o });

describe("tautan bawaan NTD dan isian admin", () => {
  it("contoh bawaan: halte BRT Bali Mester dengan halte BRT Stasiun Jatinegara, Matraman Baru dengan Stasiun Matraman", () => {
    expect(CURATED_LINKS.map((l) => [l.fromId, l.toId, l.source])).toEqual([
      ["tj:h00148p", "tj:h00225p", "ntd"],
      ["tj:h00104p", "kci:mtr", "ntd"],
    ]);
    // Akses belum disurvei: kosong = belum diketahui, bukan "tidak ada".
    expect(CURATED_LINKS.every((l) => l.access.length === 0)).toBe(true);
    const known = new Set(["tj:h00148p", "tj:h00225p", "tj:h00104p", "kci:mtr"]);
    expect(applyLinks([], known).map((l) => l.id)).toEqual([linkKey("tj:h00148p", "tj:h00225p"), linkKey("tj:h00104p", "kci:mtr")]);
    // Stasiun yang tidak dikenal dataset: tautannya dibuang.
    expect(applyLinks([], new Set(["tj:h00148p", "tj:h00225p"])).map((l) => l.fromId)).toEqual(["tj:h00148p"]);
    expect(applyLinks([], new Set())).toEqual([]);
  });

  it("isian admin menambah, menggantikan (pasangan sama, urutan terbalik pun), atau menonaktifkan tautan", () => {
    const links = applyLinks([over({}), over({ fromId: "kci:mtr", toId: "tj:h00104p", access: ["lift", "tangga"], distanceM: 90, minutes: 2, note: "lewat JPO" }), over({ fromId: "tj:h00148p", toId: "tj:h00225p", disabled: true })]);
    expect(links.map((l) => l.id).sort()).toEqual([linkKey("a", "b"), linkKey("kci:mtr", "tj:h00104p")].sort());
    const mtr = links.find((l) => l.id === linkKey("tj:h00104p", "kci:mtr"))!;
    expect(mtr).toMatchObject({ fromId: "kci:mtr", toId: "tj:h00104p", access: ["lift", "tangga"], distanceM: 90, minutes: 2, note: "lewat JPO", source: "admin" });
    expect(links.some((l) => l.id === linkKey("tj:h00148p", "tj:h00225p"))).toBe(false);
  });

  it("dua arah bawaan; tautan satu arah hanya dari asalnya", () => {
    const both = link({ fromId: "a", toId: "b" });
    const one = link({ fromId: "c", toId: "d", oneWay: true });
    expect(linkBetween([both], "a", "b")).toBe(both);
    expect(linkBetween([both], "b", "a")).toBe(both);
    expect(linkBetween([one], "c", "d")).toBe(one);
    expect(linkBetween([one], "d", "c")).toBeUndefined();
    expect(linksOf([both, one], "b").map((x) => x.otherId)).toEqual(["a"]);
    expect(linksOf([both, one], "d")).toEqual([]);
  });
});

describe("akses tautan terhadap kebutuhan pengguna", () => {
  it("lift: ada lift, atau jalan tanpa anak tangga (datar/ramp) sehingga tidak dibutuhkan; hanya tangga/eskalator = tidak ada", () => {
    expect(linkNeedStatus(["tangga", "lift"], "lift").status).toBe("available");
    expect(linkNeedStatus(["datar"], "lift").status).toBe("available");
    expect(linkNeedStatus(["ramp", "tangga"], "lift").status).toBe("available");
    expect(linkNeedStatus(["tangga"], "lift").status).toBe("absent");
    expect(linkNeedStatus(["tangga", "eskalator"], "lift").status).toBe("absent");
  });

  it("eskalator: lift menggantikan eskalator (aturan yang sudah ada tetap berlaku)", () => {
    expect(linkNeedStatus(["eskalator", "tangga"], "eskalator")).toEqual({ status: "available" });
    expect(linkNeedStatus(["lift", "tangga"], "eskalator")).toEqual({ status: "available", substitute: "lift" });
    expect(linkNeedStatus(["datar"], "eskalator").status).toBe("available");
    expect(linkNeedStatus(["tangga"], "eskalator").status).toBe("absent");
  });

  it("ramp: hanya ramp atau jalan datar; lift saja tidak menggantikan ramp", () => {
    expect(linkNeedStatus(["ramp"], "ramp").status).toBe("available");
    expect(linkNeedStatus(["datar", "tangga"], "ramp").status).toBe("available");
    expect(linkNeedStatus(["lift", "tangga"], "ramp").status).toBe("absent");
  });

  it("akses kosong = belum diketahui; belum diketahui tidak dianggap gagal, tercatat tanpa fasilitas itu = gagal", () => {
    expect(linkNeedStatus([], "lift").status).toBe("unknown");
    expect(linkFailsNeeds({ access: [] }, ["lift", "ramp"])).toBe(false);
    expect(linkFailsNeeds({ access: ["tangga"] }, ["lift"])).toBe(true);
    expect(linkFailsNeeds({ access: ["tangga", "lift"] }, ["lift"])).toBe(false);
    expect(linkFailsNeeds({ access: ["tangga", "lift"] }, ["lift", "ramp"])).toBe(true);
  });
});

describe("usulan tautan dari dataset", () => {
  const near = (id: string, lat: number, o: Partial<Station> = {}) => st(id, { lat, lng: 106.86, ...o });
  // 0,001 derajat lintang ≈ 111 m.
  const stations = [near("tj:a", -6.2, { operator: "TransJakarta", lineIds: ["tj:5"] }), near("kci:b", -6.201, { operator: "KAI Commuter", lineIds: ["krl"] }), near("tj:c", -6.2005, { operator: "TransJakarta", lineIds: ["tj:5"] }), near("jauh", -6.3), st("tanpa-koordinat")];

  it("pasangan berdekatan, terdekat dulu; satu lini yang sama dan yang berjauhan tidak diusulkan", () => {
    const out = suggestLinks(stations, [], [], { radiusM: 300 });
    // tj:a–tj:c satu lini (halte berurutan), jadi tidak diusulkan; kci:b ↔ tj:a (111 m) dan kci:b ↔ tj:c (55 m).
    expect(out.map((x) => [linkKey(x.fromId, x.toId), x.distanceM, x.sameOperator])).toEqual([
      [linkKey("kci:b", "tj:c"), 56, false],
      [linkKey("kci:b", "tj:a"), 111, false],
    ]);
  });

  it("yang sudah satu hub atau sudah bertaut tidak diusulkan lagi; hanya untuk stasiun yang dipilih", () => {
    const hub: Hub = { id: "h", name: "H", memberIds: ["kci:b", "tj:c"], walks: [] };
    expect(suggestLinks(stations, [hub], [], { radiusM: 300 }).map((x) => linkKey(x.fromId, x.toId))).toEqual([linkKey("kci:b", "tj:a")]);
    expect(suggestLinks(stations, [], [link({ fromId: "tj:a", toId: "kci:b" })], { radiusM: 300 }).map((x) => linkKey(x.fromId, x.toId))).toEqual([linkKey("kci:b", "tj:c")]);
    expect(suggestLinks(stations, [], [], { radiusM: 300, stationId: "tj:a" }).map((x) => linkKey(x.fromId, x.toId))).toEqual([linkKey("kci:b", "tj:a")]);
    // Stasiun nonaktif dilewati.
    expect(suggestLinks(stations.map((s) => (s.id === "kci:b" ? { ...s, inactive: true } : s)), [], [], { radiusM: 300 })).toEqual([]);
  });
});

describe("pencarian rute memakai tautan", () => {
  const stations = new Map<string, Station>(["a", "b", "c", "d"].map((id) => [id, st(id)]));
  const seqs = [
    { lineId: "l1", sequences: [["a", "b"]] },
    { lineId: "l2", sequences: [["c", "d"]] },
  ];

  it("a→d lewat jalan kaki b→c pada tautan; tanpa tautan tidak ada rute", () => {
    expect(findRides("a", "d", seqs, [], stations)).toBeNull();
    const rides = findRides("a", "d", seqs, [], stations, 2, { links: [link({ fromId: "b", toId: "c", distanceM: 150 })] });
    expect(rides).toEqual([
      { lineId: "l1", stops: ["a", "b"] },
      { lineId: "", stops: ["b", "c"] },
      { lineId: "l2", stops: ["c", "d"] },
    ]);
  });

  it("tautan satu arah tidak dipakai ke arah sebaliknya; dua arah dipakai di kedua arah", () => {
    const oneWay = link({ fromId: "b", toId: "c", oneWay: true });
    expect(findRides("a", "d", seqs, [], stations, 2, { links: [oneWay] })).not.toBeNull();
    // d→a: butuh jalan kaki c→b.
    const rev = [
      { lineId: "l1", sequences: [["b", "a"]] },
      { lineId: "l2", sequences: [["d", "c"]] },
    ];
    expect(findRides("d", "a", rev, [], stations, 2, { links: [oneWay] })).toBeNull();
    expect(findRides("d", "a", rev, [], stations, 2, { links: [link({ fromId: "b", toId: "c" })] })).not.toBeNull();
  });

  it("tautan yang pasti tidak memenuhi kebutuhan dilewati; yang belum diketahui tetap dipakai", () => {
    const stairs = link({ fromId: "b", toId: "c", access: ["tangga"] });
    expect(findRides("a", "d", seqs, [], stations, 2, { links: [stairs] })).not.toBeNull();
    expect(findRides("a", "d", seqs, [], stations, 2, { links: [stairs], needs: ["lift"] })).toBeNull();
    expect(findRides("a", "d", seqs, [], stations, 2, { links: [link({ fromId: "b", toId: "c", access: ["tangga", "lift"] })], needs: ["lift"] })).not.toBeNull();
    expect(findRides("a", "d", seqs, [], stations, 2, { links: [link({ fromId: "b", toId: "c" })], needs: ["lift"] })).not.toBeNull();
  });

  it("ruas pindah yang tertaut membawa akses, jarak, waktu, dan petunjuk dari tautan; total ikut disesuaikan", () => {
    const route: Route = {
      ...totals([
        { type: "RIDE", lineId: "l1", stops: ["a", "b"], distanceM: 1000, minutes: 5, fare: 0 },
        { type: "TRANSFER", stops: ["b", "c"], distanceM: 300, minutes: null, fare: 0, notes: "dari dataset" },
        { type: "RIDE", lineId: "l2", stops: ["c", "d"], distanceM: 1000, minutes: 5, fare: 0 },
      ]),
    };
    const out = applyLinksToRoute(route, [link({ fromId: "c", toId: "b", access: ["lift", "tangga"], distanceM: 120, minutes: 3, note: "lewat JPO", dedicated: true })]);
    expect(out.legs[1]).toMatchObject({ distanceM: 120, minutes: 3, notes: "lewat JPO", link: { access: ["lift", "tangga"], dedicated: true, source: "admin" } });
    expect(out.totalDistanceM).toBe(2120);
    expect(out.totalMinutes).toBe(13);
    expect(out.timeComplete).toBe(true);
    // Tanpa tautan untuk pasangan itu, rute tidak berubah.
    expect(applyLinksToRoute(route, [link({ fromId: "x", toId: "y" })])).toBe(route);
    // Yang sudah bertaut tidak ditimpa lagi.
    expect(applyLinksToRoute(out, [link({ fromId: "b", toId: "c", access: ["datar"] })])).toBe(out);
  });
});

describe("tautan lewat admin: draf lalu publikasi", () => {
  const data = { fromId: "setiabudi-astra", toId: "setiabudi-lrt", access: ["tangga", "lift"], distanceM: 150, minutes: 3, note: "lewat JPO" };

  it("validasi, satu isian per pasangan, draf hanya terlihat di pratinjau sampai dipublikasikan", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const post = (d: unknown) => request(app).post("/api/admin/content").set(auth).send({ kind: "station_link", data: d });

    const res = await post(data);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ stationId: null, state: "baru", draft: { fromId: "setiabudi-astra", toId: "setiabudi-lrt", access: ["tangga", "lift"], source: "manual" } });
    // Pasangan sama (urutan terbalik pun) = konflik; stasiun tak dikenal, stasiun sama, dan akses tak dikenal/ganda ditolak.
    expect((await post({ ...data, fromId: data.toId, toId: data.fromId })).status).toBe(409);
    expect((await post({ ...data, fromId: "tidak-ada" })).status).toBe(400);
    expect((await post({ ...data, toId: data.fromId })).status).toBe(400);
    expect((await post({ ...data, toId: "juanda", access: ["tangga", "tangga"] })).status).toBe(400);
    expect((await post({ ...data, toId: "juanda", access: ["tangga", "tebing"] })).status).toBe(400);
    expect((await post({ fromId: "gondangdia", toId: "juanda", access: [] })).status).toBe(201);

    // Pratinjau admin melihat tautan; publik belum.
    const preview = (await request(app).get("/api/admin/station-links").set(auth)).body.data;
    expect(preview.links.map((l: StationLink) => l.id)).toContain(linkKey(data.fromId, data.toId));
    expect(preview.base).toEqual([]);
    expect((await request(app).get("/api/station-links")).body.data).toEqual([]);
    expect((await request(app).get("/api/stations/setiabudi-astra")).body.data.links).toEqual([]);

    expect((await request(app).post("/api/admin/publish").set(auth).send({})).status).toBe(200);
    const pub = (await request(app).get("/api/station-links?stationId=setiabudi-lrt")).body.data;
    expect(pub).toEqual([expect.objectContaining({ otherId: "setiabudi-astra", otherName: "Setiabudi Astra", distanceM: 150, minutes: 3, access: ["tangga", "lift"], note: "lewat JPO", source: "admin" })]);
    // Detail stasiun memuat daftar "terhubung ke stasiun lain", dari kedua sisi.
    expect((await request(app).get("/api/stations/setiabudi-astra")).body.data.links).toEqual([expect.objectContaining({ otherId: "setiabudi-lrt", access: ["tangga", "lift"] })]);
    expect((await request(app).get("/api/stations/setiabudi-lrt")).body.data.links).toHaveLength(1);
    // Hanya admin berstatus editor pun hanya mengusulkan; publikasi tetap dari admin.
    const editor = await login({ email: "editor@ntd.test", password: "rahasia-editor-123" });
    expect((await request(app).post("/api/admin/content").set({ Authorization: `Bearer ${editor}` }).send({ kind: "station_link", data: { fromId: "cikini", toId: "juanda", access: ["datar"] } })).status).toBe(201);
    expect((await request(app).get("/api/station-links")).body.data.map((l: StationLink) => l.id)).not.toContain(linkKey("cikini", "juanda"));
  });

  it("usulan dari dataset dan tautan bawaan tampil di admin; menonaktifkan tautan bawaan lewat isian disabled", async () => {
    const { app, login } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const sug = (await request(app).get("/api/admin/station-links/suggestions?stationId=sudirman").set(auth)).body.data;
    // Fixture tanpa koordinat: tidak ada usulan kedekatan, tetapi endpoint tetap menjawab.
    expect(sug).toEqual({ radius: 300, suggestions: [] });
    expect((await request(app).get("/api/admin/station-links/suggestions?radius=10").set(auth)).status).toBe(400);
  });
});

describe("rute melewati tautan transfer", () => {
  // Bendungan Hilir (MRT) → Rasuna Said (LRT): rute dasar lewat hub Dukuh Atas; tautan Setiabudi Astra ↔ Setiabudi LRT
  // (di luar hub) memberi pindah yang lebih pendek.
  const publish = async (data: unknown) => {
    const t = await makeTestApp();
    const auth = { Authorization: `Bearer ${await t.login()}` };
    expect((await request(t.app).post("/api/admin/content").set(auth).send({ kind: "station_link", data })).status).toBe(201);
    expect((await request(t.app).post("/api/admin/publish").set(auth).send({})).status).toBe(200);
    return t;
  };
  const plan = async (app: Parameters<typeof request>[0], needs?: string[]) =>
    (await request(app).post("/api/plan").send({ originId: "bendungan-hilir", destinationId: "rasuna-said", ...(needs ? { needs } : {}) })).body.data;
  const withLink = (p: { options: { route: Route }[] }) => p.options.filter((o) => o.route.legs.some((l) => l.link));

  it("variasi rute menawarkan pindah lewat tautan beserta aksesnya; jarak dan waktu dari tautan", async () => {
    const { app } = await publish({ fromId: "setiabudi-astra", toId: "setiabudi-lrt", access: ["tangga", "eskalator"], distanceM: 150, minutes: 3 });
    const p = await plan(app);
    const opts = withLink(p);
    expect(opts.length).toBeGreaterThan(0);
    const leg = opts[0].route.legs.find((l) => l.link)!;
    expect(leg).toMatchObject({ type: "TRANSFER", stops: ["setiabudi-astra", "setiabudi-lrt"], distanceM: 150, minutes: 3, link: { access: ["tangga", "eskalator"], source: "admin" } });
    expect(opts[0].route.legs.map((l) => l.type)).toEqual(["RIDE", "TRANSFER", "RIDE"]);
  });

  it("pengguna butuh lift: tautan hanya tangga/eskalator = peringatan dan rute itu kalah dari rute lewat hub", async () => {
    const { app } = await publish({ fromId: "setiabudi-astra", toId: "setiabudi-lrt", access: ["tangga", "eskalator"], distanceM: 150, minutes: 3 });
    const p = await plan(app, ["lift"]);
    const opts = withLink(p);
    expect(opts.length).toBeGreaterThan(0);
    const leg = opts[0].route.legs.find((l) => l.link)!;
    expect(leg.access).toEqual(expect.arrayContaining([expect.objectContaining({ stationId: "setiabudi-astra", need: "lift", status: "absent", link: { toId: "setiabudi-lrt", means: ["tangga", "eskalator"] } })]));
    expect(opts[0].warnings.join(" ")).toMatch(/Jalan kaki dari Setiabudi Astra ke Setiabudi \(LRT\) hanya tersedia lewat tangga, eskalator; lift tidak tercatat/);
    expect(opts[0].summary.unmetCertain).toBeGreaterThan(0);
    // Rute utama (paling aksesibel) tidak memakai tautan yang pasti gagal.
    expect(p.route.legs.some((l: { link?: unknown }) => l.link)).toBe(false);
  });

  it("tautan dengan lift atau jalan datar memenuhi kebutuhan lift; lift menggantikan eskalator", async () => {
    for (const [access, need, substitute] of [[["tangga", "lift"], "lift", undefined], [["datar"], "lift", undefined], [["tangga", "lift"], "eskalator", "lift"]] as const) {
      const { app } = await publish({ fromId: "setiabudi-astra", toId: "setiabudi-lrt", access, distanceM: 150 });
      const opts = withLink(await plan(app, [need]));
      expect(opts.length).toBeGreaterThan(0);
      const entries = opts[0].route.legs.find((l) => l.link)!.access!.filter((a) => a.link);
      expect(entries).toEqual([expect.objectContaining({ need, status: "available", ...(substitute ? { substitute } : {}) })]);
      expect(opts[0].warnings.join(" ")).not.toMatch(/Jalan kaki dari Setiabudi Astra/);
    }
  });

  it("akses belum diisi: peringatan 'belum tercatat', bukan 'tidak ada'", async () => {
    const { app } = await publish({ fromId: "setiabudi-astra", toId: "setiabudi-lrt", access: [], distanceM: 150 });
    const opts = withLink(await plan(app, ["lift"]));
    expect(opts.length).toBeGreaterThan(0);
    expect(opts[0].warnings.join(" ")).toMatch(/Akses jalan kaki dari Setiabudi Astra ke Setiabudi \(LRT\).*belum tercatat/);
    expect(opts[0].route.legs.find((l) => l.link)!.access!.find((a) => a.link)!.status).toBe("unknown");
  });

  it("tautan satu arah tidak dipakai dari arah sebaliknya", async () => {
    const { app } = await publish({ fromId: "setiabudi-lrt", toId: "setiabudi-astra", oneWay: true, access: ["datar"], distanceM: 100 });
    // Bendungan Hilir → Rasuna Said butuh jalan kaki Astra → LRT; tautan hanya LRT → Astra.
    expect(withLink(await plan(app))).toEqual([]);
  });

  it("pasangan yang tidak dirutekan dataset tetap ditemukan lewat tautan (rute disusun dari urutan lini)", async () => {
    const { FixtureCommuteSource } = await import("../src/data/commute/FixtureCommuteSource");
    class TanpaTarif extends FixtureCommuteSource {
      async getFare(...a: Parameters<FixtureCommuteSource["getFare"]>) {
        // Dataset hanya merutekan di dalam satu moda; pasangan lintas moda tidak diketahui.
        return (a[0].operator === "MRTJ") === (a[1].operator === "MRTJ") ? super.getFare(...a) : null;
      }
    }
    const t = await makeTestApp({ source: new TanpaTarif() });
    const auth = { Authorization: `Bearer ${await t.login()}` };
    const ctx = newContext();
    // Tanpa tautan: tidak ada rute.
    expect(await t.services.planner.getRoute("setiabudi-astra", "rasuna-said", ctx)).toBeNull();
    await request(t.app).post("/api/admin/content").set(auth).send({ kind: "station_link", data: { fromId: "setiabudi-astra", toId: "setiabudi-lrt", access: ["lift"], distanceM: 200, minutes: 4 } });
    await request(t.app).post("/api/admin/publish").set(auth).send({});
    const route = (await t.services.planner.getRoute("setiabudi-astra", "rasuna-said", ctx))!;
    expect(route.legs.map((l) => l.type)).toEqual(["TRANSFER", "RIDE"]);
    expect(route.legs[0]).toMatchObject({ stops: ["setiabudi-astra", "setiabudi-lrt"], distanceM: 200, minutes: 4, link: { access: ["lift"] } });
  });
});
