// Informasi layanan operator (gangguan, keterlambatan, penutupan, ...) dan antrean persetujuan admin.
// Aturan inti: informasi `pending` hanya ditampilkan sebagai info; hanya yang `approved` dan masih berlaku mengubah navigasi.

import { z } from "zod";
import { AppError } from "../errors";
import type { Route } from "./models";
import type { AdvisoryCategory, AdvisoryImpact, AdvisoryStatus, NewServiceAdvisory, ServiceAdvisory, ServiceAdvisoryRepository } from "../store/types";

export type { AdvisoryCategory, AdvisoryImpact, AdvisoryStatus, ServiceAdvisory } from "../store/types";

export const ADVISORY_CATEGORIES = ["gangguan", "keterlambatan", "penutupan", "perubahan_rute", "pemeliharaan", "normal", "lainnya"] as const satisfies readonly AdvisoryCategory[];
export const ADVISORY_IMPACTS = ["info", "delay", "disruption", "closure"] as const satisfies readonly AdvisoryImpact[];

/** Pengurangan skor rute (rankScore) untuk rute yang terdampak informasi layanan yang disetujui. */
export const IMPACT_PENALTY: Record<AdvisoryImpact, number> = { info: 0, delay: 8, disruption: 30, closure: 60 };
const IMPACT_ORDER: Record<AdvisoryImpact, number> = { info: 0, delay: 1, disruption: 2, closure: 3 };

/** Masa berlaku bawaan (jam sejak postingan) bila LLM/admin tidak menyebutkannya. */
export const DEFAULT_TTL_HOURS: Record<AdvisoryImpact, number> = { info: 24, delay: 3, disruption: 6, closure: 12 };
/** Batas masa berlaku: tidak lebih dari 7 hari sejak postingan. */
export const MAX_TTL_HOURS = 7 * 24;

export const defaultExpiry = (postedAt: string, impact: AdvisoryImpact): string => new Date(Date.parse(postedAt) + DEFAULT_TTL_HOURS[impact] * 3_600_000).toISOString();

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "harus tanggal ISO 8601");

/** Isian yang boleh diubah admin pada informasi `pending` (dan diterapkan saat persetujuan). */
export const advisoryEditSchema = z.object({
  category: z.enum(ADVISORY_CATEGORIES).optional(),
  impact: z.enum(ADVISORY_IMPACTS).optional(),
  summary: z.string().trim().min(1).max(300).optional(),
  stationIds: z.array(z.string().min(1).max(80)).max(30).optional(),
  lineIds: z.array(z.string().min(1).max(80)).max(30).optional(),
  operator: z.string().trim().min(1).max(80).nullable().optional(),
  validFrom: isoDate.nullable().optional(),
  expiresAt: isoDate.optional(),
  note: z.string().trim().max(300).optional(),
});
export type AdvisoryEdit = z.infer<typeof advisoryEditSchema>;

