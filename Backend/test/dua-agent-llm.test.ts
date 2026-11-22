// Mode LLM dengan dua agent: pipeline default vs LLM, agent navigasi (tool-calling + pagar), dan efek informasi layanan
// yang baru berubah setelah disetujui admin. Agent pembaca X ada di pembaca-x.test.ts.

import request from "supertest";
import type { LlmClient, LlmRequest, LlmToolRequest, LlmToolResult } from "../src/ai/llm/LlmClient";
import { checkChoice, reasonOk } from "../src/ai/LlmNavigator";
import { llmAvailability, resolvePipeline } from "../src/ai/pipeline";
import type { NewServiceAdvisory } from "../src/store/types";
import { EDITOR, FakeLlm, makeTestApp } from "./helpers";

const plan = (app: Parameters<typeof request>[0], body: object) => request(app).post("/api/plan").send(body);
const stopsOf = (route: { legs: { stops: string[] }[] }) => route.legs.flatMap((l) => l.stops);
const JK_DA = { originId: "jakarta-kota", destinationId: "dukuh-atas-mrt" };

/** LLM tiruan: `tools` memainkan peran model yang memanggil tool; `complete` dipakai narasi. */
class ScriptLlm implements LlmClient {
  readonly name = "script";
  readonly model = "script-1";
  completeCalls: LlmRequest[] = [];
  toolResults: { name: string; out: unknown }[] = [];
  runTools?: (req: LlmToolRequest) => Promise<LlmToolResult>;

  constructor(
    private o: {
      complete?: (req: LlmRequest) => string;
      tools?: (call: (name: string, input?: unknown) => Promise<any>, req: LlmToolRequest) => Promise<void>;
    } = {},
  ) {
    const tools = o.tools;
    if (tools) {
      this.runTools = async (req) => {
        const calls: LlmToolResult["calls"] = [];
        let stopped = false;
        const call = async (name: string, input: unknown = {}) => {
          try {
            const out = await req.run(name, input);
            calls.push({ name, ok: true });
            this.toolResults.push({ name, out });
            if (name === req.stopAfter) stopped = true;
            return out;
          } catch (e) {
            calls.push({ name, ok: false });
            throw e;
          }
        };
        await tools(call, req);
        return { text: "", steps: calls.length, calls, stopped };
      };
    }
  }

  async complete(req: LlmRequest) {
    this.completeCalls.push(req);
    if (!this.o.complete) throw new Error("tidak ada narasi");
    return this.o.complete(req);
  }
}

type Overview = { indeks: number; asal: string; jenisDefault: string[]; kebutuhanTakTerpenuhi: number; dampakInfoLayanan: string }[];

let seq = 0;
const advisory = (over: Partial<NewServiceAdvisory> = {}): Omit<NewServiceAdvisory, "status" | "reviewedBy" | "reviewedAt" | "reviewNote"> => ({
  source: { type: "x", account: "KRLTest", postId: String(++seq), url: `https://x.com/KRLTest/status/${seq}`, postedAt: new Date(Date.now() - 5 * 60_000).toISOString(), text: "teks asli postingan" },
  operator: "KAI Commuter",
  category: "penutupan",
  impact: "closure",
  summary: "Stasiun Sudirman Baru BNI City ditutup sementara.",
  stationIds: ["bni-city"],
  lineIds: [],
  validFrom: null,
  expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  extraction: { by: "llm" },
  ...over,
});

async function setLlmEnabled(app: Parameters<typeof request>[0], auth: Record<string, string>, enabled: boolean) {
  const s = await request(app).get("/api/admin/settings").set(auth);
  const res = await request(app).put("/api/admin/settings").set(auth).send({ data: { ...s.body.data.published, llmEnabled: enabled } });
  expect(res.status).toBe(200);
  expect((await request(app).post("/api/admin/publish").set(auth).send({})).status).toBe(200);
}

