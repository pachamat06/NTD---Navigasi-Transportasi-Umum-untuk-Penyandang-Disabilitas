// PlanController (Tabel 3.8): endpoint publik yang dipakai Frontend. Respons selalu {status, data}.

import { Router } from "express";
import { z } from "zod";
import { ATTRIBUTION } from "../ai/GroundingGuard";
import { AMENITY_LABEL } from "../domain/FacilityAnalysisService";
import { AppError } from "../errors";
import type { Services } from "../services";
import { ok, parse } from "./middleware";

const stationId = z.string().trim().min(1).max(80).regex(/^[a-z0-9:-]+$/i, "id stasiun tidak valid");

export const planSchema = z.object({
  originId: stationId,
  destinationId: stationId,
  viaStationId: stationId.optional(),
  avoid: z.array(stationId).max(10).optional(),
  avoidModes: z.array(z.enum(["RAIL", "SUBWAY", "TRAM", "BUS", "MONORAIL"])).max(5).optional(),
  at: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "harus tanggal ISO 8601")
    .optional(),
});

const searchSchema = z.object({
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export function publicRoutes(s: Services): Router {
  const r = Router();

  r.get("/meta", async (req, res) => {
    const snap = await s.content.snapshot(req.ctx);
    ok(res, {
      disclaimer: snap.settings.disclaimer,
      attribution: ATTRIBUTION,
      scoring: snap.settings.scoring,
      amenityLabels: AMENITY_LABEL,
      dataSource: s.commute.sourceName,
      preview: req.ctx.preview,
    });
  });

  // Pencarian stasiun untuk autocomplete: langsung ke StationService tanpa agen.
  r.get("/stations", async (req, res) => {
    const { q, limit } = parse(searchSchema, req.query);
    const data = q === undefined ? await s.stations.list(req.ctx) : await s.stations.search(q, req.ctx, limit ?? 6);
    ok(res, data);
  });

  r.get("/stations/:id", async (req, res) => {
    const id = parse(stationId, req.params.id);
    const snap = await s.content.snapshot(req.ctx);
    req.ctx.cacheTtlSeconds = snap.settings.cacheTtlSeconds;
    const detail = await s.stations.detail(id, req.ctx, snap);
    if (!detail) throw new AppError("NOT_FOUND", `Stasiun "${id}" tidak ditemukan.`);
    ok(res, detail);
  });

  // Data awal GUI dalam satu panggilan: semua stasiun beserta fasilitas dan skornya (untuk peta), lini, dan hub.
  r.get("/network", async (req, res) => {
    const snap = await s.content.snapshot(req.ctx);
    req.ctx.cacheTtlSeconds = snap.settings.cacheTtlSeconds;
    const [list, lines, hubs] = await Promise.all([s.stations.list(req.ctx), s.stations.lines(req.ctx), s.stations.hubs(req.ctx)]);
    const stations = await Promise.all(
      list.map(async (st) => {
        const { assessment, facilities } = await s.facilities.assess(st.id, req.ctx, snap);
        return { ...st, ...facilities, assessment };
      }),
    );
    ok(res, { stations, lines, hubs });
  });

  r.get("/lines", async (req, res) => ok(res, await s.stations.lines(req.ctx)));
  r.get("/hubs", async (req, res) => ok(res, await s.stations.hubs(req.ctx)));

  r.get("/notices", async (req, res) => {
    const q = parse(z.object({ stationId: stationId.optional(), lineId: z.string().max(80).optional(), hubId: z.string().max(80).optional() }), req.query);
    const snap = await s.content.snapshot(req.ctx);
    const filtered = q.stationId || q.lineId || q.hubId;
    ok(res, filtered ? snap.notices({ stationIds: q.stationId ? [q.stationId] : [], lineIds: q.lineId ? [q.lineId] : [], hubIds: q.hubId ? [q.hubId] : [] }) : snap.allNotices());
  });

  // Rencana perjalanan aksesibel (UC-01): REST Controller → Agen Navigasi.
  r.post("/plan", async (req, res) => {
    const input = parse(planSchema, req.body ?? {});
    ok(res, await s.agent.rencanakan(input, req.ctx));
  });

  return r;
}
