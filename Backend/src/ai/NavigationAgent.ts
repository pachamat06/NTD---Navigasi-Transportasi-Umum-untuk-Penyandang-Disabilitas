// Agen Navigasi Aksesibilitas (Gambar 3.4). Urutan tool mengikuti Sequence Diagram:
// ambil_rute → cek_fasilitas (loop) → cari_alternatif (opt) → susunNotifikasi → validasiGrounding.
// Seluruh fakta dikumpulkan lebih dulu oleh tool; LLM hanya dipanggil SATU kali untuk menyusun
// narasi notifikasi (Risiko #9 dan #10), dan selalu ada template statis sebagai cadangan.

import type { RequestContext } from "../context";
import type { ContentService, ContentSnapshot } from "../domain/content";
import { routeStationIds, transferStationIds, usesModes } from "../domain/RoutePlannerService";
import { AMENITY_LABEL, journeyAssessment, layoutAccess, needMet, viaText } from "../domain/FacilityAnalysisService";
import type {
  Alternative,
  AmenityDetailStatus,
  JourneyPlan,
  Line,
  Mode,
  Notice,
  Notification,
  PipelineInfo,
  Platform,
  Route,
  RouteOption,
  RouteOptionKind,
  RouteOptionSummary,
  Station,
  StationAssessment,
  StationDetail,
  TransferAccess,
  TransferNeed,
} from "../domain/models";
import { advisoryAvoidStations, advisoryEffectOn, isRelevant, NO_EFFECT, toView, type AdvisoryEffect, type ServiceAdvisory, type ServiceAdvisoryService } from "../domain/serviceAdvisory";
import type { StationService } from "../domain/StationService";
import { AppError } from "../errors";
import { ATTRIBUTION, factsForPrompt, type GroundingGuard, type PlanFacts } from "./GroundingGuard";
import { LlmNavigator, type GuardView, type NavHost } from "./LlmNavigator";
import type { LlmClient } from "./llm/LlmClient";
import type { LlmSource } from "./llm/LlmService";
import { resolvePipeline, type PipelineChoice } from "./pipeline";
import type { ToolRegistry } from "./ToolRegistry";
import { inactiveMessage } from "../domain/stationStatus";

export const MODE_LABEL: Record<Mode, string> = { RAIL: "kereta (KRL)", SUBWAY: "MRT", TRAM: "LRT", BUS: "bus TransJakarta", MONORAIL: "kereta layang bandara" };

export interface PlanInput {
  originId: string;
  destinationId: string;
  /** Pakai stasiun perantara tertentu (mis. alternatif yang dipilih pengguna). */
  viaStationId?: string;
  /** Kompatibel dengan GUI: stasiun yang tidak boleh menjadi titik transfer. */
  avoid?: string[];
  /**
   * Waktu berangkat (ISO). Kosong = sekarang. Jadwal kereta, waktu tunggu, frekuensi, tarif (/fares `at`), pengumuman,
   * dan pilihan rute tercepat (tiba paling awal) dihitung pada waktu ini.
   */
  at?: string;
  /** Moda yang tidak ingin dipakai pengguna (mis. BUS). */
  avoidModes?: Mode[];
  /** Fasilitas yang wajib ada di stasiun tempat pindah (mis. lift untuk pengguna kursi roda). */
  needs?: TransferNeed[];
  /** Pintu masuk di stasiun asal yang dipilih pengguna (id dari detail stasiun `entrances`). */
  entranceId?: string;
  /** Pintu keluar di stasiun tujuan yang dipilih pengguna. */
  exitId?: string;
  /**
   * "default" (bawaan): algoritma deterministik dan notifikasi template, tanpa LLM. "llm": agent navigasi LLM memilih rute
   * dan LLM menyusun narasi. Hanya berlaku bila mode LLM menyala (admin); selain itu turun ke default.
   */
  pipeline?: PipelineChoice;
}

/** Satu rute yang sudah dilengkapi dan dinilai. */
interface Evaluated {
  route: Route;
  assessments: StationAssessment[];
  warnings: string[];
  alternatives: Alternative[];
  summary: RouteOptionSummary;
  origin?: RouteOption["origin"];
  /** Dampak informasi layanan yang disetujui pada rute ini. */
  advisory: AdvisoryEffect;
}

export interface AgentLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const SYSTEM_PROMPT = `Anda menyusun notifikasi ringkasan rute untuk pengguna transportasi umum penyandang disabilitas di Jabodetabek.
Aturan:
- Tulis dalam Bahasa Indonesia yang jelas dan ramah, 2 sampai 4 kalimat, tanpa daftar, tanpa markdown, tanpa tautan.
- Gunakan HANYA fakta pada data JSON yang diberikan. Jangan menambah stasiun, fasilitas, angka, jadwal, atau saran yang tidak ada di data.
- Bila "dataTersedia" bernilai false, katakan data fasilitas stasiun itu belum tersedia; jangan menyimpulkan fasilitasnya tidak ada.
- Status fasilitas "absent" berarti tidak tercatat pada data, bukan pasti tidak ada.
- Sebutkan titik transfer yang perlu diperhatikan dan alternatif bila ada. Sebutkan pengumuman penting bila ada.
- Bila ruas punya "pilihanLin", sebutkan bahwa lin mana pun dari daftar itu bisa dinaiki.
- "frekuensiMenit" adalah rata-rata jarak antarkendaraan, BUKAN jadwal: tulis "biasanya tiap sekitar N menit", jangan menyebut jam berangkat.
- Bila "aksesPindah" memuat fasilitas yang dibutuhkan berstatus selain "available", sebutkan dengan jelas.
- Bila "peronNaik" ada, sebut nomor peronnya. Bila "celahDenganKendaraan.level" adalah "tangga", sebut jumlah anak tangganya.
- Bila "jalurGatePeron" ada, skor stasiun itu sudah memperhitungkan jalur gate ke peron; sebut bila harus menyeberang rel (sebidang) atau jalan (crosswalk), atau lewat JPO/terowongan.
- Bila "tanpaPindahLantai" bernilai true, JANGAN menyebut lift atau eskalator di stasiun itu (tidak dibutuhkan), termasuk "tidak ada lift".
- Bila "pintuDipilih" memuat "disarankan", sebutkan pintu yang disarankan.
- Jangan menulis disclaimer; sistem menambahkannya sendiri.`;

export class NavigationAgent {
  constructor(
    private tools: ToolRegistry,
    private stations: StationService,
    private content: ContentService,
    private guard: GroundingGuard,
    /** Sumber klien LLM (konfigurasi admin/environment, dibaca saat dipakai); null = tanpa LLM. */
    private llmSource: LlmSource | null,
    private log: AgentLogger = { warn: () => {} },
    /** Informasi layanan operator (agent pembaca + persetujuan admin). Tanpa ini, rute tidak terpengaruh informasi layanan. */
    private advisories: ServiceAdvisoryService | null = null,
  ) {}

