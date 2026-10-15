// Perakitan dependensi (composition root) sesuai Class Diagram (Gambar 3.5).

import { AuthService } from "./admin/auth";
import { TestRunner } from "./admin/TestRunner";
import { GroundingGuard } from "./ai/GroundingGuard";
import { ClaudeClient } from "./ai/llm/ClaudeClient";
import { GptClient } from "./ai/llm/GptClient";
import type { LlmClient } from "./ai/llm/LlmClient";
import { NavigationAgent } from "./ai/NavigationAgent";
import { ToolRegistry } from "./ai/ToolRegistry";
import type { Config } from "./config";
import { CommuteApiClient } from "./data/commute/CommuteApiClient";
import { FixtureCommuteSource } from "./data/commute/FixtureCommuteSource";
import { HttpCommuteSource } from "./data/commute/HttpCommuteSource";
import type { CommuteSource } from "./data/commute/types";
import { AlternativeService } from "./domain/AlternativeService";
import { ContentService } from "./domain/content";
import { FacilityAnalysisService } from "./domain/FacilityAnalysisService";
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
  content: ContentService;
  stations: StationService;
  planner: RoutePlannerService;
  facilities: FacilityAnalysisService;
  alternatives: AlternativeService;
  tools: ToolRegistry;
  guard: GroundingGuard;
  llm: LlmClient | null;
  agent: NavigationAgent;
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

export function createServices(opts: { config: Config; store: Store; log: Logger; source?: CommuteSource; llm?: LlmClient | null }): Services {
  const { config, store, log } = opts;
  const source = opts.source ?? createSource(config);
  const commute = new CommuteApiClient(source, store.cache);
  const content = new ContentService(store.content);
  const facilities = new FacilityAnalysisService(commute);
  const stations = new StationService(commute, facilities);
  const planner = new RoutePlannerService(commute);
  const alternatives = new AlternativeService(planner, facilities);
  const tools = new ToolRegistry({ stations, planner, facilities, alternatives });
  const guard = new GroundingGuard();
  const llm = opts.llm === undefined ? createLlm(config) : opts.llm;
  const agent = new NavigationAgent(tools, stations, content, guard, llm, log);
  const auth = new AuthService(store.admins, config.admin.tokenSecret, config.admin.tokenTtlMinutes);
  const tests = new TestRunner(agent, store.tests);
  return { config, store, log, source, commute, content, stations, planner, facilities, alternatives, tools, guard, llm, agent, auth, tests, startedAt: new Date() };
}