describe("Pipeline default vs LLM dan toggle admin", () => {
  it("llmAvailability dan resolvePipeline", () => {
    const llm = new FakeLlm();
    expect(llmAvailability(true, llm)).toMatchObject({ available: true, pipelines: ["default", "llm"], defaultPipeline: "default" });
    expect(llmAvailability(false, llm)).toMatchObject({ available: false, pipelines: ["default"] });
    expect(llmAvailability(true, null)).toMatchObject({ available: false, pipelines: ["default"] });
    expect(resolvePipeline({ requested: "llm", llmEnabled: true, llm })).toEqual({ use: "llm" });
    expect(resolvePipeline({ llmEnabled: true, llm })).toEqual({ use: "default" });
    expect(resolvePipeline({ requested: "llm", llmEnabled: false, llm }).use).toBe("default");
    expect(resolvePipeline({ requested: "llm", llmEnabled: true, llm, skipLlm: true }).use).toBe("default");
  });

  it("/api/meta memberi tahu apakah opsi LLM tersedia", async () => {
    const none = await makeTestApp();
    expect((await request(none.app).get("/api/meta")).body.data.llm).toMatchObject({ available: false, pipelines: ["default"] });
    const { app, login } = await makeTestApp({ llm: new FakeLlm() });
    expect((await request(app).get("/api/meta")).body.data.llm).toMatchObject({ available: true, pipelines: ["default", "llm"], defaultPipeline: "default" });
    const auth = { Authorization: `Bearer ${await login()}` };
    await setLlmEnabled(app, auth, false);
    const off = (await request(app).get("/api/meta")).body.data.llm;
    expect(off).toMatchObject({ available: false, pipelines: ["default"] });
    expect(off.reason).toMatch(/dimatikan/);
  });

  it("mode LLM mati: permintaan pipeline llm turun ke default tanpa memanggil LLM", async () => {
    const llm = new ScriptLlm({ complete: () => "x", tools: async () => {} });
    const { app, login } = await makeTestApp({ llm });
    const auth = { Authorization: `Bearer ${await login()}` };
    await setLlmEnabled(app, auth, false);
    const res = await plan(app, { ...JK_DA, pipeline: "llm" });
    expect(res.status).toBe(200);
    expect(res.body.data.pipeline).toMatchObject({ requested: "llm", used: "default", navigation: "default", narration: "template" });
    expect(res.body.data.pipeline.reason).toMatch(/dimatikan oleh admin/);
    expect(llm.completeCalls).toHaveLength(0);
    expect(llm.toolResults).toHaveLength(0);
  });

  it("tanpa klien LLM, pipeline llm turun ke default dengan alasan", async () => {
    const { app } = await makeTestApp();
    const res = await plan(app, { ...JK_DA, pipeline: "llm" });
    expect(res.body.data.pipeline).toMatchObject({ requested: "llm", used: "default" });
    expect(res.body.data.pipeline.reason).toMatch(/belum dikonfigurasi/);
  });

  it("pipeline default (bawaan) tidak memanggil LLM walau tersedia", async () => {
    const llm = new ScriptLlm({ complete: () => "x", tools: async () => {} });
    const { app } = await makeTestApp({ llm });
    for (const body of [JK_DA, { ...JK_DA, pipeline: "default" }]) {
      const res = await plan(app, body);
      expect(res.body.data.pipeline).toMatchObject({ requested: "default", used: "default", navigation: "default", narration: "template" });
    }
    expect(llm.completeCalls).toHaveLength(0);
    expect(llm.toolResults).toHaveLength(0);
  });

  it("pipeline tidak dikenal ditolak", async () => {
    const { app } = await makeTestApp();
    expect((await plan(app, { ...JK_DA, pipeline: "gpt" })).status).toBe(400);
  });
});