  async rencanakan(input: PlanInput, ctx: RequestContext): Promise<JourneyPlan> {
    // Waktu berangkat pilihan pengguna, atau sekarang. Pengumuman dan fasilitas rusak berjadwal dinilai pada waktu itu.
    const when = input.at ? new Date(input.at) : ctx.now;
    const snap = await this.content.snapshot(ctx, when);
    ctx.cacheTtlSeconds = snap.settings.cacheTtlSeconds;

    // Pipeline: default (tanpa LLM) atau LLM; hanya bila mode LLM menyala dan klien ada. Informasi layanan: yang disetujui
    // mengubah navigasi di kedua pipeline; yang belum diperiksa hanya tampil sebagai info (dan konteks agent LLM), dan
    // hanya selama mode LLM menyala.
    const requested: PipelineChoice = input.pipeline ?? "default";
    const llm = this.llmSource ? await this.llmSource.client() : null;
    const pipe = resolvePipeline({ requested, llmEnabled: snap.settings.llmEnabled, llm, skipLlm: ctx.skipLlm === true });
    const pipeline: PipelineInfo = { requested, used: "default", navigation: "default", narration: "template", notes: [], ...(pipe.reason ? { reason: pipe.reason } : {}) };
    const activeInfo = this.advisories ? await this.advisories.active(when, { includePending: snap.settings.llmEnabled }) : [];
    const effective = activeInfo.filter((a) => a.status === "approved");

    const all = await this.stations.list(ctx);
    const byId = new Map(all.map((s) => [s.id, s]));
    const { originId, destinationId } = input;
    for (const id of [originId, destinationId, ...(input.viaStationId ? [input.viaStationId] : [])]) {
      if (!byId.has(id)) throw new AppError("INVALID", `Stasiun "${id}" tidak dikenal. Pilih stasiun dari daftar saran.`);
    }
    if (originId === destinationId) throw new AppError("INVALID", "Stasiun asal dan tujuan harus berbeda.");
    // Stasiun yang sudah tidak beroperasi (bawaan NTD atau isian admin) tidak bisa menjadi asal, tujuan, atau perantara.
    for (const id of [originId, destinationId, ...(input.viaStationId ? [input.viaStationId] : [])]) {
      const st = byId.get(id)!;
      if (st.inactive) throw new AppError("INVALID", inactiveMessage(st.name, { source: "ntd", ...(st.inactiveNote ? { note: st.inactiveNote } : {}) }));
    }
    const userAvoid = (input.avoid ?? []).filter((id) => id !== originId && id !== destinationId);
    // Stasiun yang terganggu atau ditutup menurut informasi layanan yang disetujui admin: dicarikan rute tambahan yang
    // menghindarinya sebagai titik transfer. Rute yang tetap melewatinya tidak dibuang (bisa jadi satu-satunya, atau yang
    // paling aksesibel); skornya saja yang dikurangi.
    const advisoryAvoid = advisoryAvoidStations(effective).filter((id) => id !== originId && id !== destinationId && !userAvoid.includes(id));
    const avoid = userAvoid;
    const avoidWithAdvisory = [...userAvoid, ...advisoryAvoid];
    const warnings: string[] = [];

    // 1. Rute dari dataset.
    const avoidModes = input.avoidModes ?? [];
    // Alternatif transfer juga tidak boleh memakai moda yang dihindari.
    const withoutModes = (alts: Alternative[]) => alts.filter((a) => !a.route || !usesModes(a.route, avoidModes));
    const needs = [...new Set(input.needs ?? [])];
    let route = await this.tools.call("ambil_rute", { fromId: originId, toId: destinationId, viaId: input.viaStationId, at: input.at, avoidModes, needs }, ctx, snap);
    if (!route) {
      throw new AppError("NOT_FOUND", `Rute antara ${byId.get(originId)!.name} dan ${byId.get(destinationId)!.name} tidak ditemukan dalam data saat ini.`);
    }
    const hubs = await this.stations.hubs(ctx);


    // 2. Pemeriksaan fasilitas setiap stasiun pada rute.
    const assessed = new Map<string, StationAssessment>();
    const assessIds = async (ids: string[]) => {
      const todo = [...new Set(ids)].filter((id) => !assessed.has(id));
      const results = await Promise.all(todo.map((stationId) => this.tools.call("cek_fasilitas", { stationId }, ctx, snap)));
      for (const r of results) assessed.set(r.assessment.stationId, r.assessment);
    };
    const assessAndStore = (r: Route) => assessIds(routeStationIds(r));
    await assessAndStore(route);
    const assessmentMap = () => new Map(assessed);

    // Permintaan GUI "hindari stasiun X": ganti rute bila titik transfernya termasuk yang dihindari.
    if (avoid.length && transferStationIds(route).some((t) => avoid.includes(t))) {
      const alts = withoutModes(await this.tools.call("cari_alternatif", { originId, destinationId, route, assessments: assessmentMap(), hubs, avoid, at: input.at, needs }, ctx, snap));
      const pick = alts.find((a) => a.route);
      if (pick?.route) {
        route = pick.route;
        await assessAndStore(route);
      } else {
        warnings.push("Rute tanpa stasiun yang ingin dihindari tidak ditemukan; ditampilkan rute dasar.");
      }
    }

    // 3. Transfer alternatif bila ada titik transfer yang tidak memadai atau tidak punya fasilitas yang dibutuhkan.
    let alternatives: Alternative[] = [];
    const lacking = async (id: string) => {
      if (!needs.length) return false;
      const d = await this.stations.detail(id, ctx, snap, byId.get(id));
      return !d || needs.some((n) => !needMet(n, d.amenities, d.assessment.layout));
    };
    const weak: string[] = [];
    for (const id of transferStationIds(route)) {
      if (id === originId || id === destinationId) continue;
      if (!assessed.get(id)?.adequate || (await lacking(id))) weak.push(id);
    }
    if (weak.length) {
      alternatives = withoutModes(await this.tools.call("cari_alternatif", { originId, destinationId, route, assessments: assessmentMap(), hubs, avoid, at: input.at, needs }, ctx, snap));
      if (!alternatives.length) warnings.push("Tidak ada alternatif transfer yang lebih aksesibel di hub ini.");
    }

    // 4. Pilihan rute: rute dasar, rute alternatif transfer, dan rute lain dengan aturan berbeda (paling sedikit pindah,
    // tanpa titik pindah tertentu, jalan kaki minimal). Tiap pilihan dinilai lengkap lalu dipilih yang paling aksesibel,
    // moderat, dan tercepat.
    const candidates: { route: Route; alternatives: Alternative[]; origin: RouteOption["origin"] }[] = [{ route, alternatives, origin: "dataset" }];
    for (const a of alternatives) if (a.route) candidates.push({ route: a.route, alternatives: [], origin: "alternatif" });
    if (!input.viaStationId) {
      const variants = await this.tools
        .call("variasi_rute", { fromId: originId, toId: destinationId, avoidModes, known: candidates.map((c) => c.route), at: input.at, avoid }, ctx, snap)
        .catch((e) => {
          this.log.warn("variasi rute dilewati", { error: (e as Error).message });
          return [] as Route[];
        });
      for (const v of variants) candidates.push({ route: v, alternatives: [], origin: "variasi" });
      // Rute tambahan yang menghindari stasiun terganggu/ditutup (informasi layanan yang disetujui admin).
      if (advisoryAvoid.length) {
        const around = await this.tools
          .call("variasi_rute", { fromId: originId, toId: destinationId, avoidModes, known: candidates.map((c) => c.route), at: input.at, avoid: avoidWithAdvisory }, ctx, snap)
          .catch((e) => {
            this.log.warn("variasi rute menghindari gangguan dilewati", { error: (e as Error).message });
            return [] as Route[];
          });
        for (const v of around) candidates.push({ route: v, alternatives: [], origin: "variasi" });
      }
    }

    const lines = await this.stations.lines(ctx);
    const details = new Map<string, StationDetail>();
    const withDataset = new Set<string>();
    const loadDetails = async (ids: string[], key: Set<string>) => {
      for (const id of new Set(ids)) {
        const want = key.has(id);
        if (details.has(id) && (!want || withDataset.has(id))) continue;
        const d = await this.stations.detail(id, ctx, snap, byId.get(id), { dataset: want });
        if (!d) continue;
        details.set(id, d);
        if (want) withDataset.add(id);
      }
    };
    const gateFor = (id: string) => (id === originId && input.entranceId ? { id: input.entranceId, role: "masuk" as const } : id === destinationId && input.exitId ? { id: input.exitId, role: "keluar" as const } : undefined);

    /** Lengkapi dan nilai satu rute: waktu (jadwal), peron, skor perjalanan, akses pindah, dan peringatannya. */
    const evaluate = async (raw: Route, alts: Alternative[]): Promise<Evaluated> => {
      let r = await this.tools.call("lengkapi_rute", { route: raw, at: input.at }, ctx, snap);
      const altsDone = await Promise.all(alts.map(async (a) => (a.route ? { ...a, route: await this.tools.call("lengkapi_rute", { route: a.route, at: input.at }, ctx, snap) } : a)));
      const ids = routeStationIds(r);
      const altIds = altsDone.flatMap((a) => (a.route ? routeStationIds(a.route) : [a.viaStationId]));
      await assessIds([...ids, ...altIds]);
      // Pemberhentian di luar daftar stasiun (mis. halte operator yang tidak diaktifkan) memakai nama dari data rute.
      for (const x of [r, ...altsDone.flatMap((a) => (a.route ? [a.route] : []))])
        for (const id of routeStationIds(x)) if (!byId.has(id)) byId.set(id, { id, name: x.stopNames?.[id] ?? id, operator: "", lineIds: [], codes: [] });
      // Peron dan pintu dari dataset hanya untuk tempat naik, turun, dan pindah.
      const key = new Set([r, ...altsDone.flatMap((a) => (a.route ? [a.route] : []))].flatMap((x) => x.legs.flatMap((l) => [l.stops[0], l.stops[l.stops.length - 1]])));
      await loadDetails([...ids, ...altIds], key);
      const w: string[] = [];
      let assessments = ids.map((id) => assessed.get(id)!);
      let altRoutes = altsDone;
      // Peron naik tiap ruas (fasilitas dan celah peron dengan kendaraan), lalu skor perjalanan: jalur gate ke
      // peron yang dipakai menentukan apakah lift/eskalator dibutuhkan. Data peron hanya pelengkap, jadi galat
      // di sini tidak menggagalkan rute.
      try {
        r = withPlatforms(r, details);
        altRoutes = altRoutes.map((a) => (a.route ? { ...a, route: withPlatforms(a.route, details) } : a));
        const used = gatePlatforms(r, details);
        const adjusted = assessments.map((a) => {
          const d = details.get(a.stationId);
          return d ? journeyAssessment(a, d, used.get(a.stationId) ?? [], snap, gateFor(a.stationId)) : a;
        });
        w.push(...gateWarnings(adjusted, byId), ...gapWarnings(r, byId), ...crossingWarnings(adjusted, byId));
        assessments = adjusted;
      } catch (e) {
        this.log.warn("data peron dilewati", { error: (e as Error).message });
      }
      // Fasilitas yang dibutuhkan pengguna di setiap stasiun tempat pindah.
      if (needs.length) {
        r = withTransferAccess(r, needs, details);
        altRoutes = altRoutes.map((a) => (a.route ? { ...a, route: withTransferAccess(a.route, needs, details) } : a));
        w.push(...accessWarnings(r, byId));
      }
      if (usesModes(r, avoidModes)) w.unshift(`Rute tanpa ${avoidModes.map((m) => MODE_LABEL[m]).join(", ")} tidak ditemukan; ditampilkan rute yang tetap memakainya.`);
      if (!r.timeComplete) w.push("Sebagian ruas tidak memiliki data waktu tempuh, sehingga total waktu belum lengkap.");
      for (const l of r.legs) if (l.turnaround && l.notes) w.push(`Berbalik arah: ${l.notes}`);
      if (r.timeEstimated) w.push("Waktu tempuh TransJakarta adalah perkiraan dari jadwal GTFS Transjakarta, bukan waktu nyata; jam berangkatnya memperkirakan waktu tunggu rata-rata (separuh frekuensi) dan belum termasuk kemacetan.");
      for (const l of r.legs)
        if (l.type === "RIDE" && l.changeAt)
          w.push(`Ganti kereta di ${byId.get(l.changeAt)?.name ?? r.stopNames?.[l.changeAt] ?? l.changeAt}: menurut jadwal, kereta ${l.lineName ?? l.lineId ?? ""} dari ${byId.get(l.stops[0])?.name ?? l.stops[0]} berakhir di sana, lalu lanjut dengan kereta berikutnya ke ${byId.get(l.stops[l.stops.length - 1])?.name ?? l.stops[l.stops.length - 1]}.`.replace(/  +/g, " "));
      const late = r.legs.filter((l) => l.type === "RIDE" && l.nextDayService);
      if (late.length) w.push(`Layanan ${late.map((l) => l.lineName ?? l.lineId ?? "kendaraan").join(", ")} sudah berakhir pada waktu berangkat yang dipilih; jadwal memakai keberangkatan pertama keesokan harinya.`);
      if (r.fareComplete === false) w.push("Tarif sebagian ruas tidak tersedia di dataset, sehingga total tarif belum lengkap.");
      const noData = assessments.filter((a) => !a.dataAvailable).map((a) => byId.get(a.stationId)!.name);
      if (noData.length) w.push(`Data fasilitas belum tersedia untuk: ${noData.join(", ")}.`);
      // Informasi layanan yang disetujui admin: mengurangi skor rute yang melewati stasiun/lini terdampak dan memberi peringatan.
      const advisory = advisoryEffectOn(r, effective);
      w.push(...advisory.notes);
      return { route: r, assessments, warnings: w, alternatives: altRoutes, summary: summarize(r, assessments, avoidModes, advisory), advisory };
    };

    const evaluated: (Evaluated & { origin: RouteOption["origin"] })[] = [];
    for (const c of candidates) {
      try {
        evaluated.push({ ...(await evaluate(c.route, c.alternatives)), origin: c.origin });
      } catch (e) {
        // Rute dasar wajib; pilihan lain dilewati bila gagal dinilai.
        if (c === candidates[0]) throw e;
        this.log.warn("pilihan rute dilewati", { error: (e as Error).message });
      }
    }
    const all2 = nameIndex(all);
    const lineName = (id: string) => {
      const l = lines.find((x) => x.id === id);
      return l ? { name: l.name, operator: l.operator } : undefined;
    };
    const nameOf = (id: string) => byId.get(id)?.name ?? evaluated.map((x) => x.route.stopNames?.[id]).find((x) => !!x) ?? id;
    /** Pengumuman aktif untuk stasiun, lini, dan hub pada sekumpulan rute. */
    const noticesFor = (rs: Route[]) => {
      const stationIds = [...new Set(rs.flatMap((r) => routeStationIds(r)))];
      const lineIds = [...new Set(rs.flatMap((r) => r.legs.flatMap((l) => (l.lineId ? [l.lineId] : []))))];
      const hubIds = [...new Set(stationIds.map((id) => byId.get(id)?.hubId).filter((x): x is string => !!x))];
      return snap.notices({ stationIds, lineIds, hubIds });
    };
    const factsFor = (e: Evaluated, ns: Notice[]): PlanFacts => ({ route: e.route, assessments: e.assessments, alternatives: e.alternatives, stations: details, knownStationNames: all2, notices: ns });

    // Agent navigasi LLM (pipeline "llm"): memilih satu rute dari kandidat dan boleh meminta rute lain lewat planner.
    // Pilihannya melewati pagar (checkChoice); bila gagal atau ditolak, pemilihan default dipakai.
    let llmPick: { e: (typeof evaluated)[number]; reason?: string } | null = null;
    if (pipe.use === "llm") {
      const sig = (r: Route) => r.legs.map((l) => `${l.type}:${l.lineId ?? ""}:${l.stops[0]}>${l.stops[l.stops.length - 1]}`).join("|");
      const overviewOf = (e: (typeof evaluated)[number], i: number, kinds: RouteOptionKind[]) => ({
        indeks: i,
        asal: e.origin,
        jenisDefault: kinds,
        moda: [...new Set(e.route.legs.filter((l) => l.type === "RIDE").map((l) => l.mode).filter((m): m is Mode => !!m))],
        stasiun: routeStationIds(e.route).map(nameOf),
        transfer: e.route.transfers,
        menit: e.route.timeComplete ? e.route.totalMinutes : null,
        tarif: e.route.totalFare,
        skorAksesibilitas: e.summary.accessScore,
        kebutuhanTakTerpenuhi: e.summary.unmetNeeds,
        memakaiModaDihindari: e.summary.usesAvoidedModes,
        dampakInfoLayanan: e.summary.advisoryImpact ?? "none",
        peringatan: e.warnings.slice(0, 5),
      });
      const host: NavHost = {
        plan: { asal: nameOf(originId), tujuan: nameOf(destinationId), kebutuhan: needs, hindariModa: avoidModes, berangkat: when.toISOString() },
        overview: () => {
          const kinds = new Map(pickOptions(evaluated, when).map((p) => [p.e, p.kinds] as const));
          return evaluated.map((e, i) => overviewOf(e, i, kinds.get(e) ?? []));
        },
        detail: (i) => {
          const e = evaluated[i];
          return e ? { ...overviewOf(e, i, []), fakta: factsForPrompt(factsFor(e, noticesFor([e.route]))) } : null;
        },
        facility: async (id) => {
          if (!byId.has(id)) throw new Error("stasiun tidak dikenal");
          const r = await this.tools.call("cek_fasilitas", { stationId: id }, ctx, snap);
          return { stasiun: nameOf(id), skor: r.assessment.score, memadai: r.assessment.adequate, dataTersedia: r.assessment.dataAvailable, fasilitas: r.facilities.amenities, catatan: r.assessment.notes ?? [] };
        },
        serviceInfo: (q) =>
          activeInfo
            .filter((a) => (!q.stationId && !q.lineId ? true : isRelevant(a, { stationIds: q.stationId ? [q.stationId] : [], lineIds: q.lineId ? [q.lineId] : [] })))
            .slice(0, 20)
            .map((a) => ({
              id: a.id,
              status: a.status === "approved" ? "disetujui" : "belum_diverifikasi",
              kategori: a.category,
              ...(a.status === "approved" ? { dampak: a.impact } : {}),
              ringkasan: a.summary,
              stasiun: a.stationIds.map(nameOf),
              lini: a.lineIds,
              sumber: `@${a.source.account}`,
              berakhir: a.expiresAt,
            })),
        explore: async (c) => {
          const modes = [...new Set([...avoidModes, ...((c.avoidModes ?? []) as Mode[])])];
          const known = evaluated.map((x) => x.route);
          let raw: Route | null;
          if (c.viaStationId) {
            if (!byId.has(c.viaStationId)) return { index: null, catatan: "Stasiun perantara tidak dikenal." };
            raw = await this.tools.call("ambil_rute", { fromId: originId, toId: destinationId, viaId: c.viaStationId, at: input.at, avoidModes: modes, needs }, ctx, snap);
          } else if (c.avoidStationIds?.length) {
            const extra = c.avoidStationIds.filter((id) => id !== originId && id !== destinationId);
            const vs = await this.tools.call("variasi_rute", { fromId: originId, toId: destinationId, avoidModes: modes, known, at: input.at, avoid: [...new Set([...avoidWithAdvisory, ...extra])] }, ctx, snap);
            raw = vs[0] ?? null;
          } else {
            raw = await this.tools.call("ambil_rute", { fromId: originId, toId: destinationId, at: input.at, avoidModes: modes, needs }, ctx, snap);
          }
          if (!raw) return { index: null, catatan: "Tidak ada rute dengan batasan itu." };
          if (known.some((r) => sig(r) === sig(raw!))) return { index: null, catatan: "Rute itu sudah ada pada daftar kandidat." };
          try {
            const e = { ...(await evaluate(raw, [])), origin: "variasi" as const };
            evaluated.push(e);
            return { index: evaluated.length - 1, catatan: "Kandidat baru ditambahkan.", kandidat: overviewOf(e, evaluated.length - 1, []) };
          } catch (err) {
            return { index: null, catatan: `Rute baru gagal dinilai: ${(err as Error).message}` };
          }
        },
        guardViews: (): GuardView[] => evaluated.map((e) => ({ unmetNeeds: e.summary.unmetNeeds, usesAvoidedModes: e.summary.usesAvoidedModes, advisoryImpact: e.summary.advisoryImpact ?? "none" })),
      };
      const out = await new LlmNavigator(llm!).decide(host);
      if (out.ok) {
        llmPick = { e: evaluated[out.index], ...(out.reason ? { reason: out.reason } : {}) };
        pipeline.navigation = "llm";
        pipeline.steps = out.steps;
        pipeline.notes.push(...out.notes);
      } else {
        pipeline.notes.push(out.why);
        this.log.warn("agent navigasi LLM tidak dipakai", { reason: out.why });
      }
    }

    let picked = pickOptions(evaluated, when);
    if (llmPick) {
      const chosen = llmPick.e;
      const hit = picked.findIndex((p) => p.e === chosen);
      if (hit > 0) picked = [picked[hit], ...picked.filter((_, i) => i !== hit)];
    }
    const primary = picked[0].e;

    const notices = noticesFor(evaluated.map((x) => x.route));
    const common = [...warnings];
    for (const n of notices) if (n.severity !== "info") common.push(noticeText(n));
    if (ctx.staleSince) common.push("Sumber data sedang tidak dapat dihubungi; sebagian data diambil dari salinan tersimpan.");

    // Informasi layanan operator yang relevan dengan salah satu rute: yang disetujui memengaruhi navigasi, yang belum
    // diperiksa hanya tampil sebagai info.
    const scope = {
      stationIds: [...new Set(evaluated.flatMap((x) => routeStationIds(x.route)))],
      lineIds: [...new Set(evaluated.flatMap((x) => x.route.legs.flatMap((l) => [l.lineId, ...(l.options ?? []).map((o) => o.lineId)]).filter((x): x is string => !!x)))],
      operators: [...new Set(evaluated.flatMap((x) => x.route.legs.map((l) => l.operator)).filter((x): x is string => !!x))],
    };
    // Informasi yang disetujui dan membuat rute menghindari stasiunnya tetap ditampilkan walau tidak ada kandidat yang melewatinya lagi.
    const relevantInfo: ServiceAdvisory[] = activeInfo.filter((a) => isRelevant(a, scope) || (a.status === "approved" && a.stationIds.some((id) => advisoryAvoid.includes(id))));
    if (advisoryAvoid.length) {
      const stillThrough = transferStationIds(primary.route).filter((id) => advisoryAvoid.includes(id));
      common.push(
        stillThrough.length
          ? `Rute ini tetap melewati titik pindah ${stillThrough.map(nameOf).join(", ")} yang terdampak informasi layanan yang disetujui admin; rute yang menghindarinya kurang aksesibel atau tidak ada.`
          : `Rute dipilih agar menghindari titik pindah ${advisoryAvoid.map(nameOf).join(", ")} yang terdampak informasi layanan yang disetujui admin.`,
      );
    }
    const serviceInfo = relevantInfo.map(toView);
    // Hanya untuk narasi LLM: informasi layanan sebagai pengumuman berlabel jelas (disetujui vs belum diverifikasi).
    const advisoryNotices: Notice[] =
      pipe.use === "llm"
        ? relevantInfo.map((a) => ({
            id: a.id,
            scope: "global",
            severity: a.status === "approved" && a.impact !== "info" ? "warning" : "info",
            title: a.status === "approved" ? "Info layanan (disetujui admin)" : "Info layanan (belum diverifikasi)",
            message: a.summary,
          }))
        : [];

    // 5. Notifikasi: LLM hanya pada pipeline "llm" (pilihan utama saja), divalidasi Grounding Guard; cadangan template statis.
    const factsOf = (e: Evaluated): PlanFacts => factsFor(e, notices);
    const notification = await this.susunNotifikasi(factsOf(primary), advisoryNotices, lines, pipe.use === "llm" ? llm : null);
    pipeline.narration = notification.source === "LLM" ? "llm" : "template";
    pipeline.used = pipeline.navigation === "llm" || pipeline.narration === "llm" ? "llm" : "default";
    if (pipeline.used === "llm" && llm) pipeline.model = llm.model;
    if (requested === "llm" && pipeline.used === "default" && !pipeline.reason) pipeline.reason = "LLM tidak dapat dipakai untuk permintaan ini; memakai pipeline default.";
    const options: RouteOption[] = picked.map((p, i) => ({
      kinds: p.kinds,
      origin: p.e.origin,
      route: p.e.route,
      assessments: p.e.assessments,
      warnings: [...p.e.warnings, ...common],
      summary: p.e.summary,
      notification: i === 0 ? notification : this.guard.fallback(factsOf(p.e), lineName),
      alternatives: p.e.alternatives,
      ...(llmPick && p.e === llmPick.e ? { pickedBy: "llm" as const, ...(llmPick.reason ? { llmReason: llmPick.reason } : {}) } : {}),
    }));

    return {
      originId,
      destinationId,
      route: primary.route,
      assessments: primary.assessments,
      alternatives: primary.alternatives,
      notification,
      warnings: options[0].warnings,
      disclaimer: snap.settings.disclaimer,
      ...(ctx.staleSince ? { fromCache: formatWib(ctx.staleSince) } : {}),
      notices,
      stations: [...details.values()],
      attribution: ATTRIBUTION,
      ...(ctx.preview ? { preview: true } : {}),
      departAt: when.toISOString(),
      departMode: input.at ? "at" : "now",
      options,
      pipeline,
      serviceInfo,
    };
  }

