"use client";

// Peron: lin/arah yang dilayani, fasilitas per peron, eskalator dan lift, serta celah peron dengan kendaraan.

import { AMENITY_LABEL, useNetwork } from "@/lib/network";
import type { DetailStatus, EscalatorGroup, LiftInfo, Platform, PlatformConnection, PlatformGap, StationDetailData } from "@/lib/types";

const TYPE_TEXT = { island: "peron pulau (island)", side: "peron samping (side)", bay: "peron ujung (bay)" } as const;
const STATUS_TEXT: Record<DetailStatus, string> = { available: "tersedia", absent: "tidak ada", unknown: "belum ada data", out_of_service: "tidak berfungsi" };
const DIRECTION_TEXT = { naik: "naik", turun: "turun", bergantian: "naik/turun bergantian" } as const;

export const VIA_TEXT: Record<PlatformConnection, string> = {
  langsung: "langsung dari gate",
  crosswalk: "menyeberang jalan (crosswalk)",
  sebidang: "pelintasan sebidang (menyeberang rel)",
  jpo: "lewat JPO",
  terowongan: "lewat terowongan",
};

export function gapText(g: PlatformGap): string {
  const base = g.level === "tangga" ? `perlu naik ${g.steps ?? "beberapa"} anak tangga ke kendaraan` : g.level === "sedikit" ? "beda tinggi kecil dengan kendaraan" : "sejajar dengan kendaraan";
  const size = [g.horizontalCm !== undefined && `celah ${g.horizontalCm} cm`, g.verticalCm !== undefined && `beda tinggi ${g.verticalCm} cm`].filter(Boolean).join(", ");
  return [base, size, g.boardingAid && "petugas dapat menyediakan pelat/ramp portabel"].filter(Boolean).join(" · ");
}

export function verticalText(escalators?: EscalatorGroup[], lift?: LiftInfo): string[] {
  const out = (escalators ?? []).map(
    (g) => `${g.count} eskalator ${DIRECTION_TEXT[g.direction]}${g.connects ? ` (${g.connects})` : ""}${g.status && g.status !== "available" ? `, ${STATUS_TEXT[g.status]}` : ""}`,
  );
  if (lift) out.push(`${lift.count} lift${lift.connects ? ` (${lift.connects})` : ""}${lift.status && lift.status !== "available" ? `, ${STATUS_TEXT[lift.status]}` : ""}`);
  return out;
}

/** Rincian satu peron. `compact` dipakai pada langkah rute (tanpa daftar lin). */
export function PlatformDetails({ p, compact }: { p: Platform; compact?: boolean }) {
  const { lineById } = useNetwork();
  const amenities = Object.entries(p.amenities) as [keyof typeof AMENITY_LABEL, DetailStatus][];
  const vertical = verticalText(p.escalators, p.lift);
  return (
    <>
      {!compact && p.serves.length > 0 && (
        <p>
          {p.serves
            .map((s) => {
              const l = lineById(s.lineId);
              return `${l ? `${l.operator} ${l.name}` : s.lineId}${s.direction ? ` (${s.direction})` : ""}`;
            })
            .join(" · ")}
        </p>
      )}
      {amenities.length > 0 && (
        <p>
          {amenities.map(([k, s], i) => (
            <span key={k} className={s === "available" ? "text-[var(--ok)]" : "text-[var(--warn)]"}>
              {i > 0 && " · "}
              <span aria-hidden>{s === "available" ? "✔" : "⚠"}</span> {AMENITY_LABEL[k]} {STATUS_TEXT[s]}
            </span>
          ))}
        </p>
      )}
      {vertical.length > 0 && <p className="text-[var(--muted)]">{vertical.join(" · ")}</p>}
      {p.gap && (
        <p className={p.gap.level === "tangga" ? "text-[var(--warn)]" : "text-[var(--muted)]"}>
          <span aria-hidden>{p.gap.level === "tangga" ? "⚠" : "↔"}</span> Celah peron: {gapText(p.gap)}
          {p.gap.note ? `. ${p.gap.note}` : ""}
        </p>
      )}
      {p.note && <p className="text-[var(--muted)]">{p.note}</p>}
    </>
  );
}

export function PlatformList({ platforms, entrances = [] }: { platforms: Platform[]; entrances?: StationDetailData["entrances"] }) {
  return (
    <ul className="mt-1 flex flex-col gap-2">
      {platforms.map((p) => (
        <li key={p.code} className="rounded-lg bg-[var(--surface-2)] p-3 text-sm">
          <p className="font-semibold">
            {p.name || `Peron ${p.code}`}
            {p.type && <span className="font-normal text-[var(--muted)]"> · {TYPE_TEXT[p.type]}</span>}
            {p.tracks?.length ? <span className="font-normal text-[var(--muted)]"> · jalur {p.tracks.join(", ")}</span> : null}
          </p>
          <PlatformDetails p={p} />
          {(() => {
            const gates = entrances.flatMap((e) => (e.platformLinks ?? []).filter((l) => l.platform === p.code).map((l) => `${e.name} (${VIA_TEXT[l.via]})`));
            return gates.length > 0 && <p className="text-[var(--muted)]">Dari gate: {gates.join(" · ")}</p>;
          })()}
          {p.source === "dataset" && <p className="text-xs text-[var(--muted)]">Fasilitas peron ini belum disurvei tim NTD.</p>}
        </li>
      ))}
    </ul>
  );
}