describe("Agent navigasi LLM", () => {
  it("memilih kandidat lewat tool; pilihannya menjadi opsi pertama beserta alasan", async () => {
    let overview: Overview = [];
    const llm = new ScriptLlm({
      complete: () => "Naik KAI Commuter Lin Bogor dari Jakarta Kota ke Manggarai.",
      tools: async (call) => {
        overview = (await call("lihat_pilihan_rute")).kandidat;
        const moderat = overview.find((c) => c.jenisDefault.includes("moderat"))!;
        await call("detail_rute", { indeks: moderat.indeks });
        await call("cek_fasilitas", { stasiunId: "manggarai" });
        await call("pilih_rute", { indeks: moderat.indeks, alasan: "Lebih sedikit anak tangga dan fasilitas lengkap." });
      },
    });
    const { app } = await makeTestApp({ llm });
    const res = await plan(app, { ...JK_DA, pipeline: "llm" });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.pipeline).toMatchObject({ requested: "llm", used: "llm", navigation: "llm", model: "script-1" });
    expect(d.pipeline.steps).toBe(4);
    // Pilihan default "moderat" (3 transfer) dipromosikan menjadi pilihan pertama; narasi tetap dicoba lewat LLM.
    expect(d.options[0]).toMatchObject({ pickedBy: "llm", llmReason: "Lebih sedikit anak tangga dan fasilitas lengkap." });
    expect(d.options[0].kinds).toContain("moderat");
    expect(d.route.transfers).toBe(3);
    expect(d.options.filter((o: { pickedBy?: string }) => o.pickedBy === "llm")).toHaveLength(1);
    expect(llm.completeCalls).toHaveLength(1);
    // Tanpa agent, pilihan pertama adalah rute paling aksesibel (2 transfer).
    const dflt = await plan(app, JK_DA);
    expect(dflt.body.data.route.transfers).toBe(2);
    expect(dflt.body.data.options[0].pickedBy).toBeUndefined();
  });

  it("hasil tool memuat fakta dari data, bukan karangan LLM", async () => {
    const llm = new ScriptLlm({
      tools: async (call) => {
        const o: Overview = (await call("lihat_pilihan_rute")).kandidat;
        const detail = await call("detail_rute", { indeks: 0 });
        expect(detail.fakta.rute.length).toBeGreaterThan(0);
        expect(JSON.stringify(detail)).toContain("Manggarai");
        const fac = await call("cek_fasilitas", { stasiunId: "sudirman" });
        expect(fac).toMatchObject({ stasiun: "Sudirman", skor: 45, memadai: false });
        await expect(call("cek_fasilitas", { stasiunId: "stasiun-karangan" })).rejects.toThrow(/tidak dikenal/);
        await expect(call("detail_rute", { indeks: 99 })).rejects.toThrow(/tidak ada/);
        await call("pilih_rute", { indeks: o[0].indeks, alasan: "" });
      },
    });
    const { app } = await makeTestApp({ llm });
    expect((await plan(app, { ...JK_DA, pipeline: "llm" })).body.data.pipeline.navigation).toBe("llm");
  });

  it("pagar menolak pilihan dengan kebutuhan fasilitas tak terpenuhi lebih banyak", async () => {
    const llm = new ScriptLlm({
      complete: () => "Naik KAI Commuter Lin Bogor dari Jakarta Kota ke Manggarai.",
      tools: async (call) => {
        const o: Overview = (await call("lihat_pilihan_rute")).kandidat;
        // Rute dataset lewat Sudirman: lift tidak tercatat padahal pengguna membutuhkannya.
        const bad = o.find((c) => c.asal === "dataset")!;
        expect(bad.kebutuhanTakTerpenuhi).toBeGreaterThan(0);
        await call("pilih_rute", { indeks: bad.indeks, alasan: "Paling cepat." });
      },
    });
    const { app } = await makeTestApp({ llm });
    const res = await plan(app, { ...JK_DA, needs: ["lift"], pipeline: "llm" });
    const d = res.body.data;
    expect(d.pipeline.navigation).toBe("default");
    expect(d.pipeline.notes.join(" ")).toMatch(/ditolak pagar/);
    expect(d.options[0].pickedBy).toBeUndefined();
    expect(d.options[0].summary.unmetNeeds).toBe(0);
    // Narasi LLM tetap dipakai sehingga pipeline dianggap llm.
    expect(d.pipeline.used).toBe("llm");
  });

  it("alasan dibuang bila memuat angka atau tautan karangan", async () => {
    const mk = (alasan: string) =>
      new ScriptLlm({
        tools: async (call) => {
          const o: Overview = (await call("lihat_pilihan_rute")).kandidat;
          await call("pilih_rute", { indeks: o[0].indeks, alasan });
        },
      });
    const { app: a1 } = await makeTestApp({ llm: mk("Hemat 99 menit dibanding rute lain.") });
    const r1 = (await plan(a1, { ...JK_DA, pipeline: "llm" })).body.data;
    expect(r1.pipeline.navigation).toBe("llm");
    expect(r1.options.find((o: { pickedBy?: string }) => o.pickedBy)?.llmReason).toBeUndefined();
    expect(r1.pipeline.notes.join(" ")).toMatch(/Alasan agent LLM dibuang/);
    const { app: a2 } = await makeTestApp({ llm: mk("Lihat https://contoh.example untuk detail.") });
    expect((await plan(a2, { ...JK_DA, pipeline: "llm" })).body.data.pipeline.notes.join(" ")).toMatch(/Alasan agent LLM dibuang/);
  });

  it("cari_rute_baru menambah kandidat lewat planner, paling banyak dua kali", async () => {
    let first: any;
    let third: unknown;
    const llm = new ScriptLlm({
      tools: async (call) => {
        first = await call("cari_rute_baru", { hindariStasiunId: ["manggarai"] });
        await call("cari_rute_baru", { hindariModa: ["BUS"] });
        third = await call("cari_rute_baru", {}).catch((e: Error) => e.message);
        const o: Overview = (await call("lihat_pilihan_rute")).kandidat;
        await call("pilih_rute", { indeks: o[0].indeks, alasan: "" });
      },
    });
    const { app } = await makeTestApp({ llm });
    const res = await plan(app, { ...JK_DA, pipeline: "llm" });
    expect(res.status).toBe(200);
    expect(typeof first.catatan).toBe("string");
    expect(third).toMatch(/sudah dipakai 2 kali/);
    expect(res.body.data.pipeline.navigation).toBe("llm");
  });

  it("LLM gagal: kembali ke pemilihan default dan tetap memberi rute", async () => {
    const llm = new ScriptLlm({
      complete: () => {
        throw new Error("timeout");
      },
      tools: async () => {
        throw new Error("LLM: batas laju terlampaui");
      },
    });
    const { app } = await makeTestApp({ llm });
    const res = await plan(app, { ...JK_DA, pipeline: "llm" });
    expect(res.status).toBe(200);
    expect(res.body.data.pipeline).toMatchObject({ requested: "llm", used: "default", navigation: "default", narration: "template" });
    expect(res.body.data.pipeline.notes.join(" ")).toMatch(/gagal/);
    expect(res.body.data.pipeline.reason).toBeDefined();
    expect(res.body.data.route.transfers).toBe(2);
  });

  it("agent yang tidak memilih sampai batas langkah: pilihan default", async () => {
    const llm = new ScriptLlm({ tools: async (call) => void (await call("lihat_pilihan_rute")) });
    const { app } = await makeTestApp({ llm });
    const res = await plan(app, { ...JK_DA, pipeline: "llm" });
    expect(res.body.data.pipeline).toMatchObject({ navigation: "default" });
    expect(res.body.data.pipeline.notes.join(" ")).toMatch(/tidak memilih/);
  });

  it("klien tanpa tool-calling: navigasi default, narasi tetap LLM", async () => {
    const llm = new FakeLlm("Naik KAI Commuter Lin Bogor dari Jakarta Kota ke Manggarai.");
    const { app } = await makeTestApp({ llm });
    const res = await plan(app, { ...JK_DA, pipeline: "llm" });
    expect(res.body.data.pipeline).toMatchObject({ used: "llm", navigation: "default", narration: "llm" });
    expect(res.body.data.pipeline.notes.join(" ")).toMatch(/tidak mendukung tool-calling/);
    expect(res.body.data.notification.source).toBe("LLM");
  });

  it("checkChoice dan reasonOk", () => {
    const v = (unmet: number, modes = false, impact: "none" | "delay" | "disruption" | "closure" = "none") => ({ unmetNeeds: unmet, usesAvoidedModes: modes, advisoryImpact: impact });
    expect(checkChoice(5, [v(0)])).toMatch(/tidak ada/);
    expect(checkChoice(0, [v(1), v(0)])).toMatch(/kebutuhan fasilitas/);
    expect(checkChoice(1, [v(1), v(0)])).toBeNull();
    expect(checkChoice(0, [v(0, true), v(0)])).toMatch(/moda yang dihindari/);
    expect(checkChoice(0, [v(0, true), v(0, true)])).toBeNull();
    expect(checkChoice(0, [v(0, false, "closure"), v(0)])).toMatch(/penutupan/);
    // Semua kandidat sama-sama terdampak berat: tidak ada pilihan yang lebih baik, jadi pilihan LLM diterima.
    expect(checkChoice(0, [v(0, false, "closure"), v(0, false, "disruption")])).toBeNull();
    expect(checkChoice(0, [v(0, false, "delay"), v(0, false, "closure")])).toBeNull();
    expect(reasonOk("Lebih sedikit transfer, hanya 2 kali pindah.", "")).toBe(true);
    expect(reasonOk("Hemat 45 menit.", '{"menit":12}')).toBe(false);
    expect(reasonOk("Hemat 45 menit.", '{"menit":45}')).toBe(true);
    expect(reasonOk("Lihat https://x.example", "")).toBe(false);
    expect(reasonOk("", "")).toBe(false);
  });
});