  /**
   * Notifikasi ringkasan rute. `llm` hanya terisi pada pipeline "llm" (mode LLM menyala dan klien ada); pipeline default
   * selalu memakai template. `extraNotices` (informasi layanan) hanya dikirim ke LLM, divalidasi bersama fakta lainnya.
   */
  private async susunNotifikasi(facts: PlanFacts, extraNotices: Notice[], lines: Line[], llm: LlmClient | null): Promise<Notification> {
    const lineName = (id: string) => {
      const l = lines.find((x) => x.id === id);
      return l ? { name: l.name, operator: l.operator } : undefined;
    };
    const template = () => this.guard.fallback(facts, lineName);
    if (!llm) return template();
    const llmFacts: PlanFacts = { ...facts, notices: [...facts.notices, ...extraNotices] };
    try {
      const text = await llm.complete({
        system: SYSTEM_PROMPT,
        prompt: `Data hasil tool (JSON):\n${JSON.stringify(factsForPrompt(llmFacts))}\n\nSusun notifikasi ringkasan rute.`,
        maxTokens: 2000,
      });
      const check = this.guard.validate(text, llmFacts);
      if (check.ok) return { text, source: "LLM", grounded: true };
      this.log.warn("notifikasi LLM gagal validasi grounding; memakai template", { reasons: check.reasons });
    } catch (e) {
      this.log.warn("LLM gagal; memakai template", { error: (e as Error).message });
    }
    return template();
  }
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Peron yang mungkin dipakai lin `lineId` di sebuah stasiun: nomor peron dari dataset bila diketahui, selain
 * itu peron yang melayani lin tersebut (dipersempit dengan arah/tujuan akhir bila cocok).
 */
export function platformsFor(d: StationDetail | undefined, lineId: string | undefined, code?: string, headsign?: string): Platform[] {
  const list = d?.platforms ?? [];
  if (code) {
    const hit = list.find((p) => p.code === code);
    return hit ? [hit] : [];
  }
  if (!lineId) return [];
  const serving = list.filter((p) => p.serves.some((s) => s.lineId === lineId));
  if (!headsign || serving.length < 2) return serving;
  const dir = serving.filter((p) => p.serves.some((s) => s.lineId === lineId && s.direction && (norm(s.direction).includes(norm(headsign)) || norm(headsign).includes(norm(s.direction)))));
  return dir.length ? dir : serving;
}

/** Ruas naik diberi peron naiknya bila peron itu dapat dipastikan (satu kandidat). */
export function withPlatforms(route: Route, details: Map<string, StationDetail>): Route {
  const legs = route.legs.map((leg) => {
    if (leg.type !== "RIDE") return leg;
    const cands = platformsFor(details.get(leg.stops[0]), leg.lineId, leg.platform, leg.headsign);
    return cands.length === 1 ? { ...leg, boardAt: cands[0] } : leg;
  });
  return { ...route, legs };
}

const RANK: Record<AmenityDetailStatus, number> = { out_of_service: 0, absent: 1, unknown: 2, available: 3 };

/**
 * Status fasilitas yang dibutuhkan di kedua ujung setiap ruas pindah (termasuk pindah lini di stasiun yang sama).
 * Bila peron turun/naik diketahui dan tim sudah mengisi fasilitas per peron, status diambil dari peron itu; bila
 * ada beberapa kemungkinan peron, dipakai status terburuk agar tidak menjanjikan fasilitas yang belum pasti.
 */
export function withTransferAccess(route: Route, needs: TransferNeed[], details: Map<string, StationDetail>): Route {
  const legs = route.legs.map((leg, i) => {
    if (leg.type !== "TRANSFER") return leg;
    const prev = route.legs[i - 1];
    const next = route.legs[i + 1];
    const ends = [
      { stationId: leg.stops[0], platforms: platformsFor(details.get(leg.stops[0]), prev?.type === "RIDE" ? prev.lineId : undefined) },
      { stationId: leg.stops[leg.stops.length - 1], platforms: next?.type === "RIDE" ? platformsFor(details.get(leg.stops[leg.stops.length - 1]), next.lineId, next.platform, next.headsign) : [] },
    ];
    const access: TransferAccess[] = [];
    for (const { stationId, platforms } of ends) {
      const d = details.get(stationId);
      // Peron yang dicapai dari gate tanpa anak tangga tidak membutuhkan lift/eskalator (aturan yang sama dengan skor).
      // Peron tidak dapat dipastikan: dipakai jalur gate ke semua peron stasiun (sama dengan skor stasiun).
      const layout = d?.entrances?.length && platforms.length ? layoutAccess(d.entrances, platforms.map((p) => p.code), d.concourses ?? []) : d?.assessment?.layout;
      const notNeeded = layout?.level
        ? { via: layout.via, gate: layout.gate, ...(layout.dedicated ? { dedicated: true } : {}), ...(layout.stepFree ? { stepFree: true } : {}), ...(layout.concourse ? { concourse: layout.concourse } : {}) }
        : undefined;
      for (const need of needs) {
        const extra = notNeeded && need !== "ramp" ? { notNeeded } : {};
        // Jalur lewat concourse yang pindah lantai: lift/eskalator di ruas itulah yang dipakai.
        const path = !layout || layout.level ? undefined : need === "lift" ? layout.pathLift : need === "eskalator" ? layout.pathEscalator : undefined;
        if (path) {
          access.push({ stationId, need, status: path, platform: platforms.map((p) => p.code).join(", ") });
          continue;
        }
        const known = platforms.filter((p) => p.amenities[need]);
        if (platforms.length && known.length === platforms.length) {
          const worst = known.reduce((a, b) => (RANK[b.amenities[need]!] < RANK[a.amenities[need]!] ? b : a));
          access.push({ stationId, need, status: worst.amenities[need]!, platform: platforms.length === 1 ? worst.code : platforms.map((p) => p.code).join(", "), ...extra });
          continue;
        }
        const ntd = d?.amenityDetails.find((x) => x.type === need && x.source === "ntd");
        access.push({
          stationId,
          need,
          status: ntd?.status === "out_of_service" ? "out_of_service" : (d?.amenities[need] ?? "unknown"),
          ...(notNeeded && need !== "ramp" ? { platform: platforms.map((p) => p.code).join(", ") } : {}),
          ...extra,
        });
      }
    }
    // Pindah di stasiun yang sama tanpa info peron menghasilkan entri kembar.
    const seen = new Set<string>();
    return { ...leg, access: access.filter((a) => !seen.has(JSON.stringify(a)) && !!seen.add(JSON.stringify(a))) };
  });
  return { ...route, legs };
}

/**
 * Peron yang dicapai lewat gate pada perjalanan: peron naik di stasiun asal, peron turun di tujuan, dan kedua ujung
 * perpindahan yang keluar stasiun (jalan kaki antarstasiun di hub). Pindah di dalam stasiun tidak melewati gate.
 */
export function gatePlatforms(route: Route, details: Map<string, StationDetail>): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (id: string, ps: Platform[]) => {
    if (!ps.length) return;
    const set = out.get(id) ?? new Set<string>();
    for (const p of ps) set.add(p.code);
    out.set(id, set);
  };
  const board = (leg: Route["legs"][number]) => (leg.boardAt ? [leg.boardAt] : platformsFor(details.get(leg.stops[0]), leg.lineId, leg.platform, leg.headsign));
  const alight = (leg: Route["legs"][number]) => platformsFor(details.get(leg.stops[leg.stops.length - 1]), leg.lineId, undefined, leg.headsign);
  const rides = route.legs.filter((l) => l.type === "RIDE");
  if (rides.length) {
    add(rides[0].stops[0], board(rides[0]));
    const last = rides[rides.length - 1];
    add(last.stops[last.stops.length - 1], alight(last));
  }
  route.legs.forEach((leg, i) => {
    if (leg.type !== "TRANSFER" || leg.stops[0] === leg.stops[leg.stops.length - 1]) return;
    const prev = route.legs[i - 1];
    const next = route.legs[i + 1];
    if (prev?.type === "RIDE") add(leg.stops[0], alight(prev));
    if (next?.type === "RIDE") add(leg.stops[leg.stops.length - 1], board(next));
  });
  return new Map([...out].map(([id, set]) => [id, [...set]]));
}

