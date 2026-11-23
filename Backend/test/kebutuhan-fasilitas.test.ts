// Filter kebutuhan fasilitas: lift menggantikan eskalator, dan rute yang PASTI tidak memenuhi kalah dari yang hanya belum
// diketahui datanya.

import request from "supertest";
import { checkChoice } from "../src/ai/LlmNavigator";
import { pickOptions, summarize } from "../src/ai/NavigationAgent";
import { needMet } from "../src/domain/FacilityAnalysisService";
import type { Route, RouteLeg, RouteOptionSummary, TransferAccess } from "../src/domain/models";
import { makeTestApp } from "./helpers";

const JK_DA = { originId: "jakarta-kota", destinationId: "dukuh-atas-mrt" };
const am = (lift: string, eskalator: string) => ({ lift, eskalator, toilet: "available", ramp: "unknown" }) as never;

describe("needMet: lift menggantikan eskalator", () => {
  it("stasiun yang hanya punya lift memenuhi kebutuhan eskalator, tidak sebaliknya", () => {
    expect(needMet("eskalator", am("available", "absent"))).toBe(true);
    expect(needMet("eskalator", am("absent", "absent"))).toBe(false);
    expect(needMet("eskalator", am("unknown", "absent"))).toBe(false);
    expect(needMet("eskalator", am("absent", "available"))).toBe(true);
    expect(needMet("lift", am("absent", "available"))).toBe(false);
    expect(needMet("lift", am("available", "absent"))).toBe(true);
  });

  it("jalur lewat concourse: lift di jalur itu menggantikan eskalator yang tidak ada", () => {
    expect(needMet("eskalator", am("absent", "absent"), { level: false, pathLift: "available", pathEscalator: "absent" } as never)).toBe(true);
    expect(needMet("eskalator", am("absent", "absent"), { level: false, pathLift: "absent", pathEscalator: "absent" } as never)).toBe(false);
  });
});

describe("Rencana dengan kebutuhan eskalator", () => {
  async function withManggarai(lift: "available" | "absent", eskalator: "available" | "absent") {
    const t = await makeTestApp();
    const auth = { Authorization: `Bearer ${await t.login()}` };
    for (const [type, status] of [["lift", lift], ["eskalator", eskalator]] as const) {
      expect((await request(t.app).post("/api/admin/content").set(auth).send({ kind: "facility", stationId: "manggarai", data: { type, status } })).status).toBe(201);
    }
    expect((await request(t.app).post("/api/admin/publish").set(auth).send({})).status).toBe(200);
    return t;
  }
  const manggaraiAccess = (o: { route: { legs: { access?: TransferAccess[] }[] } }) => o.route.legs.flatMap((l) => l.access ?? []).filter((a) => a.stationId === "manggarai");

  it("hanya ada lift di titik pindah: kebutuhan eskalator terpenuhi dan tercatat digantikan lift", async () => {
    const { app } = await withManggarai("available", "absent");
    const d = (await request(app).post("/api/plan").send({ ...JK_DA, needs: ["eskalator"] })).body.data;
    for (const o of d.options) {
      const acc = manggaraiAccess(o);
      expect(acc.length).toBeGreaterThan(0);
      expect(acc.every((a) => a.status === "available" && a.substitute === "lift")).toBe(true);
      expect(o.warnings.join(" ")).not.toMatch(/Eskalator tidak tercatat di Manggarai/);
      expect(o.summary.unmetNeeds).toBe(0);
    }
  });

  it("tanpa lift maupun eskalator: tidak terpenuhi dan dihitung pasti gagal", async () => {
    const { app } = await withManggarai("absent", "absent");
    const d = (await request(app).post("/api/plan").send({ ...JK_DA, needs: ["eskalator"] })).body.data;
    const o = d.options[0];
    expect(manggaraiAccess(o).every((a) => a.status === "absent" && a.substitute === undefined)).toBe(true);
    expect(o.summary.unmetNeeds).toBeGreaterThan(0);
    expect(o.summary.unmetCertain).toBe(o.summary.unmetNeeds);
    expect(o.warnings.join(" ")).toMatch(/Eskalator tidak tercatat di Manggarai/);
  });

  it("kebutuhan lift tidak digantikan eskalator", async () => {
    const { app } = await withManggarai("absent", "available");
    const d = (await request(app).post("/api/plan").send({ ...JK_DA, needs: ["lift"] })).body.data;
    expect(manggaraiAccess(d.options[0]).every((a) => a.status === "absent")).toBe(true);
    expect(d.options[0].summary.unmetNeeds).toBeGreaterThan(0);
  });
});

describe("Rute yang pasti tidak memenuhi kalah dari yang belum diketahui", () => {
  const ride: RouteLeg = { type: "RIDE", lineId: "a", stops: ["x", "y"], distanceM: 1000, minutes: 5, fare: 0 };
  const route = (access: TransferAccess[]): Route => ({ legs: [ride, { type: "TRANSFER", stops: ["y", "y"], distanceM: 0, minutes: null, fare: 0, access }, { ...ride, stops: ["y", "z"] }], totalDistanceM: 2000, totalMinutes: 10, timeComplete: false, totalFare: 0, transfers: 1 });
  const acc = (status: TransferAccess["status"]): TransferAccess => ({ stationId: "y", need: "eskalator", status });

  it("summarize memisahkan yang pasti gagal dari yang belum diketahui", () => {
    const s = (a: TransferAccess[]) => summarize(route(a), [], []);
    expect(s([acc("absent")])).toMatchObject({ unmetNeeds: 1, unmetCertain: 1 });
    expect(s([acc("out_of_service")])).toMatchObject({ unmetNeeds: 1, unmetCertain: 1 });
    expect(s([acc("unknown"), acc("unknown")])).toMatchObject({ unmetNeeds: 2, unmetCertain: 0 });
    expect(s([acc("available")])).toMatchObject({ unmetNeeds: 0, unmetCertain: 0 });
  });

  it("pickOptions: pilihan paling aksesibel = yang paling sedikit pasti gagal, walau skornya lebih rendah", () => {
    const sum = (rankScore: number, unmetNeeds: number, unmetCertain: number): RouteOptionSummary => ({ accessScore: Math.max(0, rankScore), rankScore, minScore: 0, minutes: 10, transfers: 1, unmetNeeds, unmetCertain, usesAvoidedModes: false });
    const certainFail = { route: route([acc("absent")]), summary: sum(10, 1, 1) };
    const unknownOnly = { route: { ...route([acc("unknown")]), totalMinutes: 20 }, summary: sum(-5, 3, 0) };
    const picked = pickOptions([certainFail, unknownOnly]);
    expect(picked[0].e).toBe(unknownOnly);
    expect(picked[0].kinds).toContain("aksesibel");
    // Tanpa perbedaan "pasti gagal" (mis. tanpa filter kebutuhan) urutan tetap menurut skor.
    const a = { route: route([]), summary: sum(10, 0, 0) };
    const b = { route: { ...route([]), totalMinutes: 20 }, summary: sum(-5, 0, 0) };
    expect(pickOptions([a, b])[0].e).toBe(a);
  });

  it("pagar pilihan LLM menolak rute yang pasti gagal bila ada yang tidak pasti gagal", () => {
    const v = (unmetNeeds: number, unmetCertain: number) => ({ unmetNeeds, unmetCertain, usesAvoidedModes: false, advisoryImpact: "none" as const });
    expect(checkChoice(0, [v(1, 1), v(2, 0)])).toMatch(/pasti tidak terpenuhi/);
    expect(checkChoice(1, [v(1, 1), v(2, 0)])).toBeNull();
  });
});
