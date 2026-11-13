"use client";

import { useState, type ReactNode } from "react";
import { clock, duration, isWalk, km, legTimes, rideName, rupiah, spanMinutes, walking, wibDate } from "@/lib/journey";
import { AMENITY_LABEL, useNetwork } from "@/lib/network";
import type { Alternative, ExitRef, Frequency, GateChoice, JourneyPlan, Notice, RouteLeg, StationAssessment } from "@/lib/types";
import { AccessBadge } from "./AccessBadge";
import { Chevron, EscalatorIcon, LevelIcon, LiftIcon, ModeIcon, RampIcon, StairsIcon, WalkIcon, WarnIcon } from "./Icons";
import { accessText, PlatformDetails } from "./PlatformInfo";

/** Hari, tanggal, dan jam WIB, mis. "Selasa, 10 November pukul 08.00". */
const dayClock = (iso: string) =>
  new Date(iso).toLocaleString("id-ID", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });

/** Rencana untuk satu pilihan rute: rute, penilaian, peringatan, dan notifikasi pilihan itu. */
export function planForOption(plan: JourneyPlan, index: number): JourneyPlan {
  const o = plan.options?.[index];
  if (!o || index === 0) return plan;
  return { ...plan, route: o.route, assessments: o.assessments, warnings: o.warnings, notification: o.notification, alternatives: o.alternatives };
}

const noticeLine = (n: Notice) => `${n.title}${/[.!?:]$/.test(n.title) ? "" : ":"} ${n.message}`;