/** Peringatan jalur gate ke peron: menyeberang rel/jalan, atau hanya lewat JPO/terowongan tanpa lift. */
export function crossingWarnings(assessments: StationAssessment[], byId: Map<string, Station>): string[] {
  const out: string[] = [];
  for (const a of assessments) {
    const j = a.journey;
    if (!j) continue;
    const name = `${byId.get(a.stationId)?.name ?? a.stationId} (peron ${j.platforms.join(", ")})`;
    if (j.dedicated) out.push(`Menuju ${name} memakai jalur ${viaText(j).replace(/^lewat /, "")} (${j.gate}); minta bantuan petugas bila perlu.`);
    else if (j.via === "sebidang") out.push(`Menuju ${name} harus menyeberang rel lewat pelintasan sebidang; minta bantuan petugas bila perlu.`);
    else if (j.via === "crosswalk") out.push(`Menuju ${name} harus menyeberang jalan lewat crosswalk.`);
    else if (!j.level && j.pathLift === "out_of_service") out.push(`${name} hanya dapat dicapai ${viaText(j)}, dan lift di jalur itu dilaporkan sedang tidak berfungsi.`);
    else if (!j.level && j.lift !== "available") out.push(`${name} hanya dapat dicapai ${viaText(j)}, dan lift ${j.lift === "unknown" ? "belum ada datanya" : "tidak tercatat"}.`);
  }
  return out;
}

