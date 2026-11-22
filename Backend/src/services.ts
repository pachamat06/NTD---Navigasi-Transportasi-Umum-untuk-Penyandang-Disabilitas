// Perakitan dependensi (composition root) sesuai Class Diagram (Gambar 3.5).

import { AuthService } from "./admin/auth";
import { TestRunner } from "./admin/TestRunner";
import { GroundingGuard } from "./ai/GroundingGuard";
import type { LlmClient } from "./ai/llm/LlmClient";
import { LlmService, type LlmClientFactory } from "./ai/llm/LlmService";
import { NavigationAgent } from "./ai/NavigationAgent";
import { FixturePostSource, XApiPostSource, type PostSource } from "./ai/reader/PostSource";
import { PostSourceService } from "./ai/reader/PostSourceService";
import { SecretBox } from "./ai/secrets";
import { ReaderConfigService } from "./ai/reader/ReaderConfig";
import { ServiceInfoReaderAgent } from "./ai/reader/ServiceInfoReaderAgent";
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
import { ServiceAdvisoryService } from "./domain/serviceAdvisory";
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
  /** Konfigurasi LLM (admin atau environment); `client()` memberi klien terkini. */
  llm: LlmService;
  agent: NavigationAgent;
  /** Informasi layanan operator dan antrean persetujuan admin. */
  advisories: ServiceAdvisoryService;
  /** Sumber postingan akun operator (X API dengan token dari admin/environment, atau fixture). */
  postSource: PostSourceService;
  readerConfig: ReaderConfigService;
  /** Agent pembaca informasi layanan dari akun X operator. */
  reader: ServiceInfoReaderAgent;
  /** AI pembaca denah stasiun untuk halaman admin. */
  vision: VisionService;
  auth: AuthService;
  tests: TestRunner;
  startedAt: Date;
}

export function createSource(config: Config): CommuteSource {
  return config.commute.source === "http"
    ? new HttpCommuteSource({ baseUrl: config.commute.baseUrl, apiKey: config.commute.apiKey, timeoutMs: config.commute.timeoutMs, operators: config.commute.operators, regions: config.commute.regions })
    : new FixtureCommuteSource();
}

export function createPostSource(config: Config): PostSource | null {
  const c = config.serviceInfo;
  if (c.source === "none") return null;
  if (c.source === "fixture") {
    if (!c.fixtureFile) throw new Error("SERVICE_INFO_FIXTURE_FILE wajib diisi untuk SERVICE_INFO_SOURCE=fixture.");
    return FixturePostSource.fromFile(c.fixtureFile);
  }
  if (!c.xBearerToken) throw new Error("X_API_BEARER_TOKEN wajib diisi untuk SERVICE_INFO_SOURCE=x.");
  return new XApiPostSource({ bearerToken: c.xBearerToken, baseUrl: c.xBaseUrl, timeoutMs: c.timeoutMs });
}

export function createServices(opts: { config: Config; store: Store; log: Logger; source?: CommuteSource; llm?: LlmClient | null; visionFactory?: VisionClientFactory; postSource?: PostSource | null; llmFactory?: LlmClientFactory; xFactory?: (token: string) => PostSource }): Services {
  const { config, store, log } = opts;
  const source = opts.source ?? createSource(config);
  // GTFS Transjakarta (koridor BRT 1–14 dan lin BRT turunannya) melengkapi data TransJakarta yang tidak ada di Commute.
  const gtfs = new TjGtfs();
  const commute = new CommuteApiClient(source, store.cache, gtfs);
  const content = new ContentService(store.content);
  // Stasiun dan lini dari admin (tambah manual / impor GTFS / koreksi) di atas dataset.
  commute.setOverlay(async (ctx) => (await content.snapshot(ctx)).datasetOverlay());
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
  // Rahasia (kunci LLM, token X) yang diisi admin disimpan terenkripsi dengan kunci turunan ADMIN_TOKEN_SECRET.
  const box = new SecretBox(config.admin.tokenSecret);
  const llm = new LlmService(config.llm, store.serverConfig, box, { factory: opts.llmFactory, fixed: opts.llm });
  const advisories = new ServiceAdvisoryService(store.advisories);
  const agent = new NavigationAgent(tools, stations, content, guard, llm, log, advisories);
  const postSource = new PostSourceService(config.serviceInfo, store.serverConfig, box, { xFactory: opts.xFactory, fixed: opts.postSource });
  const readerConfig = new ReaderConfigService(store.serverConfig);
  const reader = new ServiceInfoReaderAgent({ sources: postSource, config: readerConfig, advisories, llm, stations, content, log });
  const vision = new VisionService(config.vision, store.serverConfig, opts.visionFactory);
  const auth = new AuthService(store.admins, config.admin.tokenSecret, config.admin.tokenTtlMinutes);
  const tests = new TestRunner(agent, store.tests);
  return { config, store, log, source, commute, gtfs, content, stations, planner, routeSync, facilities, alternatives, tools, guard, llm, agent, advisories, postSource, readerConfig, reader, vision, auth, tests, startedAt: new Date() };
}
