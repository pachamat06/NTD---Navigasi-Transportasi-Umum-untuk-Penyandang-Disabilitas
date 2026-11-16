"use client";

import { useState } from "react";
import { busCode, clock, duration, isWalk, optionsOf, rideName, rupiah, sortedIndices, spanMinutes, type SortPref } from "@/lib/journey";
import { useNetwork } from "@/lib/network";
import type { JourneyPlan, RouteOption, RouteOptionKind } from "@/lib/types";
import { Chevron, ModeIcon, WalkIcon } from "./Icons";
import { Dur } from "./ResultPanel";

const KIND_LABEL: Record<RouteOptionKind, string> = { aksesibel: "Paling aksesibel", moderat: "Seimbang", tercepat: "Tercepat" };

/** Daftar hasil perjalanan: jam, durasi, tarif, ikon ringkas tiap langkah; pilihan terpilih memperlihatkan langkahnya. */
export function JourneyResults({
  plan,
  sort,
  arriveBy,
  selected,
  onSelect,
  onDetail,
  onShowMap,
  onEarlier,
  onLater,
}: {
  plan: JourneyPlan;
  sort: SortPref;
  /** Mode "Tiba": batas jam tiba (ISO). */
  arriveBy?: string;
  selected: number;
  onSelect: (i: number) => void;
  onDetail: (i: number) => void;
  onShowMap: (i: number) => void;
  onEarlier?: () => void;
  onLater?: () => void;
}) {
  const { stationById } = useNetwork();
  const options = optionsOf(plan);
  const order = sortedIndices(options, sort, arriveBy);
  const name = (id: string) => stationById(id)?.name ?? plan.route.stopNames?.[id] ?? options.find((o) => o.route.stopNames?.[id])?.route.stopNames?.[id] ?? id;

  return (
    <section aria-labelledby="judul-hasil" className="flex flex-col gap-3">
      <div>
        <h2 id="judul-hasil" className="text-lg font-bold">
          {name(plan.originId)} → {name(plan.destinationId)}
        </h2>
        <p className="text-sm text-[var(--muted)]">
          {arriveBy
            ? `Tiba paling lambat ${dayLabel(arriveBy)}`
            : plan.departAt
              ? plan.departMode === "at"
                ? `Berangkat ${dayLabel(plan.departAt)}`
                : `Berangkat sekarang, ${clock(plan.departAt)}`
              : ""}{" "}
          · {options.length} pilihan
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {order.map((i) => (
          <li key={i}>
            <JourneyCard
              option={options[i]}
              on={i === selected}
              late={!!arriveBy && !!options[i].summary.arrivalAt && Date.parse(options[i].summary.arrivalAt!) > Date.parse(arriveBy)}
              name={name}
              onSelect={() => onSelect(i)}
              onDetail={() => onDetail(i)}
              onShowMap={() => onShowMap(i)}
            />
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2 text-sm">
        {onEarlier ? (
          <button type="button" className="link-sm inline-flex items-center gap-1 whitespace-nowrap" onClick={onEarlier}>
            <Chevron dir="left" size={16} /> Perjalanan lebih awal
          </button>
        ) : (
          <span />
        )}
        {onLater && (
          <button type="button" className="link-sm inline-flex items-center gap-1 whitespace-nowrap" onClick={onLater}>
            Perjalanan lebih akhir <Chevron dir="right" size={16} />
          </button>
        )}
      </div>
    </section>
  );
}

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleString("id-ID", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });

function JourneyCard({
  option: o,
  on,
  late,
  name,
  onSelect,
  onDetail,
  onShowMap,
}: {
  option: RouteOption;
  on: boolean;
  late: boolean;
  name: (id: string) => string;
  onSelect: () => void;
  onDetail: () => void;
  onShowMap: () => void;
}) {
  const { meta } = useNetwork();
  const s = o.summary;
  const total = spanMinutes(o);
  const fare = o.route.totalFare;
  const est = o.route.legs.some((l) => l.scheduleEstimated);
  const times =
    s.departureAt && s.arrivalAt ? `${est ? "± " : ""}${clock(s.departureAt)} – ${clock(s.arrivalAt)}` : s.departureAt ? `Berangkat ${clock(s.departureAt)}` : "Jam belum tersedia";
  const label = `${times}, ${total === null ? "" : duration(total)}, ${s.transfers} kali pindah, aksesibilitas ${s.accessScore} dari 100`;
  return (
    <article className={`journey ${on ? "journey-on" : ""}`}>
      <button type="button" className="journey-hit" aria-pressed={on} aria-label={`${label}. ${on ? "Dipilih" : "Pilih dan tampilkan di peta"}`} onClick={onSelect} />
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xl font-light tabular-nums">{times}</p>
          <p className="text-sm">
            {fare > 0 ? `${rupiah(fare)}${o.route.fareComplete === false ? "+" : ""}` : "Tarif tidak tersedia"}
            <span className="text-[var(--muted)]"> · {s.transfers}× pindah</span>
          </p>
        </div>
        {total !== null && <Dur minutes={total} />}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {o.kinds.map((k) => (
          <span key={k} className={`badge ${k === "aksesibel" ? "badge-ok" : "badge-unknown"}`}>
            {KIND_LABEL[k]}
          </span>
        ))}
        <span className={`badge ${s.minScore >= (meta?.scoring.threshold ?? 60) ? "badge-ok" : "badge-warn"}`}>
          <span aria-hidden>♿</span> {s.accessScore}/100
        </span>
        {late && <span className="badge badge-warn">Tiba lewat batas</span>}
        {s.unmetNeeds > 0 && <span className="badge badge-warn">{s.unmetNeeds} kebutuhan belum terpenuhi</span>}
        {s.usesAvoidedModes && <span className="badge badge-warn">Memakai moda yang dihindari</span>}
      </div>
      {on ? <StepList option={o} name={name} /> : <IconStrip option={o} />}
      {on && (
        <div className="relative z-[1] mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost" onClick={onDetail}>
            Lihat detail
          </button>
          <button type="button" className="btn btn-ghost" onClick={onShowMap}>
            Tampilkan di peta
          </button>
        </div>
      )}
    </article>
  );
}

/** Ikon ringkas tiap langkah: jalan kaki bertitik, kendaraan dengan garis warna lin. */
function IconStrip({ option }: { option: RouteOption }) {
  const { lineById } = useNetwork();
  const legs = option.route.legs;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-2" aria-hidden>
      {legs[0]?.type === "RIDE" && <WalkIcon size={20} />}
      {legs.map((l, j) => {
        const line = l.lineId ? lineById(l.lineId) : undefined;
        if (l.type === "RIDE")
          return (
            <span key={j} className="inline-flex items-center gap-1">
              <ModeIcon mode={line?.mode ?? l.mode ?? "RAIL"} color={line?.color} size={20} />
              {(line?.mode ?? l.mode) === "BUS" && busCode(l.lineId) ? (
                <span className="rounded px-1 text-xs font-bold text-white" style={{ background: line?.color ?? "var(--muted)" }}>
                  {busCode(l.lineId)}
                </span>
              ) : (
                <span className="h-[5px] w-8 rounded-sm" style={{ background: line?.color ?? "var(--muted)" }} />
              )}
            </span>
          );
        return (
          <span key={j} className="inline-flex items-center gap-1">
            <WalkIcon size={20} />
            {isWalk(l) ? <span className="walk-dots" /> : null}
          </span>
        );
      })}
      <WalkIcon size={20} />
    </p>
  );
}

/** Langkah ringkas pilihan terpilih: "KRL ... ke X, 36 mnt", "Jalan kaki ke Y, 6 mnt". */
function StepList({ option, name }: { option: RouteOption; name: (id: string) => string }) {
  const { lineById } = useNetwork();
  const [openLeg, setOpenLeg] = useState<number | null>(null);
  const legs = option.route.legs;
  return (
    <ol className="steps steps-compact mt-3">
      {legs.map((l, j) => {
        const line = l.lineId ? lineById(l.lineId) : undefined;
        const mode = line?.mode ?? l.mode ?? "RAIL";
        const last = l.stops[l.stops.length - 1];
        const text =
          l.type === "RIDE"
            ? `${rideName(mode, l.lineId, line?.name)} ke ${name(last)}`
            : l.turnaround
              ? `Berbalik arah di ${name(l.stops[0])}`
              : isWalk(l)
                ? `Jalan kaki ke ${name(last)}`
                : `Pindah lini di ${name(l.stops[0])}`;
        return (
          <li key={j} className="step" data-walk={l.type === "TRANSFER" ? "" : undefined} style={{ ["--leg" as string]: line?.color ?? "var(--foreground)" }}>
            <div className="step-head">
              <span className="step-icon">{l.type === "RIDE" ? <ModeIcon mode={mode} color={line?.color} size={20} /> : <WalkIcon size={20} />}</span>
              <p>{text}</p>
            </div>
            <div className="step-body">
              <p className="flex flex-wrap gap-x-3 text-sm">
                <b>
                  {l.minutes === null
                    ? l.distanceM > 0
                      ? `${l.distanceM} m`
                      : "–"
                    : `${l.minutesEstimated || (l.type === "TRANSFER" && l.includesWait) ? "± " : ""}${duration(l.minutes)}`}
                </b>
                {l.type === "RIDE" && l.stops.length > 2 && (
                  <button type="button" className="link-sm relative z-[1]" aria-expanded={openLeg === j} onClick={() => setOpenLeg(openLeg === j ? null : j)}>
                    {openLeg === j ? "Sembunyikan" : mode === "BUS" ? "Lihat halte" : "Lihat pemberhentian"}
                  </button>
                )}
              </p>
              {openLeg === j && (
                <ul className="mt-1 text-sm text-[var(--muted)]">
                  {l.stops.slice(1, -1).map((s) => (
                    <li key={s}>{name(s)}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        );
      })}
      <li className="step step-end">
        <div className="step-head">
          <span className="step-icon">
            <WalkIcon size={20} />
          </span>
          <p>{name(legs.length ? legs[legs.length - 1].stops[legs[legs.length - 1].stops.length - 1] : "")}</p>
        </div>
      </li>
    </ol>
  );
}