/** Peringatan pintu pilihan pengguna yang fasilitasnya kurang, beserta pintu yang disarankan. */
export function gateWarnings(assessments: StationAssessment[], byId: Map<string, Station>): string[] {
  const out: string[] = [];
  for (const a of assessments) {
    const g = a.gateChoice;
    if (!g?.recommended) continue;
    const st = byId.get(a.stationId)?.name ?? a.stationId;
    out.push(`${g.chosen} di ${st} ${g.reason ?? "kurang aksesibel"}. Disarankan ${g.role} lewat ${g.recommended}${g.recommendedVia ? ` (${g.recommendedVia})` : ""}.`);
  }
  return out;
}

/** Perkiraan menit untuk membandingkan rute (bukan untuk ditampilkan): ruas tanpa waktu diperkirakan kasar. */
/** Waktu ruas sesudah ruas naik terakhir (mis. jalan kaki ke stasiun tujuan), untuk membandingkan jam tiba. */
function afterLastRide(r: Route): number {
  let i = r.legs.length;
  while (i > 0 && r.legs[i - 1].type !== "RIDE") i--;
  return r.legs.slice(i).reduce((s, l) => s + (l.minutes ?? (l.stops[0] === l.stops[l.stops.length - 1] ? 0 : Math.max(3, l.distanceM / 50))), 0);
}

