import { createApp } from "./app";
import { loadConfig } from "./config";
import { consoleLogger } from "./http/middleware";
import { createServices } from "./services";
import { createMemoryStore } from "./store/memory";
import { connectPgStore } from "./store/pg";
import type { Store } from "./store/types";

async function main() {
  const config = loadConfig();
  const log = consoleLogger;

  let store: Store;
  if (config.databaseUrl) {
    store = await connectPgStore(config.databaseUrl, (m) => log.info(m));
  } else {
    if (config.nodeEnv === "production") throw new Error("DATABASE_URL wajib diisi di production.");
    log.warn("DATABASE_URL kosong: memakai penyimpanan memori (data admin hilang saat server berhenti).");
    store = createMemoryStore();
  }

  const services = createServices({ config, store, log });
  if (config.admin.enabled) {
    if (!config.admin.tokenSecret) log.warn("ADMIN_TOKEN_SECRET kosong: secret acak dipakai, sesi admin hilang saat server restart.");
    await services.auth.bootstrap(config.admin.bootstrapEmail, config.admin.bootstrapPassword, (m) => log.info(m));
  }

  const app = createApp(services);
  const server = app.listen(config.port, () => {
    log.info(`API running on http://localhost:${config.port}`, {
      commute: config.commute.source,
      store: store.kind,
      llm: services.llm ? `${services.llm.name}/${services.llm.model}` : "none (template)",
    });
  });

  const shutdown = () => {
    server.close(() => void store.close().finally(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