/** Peringatan ringkas: satu blok tipis dengan judul satu baris, bisa dibuka/tutup, isi dipotong bila panjang. */
export function Alert({
  title,
  items,
  tone = "warn",
  action,
  defaultOpen = true,
}: {
  title: string;
  items: string[];
  tone?: "warn" | "info";
  action?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [full, setFull] = useState(false);
  const LIMIT = 150;
  const first = items[0] ?? "";
  const long = items.length > 1 || first.length > LIMIT;
  const cut = first.length > LIMIT ? `${first.slice(0, first.lastIndexOf(" ", LIMIT - 10) > 60 ? first.lastIndexOf(" ", LIMIT - 10) : LIMIT - 10)}…` : first;
  return (
    <div className={`alert ${tone === "info" ? "alert-info" : ""}`} role={tone === "warn" ? "note" : undefined}>
      <button type="button" className="alert-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {tone === "warn" ? (
          <WarnIcon size={20} />
        ) : (
          <span aria-hidden className="alert-i">
            i
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
        <span aria-hidden className="text-lg font-bold leading-none">
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <div className="alert-body">
          {full ? (
            <ul className={items.length > 1 ? "list-disc pl-4" : ""}>
              {items.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : (
            <p>
              {cut}
              {items.length > 1 && <span className="text-[var(--muted)]"> (+{items.length - 1} lainnya)</span>}
            </p>
          )}
          {long && (
            <button type="button" className="link-sm" onClick={() => setFull((v) => !v)}>
              {full ? "Ringkas" : "Selengkapnya"}
            </button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

const ACCESS_TEXT = { available: "tersedia", absent: "tidak tercatat", unknown: "belum ada data", out_of_service: "tidak berfungsi" } as const;
const PATH_LIFT_TEXT = {
  available: "ada lift di jalur ini",
  absent: "tidak ada lift di jalur ini",
  unknown: "data lift di jalur ini belum ada",
  out_of_service: "lift di jalur ini sedang tidak berfungsi",
} as const;

/** Detail perjalanan (UC-03 s.d. UC-07): langkah per stasiun dengan jam, peringatan ringkas, dan rincian aksesibilitas. */
export function ResultPanel({
  plan: full,
  selected = 0,
  onShowDetail,
  onUseAlternative,
  onUseGate,
  onShowMap,
  onBack,
}: {
  plan: JourneyPlan;
  /** Indeks pilihan rute yang ditampilkan (0 = paling aksesibel). */
  selected?: number;
  onShowDetail: (id: string) => void;
  onUseAlternative: (alt: Alternative) => void;
  /** Pakai pintu yang disarankan: cari ulang dengan pintu itu. */
  onUseGate?: (role: GateChoice["role"], gateId: string) => void;
  onShowMap: () => void;
  onBack?: () => void;
}) {
  const { stationById, lineById } = useNetwork();
  const plan = planForOption(full, selected);
  const option = full.options?.[selected];
  const { route } = plan;
  const times = legTimes(route);
  const dayShift = (iso?: string) => (iso && plan.departAt && wibDate(iso) > wibDate(plan.departAt) ? " (+1 hari)" : "");
  const assessmentOf = (id: string): StationAssessment => plan.assessments.find((a) => a.stationId === id) ?? { stationId: id, score: 0, adequate: false, dataAvailable: false };
  const name = (id: string) => stationById(id)?.name ?? route.stopNames?.[id] ?? id;
  const first = times.start.find(Boolean);
  const span = option ? spanMinutes(option) : first && times.end ? Math.round((Date.parse(times.end) - Date.parse(first)) / 60_000) : route.totalMinutes;

  // Peringatan Backend ditempatkan pada langkah stasiun yang disebut (nama terpanjang yang cocok); sisanya umum.
  const noticeTexts = new Set((plan.notices ?? []).map(noticeLine));
  const stepStops = [...route.legs.map((l) => l.stops[0]), plan.destinationId];
  const perStep: string[][] = stepStops.map(() => []);
  const general: string[] = [];
  const gateAdvice = new Map<string, GateChoice>();
  for (const a of plan.assessments) if (a.gateChoice?.recommended && a.gateChoice.recommendedId) gateAdvice.set(a.stationId, a.gateChoice);
  for (const w of plan.warnings) {
    if (noticeTexts.has(w)) continue;
    if ([...gateAdvice.values()].some((g) => w.includes(`Disarankan ${g.role} lewat ${g.recommended}`))) continue;
    if (/^(Data fasilitas belum tersedia|Rute tanpa|Sebagian ruas|Tarif sebagian|Waktu tempuh TransJakarta|Sumber data)/.test(w)) {
      general.push(w);
      continue;
    }
    let best = -1;
    let len = 0;
    stepStops.forEach((id, i) => {
      const n = name(id);
      if (n.length > len && w.includes(n)) {
        best = i;
        len = n.length;
      }
    });
    if (best < 0)
      route.legs.forEach((l, i) => {
        if (best >= 0) return;
        if (l.stops.some((s) => w.includes(name(s)))) best = i;
      });
    if (best >= 0) perStep[best].push(w);
    else general.push(w);
  }
  // Pengumuman tim NTD: stasiun/hub pada langkah stasiunnya, lini pada ruas lini itu, umum di atas.
  const noticesAt = (i: number) =>
    (plan.notices ?? []).filter((n) => {
      const leg = route.legs[i];
      const id = stepStops[i];
      if (n.scope === "station") return n.targetId === id || (leg?.type === "RIDE" && leg.stops.slice(1, -1).includes(n.targetId ?? ""));
      if (n.scope === "line") return leg?.type === "RIDE" && leg.lineId === n.targetId;
      if (n.scope === "hub") return stationById(id)?.hubId === n.targetId && stepStops.findIndex((s) => stationById(s)?.hubId === n.targetId) === i;
      return false;
    });
  const globalNotices = (plan.notices ?? []).filter(
    (n) => n.scope === "global" || (n.scope === "station" && !route.legs.some((l) => l.stops.includes(n.targetId ?? "")) && n.targetId !== plan.destinationId),
  );

  const stepAlerts = (i: number) => {
    const id = stepStops[i];
    const a = assessmentOf(id);
    const g = gateAdvice.get(id);
    const teamNotes = a.dataAvailable ? (a.notes ?? []).filter((n) => !(a.journey && n.startsWith("Skor perjalanan"))) : [];
    const alts = plan.alternatives.filter((alt) => route.legs.findIndex((l) => l.type === "TRANSFER" && l.stops.includes(alt.replacesStationId)) === i);
    return (
      <>
        {noticesAt(i).map((n) => (
          <Alert key={n.id} tone={n.severity === "info" ? "info" : "warn"} title={n.title} items={[n.message]} />
        ))}
        {perStep[i].length > 0 && <Alert title={`Peringatan di ${name(id)}`} items={perStep[i]} />}
        {g && (
          <Alert
            title={`Saran pintu ${g.role}`}
            items={[`${g.chosen} ${g.reason ?? "kurang aksesibel"}. Disarankan ${g.role} lewat ${g.recommended}${g.recommendedVia ? ` (${g.recommendedVia})` : ""}.`]}
            action={
              onUseGate && (
                <button type="button" className="btn btn-secondary mt-2 min-h-10 text-sm" onClick={() => onUseGate(g.role, g.recommendedId!)}>
                  Pakai {g.recommended}
                </button>
              )
            }
          />
        )}
        {teamNotes.length > 0 && <Alert tone="info" title={`Info tim NTD: ${name(id)}`} items={teamNotes} />}
        {alts.map((alt) => (
          <AlternativeAlert key={alt.viaStationId} alt={alt} weak={assessmentOf(alt.replacesStationId)} onUse={onUseAlternative} />
        ))}
      </>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {onBack && (
        <button type="button" className="link-sm inline-flex items-center gap-1 self-start" onClick={onBack}>
          <Chevron dir="left" size={16} /> Semua perjalanan
        </button>
      )}
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-2xl font-light tabular-nums">
          {first && times.end ? (
            <>
              {route.legs.some((l) => l.scheduleEstimated) ? "± " : ""}
              {clock(first)} – {clock(times.end)}
              <span className="text-base">{dayShift(times.end)}</span>
            </>
          ) : (
            "Jam belum tersedia"
          )}
        </h2>
        {span !== null && <Dur minutes={span} />}
      </div>
      <p className="-mt-2 text-sm text-[var(--muted)]">
        {plan.departAt && (plan.departMode === "at" ? `Berangkat ${dayClock(plan.departAt)} WIB` : `Berangkat sekarang (${clock(plan.departAt)} WIB)`)}
        {route.totalFare > 0 && ` · ${rupiah(route.totalFare)}${route.fareComplete === false ? "+" : ""}`} · {route.transfers}× pindah · {km(route.totalDistanceM)}
      </p>

      {plan.fromCache && (
        <Alert tone="info" title="Memakai data tersimpan" items={[`Sumber data sedang tidak dapat dihubungi. Menampilkan data tersimpan terakhir (${plan.fromCache}).`]} />
      )}
      {globalNotices.map((n) => (
        <Alert key={n.id} tone={n.severity === "info" ? "info" : "warn"} title={n.title} items={[n.message]} />
      ))}
      {general.length > 0 && <Alert title="Peringatan untuk perjalanan ini" items={general} defaultOpen={general.length < 3} />}

      <ol className="steps" aria-label="Langkah perjalanan">
        {route.legs.map((leg, i) => {
          const start = leg.stops[0];
          const line = leg.lineId ? lineById(leg.lineId) : undefined;
          const mode = line?.mode ?? leg.mode ?? "RAIL";
          const color = leg.type === "RIDE" ? (line?.color ?? "var(--muted)") : undefined;
          const nextRide = route.legs.slice(i).find((l) => l.type === "RIDE");
          const nextLine = nextRide?.lineId ? lineById(nextRide.lineId) : undefined;
          const board =
            leg.type === "RIDE"
              ? leg.boardAt?.name || ((leg.boardAt?.code ?? leg.platform) ? `${mode === "BUS" ? "halte" : "peron"} ${leg.boardAt?.code ?? leg.platform}` : "")
              : "";
          // Pindah lini di stasiun yang sama: nama stasiun cukup tampil sekali (pada langkah pindah).
          const prev = route.legs[i - 1];
          const merged = leg.type === "RIDE" && prev?.type === "TRANSFER" && !isWalk(prev) && !prev.turnaround && prev.stops[0] === start;
          const at = times.start[i] ? ` pukul ${leg.scheduleEstimated ? "± " : ""}${clock(times.start[i]!)}${dayShift(times.start[i])}` : "";
          return (
            <li key={i} className="step" data-walk={leg.type === "TRANSFER" ? "" : undefined} style={{ ["--leg" as string]: color ?? "var(--foreground)" }}>
              {merged ? (
                <div className="step-head">
                  <span className="step-icon">
                    <ModeIcon mode={mode} color={line?.color} />
                  </span>
                  <p className="font-semibold">
                    Naik{board ? ` di ${board}` : ""}
                    {at}
                  </p>
                </div>
              ) : (
                <div className="step-head">
                  <span className="step-icon">
                    {leg.type === "RIDE" ? (
                      <ModeIcon mode={mode} color={line?.color} />
                    ) : isWalk(leg) || !nextRide ? (
                      <WalkIcon />
                    ) : (
                      <ModeIcon mode={nextLine?.mode ?? nextRide.mode ?? "RAIL"} color={nextLine?.color} />
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="text-lg leading-snug">
                      <button type="button" className="step-name" onClick={() => onShowDetail(start)} aria-label={`${name(start)}, lihat fasilitas`}>
                        {name(start)}
                      </button>
                      {board && <span className="font-semibold"> – naik di {board}</span>}
                      {times.start[i] && (
                        <span className="whitespace-nowrap">
                          {" "}
                          pukul {leg.scheduleEstimated ? "± " : ""}
                          {clock(times.start[i]!)}
                          {dayShift(times.start[i])}
                        </span>
                      )}
                    </p>
                    <StationAccess a={assessmentOf(start)} />
                  </div>
                </div>
              )}
              <div className="step-body">
                {leg.type === "RIDE" ? <RideBody leg={leg} name={name} assessmentOf={assessmentOf} /> : <TransferBody leg={leg} name={name} />}
                {stepAlerts(i)}
              </div>
            </li>
          );
        })}
        <li className="step step-end">
          <div className="step-head">
            <span className="step-icon">
              <WalkIcon />
            </span>
            <div className="min-w-0">
              <p className="text-lg leading-snug">
                <button type="button" className="step-name" onClick={() => onShowDetail(plan.destinationId)} aria-label={`${name(plan.destinationId)}, lihat fasilitas`}>
                  {name(plan.destinationId)}
                </button>
                {times.end && (
                  <span className="whitespace-nowrap">
                    {" "}
                    pukul {route.legs.some((l) => l.scheduleEstimated) ? "± " : ""}
                    {clock(times.end)}
                    {dayShift(times.end)}
                  </span>
                )}
              </p>
              <StationAccess a={assessmentOf(plan.destinationId)} />
              <div className="mt-1 flex flex-col gap-2">{stepAlerts(route.legs.length)}</div>
            </div>
          </div>
        </li>
      </ol>

      <div className="flex flex-wrap gap-2">
        {onBack && (
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            Sembunyikan detail
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onShowMap}>
          Tampilkan di peta
        </button>
      </div>

      <AccessSummary plan={plan} option={option?.summary} name={name} />

      <details className="disclosure">
        <summary>
          <span>Ringkasan dari NTD</span>
          <Chevron size={16} />
        </summary>
        <p className="px-3 pb-3 text-sm leading-relaxed">{plan.notification.text}</p>
      </details>

      <footer className="text-xs text-[var(--muted)]">
        <p>{plan.disclaimer}</p>
        <p className="mt-1">{plan.attribution ?? "Data © Commute Data API, Shiori Labs (ODbL-1.0)."}</p>
      </footer>
    </div>
  );
}

/** Durasi besar gaya papan jadwal, mis. "1 j 5 mnt". */
export function Dur({ minutes }: { minutes: number }) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return (
    <span className="whitespace-nowrap" aria-label={duration(minutes)}>
      {h > 0 && (
        <>
          <span className="text-2xl font-semibold">{h}</span>
          <span className="text-sm"> j </span>
        </>
      )}
      <span className="text-2xl font-semibold">{m}</span>
      <span className="text-sm"> mnt</span>
    </span>
  );
}

/** Akses gate ke peron di satu stasiun, satu baris dengan ikon. */
function StationAccess({ a }: { a: StationAssessment }) {
  const st = useNetwork().stationById(a.stationId);
  const j = a.journey;
  const am = st?.amenities;
  const icons = (
    <span className="inline-flex items-center gap-1 text-[var(--accent)]">
      {am?.lift === "available" && <LiftIcon size={18} />}
      {am?.eskalator === "available" && <EscalatorIcon size={18} />}
      {am?.ramp === "available" && <RampIcon size={18} />}
    </span>
  );
  if (!j && !a.dataAvailable) return <p className="mt-0.5 text-sm text-[var(--muted)]">Data fasilitas belum tersedia</p>;
  const lift = j?.pathLift ?? j?.lift;
  const ok = !j || j.level || lift === "available";
  return (
    <p className={`mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm ${ok ? "text-[var(--muted)]" : "text-[var(--warn)]"}`}>
      {j ? (
        <span className="inline-flex items-center gap-1">
          {j.level ? <LevelIcon size={18} /> : lift === "available" ? <LiftIcon size={18} /> : <StairsIcon size={18} />}
          Peron {j.platforms.join(", ")}: {j.level ? "tanpa naik-turun lantai" : `naik-turun lantai, lift ${ACCESS_TEXT[lift ?? "unknown"]}`}
        </span>
      ) : null}
      {icons}
      <AccessBadge a={a} compact />
    </p>
  );
}

function RideBody({ leg, name, assessmentOf }: { leg: RouteLeg; name: (id: string) => string; assessmentOf: (id: string) => StationAssessment }) {
  const { lineById, stationById } = useNetwork();
  const [stops, setStops] = useState(false);
  const line = leg.lineId ? lineById(leg.lineId) : undefined;
  const mode = line?.mode ?? leg.mode ?? "RAIL";
  const lineName = line?.name ?? leg.lineId ?? "";
  const toward = leg.headsign ?? name(leg.stops[leg.stops.length - 1]);
  const j = assessmentOf(leg.stops[0]).journey;
  const hasInfo = !!(leg.boardAt || j || (leg.options && leg.options.length > 1) || leg.frequency || leg.tripNumber);
  return (
    <>
      <p>
        <b>{rideName(mode, leg.lineId, lineName)}</b> menuju {toward}
        {mode === "BUS" && line?.name && <span className="block text-sm text-[var(--muted)]">Koridor {line.name}</span>}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm">
        <b>{leg.minutes === null ? "waktu tidak tersedia" : `${leg.minutesEstimated ? "± " : ""}${duration(leg.minutes)}`}</b>
        {leg.stops.length > 2 && (
          <button type="button" className="link-sm" aria-expanded={stops} onClick={() => setStops((v) => !v)}>
            {stops ? "Sembunyikan" : mode === "BUS" ? "Lihat halte" : "Lihat pemberhentian"}
          </button>
        )}
        {leg.fare > 0 && <span className="text-[var(--muted)]">{rupiah(leg.fare)}</span>}
      </p>
      {stops && (
        <ul className="mt-1 text-sm">
          {leg.stops.slice(1, -1).map((s) => (
            <li key={s} className="flex items-center gap-2 py-0.5">
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full border-2" style={{ borderColor: line?.color ?? "var(--muted)" }} />
              {name(s)}
              {stationById(s) && <AccessBadge a={assessmentOf(s)} compact />}
            </li>
          ))}
        </ul>
      )}
      {leg.changeAt && (
        <p className="mt-1 text-sm">
          Ganti kereta di <b>{name(leg.changeAt)}</b>
          {leg.changeDepartureAt ? ` pukul ${clock(leg.changeDepartureAt)}` : ""}
        </p>
      )}
      {hasInfo && (
        <details className="mt-1 text-sm">
          <summary className="link-sm cursor-pointer">Info peron dan akses</summary>
          <div className="mt-1 flex flex-col gap-1">
            {j && (
              <p className="text-[var(--muted)]">
                Peron {j.platforms.join(", ")} {accessText(j)}
                {j.gate ? ` (${j.gate})` : ""}
                {j.level ? ", lift dan eskalator tidak dibutuhkan" : j.pathLift ? `, ${PATH_LIFT_TEXT[j.pathLift]}` : ", lift dan eskalator dibutuhkan"} · skor stasiun{" "}
                {j.stationScore}
              </p>
            )}
            {leg.boardAt && <PlatformDetails p={leg.boardAt} compact station={stationById(leg.stops[0])?.amenities} />}
            {leg.tripNumber && <p className="text-[var(--muted)]">Perjalanan {leg.tripNumber}</p>}
            {leg.scheduleEstimated && leg.waitMinutes ? <p className="text-[var(--muted)]">Perkiraan menunggu ± {leg.waitMinutes} mnt</p> : null}
            <RideChoices leg={leg} />
          </div>
        </details>
      )}
    </>
  );
}

function TransferBody({ leg, name }: { leg: RouteLeg; name: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const hints = [
    leg.fromExit && `Keluar lewat ${exitText(leg.fromExit)}.`,
    leg.notes && !leg.turnaround ? leg.notes : undefined,
    leg.toExit && `Masuk lewat ${exitText(leg.toExit)}.`,
  ].filter((x): x is string => !!x);
  const access = leg.access ?? [];
  const mins =
    leg.minutes === null
      ? leg.distanceM > 0
        ? `${leg.distanceM} m`
        : "waktu tidak tersedia"
      : leg.includesWait
        ? `± ${duration(leg.minutes)} termasuk menunggu`
        : duration(leg.minutes);
  return (
    <>
      <p>{leg.turnaround ? `Berbalik arah di ${name(leg.stops[0])}` : isWalk(leg) ? `Jalan kaki ke ${name(leg.stops[leg.stops.length - 1])}` : "Pindah lini di dalam stasiun"}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm">
        <b>{mins}</b>
        {isWalk(leg) && leg.distanceM > 0 && leg.minutes !== null && <span className="text-[var(--muted)]">{leg.distanceM} m</span>}
        {(hints.length > 0 || access.length > 0) && (
          <button type="button" className="link-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Sembunyikan petunjuk" : "Lihat petunjuk"}
          </button>
        )}
      </p>
      {open && (
        <div className="mt-1 text-sm">
          {hints.map((l) => (
            <p key={l} className="text-[var(--muted)]">
              {l}
            </p>
          ))}
          {access.length > 0 && (
            <ul className="mt-1" aria-label="Fasilitas untuk pindah">
              {access.map((a) => (
                <li key={`${a.stationId}-${a.need}-${a.platform ?? ""}`} className={a.status === "available" || a.notNeeded ? "" : "text-[var(--warn)]"}>
                  <span aria-hidden>{a.status === "available" || a.notNeeded ? "✔" : "⚠"}</span> {AMENITY_LABEL[a.need]} di {name(a.stationId)}
                  {a.platform ? ` (peron ${a.platform})` : ""}: {a.notNeeded ? `tidak dibutuhkan, peron dicapai ${accessText(a.notNeeded)}` : ACCESS_TEXT[a.status]}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

const freqText = (f: Frequency) => `biasanya tiap ±${f.headwayMinutes} mnt${f.serviceHours ? ` (beroperasi ${f.serviceHours})` : ""}`;

/** Lin paralel yang bisa dinaiki (pemberhentian dan tarif sama) dan frekuensi bila jadwal tidak tersedia. */
function RideChoices({ leg }: { leg: RouteLeg }) {
  const { lineById } = useNetwork();
  const options = leg.options && leg.options.length > 1 ? leg.options : null;
  if (!options && !leg.frequency) return null;
  return (
    <div>
      {options && (
        <>
          <p className="font-semibold">Naik yang datang lebih dulu:</p>
          <ul className="mt-1 flex flex-wrap gap-2" aria-label="Pilihan lin">
            {options.map((o, k) => {
              const line = lineById(o.lineId);
              return (
                <li key={`${o.lineId}-${o.headsign ?? ""}-${k}`} className="rounded-md border-2 px-2 py-0.5" style={{ borderColor: line?.color ?? "var(--muted)" }}>
                  <b>{line?.name ?? o.lineName ?? o.lineId}</b>
                  {o.headsign && <span className="text-[var(--muted)]"> · arah {o.headsign}</span>}
                  {o.frequency && <span className="text-[var(--muted)]"> · ±{o.frequency.headwayMinutes} mnt</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {leg.frequency && (
        <p className="mt-1 text-[var(--muted)]">
          {leg.frequency.source === "TIMETABLE"
            ? `Menurut jadwal Commute, kereta ke tujuan ruas ini ${freqText(leg.frequency)}.`
            : `Jadwal tetap tidak tersedia; ${freqText(leg.frequency)}. Bukan jadwal pasti.`}
        </p>
      )}
    </div>
  );
}

const exitText = (e: ExitRef) => `${e.name ?? e.ref}${e.signs?.length ? ` (ikuti tanda ${e.signs.join(", ")})` : ""}`;

/** Rincian aksesibilitas perjalanan: jalan kaki, naik-turun lantai, lift/eskalator, celah peron, dan data yang kurang. */
function AccessSummary({ plan, option, name }: { plan: JourneyPlan; option?: { accessScore: number; minScore: number; unmetNeeds: number }; name: (id: string) => string }) {
  const { stationById } = useNetwork();
  const route = plan.route;
  const walk = walking(route);
  const judged = plan.assessments.filter((a) => a.journey);
  const level = judged.filter((a) => a.journey!.level);
  const climb = judged.filter((a) => !a.journey!.level);
  const liftOk = climb.filter((a) => (a.journey!.pathLift ?? a.journey!.lift) === "available");
  const liftBad = climb.filter((a) => (a.journey!.pathLift ?? a.journey!.lift) !== "available");
  const esc = climb.filter((a) => stationById(a.stationId)?.amenities.eskalator === "available");
  const gaps = route.legs.filter((l) => l.type === "RIDE" && l.boardAt?.gap?.level === "tangga");
  // Hanya tempat naik, turun, dan pindah (stasiun yang dilewati tidak perlu diakses).
  const key = new Set([...route.legs.flatMap((l) => [l.stops[0], l.stops[l.stops.length - 1]]), plan.destinationId]);
  const noData = plan.assessments.filter((a) => !a.dataAvailable && key.has(a.stationId));
  const names = (xs: { stationId: string }[]) => {
    const n = [...new Set(xs.map((a) => name(a.stationId)))];
    return n.length > 4 ? `${n.slice(0, 3).join(", ")}, dan ${n.length - 3} lainnya` : n.join(", ");
  };
  const rows: { icon: ReactNode; text: string; warn?: boolean }[] = [
    {
      icon: <WalkIcon size={20} />,
      text: !walk.count
        ? "Tanpa jalan kaki antarstasiun"
        : walk.complete
          ? `Jalan kaki ${walk.minutes} menit (${walk.meters} m)`
          : `Jalan kaki ${walk.meters} m${walk.minutes ? ` (sebagian ${walk.minutes} menit, sisanya tanpa data waktu)` : ""}`,
    },
  ];
  if (level.length) rows.push({ icon: <LevelIcon />, text: `${level.length} stasiun tanpa naik-turun lantai: ${names(level)}` });
  if (liftOk.length) rows.push({ icon: <LiftIcon />, text: `Lift tersedia di ${names(liftOk)}` });
  if (liftBad.length) rows.push({ icon: <StairsIcon />, text: `Naik-turun lantai tanpa lift pasti di ${names(liftBad)}`, warn: true });
  if (esc.length) rows.push({ icon: <EscalatorIcon />, text: `Eskalator tersedia di ${names(esc)}` });
  if (gaps.length) rows.push({ icon: <StairsIcon />, text: `Anak tangga ke kendaraan di ${gaps.map((l) => name(l.stops[0])).join(", ")}`, warn: true });
  if (option?.unmetNeeds) rows.push({ icon: <WarnIcon size={20} />, text: `${option.unmetNeeds} kebutuhan fasilitas belum terpenuhi`, warn: true });
  if (noData.length)
    rows.push({
      icon: (
        <span aria-hidden className="font-bold">
          ?
        </span>
      ),
      text: `Data fasilitas belum ada: ${names(noData)}`,
    });

  return (
    <details className="disclosure" open>
      <summary>
        <span>Rincian aksesibilitas</span>
        <Chevron size={16} />
      </summary>
      <div className="px-3 pb-3">
        {option && (
          <p className="mb-2 text-sm">
            Skor aksesibilitas rute <b>{option.accessScore}/100</b> · terendah {option.minScore}
          </p>
        )}
        <ul className="flex flex-col gap-2 text-sm">
          {rows.map((r) => (
            <li key={r.text} className={`flex items-start gap-3 ${r.warn ? "text-[var(--warn)]" : ""}`}>
              <span className="mt-0.5 grid w-6 shrink-0 place-items-center">{r.icon}</span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function AlternativeAlert({ alt, weak, onUse }: { alt: Alternative; weak: StationAssessment; onUse: (a: Alternative) => void }) {
  const { stationById, hubById } = useNetwork();
  const via = stationById(alt.viaStationId);
  const weakSt = stationById(alt.replacesStationId);
  return (
    <Alert
      title="Ada transfer yang lebih aksesibel"
      items={[
        `Transfer di ${weakSt?.name ?? alt.replacesStationId} perlu perhatian (skor ${weak.score}). Alternatif: lewat ${via?.name ?? alt.viaStationId} di Hub ${hubById(alt.hubId)?.name ?? alt.hubId} (skor ${alt.assessment.score}).`,
      ]}
      action={
        <button type="button" className="btn btn-secondary mt-2 min-h-10 text-sm" onClick={() => onUse(alt)}>
          Pakai rute ini
        </button>
      }
    />
  );
}

const NOTICE_STYLE = {
  info: { cls: "banner-info", icon: "ⓘ" },
  warning: { cls: "banner-warn", icon: "⚠" },
  critical: { cls: "banner-warn border-l-4 border-l-[var(--bad)]", icon: "⛔" },
} as const;

/** Pengumuman dari tim NTD (dikelola lewat halaman admin), mis. lift sedang diperbaiki. */
export function NoticeBanner({ notice, target }: { notice: Notice; target?: string }) {
  const st = NOTICE_STYLE[notice.severity];
  return (
    <div className={`banner ${st.cls}`} role={notice.severity === "critical" ? "alert" : undefined}>
      <span aria-hidden>{st.icon}</span>{" "}
      <span>
        <b>
          {notice.title}
          {/[.!?:]$/.test(notice.title) ? "" : "."}
        </b>{" "}
        {notice.message}
        {target && <span className="block text-sm opacity-80">Berlaku untuk: {target}</span>}
      </span>
    </div>
  );
}