function comparableMinutes(r: Route): number {
  return r.legs.reduce((sum, l) => {
    if (l.minutes !== null) return sum + l.minutes;
    // Ruas tanpa data waktu dibuat sedikit lebih lama agar rute berwaktu jelas tidak kalah karena perkiraan kasar.
    if (l.type === "RIDE") return sum + 3 + (l.distanceM / 1000 / 20) * 60;
    return sum + (l.stops[0] === l.stops[l.stops.length - 1] ? 4 : Math.max(3, l.distanceM / 50));
  }, 0);
}

/**
 * Ringkasan satu pilihan rute. Skor aksesibilitas rute = separuh skor perjalanan terendah di titik pindah (atau rata-rata
 * stasiun naik/turun bila tanpa pindah) dan separuh rata-rata stasiun naik, turun, dan pindah; dikurangi 12 per fasilitas
 * yang dibutuhkan tetapi tidak ada/rusak (5 bila datanya belum ada), 4 per kendala jalur (menyeberang, celah bertangga,
 * JPO tanpa lift), 3 per pindah, dan 2 per jalan kaki antarstasiun. Rute yang tetap memakai moda yang dihindari
 * dikurangi 40; rute yang terdampak informasi layanan yang disetujui admin dikurangi 8 (delay), 30 (gangguan), atau 60 (penutupan).
 */
