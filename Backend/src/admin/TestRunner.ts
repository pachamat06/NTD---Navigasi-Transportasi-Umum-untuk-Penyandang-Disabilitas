// Uji coba API sebelum perubahan diberikan ke pengguna. Kasus uji (pasangan asal–tujuan + ekspektasi)
// dijalankan terhadap konten draft (mode "preview") atau konten terbit (mode "published").

import { z } from "zod";
import { newContext } from "../context";
import type { NavigationAgent } from "../ai/NavigationAgent";
import { routeStationIds, transferStationIds } from "../domain/RoutePlannerService";
import type { JourneyPlan } from "../domain/models";
import { AppError } from "../errors";
import type { TestCase, TestRepository, TestRun } from "../store/types";

export const testRequestSchema = z.object({
  originId: z.string().min(1),
  destinationId: z.string().min(1),
  viaStationId: z.string().min(1).optional(),
  avoid: z.array(z.string()).max(10).optional(),
});

export const testExpectSchema = z.object({
  status: z.enum(["ok", "error"]).default("ok"),
  errorCode: z.enum(["INVALID", "NOT_FOUND", "API_DOWN"]).optional(),
  maxTransfers: z.number().int().min(0).optional(),
  mustPassStations: z.array(z.string()).optional(),
  mustNotTransferAt: z.array(z.string()).optional(),
  minScoreAt: z.array(z.object({ stationId: z.string(), min: z.number().min(0).max(100) })).optional(),
  adequateAt: z.array(z.string()).optional(),
  expectAlternative: z.boolean().optional(),
  expectNoticeIds: z.array(z.string()).optional(),
  maxLatencyMs: z.number().int().positive().optional(),
});

export const testCaseSchema = z.object({
  name: z.string().min(1).max(120),
  request: testRequestSchema,
  expect: testExpectSchema,
  enabled: z.boolean().default(true),
});

export type TestExpect = z.infer<typeof testExpectSchema>;

export interface CaseResult {
  caseId: string;
  name: string;
  passed: boolean;
  latencyMs: number;
  failures: string[];
  summary?: { transfers: number; stations: string[]; alternatives: string[]; notificationSource: string; warnings: number };
  error?: { code: string; message: string };
}

export function checkExpectations(expect: TestExpect, plan: JourneyPlan | null, err: AppError | null, latencyMs: number): string[] {
  const f: string[] = [];
  if (expect.maxLatencyMs && latencyMs > expect.maxLatencyMs) f.push(`latensi ${latencyMs} ms melebihi ${expect.maxLatencyMs} ms`);
  if (expect.status === "error") {
    if (!err) f.push("diharapkan galat, tetapi rute berhasil disusun");
    else if (expect.errorCode && err.code !== expect.errorCode) f.push(`kode galat ${err.code}, diharapkan ${expect.errorCode}`);
    return f;
  }
  if (!plan) return [...f, `diharapkan berhasil, tetapi galat ${err?.code}: ${err?.message}`];
  const stations = routeStationIds(plan.route);
  const transfers = transferStationIds(plan.route);
  if (expect.maxTransfers !== undefined && plan.route.transfers > expect.maxTransfers) f.push(`jumlah transfer ${plan.route.transfers} > ${expect.maxTransfers}`);
  for (const s of expect.mustPassStations ?? []) if (!stations.includes(s)) f.push(`rute tidak melewati ${s}`);
  for (const s of expect.mustNotTransferAt ?? []) if (transfers.includes(s)) f.push(`rute transfer di ${s}`);
  for (const { stationId, min } of expect.minScoreAt ?? []) {
    const a = plan.assessments.find((x) => x.stationId === stationId);
    if (!a) f.push(`stasiun ${stationId} tidak dinilai`);
    else if (a.score < min) f.push(`skor ${stationId} ${a.score} < ${min}`);
  }
  for (const s of expect.adequateAt ?? []) if (!plan.assessments.find((x) => x.stationId === s)?.adequate) f.push(`stasiun ${s} tidak memadai`);
  if (expect.expectAlternative === true && !plan.alternatives.length) f.push("diharapkan ada alternatif, tetapi tidak ada");
  if (expect.expectAlternative === false && plan.alternatives.length) f.push("diharapkan tanpa alternatif, tetapi ada");
  for (const id of expect.expectNoticeIds ?? []) if (!plan.notices.some((n) => n.id === id)) f.push(`pengumuman ${id} tidak muncul`);
  return f;
}

export class TestRunner {
  constructor(
    private agent: NavigationAgent,
    private repo: TestRepository,
  ) {}

  async runCase(c: Pick<TestCase, "id" | "name" | "request" | "expect">, mode: "preview" | "published"): Promise<CaseResult> {
    const req = testRequestSchema.parse(c.request);
    const expect = testExpectSchema.parse(c.expect);
    const ctx = newContext({ preview: mode === "preview" });
    // Uji coba tidak memanggil LLM agar hasil deterministik dan tidak menambah biaya.
    ctx.skipLlm = true;
    const t = Date.now();
    let plan: JourneyPlan | null = null;
    let err: AppError | null = null;
    try {
      plan = await this.agent.rencanakan(req, ctx);
    } catch (e) {
      err = e instanceof AppError ? e : new AppError("INTERNAL", (e as Error).message);
    }
    const latencyMs = Date.now() - t;
    const failures = checkExpectations(expect, plan, err, latencyMs);
    return {
      caseId: c.id,
      name: c.name,
      passed: failures.length === 0,
      latencyMs,
      failures,
      ...(plan
        ? {
            summary: {
              transfers: plan.route.transfers,
              stations: routeStationIds(plan.route),
              alternatives: plan.alternatives.map((a) => a.viaStationId),
              notificationSource: plan.notification.source,
              warnings: plan.warnings.length,
            },
          }
        : {}),
      ...(err ? { error: { code: err.code, message: err.message } } : {}),
    };
  }

  async runAll(mode: "preview" | "published", by: string): Promise<TestRun> {
    const cases = (await this.repo.listCases()).filter((c) => c.enabled);
    const startedAt = new Date();
    const results: CaseResult[] = [];
    for (const c of cases) results.push(await this.runCase(c, mode));
    return this.repo.addRun({
      mode,
      startedAt,
      finishedAt: new Date(),
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      results,
      triggeredBy: by,
    });
  }
}
