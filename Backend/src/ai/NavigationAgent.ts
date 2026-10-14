// Agen Navigasi Aksesibilitas (Gambar 3.4). Urutan tool mengikuti Sequence Diagram:
// ambil_rute → cek_fasilitas (loop) → cari_alternatif (opt) → susunNotifikasi → validasiGrounding.
// Seluruh fakta dikumpulkan lebih dulu oleh tool; LLM hanya dipanggil SATU kali untuk menyusun
// narasi notifikasi (Risiko #9 dan #10), dan selalu ada template statis sebagai cadangan.

import type { RequestContext } from "../context";
import type { ContentService, ContentSnapshot } from "../domain/content";
import { routeStationIds, transferStationIds } from "../domain/RoutePlannerService";
import type { Alternative, JourneyPlan, Line, Notification, Route, Station, StationAssessment, StationDetail } from "../domain/models";
import type { StationService } from "../domain/StationService";
import { AppError } from "../errors";
import { ATTRIBUTION, factsForPrompt, type GroundingGuard, type PlanFacts } from "./GroundingGuard";
import type { LlmClient } from "./llm/LlmClient";
import type { ToolRegistry } from "./ToolRegistry";

export interface PlanInput {
  originId: string;
  destinationId: string;
  /** Pakai stasiun perantara tertentu (mis. alternatif yang dipilih pengguna). */
  viaStationId?: string;
  /** Kompatibel dengan GUI: stasiun yang tidak boleh menjadi titik transfer. */
  avoid?: string[];
  /** Waktu berangkat (ISO), diteruskan ke /fares sebagai parameter `at`. */
  at?: string;
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
- Jangan menulis disclaimer; sistem menambahkannya sendiri.`;

export class NavigationAgent {
  constructor(
    private tools: ToolRegistry,
    private stations: StationService,
    private content: ContentService,
    private guard: GroundingGuard,
    private llm: LlmClient | null,
    private log: AgentLogger = { warn: () => {} },
  ) {}

  async rencanakan(input: PlanInput, ctx: RequestContext): Promise<JourneyPlan> {
    const snap = await this.content.snapshot(ctx);
    ctx.cacheTtlSeconds = snap.settings.cacheTtlSeconds;

    const all = await this.stations.list(ctx);
    const byId = new Map(all.map((s) => [s.id, s]));
    const { originId, destinationId } = input;
    for (const id of [originId, destinationId, ...(input.viaStationId ? [input.viaStationId] : [])]) {
      if (!byId.has(id)) throw new AppError("INVALID", `Stasiun "${id}" tidak dikenal. Pilih stasiun dari daftar saran.`);
    }
    if (originId === destinationId) throw new AppError("INVALID", "Stasiun asal dan tujuan harus berbeda.");
    const avoid = (input.avoid ?? []).filter((id) => id !== originId && id !== destinationId);
    const warnings: string[] = [];

    // 1. Rute dari dataset.
    let route = await this.tools.call("ambil_rute", { fromId: originId, toId: destinationId, viaId: input.viaStationId, at: input.at }, ctx, snap);
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
      const alts = await this.tools.call("cari_alternatif", { originId, destinationId, route, assessments: assessmentMap(), hubs, avoid, at: input.at }, ctx, snap);
      const pick = alts.find((a) => a.route);
      if (pick?.route) {
        route = pick.route;
        await assessAndStore(route);
      } else {
        warnings.push("Rute tanpa stasiun yang ingin dihindari tidak ditemukan; ditampilkan rute dasar.");
      }
    }

    // 3. Transfer alternatif bila ada titik transfer yang tidak memadai.
    let alternatives: Alternative[] = [];
    const weak = transferStationIds(route).filter((id) => id !== originId && id !== destinationId && !assessed.get(id)?.adequate);
    if (weak.length) {
      alternatives = await this.tools.call("cari_alternatif", { originId, destinationId, route, assessments: assessmentMap(), hubs, avoid, at: input.at }, ctx, snap);
      if (!alternatives.length) warnings.push("Tidak ada alternatif transfer yang lebih aksesibel di hub ini.");
    }

    const routeIds = routeStationIds(route);
    const assessments = routeIds.map((id) => assessed.get(id)!);
    // Stasiun pada rute alternatif ikut dinilai dan dirinci agar GUI dapat menampilkannya.
    const altIds = alternatives.flatMap((a) => (a.route ? routeStationIds(a.route) : [a.viaStationId]));
    await assessIds(altIds);
    const lines = await this.stations.lines(ctx);
    const details = new Map<string, StationDetail>();
    for (const id of new Set([...routeIds, ...altIds])) {
      const d = await this.stations.detail(id, ctx, snap, byId.get(id));
      if (d) details.set(id, d);
    }

    // Pengumuman aktif untuk stasiun, lini, dan hub pada rute.
    const lineIds = [...new Set(route.legs.flatMap((l) => (l.lineId ? [l.lineId] : [])))];
    const hubIds = [...new Set(routeIds.map((id) => byId.get(id)?.hubId).filter((x): x is string => !!x))];
    const notices = snap.notices({ stationIds: routeIds, lineIds, hubIds });

    if (!route.timeComplete) warnings.push("Sebagian ruas tidak memiliki data waktu tempuh, sehingga total waktu belum lengkap.");
    const noData = assessments.filter((a) => !a.dataAvailable).map((a) => byId.get(a.stationId)!.name);
    if (noData.length) warnings.push(`Data fasilitas belum tersedia untuk: ${noData.join(", ")}.`);
    for (const n of notices) if (n.severity !== "info") warnings.push(noticeText(n));

    // 4. Notifikasi: LLM bila aktif, divalidasi Grounding Guard; cadangan template statis.
    const facts: PlanFacts = { route, assessments, alternatives, stations: details, knownStationNames: nameIndex(all), notices };
    const notification = await this.susunNotifikasi(facts, lines, snap, ctx.skipLlm === true);

    if (ctx.staleSince) warnings.push("Sumber data sedang tidak dapat dihubungi; sebagian data diambil dari salinan tersimpan.");

    return {
      originId,
      destinationId,
      route,
      assessments,
      alternatives,
      notification,
      warnings,
      disclaimer: snap.settings.disclaimer,
      ...(ctx.staleSince ? { fromCache: formatWib(ctx.staleSince) } : {}),
      notices,
      stations: [...details.values()],
      attribution: ATTRIBUTION,
      ...(ctx.preview ? { preview: true } : {}),
    };
  }

  private async susunNotifikasi(facts: PlanFacts, lines: Line[], snap: ContentSnapshot, skipLlm: boolean): Promise<Notification> {
    const lineName = (id: string) => {
      const l = lines.find((x) => x.id === id);
      return l ? { name: l.name, operator: l.operator } : undefined;
    };
    const template = () => this.guard.fallback(facts, lineName);
    if (!this.llm || !snap.settings.llmEnabled || skipLlm) return template();
    try {
      const text = await this.llm.complete({
        system: SYSTEM_PROMPT,
        prompt: `Data hasil tool (JSON):\n${JSON.stringify(factsForPrompt(facts))}\n\nSusun notifikasi ringkasan rute.`,
        maxTokens: 2000,
      });
      const check = this.guard.validate(text, facts);
      if (check.ok) return { text, source: "LLM", grounded: true };
      this.log.warn("notifikasi LLM gagal validasi grounding; memakai template", { reasons: check.reasons });
    } catch (e) {
      this.log.warn("LLM gagal; memakai template", { error: (e as Error).message });
    }
    return template();
  }
}

function nameIndex(stations: Station[]): Map<string, string> {
  return new Map(stations.map((s) => [s.name.toLowerCase(), s.id]));
}

function formatWib(d: Date): string {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(d) + " WIB";
}

/** Teks pengumuman sebagai peringatan; dipakai juga GUI untuk menghindari tampilan ganda. */
export const noticeText = (n: { title: string; message: string }) => `${n.title}${/[.!?:]$/.test(n.title) ? "" : ":"} ${n.message}`;
