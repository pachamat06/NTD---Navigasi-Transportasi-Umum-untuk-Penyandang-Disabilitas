// Agen Navigasi Aksesibilitas (Gambar 3.4). Urutan tool mengikuti Sequence Diagram:
// ambil_rute → cek_fasilitas (loop) → cari_alternatif (opt) → susunNotifikasi → validasiGrounding.
// Seluruh fakta dikumpulkan lebih dulu oleh tool; LLM hanya dipanggil SATU kali untuk menyusun
// narasi notifikasi (Risiko #9 dan #10), dan selalu ada template statis sebagai cadangan.

import type { RequestContext } from "../context";
import type { ContentService, ContentSnapshot } from "../domain/content";
import { routeStationIds, transferStationIds, usesModes } from "../domain/RoutePlannerService";
import { AMENITY_LABEL, journeyAssessment, VIA_LABEL } from "../domain/FacilityAnalysisService";
import type { Alternative, AmenityDetailStatus, JourneyPlan, Line, Mode, Notification, Platform, Route, Station, StationAssessment, StationDetail, TransferAccess, TransferNeed } from "../domain/models";
import type { StationService } from "../domain/StationService";
import { AppError } from "../errors";
import { ATTRIBUTION, factsForPrompt, type GroundingGuard, type PlanFacts } from "./GroundingGuard";
import type { LlmClient } from "./llm/LlmClient";
import type { ToolRegistry } from "./ToolRegistry";

export const MODE_LABEL: Record<Mode, string> = { RAIL: "kereta (KRL)", SUBWAY: "MRT", TRAM: "LRT", BUS: "bus TransJakarta", MONORAIL: "kereta layang bandara" };

export interface PlanInput {
  originId: string;
  destinationId: string;
  /** Pakai stasiun perantara tertentu (mis. alternatif yang dipilih pengguna). */
  viaStationId?: string;
  /** Kompatibel dengan GUI: stasiun yang tidak boleh menjadi titik transfer. */
  avoid?: string[];
  /** Waktu berangkat (ISO), diteruskan ke /fares sebagai parameter `at`. */
  at?: string;
  /** Moda yang tidak ingin dipakai pengguna (mis. BUS). */
  avoidModes?: Mode[];
  /** Fasilitas yang wajib ada di stasiun tempat pindah (mis. lift untuk pengguna kursi roda). */
  needs?: TransferNeed[];
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
    const avoidModes = input.avoidModes ?? [];
    // Alternatif transfer juga tidak boleh memakai moda yang dihindari.
    const withoutModes = (alts: Alternative[]) => alts.filter((a) => !a.route || !usesModes(a.route, avoidModes));
    const needs = [...new Set(input.needs ?? [])];
    let route = await this.tools.call("ambil_rute", { fromId: originId, toId: destinationId, viaId: input.viaStationId, at: input.at, avoidModes, needs }, ctx, snap);
    if (!route) {
      throw new AppError("NOT_FOUND", `Rute antara ${byId.get(originId)!.name} dan ${byId.get(destinationId)!.name} tidak ditemukan dalam data saat ini.`);
    }
    const hubs = await this.stations.hubs(ctx);

    if (route && usesModes(route, avoidModes)) {
      warnings.push(`Rute tanpa ${avoidModes.map((m) => MODE_LABEL[m]).join(", ")} tidak ditemukan; ditampilkan rute yang tetap memakainya.`);
    }

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
      return !d || needs.some((n) => d.amenities[n] !== "available");
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

    // 4. Lengkapi rute: jalan kaki saat pindah, lin paralel, dan frekuensi bila jadwal tidak tersedia.
    route = await this.tools.call("lengkapi_rute", { route, at: input.at }, ctx, snap);
    alternatives = await Promise.all(alternatives.map(async (a) => (a.route ? { ...a, route: await this.tools.call("lengkapi_rute", { route: a.route, at: input.at }, ctx, snap) } : a)));

