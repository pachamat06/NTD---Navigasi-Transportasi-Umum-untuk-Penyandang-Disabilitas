// Middleware lapisan API (Tabel 3.2): logging, pembatasan laju, penanganan galat, dan respons {status, data}.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodType } from "zod";
import type { AuthService } from "../admin/auth";
import { newContext, type RequestContext } from "../context";
import { AppError, UpstreamError } from "../errors";
import type { AdminUser } from "../store/types";

declare module "express-serve-static-core" {
  interface Request {
    ctx: RequestContext;
    admin?: AdminUser;
  }
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: "info", msg, ...meta })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: "warn", msg, ...meta })),
  error: (msg, meta) => console.error(JSON.stringify({ level: "error", msg, ...meta })),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export const ok = <T>(res: Response, data: T, status = 200) => res.status(status).json({ status: "ok", data });

/** Mencatat metode, path, status, dan durasi. Tidak mencatat body atau IP (Tabel 3.4 no. 12). */
export function requestLogger(log: Logger): RequestHandler {
  return (req, res, next) => {
    const t = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      log.info("request", { method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) });
    });
    next();
  };
}

/** Pembatasan laju sederhana per IP dalam memori (cukup untuk satu instance di Render/Railway). */
export function rateLimit(opts: { windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, { count: number; reset: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, opts.windowMs).unref();
  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + opts.windowMs };
      hits.set(key, h);
    }
    h.count++;
    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, opts.max - h.count)));
    if (h.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
      return next(new AppError("RATE_LIMITED", "Terlalu banyak permintaan. Coba lagi sebentar lagi."));
    }
    next();
  };
}

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  };
}

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

/**
 * Membuat RequestContext. Mode pratinjau (data draft) hanya aktif bila header X-NTD-Preview dikirim
 * bersama token admin yang valid; pengguna biasa selalu melihat data terbit.
 */
export function contextMiddleware(auth: AuthService | null): RequestHandler {
  return async (req, _res, next) => {
    req.ctx = newContext();
    const wantsPreview = req.headers["x-ntd-preview"] === "1" || req.headers["x-ntd-preview"] === "true";
    const token = bearer(req);
    if (token && auth) req.admin = (await auth.verify(token)) ?? undefined;
    if (wantsPreview) {
      if (!req.admin) return next(new AppError("UNAUTHORIZED", "Mode pratinjau membutuhkan token admin yang valid."));
      req.ctx.preview = true;
    }
    next();
  };
}

export function requireAdmin(role?: "admin"): RequestHandler {
  return (req, _res, next) => {
    if (!req.admin) return next(new AppError("UNAUTHORIZED", "Sesi admin tidak valid atau sudah berakhir. Silakan masuk lagi."));
    if (role && req.admin.role !== role) return next(new AppError("FORBIDDEN", "Aksi ini hanya untuk peran admin."));
    next();
  };
}

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw r.error;
  return r.data;
}

export function errorHandler(log: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        status: "error",
        code: "INVALID",
        message: "Input tidak valid.",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (err instanceof AppError) {
      return res.status(err.httpStatus).json({ status: "error", code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    if (err instanceof UpstreamError) {
      log.warn("upstream", { path: req.path, error: err.message });
      return res
        .status(503)
        .json({ status: "error", code: "API_DOWN", message: "Sumber data sedang tidak dapat dihubungi dan belum ada data tersimpan untuk permintaan ini." });
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === "entity.parse.failed") return res.status(400).json({ status: "error", code: "INVALID", message: "Body JSON tidak valid." });
    if (e?.type === "entity.too.large") return res.status(413).json({ status: "error", code: "INVALID", message: "Body terlalu besar." });
    log.error("unhandled", { path: req.path, error: e?.message });
    return res.status(500).json({ status: "error", code: "INTERNAL", message: "Terjadi galat pada server." });
  };
}
