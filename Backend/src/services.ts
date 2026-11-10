// Perakitan dependensi (composition root) sesuai Class Diagram (Gambar 3.5).

import { AuthService } from "./admin/auth";
import { TestRunner } from "./admin/TestRunner";
import { GroundingGuard } from "./ai/GroundingGuard";
import { ClaudeClient } from "./ai/llm/ClaudeClient";
import { GptClient } from "./ai/llm/GptClient";
import type { LlmClient } from "./ai/llm/LlmClient";
import { NavigationAgent } from "./ai/NavigationAgent";
import { VisionService, type VisionClientFactory } from "./ai/vision/VisionService";
import { ToolRegistry } from "./ai/ToolRegistry";
import type { Config } from "./config";
import type { RequestContext } from "./context";
import { CommuteApiClient } from "./data/commute/CommuteApiClient";
import { FixtureCommuteSource } from "./data/commute/FixtureCommuteSource";
import { HttpCommuteSource } from "./data/commute/HttpCommuteSource";
import { TjGtfs } from "./data/gtfs/TjGtfs";
import type { CommuteSource } from "./data/commute/types";
import { AlternativeService } from "./domain/AlternativeService";
import { ContentService } from "./domain/content";
import { FacilityAnalysisService } from "./domain/FacilityAnalysisService";
import { RouteSyncService } from "./domain/routeSync";
import { RoutePlannerService } from "./domain/RoutePlannerService";
import { StationService } from "./domain/StationService";
import type { Logger } from "./http/middleware";
import type { Store } from "./store/types";

export interface Services {
  config: Config;
  store: Store;
  log: Logger;
  source: CommuteSource;
  commute: CommuteApiClient;
  gtfs: TjGtfs;
  content: ContentService;
  stations: StationService;
  planner: RoutePlannerService;
  /** Sinkron pengaturan rute admin dari GTFS / Commute (urutan, waktu, frekuensi, jam layanan). */
  routeSync: RouteSyncService;
  facilities: FacilityAnalysisService;
  alternatives: AlternativeService;
  tools: ToolRegistry;
  guard: GroundingGuard;
  llm: LlmClient | null;
  agent: NavigationAgent;
  /** AI pembaca denah stasiun untuk halaman admin. */
  vision: VisionService;
  auth: AuthService;
  tests: TestRunner;
  startedAt: Date;
}

export function createLlm(config: Config): LlmClient | null {
  const { provider, apiKey, model, timeoutMs } = config.llm;
  if (provider === "none" || !apiKey) return null;
  if (provider === "claude") return new ClaudeClient(apiKey, model, timeoutMs);
  if (!model) throw new Error("LLM_MODEL wajib diisi untuk LLM_PROVIDER=gpt.");
  return new GptClient(apiKey, model, timeoutMs);
}

export function createSource(config: Config): CommuteSource {
  return config.commute.source === "http"
    ? new HttpCommuteSource({ baseUrl: config.commute.baseUrl, apiKey: config.commute.apiKey, timeoutMs: config.commute.timeoutMs, operators: config.commute.operators, regions: config.commute.regions })
    : new FixtureCommuteSource();
}

export function createServices(opts: { config: Config; store: Store; log: Logger; source?: CommuteSource; llm?: LlmClient | null; visionFactory?: VisionClientFactory }): Services {
  const { config, store, log } = opts;
  const source = opts.source ?? createSource(config);
  // GTFS Transjakarta (koridor BRT 1–14 dan lin BRT turunannya) melengkapi data TransJakarta yang tidak ada di Commute.
  const gtfs = new TjGtfs();
  const commute = new CommuteApiClient(source, store.cache, gtfs);
  const content = new ContentService(store.content);
  // Pengaturan rute per lini dan arah dari admin (draft hanya untuk pratinjau admin).
  const patterns = async (ctx: RequestContext) => (await content.snapshot(ctx)).routePatterns();
  // Hub transfer yang dibuat/diubah admin, di atas hub Commute dan hub bawaan NTD.
  const hubOverrides = async (ctx: RequestContext) => (await content.snapshot(ctx)).hubOverrides();
  const facilities = new FacilityAnalysisService(commute);
  const stationStatuses = async (ctx: RequestContext) => (await content.snapshot(ctx)).stationStatuses();
  const stations = new StationService(commute, facilities, patterns, hubOverrides, stationStatuses);
  const planner = new RoutePlannerService(commute, gtfs, patterns, hubOverrides);
  const routeSync = new RouteSyncService(commute, planner, gtfs);
  const alternatives = new AlternativeService(planner, facilities);
  const tools = new ToolRegistry({ stations, planner, facilities, alternatives });
  const guard = new GroundingGuard();
  const llm = opts.llm === undefined ? createLlm(config) : opts.llm;
  const agent = new NavigationAgent(tools, stations, content, guard, llm, log);
  const vision = new VisionService(config.vision, store.serverConfig, opts.visionFactory);
  const auth = new AuthService(store.admins, config.admin.tokenSecret, config.admin.tokenTtlMinutes);
  const tests = new TestRunner(agent, store.tests);
  return { config, store, log, source, commute, gtfs, content, stations, planner, routeSync, facilities, alternatives, tools, guard, llm, agent, vision, auth, tests, startedAt: new Date() };
}