    const routeIds = routeStationIds(route);
    let assessments = routeIds.map((id) => assessed.get(id)!);
    // Stasiun pada rute alternatif ikut dinilai dan dirinci agar GUI dapat menampilkannya.
    const altIds = alternatives.flatMap((a) => (a.route ? routeStationIds(a.route) : [a.viaStationId]));
    await assessIds(altIds);
    // Pemberhentian di luar daftar stasiun (mis. halte operator yang tidak diaktifkan) memakai nama dari data rute.
    for (const r of [route, ...alternatives.flatMap((a) => (a.route ? [a.route] : []))])
      for (const id of routeStationIds(r))
        if (!byId.has(id)) byId.set(id, { id, name: r.stopNames?.[id] ?? id, operator: "", lineIds: [], codes: [] });
    const lines = await this.stations.lines(ctx);
    const details = new Map<string, StationDetail>();
    // Peron dan pintu dari dataset hanya untuk tempat naik, turun, dan pindah.
    const key = new Set([route, ...alternatives.flatMap((a) => (a.route ? [a.route] : []))].flatMap((r) => r.legs.flatMap((l) => [l.stops[0], l.stops[l.stops.length - 1]])));
    for (const id of new Set([...routeIds, ...altIds])) {
      const d = await this.stations.detail(id, ctx, snap, byId.get(id), { dataset: key.has(id) });
      if (d) details.set(id, d);
    }

    // Peron naik tiap ruas (fasilitas dan celah peron dengan kendaraan).
    route = withPlatforms(route, details);
    for (const a of alternatives) if (a.route) a.route = withPlatforms(a.route, details);
    warnings.push(...gapWarnings(route, byId));

    // Skor perjalanan: jalur gate ke peron yang dipakai menentukan apakah lift/eskalator dibutuhkan.
    const used = gatePlatforms(route, details);
    assessments = assessments.map((a) => {
      const d = details.get(a.stationId);
      return d ? journeyAssessment(a, d, used.get(a.stationId) ?? [], snap) : a;
    });
    warnings.push(...crossingWarnings(assessments, byId));

    // Fasilitas yang dibutuhkan pengguna di setiap stasiun tempat pindah.
    if (needs.length) {
      route = withTransferAccess(route, needs, details);
      for (const a of alternatives) if (a.route) a.route = withTransferAccess(a.route, needs, details);
      warnings.push(...accessWarnings(route, byId));
    }

    // Pengumuman aktif untuk stasiun, lini, dan hub pada rute.
    const lineIds = [...new Set(route.legs.flatMap((l) => (l.lineId ? [l.lineId] : [])))];
    const hubIds = [...new Set(routeIds.map((id) => byId.get(id)?.hubId).filter((x): x is string => !!x))];
    const notices = snap.notices({ stationIds: routeIds, lineIds, hubIds });

    if (!route.timeComplete) warnings.push("Sebagian ruas tidak memiliki data waktu tempuh, sehingga total waktu belum lengkap.");
    if (route.fareComplete === false) warnings.push("Tarif sebagian ruas tidak tersedia di dataset, sehingga total tarif belum lengkap.");
    const noData = assessments.filter((a) => !a.dataAvailable).map((a) => byId.get(a.stationId)!.name);
    if (noData.length) warnings.push(`Data fasilitas belum tersedia untuk: ${noData.join(", ")}.`);
    for (const n of notices) if (n.severity !== "info") warnings.push(noticeText(n));

    // 5. Notifikasi: LLM bila aktif, divalidasi Grounding Guard; cadangan template statis.
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
    for (const { stationId, platforms } of ends)
      for (const need of needs) {
        const known = platforms.filter((p) => p.amenities[need]);
        if (platforms.length && known.length === platforms.length) {
          const worst = known.reduce((a, b) => (RANK[b.amenities[need]!] < RANK[a.amenities[need]!] ? b : a));
          access.push({ stationId, need, status: worst.amenities[need]!, platform: platforms.length === 1 ? worst.code : platforms.map((p) => p.code).join(", ") });
          continue;
        }
        const d = details.get(stationId);
        const ntd = d?.amenityDetails.find((x) => x.type === need && x.source === "ntd");
        access.push({ stationId, need, status: ntd?.status === "out_of_service" ? "out_of_service" : (d?.amenities[need] ?? "unknown") });
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
    if (j.via === "sebidang") out.push(`Menuju ${name} harus menyeberang rel lewat pelintasan sebidang; minta bantuan petugas bila perlu.`);
    else if (j.via === "crosswalk") out.push(`Menuju ${name} harus menyeberang jalan lewat crosswalk.`);
    else if (!j.level && j.lift !== "available") out.push(`${name} hanya dapat dicapai ${VIA_LABEL[j.via]}, dan lift ${j.lift === "unknown" ? "belum ada datanya" : "tidak tercatat"}.`);
  }
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