export function summarize(r: Route, assessments: StationAssessment[], avoidModes: readonly Mode[], advisory: AdvisoryEffect = NO_EFFECT): RouteOptionSummary {
  const byId = new Map(assessments.map((a) => [a.stationId, a]));
  const rides = r.legs.filter((l) => l.type === "RIDE");
  const endIds = new Set<string>();
  if (rides.length) {
    endIds.add(rides[0].stops[0]);
    endIds.add(rides[rides.length - 1].stops[rides[rides.length - 1].stops.length - 1]);
  }
  const transferIds = new Set(r.legs.filter((l) => l.type === "TRANSFER").flatMap((l) => l.stops));
  const scoreOf = (id: string) => byId.get(id)?.score ?? 0;
  const key = [...new Set([...endIds, ...transferIds])].filter((id) => byId.has(id));
  const avg = key.length ? key.reduce((s, id) => s + scoreOf(id), 0) / key.length : 0;
  const tr = [...transferIds].filter((id) => byId.has(id));
  const minScore = key.length ? Math.min(...key.map(scoreOf)) : 0;
  const weakest = tr.length ? Math.min(...tr.map(scoreOf)) : avg;
  const unmet = r.legs.flatMap((l) => l.access ?? []).filter((a) => a.status !== "available" && !a.notNeeded);
  const unmetNeeds = unmet.length;
  // Fasilitas yang pasti tidak ada/rusak lebih berat daripada yang belum ada datanya.
  const unmetPoints = unmet.reduce((s, a) => s + (a.status === "unknown" ? 5 : 12), 0);
  const walks = r.legs.filter((l) => l.type === "TRANSFER" && l.stops[0] !== l.stops[l.stops.length - 1]).length;
  const obstacles =
    assessments.filter((a) => a.journey && (a.journey.via === "sebidang" || a.journey.via === "crosswalk" || (!a.journey.level && a.journey.lift !== "available" && a.journey.pathLift !== "available"))).length +
    rides.filter((l) => l.boardAt?.gap?.level === "tangga").length;
  const usesAvoided = usesModes(r, avoidModes);
  const rankScore = Math.round(0.5 * weakest + 0.5 * avg - unmetPoints - 4 * obstacles - 3 * r.transfers - 2 * walks - (usesAvoided ? 40 : 0) - advisory.penalty);
  const accessScore = Math.max(0, Math.min(100, rankScore));
  const first = rides[0];
  const last = rides[rides.length - 1];
  return {
    accessScore,
    rankScore,
    minScore,
    minutes: r.totalMinutes,
    ...(first?.departureAt ? { departureAt: first.departureAt } : {}),
    ...(last?.arrivalAt ? { arrivalAt: last.arrivalAt } : {}),
    transfers: r.transfers,
    unmetNeeds,
    usesAvoidedModes: usesAvoided,
    ...(advisory.impact !== "none" ? { advisoryImpact: advisory.impact, advisoryIds: advisory.ids } : {}),
  };
}