describe("Informasi layanan: baru mengubah navigasi setelah disetujui admin", () => {
  const rank = (d: { options: { summary: { rankScore: number }; kinds: string[] }[] }) => d.options.map((o) => ({ r: o.summary.rankScore, k: o.kinds }));

  it("belum disetujui: hanya tampil sebagai info, rute tidak berubah; setelah disetujui, rute berubah", async () => {
    const { app, login, services } = await makeTestApp();
    const auth = { Authorization: `Bearer ${await login()}` };
    const base = (await plan(app, JK_DA)).body.data;
    expect(base.serviceInfo).toEqual([]);
    expect(stopsOf(base.options[0].route)).toContain("bni-city");

    const pending = await services.advisories.create(advisory());
    const withPending = (await plan(app, JK_DA)).body.data;
    expect(withPending.serviceInfo).toHaveLength(1);
    expect(withPending.serviceInfo[0]).toMatchObject({ id: pending.id, status: "pending", verified: false, category: "penutupan" });
    // Informasi yang belum disetujui tidak membocorkan dampak maupun teks asli postingan.
    expect(withPending.serviceInfo[0].impact).toBeUndefined();
    expect(JSON.stringify(withPending.serviceInfo)).not.toContain("teks asli postingan");
    // Navigasi sama persis.
    expect(rank(withPending)).toEqual(rank(base));
    expect(withPending.options.map((o: { route: any }) => stopsOf(o.route))).toEqual(base.options.map((o: { route: any }) => stopsOf(o.route)));
    expect(withPending.options.every((o: { summary: { advisoryImpact?: string } }) => o.summary.advisoryImpact === undefined)).toBe(true);

    // Admin menyetujui: navigasi berubah.
    const ok = await request(app).post(`/api/admin/service-info/${pending.id}/approve`).set(auth).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: "approved", reviewedBy: "admin@ntd.test" });
    const after = (await plan(app, JK_DA)).body.data;
    expect(after.serviceInfo[0]).toMatchObject({ status: "approved", verified: true, impact: "closure" });
    expect(rank(after)).not.toEqual(rank(base));
    // Stasiun yang ditutup dihindari sebagai titik pindah: rute dialihkan (lewat Sudirman) dan penumpang diberi tahu.
    const touching = after.options.filter((o: { route: any }) => o.route.legs.some((l: any) => [l.stops[0], l.stops[l.stops.length - 1]].includes("bni-city")));
    for (const o of touching) expect(o.summary).toMatchObject({ advisoryImpact: "closure", advisoryIds: [pending.id] });
    const first = after.options[0];
    expect(first.route.legs.some((l: any) => [l.stops[0], l.stops[l.stops.length - 1]].includes("bni-city"))).toBe(false);
    expect(first.summary.advisoryImpact).toBeUndefined();
    expect(first.route.legs.some((l: any) => l.lineId === "krl-cikarang")).toBe(true);
    expect(first.warnings.join(" ")).toMatch(/Rute dipilih agar menghindari titik pindah Sudirman Baru BNI City yang terdampak informasi layanan yang disetujui admin/);
  });

  it("gangguan di titik pindah yang tak terhindarkan: rute alternatif tidak dibuang, hanya dikurangi skornya", async () => {
    const { app, services } = await makeTestApp();
    const base = (await plan(app, JK_DA)).body.data;
    expect(base.options).toHaveLength(3);
    // Semua rute dari Jakarta Kota ke Dukuh Atas pindah di Manggarai.
    const a = await services.advisories.create(advisory({ impact: "disruption", category: "gangguan", summary: "Gangguan sinyal di Manggarai.", stationIds: ["manggarai"], lineIds: [] }));
    await services.advisories.approve(a.id, {}, "admin@ntd.test");
    const after = (await plan(app, JK_DA)).body.data;
    // Pilihan tetap ada dan urutannya tetap; yang berubah hanya skor (-30) dan peringatan.
    expect(after.options).toHaveLength(3);
    expect(after.options.map((o: any) => stopsOf(o.route))).toEqual(base.options.map((o: any) => stopsOf(o.route)));
    expect(after.options.map((o: any) => o.summary.rankScore)).toEqual(base.options.map((o: any) => o.summary.rankScore - 30));
    expect(after.options.every((o: any) => o.summary.advisoryImpact === "disruption")).toBe(true);
    expect(after.options[0].warnings.join(" ")).toMatch(/Rute ini tetap melewati titik pindah Manggarai yang terdampak informasi layanan yang disetujui admin; rute yang menghindarinya kurang aksesibel atau tidak ada/);
    expect(after.serviceInfo[0]).toMatchObject({ status: "approved", impact: "disruption" });
  });

  it("penutupan lini disetujui mengurangi skor rute yang memakainya dan memberi peringatan", async () => {
    const { app, services } = await makeTestApp();
    const base = (await plan(app, JK_DA)).body.data;
    expect(base.options[0].route.legs.some((l: any) => l.lineId === "ka-bandara")).toBe(true);
    const a = await services.advisories.create(advisory({ impact: "closure", category: "penutupan", summary: "KA Bandara tidak beroperasi sementara.", stationIds: [], lineIds: ["ka-bandara"] }));
    const pendingView = (await plan(app, JK_DA)).body.data;
    expect(rank(pendingView)).toEqual(rank(base));
    await services.advisories.approve(a.id, {}, "admin@ntd.test");
    const after = (await plan(app, JK_DA)).body.data;
    const usesAirport = (o: any) => o.route.legs.some((l: any) => l.lineId === "ka-bandara");
    expect(after.options.filter(usesAirport).length).toBeGreaterThan(0);
    for (const o of after.options.filter(usesAirport)) {
      expect(o.summary).toMatchObject({ advisoryImpact: "closure", advisoryIds: [a.id] });
      expect(o.warnings.join(" ")).toMatch(/Informasi layanan \(disetujui admin, sumber @KRLTest\): KA Bandara tidak beroperasi sementara\./);
    }
    // Pilihan pertama sekarang rute yang tidak memakai KA Bandara.
    expect(usesAirport(after.options[0])).toBe(false);
    expect(after.options[0].summary.advisoryImpact).toBeUndefined();
    // Selisih skor tepat penalti penutupan (60) bagi rute yang sama.
    const same = after.options.find(usesAirport);
    const was = base.options.find((o: any) => JSON.stringify(stopsOf(o.route)) === JSON.stringify(stopsOf(same.route)));
    expect(was.summary.rankScore - same.summary.rankScore).toBe(60);
  });

  it("delay disetujui mengurangi skor rute yang memakai lininya tanpa menutupnya", async () => {
    const { app, services } = await makeTestApp();
    const base = (await plan(app, JK_DA)).body.data;
    const a = await services.advisories.create(advisory({ category: "keterlambatan", impact: "delay", summary: "Lin Bogor terlambat.", stationIds: [], lineIds: ["krl-bogor"] }));
    await services.advisories.approve(a.id, {}, "admin@ntd.test");
    const after = (await plan(app, JK_DA)).body.data;
    // Semua rute memakai Lin Bogor: semuanya dikurangi 8 poin, urutan tetap.
    expect(after.options.map((o: any) => o.summary.rankScore)).toEqual(base.options.map((o: any) => o.summary.rankScore - 8));
    expect(after.options.every((o: any) => o.summary.advisoryImpact === "delay")).toBe(true);
  });

  it("masa berlaku: informasi kedaluwarsa tidak lagi tampil atau berpengaruh", async () => {
    const { app, services } = await makeTestApp();
    const a = await services.advisories.create(advisory({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    await services.advisories.approve(a.id, {}, "admin@ntd.test");
    const now = (await plan(app, JK_DA)).body.data;
    expect(now.serviceInfo).toHaveLength(1);
    const later = (await plan(app, { ...JK_DA, at: new Date(Date.now() + 2 * 3_600_000).toISOString() })).body.data;
    expect(later.serviceInfo).toEqual([]);
    expect(later.options.every((o: any) => o.summary.advisoryImpact === undefined)).toBe(true);
    // Dikedaluwarsakan admin: berhenti saat itu juga.
    await services.advisories.expire(a.id, "admin@ntd.test");
    expect((await plan(app, JK_DA)).body.data.serviceInfo).toEqual([]);
  });

  it("mode LLM mati: yang belum diverifikasi disembunyikan, yang disetujui tetap berlaku", async () => {
    const { app, login, services } = await makeTestApp({ llm: new FakeLlm() });
    const auth = { Authorization: `Bearer ${await login()}` };
    const approved = await services.advisories.create(advisory());
    await services.advisories.approve(approved.id, {}, "admin@ntd.test");
    await services.advisories.create(advisory({ summary: "Kabar belum diperiksa.", stationIds: ["manggarai"], impact: "info", category: "lainnya" }));
    expect((await plan(app, JK_DA)).body.data.serviceInfo).toHaveLength(2);
    expect((await request(app).get("/api/service-info")).body.data).toHaveLength(2);

    await setLlmEnabled(app, auth, false);
    const d = (await plan(app, JK_DA)).body.data;
    expect(d.serviceInfo.map((x: any) => x.status)).toEqual(["approved"]);
    // Yang disetujui tetap mengubah navigasi walau LLM dimatikan: bni-city dihindari sebagai titik pindah.
    expect(d.options[0].warnings.join(" ")).toMatch(/Rute dipilih agar menghindari titik pindah Sudirman Baru BNI City/);
    expect(d.options[0].route.legs.some((l: any) => [l.stops[0], l.stops[l.stops.length - 1]].includes("bni-city"))).toBe(false);
    expect((await request(app).get("/api/service-info")).body.data.map((x: any) => x.status)).toEqual(["approved"]);
  });

  it("GET /api/service-info: saring per stasiun/lini dan tanpa data internal", async () => {
    const { app, services } = await makeTestApp();
    const a = await services.advisories.create(advisory({ stationIds: ["manggarai"], lineIds: [] }));
    await services.advisories.create(advisory({ stationIds: ["duri"], lineIds: [] }));
    const all = (await request(app).get("/api/service-info")).body.data;
    expect(all).toHaveLength(2);
    const m = (await request(app).get("/api/service-info?stationId=manggarai")).body.data;
    expect(m.map((x: any) => x.id)).toEqual([a.id]);
    expect(m[0]).toMatchObject({ source: { account: "KRLTest", type: "x" }, status: "pending" });
    expect(m[0].source.text).toBeUndefined();
    expect(m[0].reviewedBy).toBeUndefined();
    expect((await request(app).get("/api/service-info?lineId=mrt-ns")).body.data).toEqual([]);
  });

  it("informasi layanan tanpa cakupan stasiun/lini dicocokkan lewat operator", async () => {
    const { app, services } = await makeTestApp();
    await services.advisories.create(advisory({ stationIds: [], lineIds: [], operator: "KAI Commuter", impact: "info", category: "lainnya", summary: "Info KRL." }));
    await services.advisories.create(advisory({ stationIds: [], lineIds: [], operator: "Operator Lain", impact: "info", category: "lainnya", summary: "Info lain." }));
    const d = (await plan(app, JK_DA)).body.data;
    expect(d.serviceInfo.map((x: any) => x.summary)).toEqual(["Info KRL."]);
  });

  it("agent LLM melihat info layanan berlabel disetujui atau belum diverifikasi lewat tool", async () => {
    let seen: any[] = [];
    const llm = new ScriptLlm({
      tools: async (call) => {
        seen = (await call("info_layanan", {})).informasi;
        const o: Overview = (await call("lihat_pilihan_rute")).kandidat;
        expect(o.some((c) => c.dampakInfoLayanan === "closure")).toBe(true);
        const best = o.find((c) => c.dampakInfoLayanan === "none")!;
        await call("pilih_rute", { indeks: best.indeks, alasan: "" });
      },
    });
    const { app, services } = await makeTestApp({ llm });
    const a = await services.advisories.create(advisory({ stationIds: [], lineIds: ["ka-bandara"] }));
    await services.advisories.approve(a.id, {}, "admin@ntd.test");
    await services.advisories.create(advisory({ impact: "info", category: "lainnya", summary: "Kabar belum diperiksa.", stationIds: ["manggarai"] }));
    const res = await plan(app, { ...JK_DA, pipeline: "llm" });
    expect(res.body.data.pipeline.navigation).toBe("llm");
    expect(seen.map((x) => x.status).sort()).toEqual(["belum_diverifikasi", "disetujui"]);
    expect(seen.find((x) => x.status === "belum_diverifikasi").dampak).toBeUndefined();
    expect(seen.find((x) => x.status === "disetujui").dampak).toBe("closure");
  });

  it("pagar: agent LLM tidak boleh memilih rute yang menembus penutupan disetujui bila ada rute lain", async () => {
    const llm = new ScriptLlm({
      tools: async (call) => {
        const o: Overview = (await call("lihat_pilihan_rute")).kandidat;
        const closed = o.find((c) => c.dampakInfoLayanan === "closure")!;
        await call("pilih_rute", { indeks: closed.indeks, alasan: "Lebih cepat." });
      },
    });
    const { app, services } = await makeTestApp({ llm });
    const a = await services.advisories.create(advisory({ stationIds: [], lineIds: ["ka-bandara"] }));
    await services.advisories.approve(a.id, {}, "admin@ntd.test");
    const d = (await plan(app, { ...JK_DA, pipeline: "llm" })).body.data;
    expect(d.pipeline.navigation).toBe("default");
    expect(d.pipeline.notes.join(" ")).toMatch(/penutupan/);
    expect(d.options[0].summary.advisoryImpact).toBeUndefined();
  });

  it("narasi LLM boleh menyebut angka dari informasi layanan yang ikut dikirim ke LLM", async () => {
    const llm = new ScriptLlm({
      complete: () => "Naik KAI Commuter Lin Bogor dari Jakarta Kota ke Manggarai. Ada informasi layanan: perjalanan terlambat sekitar 25 menit.",
      tools: async (call) => {
        const o: Overview = (await call("lihat_pilihan_rute")).kandidat;
        await call("pilih_rute", { indeks: o.find((c) => c.jenisDefault.includes("aksesibel"))!.indeks, alasan: "" });
      },
    });
    const { app, services } = await makeTestApp({ llm });
    await services.advisories.create(advisory({ stationIds: ["manggarai"], impact: "info", category: "keterlambatan", summary: "Perjalanan terlambat sekitar 25 menit." }));
    const d = (await plan(app, { ...JK_DA, pipeline: "llm" })).body.data;
    expect(d.notification).toMatchObject({ source: "LLM", grounded: true });
    const prompt = llm.completeCalls[0].prompt;
    expect(prompt).toContain("belum diverifikasi");
  });
});

describe("Antrean persetujuan admin (API)", () => {
  it("peran: editor boleh melihat dan mengubah isian, hanya admin yang menyetujui, menolak, dan mengedaluwarsakan", async () => {
    const { app, login, services } = await makeTestApp();
    const admin = { Authorization: `Bearer ${await login()}` };
    const editor = { Authorization: `Bearer ${await login(EDITOR)}` };
    const a = await services.advisories.create(advisory());
    expect((await request(app).get("/api/admin/service-info")).status).toBe(401);
    const list = await request(app).get("/api/admin/service-info?status=pending").set(editor);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    // Admin melihat teks asli; ini hanya di API admin.
    expect(list.body.data[0].source.text).toBe("teks asli postingan");
    const patch = await request(app).patch(`/api/admin/service-info/${a.id}`).set(editor).send({ summary: "Ringkasan diperbaiki." });
    expect(patch.status).toBe(200);
    expect(patch.body.data.summary).toBe("Ringkasan diperbaiki.");
    for (const path of ["approve", "reject", "expire"]) expect((await request(app).post(`/api/admin/service-info/${a.id}/${path}`).set(editor).send({})).status).toBe(403);
    expect((await request(app).post("/api/admin/service-info/ingest").set(editor).send({ text: "Gangguan di Stasiun Manggarai" })).status).toBe(403);
    expect((await request(app).post("/api/admin/service-info/poll").set(editor).send({})).status).toBe(403);
    expect((await request(app).put("/api/admin/ai/reader").set(editor).send({ enabled: true })).status).toBe(403);
    expect((await request(app).post(`/api/admin/service-info/${a.id}/approve`).set(admin).send({})).status).toBe(200);
  });

  it("validasi: dampak tanpa cakupan, stasiun tak dikenal, masa berlaku lewat atau terlalu panjang", async () => {
    const { app, login, services } = await makeTestApp();
    const admin = { Authorization: `Bearer ${await login()}` };
    const post = (id: string, path: string, body: object = {}) => request(app).post(`/api/admin/service-info/${id}/${path}`).set(admin).send(body);
    const noScope = await services.advisories.create(advisory({ stationIds: [], lineIds: [] }));
    const r1 = await post(noScope.id, "approve");
    expect(r1.status).toBe(400);
    expect(r1.body.message).toMatch(/stasiun atau lini yang terdampak/);
    expect((await post(noScope.id, "approve", { stationIds: ["stasiun-karangan"] })).status).toBe(400);
    expect((await post(noScope.id, "approve", { lineIds: ["lin-karangan"] })).status).toBe(400);
    // Lengkapi cakupan lalu setujui.
    expect((await post(noScope.id, "approve", { stationIds: ["manggarai"], impact: "disruption" })).body.data).toMatchObject({ status: "approved", impact: "disruption", stationIds: ["manggarai"] });

    const past = await services.advisories.create(advisory({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect((await post(past.id, "approve")).body.message).toMatch(/sudah lewat/);
    const tooLong = await services.advisories.create(advisory());
    expect((await post(tooLong.id, "approve", { expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() })).body.message).toMatch(/paling lama 7 hari/);
    expect((await post(tooLong.id, "approve", { impact: "tidak-ada" })).status).toBe(400);
  });

  it("siklus status: setujui sekali, tolak, kedaluwarsakan; tolak tidak berpengaruh pada navigasi", async () => {
    const { app, login, services } = await makeTestApp();
    const admin = { Authorization: `Bearer ${await login()}` };
    const post = (id: string, path: string, body: object = {}) => request(app).post(`/api/admin/service-info/${id}/${path}`).set(admin).send(body);
    const a = await services.advisories.create(advisory());
    expect((await post(a.id, "expire")).status).toBe(409);
    expect((await post(a.id, "approve")).status).toBe(200);
    expect((await post(a.id, "approve")).status).toBe(409);
    expect((await request(app).patch(`/api/admin/service-info/${a.id}`).set(admin).send({ summary: "ubah" })).status).toBe(409);
    expect((await post(a.id, "expire")).body.data.status).toBe("approved");
    expect((await plan(app, JK_DA)).body.data.serviceInfo).toEqual([]);

    const b = await services.advisories.create(advisory());
    const rej = await post(b.id, "reject", { note: "Bukan informasi resmi." });
    expect(rej.body.data).toMatchObject({ status: "rejected", reviewNote: "Bukan informasi resmi." });
    expect((await post(b.id, "reject")).status).toBe(409);
    expect((await plan(app, JK_DA)).body.data.serviceInfo).toEqual([]);
    expect((await request(app).get("/api/service-info")).body.data).toEqual([]);
    expect((await request(app).get("/api/admin/service-info/tidak-ada").set(admin)).status).toBe(404);
    const audit = (await request(app).get("/api/admin/audit").set(admin)).body.data.map((x: any) => x.action);
    expect(audit).toEqual(expect.arrayContaining(["service_info.approve", "service_info.reject", "service_info.expire"]));
  });

  it("input manual: tanpa LLM, stasiun/lini dicocokkan deterministik dan masuk antrean pending", async () => {
    const { app, login } = await makeTestApp();
    const admin = { Authorization: `Bearer ${await login()}` };
    const res = await request(app).post("/api/admin/service-info/ingest").set(admin).send({ text: "Gangguan sinyal di Stasiun Manggarai, perjalanan KRL Lin Cikarang terlambat.", account: "@KRLTest", operator: "KAI Commuter", postId: "777" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "pending", impact: "info", stationIds: ["manggarai"], lineIds: ["krl-cikarang"], extraction: { by: "manual" }, source: { type: "manual", account: "KRLTest" } });
    // Postingan yang sama tidak masuk dua kali.
    expect((await request(app).post("/api/admin/service-info/ingest").set(admin).send({ text: "Gangguan sinyal di Stasiun Manggarai", account: "KRLTest", postId: "777" })).status).toBe(409);
    expect((await request(app).post("/api/admin/service-info/ingest").set(admin).send({ text: "x" })).status).toBe(400);
    expect((await request(app).post("/api/admin/service-info/ingest").set(admin).send({ text: "Gangguan di Manggarai", url: "http://tidak-aman.example" })).status).toBe(400);
  });

  it("/ai/status dan /ai/reader: ringkasan mode LLM, klien, pembaca, dan pengaturan akun", async () => {
    const { app, login } = await makeTestApp({ llm: new ScriptLlm({ tools: async () => {} }) });
    const admin = { Authorization: `Bearer ${await login()}` };
    const st = (await request(app).get("/api/admin/ai/status").set(admin)).body.data;
    expect(st.llm).toMatchObject({ enabled: true, draftEnabled: null, client: { provider: "script", toolCalling: true }, availability: { available: true } });
    expect(st.reader.source).toEqual({ kind: "none", configured: false });
    expect(st.reader.problem).toMatch(/Sumber postingan belum dikonfigurasi/);
    expect(st.reader.config).toMatchObject({ enabled: false, monthlyPostBudget: 3000, accounts: [] });

    const put = await request(app).put("/api/admin/ai/reader").set(admin).send({ enabled: true, monthlyPostBudget: 1000, accounts: [{ handle: "@KRLTest", operator: "KAI Commuter" }] });
    expect(put.status).toBe(200);
    expect(put.body.data.config).toMatchObject({ enabled: true, monthlyPostBudget: 1000, accounts: [{ handle: "KRLTest", operator: "KAI Commuter", enabled: true }] });
    // Konfigurasi tidak valid.
    expect((await request(app).put("/api/admin/ai/reader").set(admin).send({ accounts: [{ handle: "a b", operator: "X" }] })).status).toBe(400);
    expect((await request(app).put("/api/admin/ai/reader").set(admin).send({ accounts: [{ handle: "KRLTest", operator: "X" }, { handle: "krltest", operator: "Y" }] })).status).toBe(400);
    expect((await request(app).put("/api/admin/ai/reader").set(admin).send({ intervalMinutes: 1 })).status).toBe(400);
    // Toggle induk lewat pengaturan: draft terlihat di status sebelum dipublikasikan.
    const s = await request(app).get("/api/admin/settings").set(admin);
    await request(app).put("/api/admin/settings").set(admin).send({ data: { ...s.body.data.published, llmEnabled: false } });
    expect((await request(app).get("/api/admin/ai/status").set(admin)).body.data.llm).toMatchObject({ enabled: true, draftEnabled: false });
  });
});