/** Postingan yang ditempel admin (input manual). */
export const advisoryIngestSchema = z.object({
  text: z.string().trim().min(5).max(2000),
  account: z.string().trim().regex(/^@?[A-Za-z0-9_]{1,15}$/, "nama akun X tidak valid").optional(),
  operator: z.string().trim().min(1).max(80).optional(),
  url: z.string().trim().url().max(300).refine((u) => /^https:\/\//i.test(u), "tautan harus https").optional(),
  postId: z.string().regex(/^[0-9]{1,19}$/, "id postingan berupa angka").optional(),
  postedAt: isoDate.optional(),
});
export type AdvisoryIngest = z.infer<typeof advisoryIngestSchema>;

/** Tampilan ke pengguna: ringkasan + atribusi sumber (teks asli dan catatan admin tidak ikut). */
export interface AdvisoryView {
  id: string;
  /** approved = sudah diperiksa admin; pending = dibaca otomatis, belum diverifikasi. */
  status: "approved" | "pending";
  verified: boolean;
  category: AdvisoryCategory;
  /** Hanya untuk informasi yang disetujui: dampaknya pada navigasi. */
  impact?: AdvisoryImpact;
  summary: string;
  operator: string | null;
  stationIds: string[];
  lineIds: string[];
  source: { type: "x" | "manual"; account: string; url: string | null; postedAt: string };
  expiresAt: string;
}

export function toView(a: ServiceAdvisory): AdvisoryView {
  const approved = a.status === "approved";
  return {
    id: a.id,
    status: approved ? "approved" : "pending",
    verified: approved,
    category: a.category,
    ...(approved ? { impact: a.impact } : {}),
    summary: a.summary,
    operator: a.operator,
    stationIds: a.stationIds,
    lineIds: a.lineIds,
    source: { type: a.source.type, account: a.source.account, url: a.source.url, postedAt: a.source.postedAt },
    expiresAt: a.expiresAt,
  };
}

/** Mulai berlaku: `validFrom`, atau waktu postingan. */
const startsAt = (a: ServiceAdvisory) => Date.parse(a.validFrom ?? a.source.postedAt);
export const isActive = (a: ServiceAdvisory, at: Date) => a.status !== "rejected" && startsAt(a) <= at.getTime() && Date.parse(a.expiresAt) > at.getTime();
/** Hanya yang disetujui dan sedang berlaku yang mengubah navigasi. */
export const isEffective = (a: ServiceAdvisory, at: Date) => a.status === "approved" && isActive(a, at);

export interface RelevanceScope {
  stationIds: string[];
  lineIds: string[];
  hubIds?: string[];
  operators?: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Apakah informasi ini relevan dengan sekumpulan stasiun/lini/operator (mis. yang dilewati rute). Tanpa cakupan = relevan untuk semua. */
export function isRelevant(a: ServiceAdvisory, scope: RelevanceScope): boolean {
  const hasScope = a.stationIds.length > 0 || a.lineIds.length > 0;
  if (hasScope) return a.stationIds.some((id) => scope.stationIds.includes(id)) || a.lineIds.some((id) => scope.lineIds.includes(id));
  if (!a.operator) return true;
  return (scope.operators ?? []).some((o) => norm(o) === norm(a.operator!));
}

export interface AdvisoryEffect {
  impact: "none" | Exclude<AdvisoryImpact, "info">;
  /** Pengurangan skor rute. */
  penalty: number;
  /** Id informasi yang memengaruhi rute ini. */
  ids: string[];
  notes: string[];
}

export const NO_EFFECT: AdvisoryEffect = { impact: "none", penalty: 0, ids: [], notes: [] };

/**
 * Dampak informasi layanan yang disetujui pada satu rute. Lini terdampak: ada ruas naik dengan lini itu. Stasiun
 * terdampak: dilewati rute (penutupan: hanya bila menjadi tempat naik, turun, atau pindah). Dampak terberat menentukan
 * pengurangan skor.
 */
export function advisoryEffectOn(route: Route, effective: ServiceAdvisory[]): AdvisoryEffect {
  let impact: AdvisoryImpact = "info";
  const ids: string[] = [];
  const notes: string[] = [];
  const rideLines = new Set(route.legs.flatMap((l) => (l.type === "RIDE" ? [l.lineId, ...(l.options ?? []).map((o) => o.lineId)] : [])).filter((x): x is string => !!x));
  const passed = new Set(route.legs.flatMap((l) => l.stops));
  const stopPoints = new Set(route.legs.flatMap((l) => (l.stops.length ? [l.stops[0], l.stops[l.stops.length - 1]] : [])));
  for (const a of effective) {
    if (a.impact === "info") continue;
    const stationHit = a.stationIds.some((id) => (a.impact === "closure" ? stopPoints : passed).has(id));
    const lineHit = a.lineIds.some((id) => rideLines.has(id));
    if (!stationHit && !lineHit) continue;
    ids.push(a.id);
    notes.push(`Informasi layanan (disetujui admin, sumber @${a.source.account}): ${a.summary}`);
    if (IMPACT_ORDER[a.impact] > IMPACT_ORDER[impact]) impact = a.impact;
  }
  if (impact === "info") return NO_EFFECT;
  return { impact: impact as AdvisoryEffect["impact"], penalty: IMPACT_PENALTY[impact], ids, notes };
}

/** Stasiun yang sebaiknya tidak menjadi titik transfer karena gangguan atau penutupan yang disetujui. */
export function advisoryAvoidStations(effective: ServiceAdvisory[]): string[] {
  return [...new Set(effective.filter((a) => IMPACT_ORDER[a.impact] >= IMPACT_ORDER.disruption).flatMap((a) => a.stationIds))];
}

export class ServiceAdvisoryService {
  constructor(private repo: ServiceAdvisoryRepository) {}

  /** Informasi yang sedang berlaku pada waktu `at`: yang disetujui, dan (bila `includePending`) yang belum diperiksa. */
  async active(at: Date, opts: { includePending: boolean }): Promise<ServiceAdvisory[]> {
    const rows = await this.repo.list({ activeAt: at });
    return rows.filter((a) => isActive(a, at) && (a.status === "approved" || (opts.includePending && a.status === "pending")));
  }

  list(filter: { status?: AdvisoryStatus; limit?: number } = {}) {
    return this.repo.list(filter);
  }

  async get(id: string): Promise<ServiceAdvisory> {
    const a = await this.repo.get(id);
    if (!a) throw new AppError("NOT_FOUND", "Informasi layanan tidak ditemukan.");
    return a;
  }

  findBySource(type: "x" | "manual", account: string, postId: string) {
    return this.repo.findBySource(type, account, postId);
  }

  /** Menambah informasi baru (selalu `pending`); isian dijaga agar konsisten. */
  async create(input: Omit<NewServiceAdvisory, "status" | "reviewedBy" | "reviewedAt" | "reviewNote">): Promise<ServiceAdvisory> {
    return this.repo.create({ ...input, status: "pending", reviewedBy: null, reviewedAt: null, reviewNote: null });
  }

  /** Mengubah isian informasi yang masih `pending`. */
  async edit(id: string, patch: AdvisoryEdit, by: string): Promise<ServiceAdvisory> {
    const a = await this.get(id);
    if (a.status !== "pending") throw new AppError("CONFLICT", "Hanya informasi yang belum diperiksa yang dapat diubah.");
    const next = applyEdit(a, patch);
    return (await this.repo.update(id, { ...next, reviewedBy: a.reviewedBy, reviewNote: patch.note ?? a.reviewNote }))!;
  }

  /**
   * Menyetujui informasi (dengan perubahan opsional). Dampak selain `info` wajib punya stasiun atau lini terdampak, dan
   * masa berlakunya harus di masa depan agar tidak menyetujui informasi yang sudah lewat.
   */
  async approve(id: string, patch: AdvisoryEdit, by: string, now = new Date()): Promise<ServiceAdvisory> {
    const a = await this.get(id);
    if (a.status !== "pending") throw new AppError("CONFLICT", `Informasi sudah ${a.status === "approved" ? "disetujui" : "ditolak"}.`);
    const next = applyEdit(a, patch);
    if (next.impact !== "info" && !next.stationIds.length && !next.lineIds.length) {
      throw new AppError("INVALID", "Tentukan stasiun atau lini yang terdampak sebelum menyetujui informasi yang mengubah navigasi.");
    }
    if (Date.parse(next.expiresAt) <= now.getTime()) throw new AppError("INVALID", "Masa berlaku informasi sudah lewat; tentukan expiresAt baru di masa depan.");
    return (await this.repo.update(id, { ...next, status: "approved", reviewedBy: by, reviewedAt: now.toISOString(), reviewNote: patch.note ?? null }))!;
  }

  async reject(id: string, note: string | undefined, by: string, now = new Date()): Promise<ServiceAdvisory> {
    const a = await this.get(id);
    if (a.status === "rejected") throw new AppError("CONFLICT", "Informasi sudah ditolak.");
    return (await this.repo.update(id, { status: "rejected", reviewedBy: by, reviewedAt: now.toISOString(), reviewNote: note ?? null }))!;
  }

  /** Mengakhiri informasi yang disetujui lebih awal (mis. operator mengumumkan sudah normal). */
  async expire(id: string, by: string, now = new Date()): Promise<ServiceAdvisory> {
    const a = await this.get(id);
    if (a.status !== "approved") throw new AppError("CONFLICT", "Hanya informasi yang disetujui yang dapat dikedaluwarsakan; tolak informasi yang belum diperiksa.");
    return (await this.repo.update(id, { expiresAt: now.toISOString(), reviewedBy: by, reviewedAt: now.toISOString(), reviewNote: a.reviewNote ?? "Dikedaluwarsakan admin." }))!;
  }
}

/** Menerapkan perubahan admin pada salinan isian; masa berlaku dibatasi 7 hari sejak postingan. */
function applyEdit(a: ServiceAdvisory, p: AdvisoryEdit): Pick<ServiceAdvisory, "category" | "impact" | "summary" | "stationIds" | "lineIds" | "operator" | "validFrom" | "expiresAt"> {
  const impact = p.impact ?? a.impact;
  const expiresAt = p.expiresAt ?? (p.impact && p.impact !== a.impact ? defaultExpiry(a.source.postedAt, impact) : a.expiresAt);
  const maxExpiry = Date.parse(a.source.postedAt) + MAX_TTL_HOURS * 3_600_000;
  if (Date.parse(expiresAt) > maxExpiry) throw new AppError("INVALID", `Masa berlaku paling lama ${MAX_TTL_HOURS / 24} hari sejak postingan.`);
  const validFrom = p.validFrom === undefined ? a.validFrom : p.validFrom;
  if (validFrom && Date.parse(validFrom) >= Date.parse(expiresAt)) throw new AppError("INVALID", "validFrom harus sebelum expiresAt.");
  return {
    category: p.category ?? a.category,
    impact,
    summary: p.summary ?? a.summary,
    stationIds: p.stationIds ? [...new Set(p.stationIds)] : a.stationIds,
    lineIds: p.lineIds ? [...new Set(p.lineIds)] : a.lineIds,
    operator: p.operator === undefined ? a.operator : p.operator,
    validFrom,
    expiresAt,
  };
}