const KIND_ORDER: RouteOptionKind[] = ["aksesibel", "moderat", "tercepat"];

/**
 * Memilih pilihan rute dari rute yang sudah dinilai: paling aksesibel (skor aksesibilitas tertinggi; prioritas utama,
 * mengikuti filter moda dan kebutuhan fasilitas), tercepat (waktu terkecil), dan moderat (seimbang antara keduanya,
 * diutamakan rute yang berbeda dari dua lainnya). Rute yang sama untuk beberapa jenis digabung.
 */
export function pickOptions<T extends { route: Route; summary: RouteOptionSummary }>(list: T[], when?: Date): { e: T; kinds: RouteOptionKind[] }[] {
  // Tercepat = tiba paling awal sejak waktu berangkat (termasuk menunggu kereta/bus) bila semua pilihan punya jam tiba;
  // selain itu total waktu tempuh.
  const byArrival = when && list.length > 0 && list.every((x) => x.summary.arrivalAt);
  const mins = list.map((x) => (byArrival ? Math.max(0, (Date.parse(x.summary.arrivalAt!) - when!.getTime()) / 60_000) + afterLastRide(x.route) : comparableMinutes(x.route)));
  const idx = list.map((_, i) => i);
  const acc = (i: number) => list[i].summary.rankScore;
  // Rute dasar (pertama, dari dataset) diberi kelebihan 3 poin agar rute susunan sendiri yang datanya kurang lengkap
  // tidak menggesernya karena selisih kecil; rute lain harus jelas lebih aksesibel.
  const bonus = (i: number) => acc(i) + (i === 0 ? 2.5 : 0);
  const accessible = idx.reduce((a, b) => (bonus(b) > bonus(a) || (bonus(b) === bonus(a) && mins[b] < mins[a]) ? b : a), 0);
  const fastest = idx.reduce((a, b) => (mins[b] < mins[a] - 0.5 || (Math.abs(mins[b] - mins[a]) <= 0.5 && acc(b) > acc(a)) ? b : a), 0);
  const fast = Math.max(1, mins[fastest]);
  const best = acc(accessible);
  // Biaya seimbang: tiap 50 poin aksesibilitas yang hilang setara dengan waktu tempuh dua kali lipat yang tercepat.
  const cost = (i: number) => (best - acc(i)) / 50 + (mins[i] - fast) / fast;
  const others = idx.filter((i) => i !== accessible && i !== fastest);
  const pool = others.length ? others : idx;
  const moderate = pool.reduce((a, b) => (cost(b) < cost(a) ? b : a), pool[0]);
  const chosen: [RouteOptionKind, number][] = [
    ["aksesibel", accessible],
    ["moderat", moderate],
    ["tercepat", fastest],
  ];
  const out: { e: T; kinds: RouteOptionKind[] }[] = [];
  for (const [kind, i] of chosen) {
    const hit = out.find((o) => o.e === list[i]);
    if (hit) hit.kinds.push(kind);
    else out.push({ e: list[i], kinds: [kind] });
  }
  for (const o of out) o.kinds.sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
  // Rute lain yang tidak terpilih tetap ditampilkan sebagai pilihan tambahan (tanpa jenis), paling aksesibel dulu.
  const rest = idx.filter((i) => !out.some((o) => o.e === list[i])).sort((a, b) => acc(b) - acc(a) || mins[a] - mins[b]);
  for (const i of rest) out.push({ e: list[i], kinds: [] });
  return out;
}

/** Peringatan celah peron: naik ke kendaraan harus melewati anak tangga. */
export function gapWarnings(route: Route, byId: Map<string, Station>): string[] {
  const out = new Set<string>();
  for (const leg of route.legs) {
    const g = leg.boardAt?.gap;
    if (!g || g.level !== "tangga") continue;
    const name = byId.get(leg.stops[0])?.name ?? route.stopNames?.[leg.stops[0]] ?? leg.stops[0];
    const aid = g.boardingAid ? " Petugas dapat menyediakan pelat/ramp portabel." : "";
    out.add(`Naik di ${name} (peron ${leg.boardAt!.code}): ada ${g.steps ?? "beberapa"} anak tangga antara peron dan kendaraan.${aid}`);
  }
  return [...out];
}

/** Peringatan untuk fasilitas yang dibutuhkan tetapi tidak tercatat, rusak, atau belum ada datanya. */
export function accessWarnings(route: Route, byId: Map<string, Station>): string[] {
  const out = new Set<string>();
  for (const leg of route.legs)
    for (const a of leg.access ?? []) {
      const st = byId.get(a.stationId)?.name ?? route.stopNames?.[a.stationId] ?? a.stationId;
      const name = a.platform ? `${st} (peron ${a.platform})` : st;
      const label = AMENITY_LABEL[a.need] ?? a.need;
      // Tidak dibutuhkan: peron dicapai tanpa anak tangga; penyeberangannya sudah dijelaskan crossingWarnings.
      if (a.notNeeded) continue;
      if (a.status === "out_of_service") out.add(`${label} di ${name} dilaporkan sedang tidak berfungsi; perpindahan di sini mungkin tidak bisa dilakukan.`);
      else if (a.status === "absent") out.add(`${label} tidak tercatat di ${name}, padahal Anda membutuhkannya untuk pindah. Pertimbangkan alternatif atau minta bantuan petugas.`);
      else if (a.status === "unknown") out.add(`Data ${label.toLowerCase()} di ${name} belum tersedia; belum bisa dipastikan perpindahan di sini dapat dilakukan.`);
    }
  return [...out];
}

function nameIndex(stations: Station[]): Map<string, string> {
  return new Map(stations.map((s) => [s.name.toLowerCase(), s.id]));
}

function formatWib(d: Date): string {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(d) + " WIB";
}

/** Teks pengumuman sebagai peringatan; dipakai juga GUI untuk menghindari tampilan ganda. */
export const noticeText = (n: { title: string; message: string }) => `${n.title}${/[.!?:]$/.test(n.title) ? "" : ":"} ${n.message}`;
