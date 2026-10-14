import cors from "cors";
import express from "express";
import { AppError } from "./errors";
import { adminRoutes } from "./http/adminRoutes";
import { contextMiddleware, errorHandler, rateLimit, requestLogger, securityHeaders } from "./http/middleware";
import { publicRoutes } from "./http/publicRoutes";
import type { Services } from "./services";

export function createApp(s: Services): express.Express {
  const app = express();
  const { config, log } = s;
  app.disable("x-powered-by");
  // Render/Railway berada di belakang proxy; diperlukan agar req.ip benar untuk pembatasan laju.
  app.set("trust proxy", 1);

  // Endpoint publik: origin frontend dan admin. Endpoint /api/admin: hanya origin halaman admin.
  const publicOrigins = [...config.corsOrigins, ...config.adminOrigins];
  const corsMiddleware = cors((req, cb) => {
    const origins = (req as express.Request).path.startsWith("/admin") ? config.adminOrigins : publicOrigins;
    const origin = req.headers.origin;
    cb(null, {
      origin: !origin || origins.includes(origin) ? origin || false : false,
      allowedHeaders: ["Content-Type", "Authorization", "X-NTD-Preview"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      maxAge: 600,
    });
  });

  app.use(requestLogger(log));
  app.use(securityHeaders());
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const api = express.Router();
  api.use(corsMiddleware);
  api.use(contextMiddleware(config.admin.enabled ? s.auth : null));
  // Admin yang sudah masuk tidak dibatasi agar uji coba API tidak terhambat.
  const limiter = rateLimit(config.rateLimit);
  api.use((req, res, next) => (req.admin ? next() : limiter(req, res, next)));
  api.use(async (req, _res, next) => {
    req.ctx.cacheTtlSeconds = (await s.content.snapshot(req.ctx)).settings.cacheTtlSeconds;
    next();
  });
  if (config.admin.enabled) {
    api.use("/admin", adminRoutes(s));
  }
  api.use(publicRoutes(s));
  app.use("/api", api);

  app.use((_req, _res, next) => next(new AppError("NOT_FOUND", "Endpoint tidak ditemukan.")));
  app.use(errorHandler(log));
  return app;
}
