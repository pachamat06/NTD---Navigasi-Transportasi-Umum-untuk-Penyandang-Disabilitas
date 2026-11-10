"use client";

import { AMENITY_LABEL, useNetwork } from "@/lib/network";
import type { Alternative, AmenityType, ExitRef, Frequency, GateChoice, JourneyPlan, Notice, RouteLeg, RouteOption, RouteOptionKind } from "@/lib/types";
import { AccessBadge } from "./AccessBadge";
import { accessText, PlatformDetails } from "./PlatformInfo";

const km = (m: number) => `${(m / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} km`;
const rupiah = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
/** Jam WIB dari waktu ISO, mis. "08.03". */
const clock = (iso: string) => new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
/** Tanggal WIB (YYYY-MM-DD) dari waktu ISO, untuk mengenali jam yang jatuh keesokan harinya. */
const wibDate = (iso: string) => new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(0, 10);
/** Hari, tanggal, dan jam WIB, mis. "Selasa, 10 November pukul 08.00". */
const dayClock = (iso: string) =>
  new Date(iso).toLocaleString("id-ID", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
const duration = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} j ${m % 60} mnt` : `${m} mnt`);

const KIND_LABEL: Record<RouteOptionKind, string> = { aksesibel: "Paling aksesibel", moderat: "Moderat", tercepat: "Tercepat" };

/** Rencana untuk satu pilihan rute: rute, penilaian, peringatan, dan notifikasi pilihan itu. */
export function planForOption(plan: JourneyPlan, index: number): JourneyPlan {
  const o = plan.options?.[index];
  if (!o || index === 0) return plan;
  return { ...plan, route: o.route, assessments: o.assessments, warnings: o.warnings, notification: o.notification, alternatives: o.alternatives };
}

/** Hasil Rute dan Status Aksesibilitas (UC-03, UC-04, UC-05, UC-06, UC-07). */
export function ResultPanel({
  plan: full,
  selected = 0,
  onSelect,
  onShowDetail,
  onUseAlternative,
  onUseGate,
  onShowMap,
}: {
  plan: JourneyPlan;
  /** Indeks pilihan rute yang ditampilkan (0 = paling aksesibel). */
  selected?: number;
  onSelect?: (index: number) => void;
  onShowDetail: (id: string) => void;
  onUseAlternative: (alt: Alternative) => void;
  /** Pakai pintu yang disarankan: cari ulang dengan pintu itu. */
  onUseGate?: (role: GateChoice["role"], gateId: string) => void;
  onShowMap: () => void;
}) {
  const { stationById, lineById, positionOf } = useNetwork();
  const plan = planForOption(full, selected);
  const { route } = plan;
  const first = route.legs.find((l) => l.type === "RIDE" && l.departureAt);
  const last = [...route.legs].reverse().find((l) => l.type === "RIDE" && l.arrivalAt);
  const roughTimes = route.legs.some((l) => l.scheduleEstimated);
  // Jam yang jatuh setelah hari keberangkatan (mis. kereta pertama besok pagi) diberi tanda "+1 hari".
  const dayShift = (iso: string) => (plan.departAt && wibDate(iso) > wibDate(plan.departAt) ? " (+1 hari)" : "");
  const assessmentOf = (id: string) => plan.assessments.find((a) => a.stationId === id) ?? { stationId: id, score: 0, adequate: false, dataAvailable: false };
  const name = (id: string) => stationById(id)?.name ?? route.stopNames?.[id] ?? id;
  // Backend juga menyalin pengumuman ke `warnings` (untuk klien lama); di sini cukup tampil sebagai pengumuman.
  const noticeTexts = new Set((plan.notices ?? []).map((n) => `${n.title}${/[.!?:]$/.test(n.title) ? "" : ":"} ${n.message}`));

  return (
    <div className="flex flex-col gap-4">
      {plan.fromCache && (
        <p className="banner banner-info" role="status">
          <span aria-hidden>ⓘ</span> Sumber data sedang tidak dapat dihubungi. Menampilkan data tersimpan terakhir ({plan.fromCache}).
        </p>
      )}

      {full.options && full.options.length > 1 && (
        <RouteOptions options={full.options} selected={selected} onSelect={onSelect} />
      )}

      <section aria-labelledby="ringkasan" className="card">
        <h3 id="ringkasan" className="card-title">
          Ringkasan
        </h3>
        {plan.departAt && (
          <p className="mb-2 text-sm">
            <span aria-hidden>🗓</span> {plan.departMode === "at" ? <>Berangkat <b>{dayClock(plan.departAt)}</b> WIB</> : <>Berangkat sekarang ({clock(plan.departAt)} WIB)</>}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-3">
          <Stat icon="⏱" label="Waktu tempuh" value={route.totalMinutes === null ? "Tidak tersedia" : `${route.timeEstimated ? "± " : ""}${route.totalMinutes} mnt${route.timeComplete ? "" : "*"}`} />
          <Stat icon="📏" label="Jarak" value={km(route.totalDistanceM)} />
          <Stat icon="💳" label="Tarif" value={rupiah(route.totalFare)} />
          <Stat icon="⇄" label="Transfer" value={`${route.transfers}×`} />
          {first?.departureAt && last?.arrivalAt && (
            <Stat
              icon="🕒"
              label={roughTimes ? "Berangkat – tiba (jadwal & perkiraan)" : "Berangkat – tiba (jadwal)"}
              value={`${roughTimes ? "± " : ""}${clock(first.departureAt)}${dayShift(first.departureAt)} – ${clock(last.arrivalAt)}${dayShift(last.arrivalAt)}`}
            />
          )}
        </dl>
        {!route.timeComplete && <p className="mt-2 text-sm text-[var(--muted)]">* Total belum lengkap karena ada ruas tanpa data waktu tempuh.</p>}
        {route.timeEstimated && <p className="mt-2 text-sm text-[var(--muted)]">± Waktu TransJakarta adalah perkiraan dari jadwal GTFS Transjakarta. Total waktu tempuh belum termasuk menunggu bus; jam berangkat bus sudah memperkirakan waktu tunggu rata-rata, belum termasuk kemacetan.</p>}
      </section>

      <section aria-labelledby="notifikasi" className="card border-l-4 border-l-[var(--accent)]">
        <h3 id="notifikasi" className="card-title">
          <span aria-hidden>🔔</span> Notifikasi
        </h3>
        <p className="leading-relaxed">{plan.notification.text}</p>
      </section>

      {plan.notices && plan.notices.length > 0 && (
        <section aria-labelledby="pengumuman" className="flex flex-col gap-2">
          <h3 id="pengumuman" className="sr-only">
            Pengumuman
          </h3>
          {plan.notices.map((n) => (
            <NoticeBanner key={n.id} notice={n} />
          ))}
        </section>
      )}

      {plan.warnings.filter((w) => !noticeTexts.has(w)).map((w) => (
        <p key={w} className="banner banner-warn">
          <span aria-hidden>⚠</span> {w}
        </p>
      ))}

      <section aria-labelledby="rute" className="card">
        <div className="flex items-center justify-between">
          <h3 id="rute" className="card-title">
            Rute
          </h3>
          <button className="btn btn-link md:hidden" onClick={onShowMap}>
            Lihat di peta ↑
          </button>
        </div>
        <ol className="timeline">
          {route.legs.map((leg, i) => {
            const start = leg.stops[0];
            const line = leg.lineId ? lineById(leg.lineId) : null;
            // Kartu alternatif tampil sekali, pada ruas transfer pertama yang melibatkan stasiun yang kurang aksesibel.
            const alts = plan.alternatives.filter(
              (a) => route.legs.findIndex((l) => l.type === "TRANSFER" && l.stops.includes(a.replacesStationId)) === i,
            );
            return (
              <li key={i} className="timeline-item" style={{ ["--leg" as string]: line?.color ?? "var(--muted)" }} data-type={leg.type}>
                <StopRow
                  id={start}
                  name={name(start)}
                  label={i === 0 ? "Berangkat" : leg.type === "TRANSFER" ? "Transfer" : undefined}
                  a={assessmentOf(start)}
                  onShowDetail={onShowDetail}
                  onUseGate={onUseGate}
                />
                <div className="leg-body">
                  {leg.type === "RIDE" ? (
                    <>
                      <p className="font-semibold">
                        {modeIcon(line?.mode ?? leg.mode ?? "RAIL")} {line ? `${line.operator} · ${line.name}` : leg.lineId}
                      </p>
                      {leg.headsign && <p className="text-sm">Arah {leg.headsign}</p>}
                      {leg.departureAt && leg.arrivalAt && (
                        <p className="text-sm">
                          <span aria-hidden>🕒</span> {leg.scheduleEstimated ? "Berangkat sekitar" : "Berangkat"} <b>{clock(leg.departureAt)}</b>
                          {dayShift(leg.departureAt)}, tiba {leg.scheduleEstimated ? "sekitar " : ""}
                          <b>{clock(leg.arrivalAt)}</b>
                          {dayShift(leg.arrivalAt)}
                          {leg.tripNumber ? <span className="text-[var(--muted)]"> · perjalanan {leg.tripNumber}</span> : null}
                          {leg.scheduleEstimated && leg.waitMinutes ? <span className="text-[var(--muted)]"> · menunggu ± {leg.waitMinutes} mnt</span> : null}
                          {leg.nextDayService ? <span className="text-[var(--muted)]"> · layanan malam itu sudah berakhir</span> : null}
                        </p>
                      )}
                      {leg.changeAt && (
                        <p className="text-sm">
                          <span aria-hidden>🔁</span> Ganti kereta di <b>{name(leg.changeAt)}</b>
                          {leg.changeDepartureAt ? (
                            <>
                              , kereta sambungan berangkat <b>{clock(leg.changeDepartureAt)}</b>
                            </>
                          ) : null}
                        </p>
                      )}
                      <p className="text-sm text-[var(--muted)]">
                        {leg.stops.length - 1} pemberhentian · {km(leg.distanceM)} · {leg.minutes === null ? "waktu tidak tersedia" : leg.minutesEstimated ? `± ${leg.minutes} mnt (perkiraan jadwal)` : `${leg.minutes} mnt`} · {rupiah(leg.fare)}
                      </p>
                      {(leg.boardAt || leg.platform) && (
                        <div className="mt-1 text-sm">
                          <p>
                            <span aria-hidden>🚉</span> Naik dari <b>{leg.boardAt?.name || `peron ${leg.boardAt?.code ?? leg.platform}`}</b>
                          </p>
                          {leg.boardAt && <PlatformDetails p={leg.boardAt} compact station={stationById(start)?.amenities} />}
                        </div>
                      )}
                      <RideChoices leg={leg} />
                      {leg.stops.length > 2 && (
                        <details className="mt-1 text-sm">
                          <summary className="cursor-pointer">Lewati {leg.stops.length - 2} stasiun</summary>
                          <ul className="ml-4 mt-1 list-disc">
                            {leg.stops.slice(1, -1).map((s) => (
                              <li key={s}>
                                {name(s)} <AccessBadge a={assessmentOf(s)} compact />
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </>
                  ) : (
                    <p className="text-sm">
                      {leg.turnaround ? (
                        <>
                          ↩ Berbalik arah di <b>{name(leg.stops[0])}</b>: pindah ke bus arah sebaliknya
                        </>
                      ) : leg.stops[0] === leg.stops[1] ? (
                        <>
                          ⇄ Pindah lini di dalam stasiun ·{" "}
                          {leg.minutes === null ? "waktu tidak tersedia" : leg.includesWait ? `±${leg.minutes} mnt termasuk menunggu kereta berikutnya` : `${leg.minutes} mnt`}
                        </>
                      ) : (
                        <>
                          🚶 Jalan kaki di dalam hub ke <b>{name(leg.stops[1])}</b> · {km(leg.distanceM)} ·{" "}
                          {leg.minutes === null ? "waktu tidak tersedia" : `${leg.minutes} mnt`}
                        </>
                      )}
                    </p>
                  )}
                  {leg.type === "TRANSFER" && <TransferHints leg={leg} name={name} />}
                  {leg.stops.some((s) => !positionOf(s)) && (
                    <p className="mt-1 text-xs text-[var(--muted)]">ⓘ Sebagian pemberhentian pada ruas ini belum ada di peta.</p>
                  )}
                  {alts.map((alt) => (
                    <AlternativeCard key={alt.viaStationId} alt={alt} weak={assessmentOf(alt.replacesStationId)} onUse={onUseAlternative} />
                  ))}
                </div>
              </li>
            );
          })}
          <li className="timeline-item timeline-end">
            <StopRow id={plan.destinationId} label="Tiba" a={assessmentOf(plan.destinationId)} onShowDetail={onShowDetail} onUseGate={onUseGate} />
          </li>
        </ol>
      </section>

      <footer className="text-sm text-[var(--muted)]">
        <p>
          <span aria-hidden>⚠</span> {plan.disclaimer}
        </p>
        <p className="mt-1">{plan.attribution ?? "Data © Commute Data API, Shiori Labs (ODbL-1.0)."}</p>
      </footer>
    </div>
  );
}

const freqText = (f: Frequency) => `biasanya tiap ±${f.headwayMinutes} mnt${f.serviceHours ? ` (beroperasi ${f.serviceHours})` : ""}`;

/** Pilihan rute gaya TfL: jam, durasi, urutan moda, dan skor aksesibilitas tiap pilihan. */
function RouteOptions({ options, selected, onSelect }: { options: RouteOption[]; selected: number; onSelect?: (i: number) => void }) {
  const { lineById } = useNetwork();
  return (
    <section aria-labelledby="pilihan-rute" className="flex flex-col gap-2">
      <h3 id="pilihan-rute" className="card-title mb-0">
        Pilihan rute
      </h3>
      <ul className="flex flex-col gap-2">
        {options.map((o, i) => {
          const s = o.summary;
          const on = i === selected;
          // Durasi dari jam berangkat sampai tiba (termasuk jalan kaki dan menunggu) bila jadwal diketahui.
          const span = s.departureAt && s.arrivalAt ? Math.round((Date.parse(s.arrivalAt) - Date.parse(s.departureAt)) / 60_000) : null;
          const total = span ?? s.minutes;
          return (
            <li key={i}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onSelect?.(i)}
                className={`card w-full text-left ${on ? "border-2 border-[var(--accent)]" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-1">
                  {(o.kinds.length ? o.kinds.map((k) => KIND_LABEL[k]) : ["Rute lain"]).map((k) => (
                    <span key={k} className={`badge ${k === "Paling aksesibel" ? "badge-ok" : "badge-unknown"}`}>
                      {k}
                    </span>
                  ))}
                  {on && <span className="sr-only">(dipilih)</span>}
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-2">
                  <span className="font-semibold">{s.departureAt && s.arrivalAt ? `${clock(s.departureAt)} – ${clock(s.arrivalAt)}` : s.departureAt ? `Berangkat ${clock(s.departureAt)}` : "Jam belum tersedia"}</span>
                  <span className="text-xl font-extrabold">{total === null ? "–" : duration(total)}</span>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-1 text-sm" aria-label="Urutan perjalanan">
                  {o.route.legs.map((l, j) => {
                    const line = l.lineId ? lineById(l.lineId) : undefined;
                    return (
                      <span key={j} className="inline-flex items-center gap-1">
                        {j > 0 && <span aria-hidden className="text-[var(--muted)]">›</span>}
                        {l.type === "RIDE" ? (
                          <span className="inline-flex items-center gap-1">
                            <span aria-hidden>{modeIcon(line?.mode ?? l.mode ?? "RAIL")}</span>
                            <span className="rounded px-1 text-xs font-bold text-white" style={{ background: line?.color ?? "var(--muted)" }}>
                              {line?.name ?? l.lineId}
                            </span>
                          </span>
                        ) : (
                          <span aria-label={l.stops[0] === l.stops[l.stops.length - 1] ? "pindah lini" : "jalan kaki"}>{l.stops[0] === l.stops[l.stops.length - 1] ? "⇄" : "🚶"}</span>
                        )}
                      </span>
                    );
                  })}
                </p>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Aksesibilitas {s.accessScore}/100 · {s.transfers}× pindah
                  {s.unmetNeeds ? ` · ${s.unmetNeeds} kebutuhan fasilitas belum terpenuhi` : ""}
                  {s.usesAvoidedModes ? " · memakai moda yang dihindari" : ""}
                </p>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Lin paralel yang bisa dinaiki (pemberhentian dan tarif sama) dan frekuensi bila jadwal tidak tersedia. */
function RideChoices({ leg }: { leg: RouteLeg }) {
  const { lineById } = useNetwork();
  const options = leg.options && leg.options.length > 1 ? leg.options : null;
  if (!options && !leg.frequency) return null;
  return (
    <div className="mt-1 text-sm">
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
      {leg.frequency && leg.frequency.source === "TIMETABLE" ? (
        <p className="mt-1 text-[var(--muted)]">
          <span aria-hidden>🕒</span> Menurut jadwal Commute, kereta ke tujuan ruas ini {freqText(leg.frequency)}.
        </p>
      ) : leg.frequency ? (
        <p className="mt-1 text-[var(--muted)]">
          <span aria-hidden>🕒</span> Jadwal tetap tidak tersedia; {options ? "gabungan semua pilihan " : ""}
          {freqText(leg.frequency)}. Bukan jadwal pasti.
        </p>
      ) : null}
    </div>
  );
}

const exitText = (e: ExitRef) => `${e.name ?? e.ref}${e.signs?.length ? ` (ikuti tanda ${e.signs.join(", ")})` : ""}`;
const ACCESS_TEXT = { available: "tersedia", absent: "tidak tercatat", unknown: "belum ada data", out_of_service: "tidak berfungsi" } as const;
/** Lift pada ruas yang pindah lantai di jalur lewat concourse. */
const PATH_LIFT_TEXT = {
  available: "ada lift di jalur ini",
  absent: "tidak ada lift di jalur ini",
  unknown: "data lift di jalur ini belum ada",
  out_of_service: "lift di jalur ini sedang tidak berfungsi",
} as const;

/** Petunjuk jalan kaki dan status fasilitas yang dibutuhkan pengguna di titik pindah. */
function TransferHints({ leg, name }: { leg: RouteLeg; name: (id: string) => string }) {
  const lines = [
    leg.fromExit && `Keluar lewat ${exitText(leg.fromExit)}.`,
    leg.notes,
    leg.toExit && `Masuk lewat ${exitText(leg.toExit)}.`,
  ].filter((x): x is string => !!x);
  if (!lines.length && !leg.access?.length) return null;
  return (
    <div className="mt-1 text-sm">
      {lines.map((l) => (
        <p key={l} className="text-[var(--muted)]">
          <span aria-hidden>➜</span> {l}
        </p>
      ))}
      {leg.access && leg.access.length > 0 && (
        <ul className="mt-1" aria-label="Fasilitas untuk pindah">
          {leg.access.map((a) => (
            <li key={`${a.stationId}-${a.need}-${a.platform ?? ""}`} className={a.status === "available" || a.notNeeded ? "" : "text-[var(--warn)]"}>
              <span aria-hidden>{a.status === "available" || a.notNeeded ? "✔" : "⚠"}</span> {AMENITY_LABEL[a.need]} di {name(a.stationId)}
              {a.platform ? ` (peron ${a.platform})` : ""}:{" "}
              {a.notNeeded
                ? `tidak dibutuhkan, peron dicapai ${accessText(a.notNeeded)}`
                : ACCESS_TEXT[a.status]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--surface-2)] p-3">
      <dt className="text-xs text-[var(--muted)]">
        <span aria-hidden>{icon}</span> {label}
      </dt>
      <dd className="text-lg font-bold">{value}</dd>
    </div>
  );
}

function StopRow({
  id,
  name,
  label,
  a,
  onShowDetail,
  onUseGate,
}: {
  id: string;
  name?: string;
  label?: string;
  a: JourneyPlan["assessments"][number];
  onShowDetail: (id: string) => void;
  onUseGate?: (role: GateChoice["role"], gateId: string) => void;
}) {
  const stationName = useNetwork().stationById(id)?.name ?? name ?? id;
  // Catatan dari tim NTD, mis. lift sedang tidak berfungsi.
  const notes = a.dataAvailable ? (a.notes ?? []).filter((n) => !(a.journey && n.startsWith("Skor perjalanan"))) : [];
  const j = a.journey;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="stop-dot" aria-hidden />
      <button className="btn-link text-left font-bold" onClick={() => onShowDetail(id)} aria-label={`${stationName}, lihat fasilitas`}>
        {stationName}
      </button>
      {label && <span className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</span>}
      <AccessBadge a={a} />
      {j && (
        <p className={`w-full text-sm ${j.level || j.pathLift === "available" ? "text-[var(--muted)]" : "text-[var(--warn)]"}`}>
          <span aria-hidden>{j.level ? "↔" : "↕"}</span> Peron {j.platforms.join(", ")} {accessText(j)}
          {j.gate ? ` (${j.gate})` : ""}
          {j.level ? ", lift dan eskalator tidak dibutuhkan" : j.pathLift ? `, ${PATH_LIFT_TEXT[j.pathLift]}` : ", lift dan eskalator dibutuhkan"} · skor stasiun {j.stationScore}
        </p>
      )}
      {a.gateChoice && <GateAdvice g={a.gateChoice} onUseGate={onUseGate} />}
      {notes.map((n) => (
        <p key={n} className="w-full text-sm text-[var(--warn)]">
          <span aria-hidden>ⓘ</span> {n}
        </p>
      ))}
    </div>
  );
}

/** Pintu masuk/keluar pilihan pengguna, dengan saran pintu lain bila fasilitasnya kurang. */
function GateAdvice({ g, onUseGate }: { g: GateChoice; onUseGate?: (role: GateChoice["role"], gateId: string) => void }) {
  return (
    <div className={`w-full text-sm ${g.recommended ? "text-[var(--warn)]" : "text-[var(--muted)]"}`}>
      <p>
        <span aria-hidden>🚪</span> {g.role === "masuk" ? "Masuk" : "Keluar"} lewat <b>{g.chosen}</b>
        {g.recommended ? ` (${g.reason ?? "kurang aksesibel"})` : g.known ? "" : " (jalur ke peron belum didata)"}
      </p>
      {g.recommended && g.recommendedId && (
        <p className="mt-1">
          Disarankan {g.role} lewat <b>{g.recommended}</b>
          {g.recommendedVia ? ` (${g.recommendedVia})` : ""}.{" "}
          {onUseGate && (
            <button className="btn-link" onClick={() => onUseGate(g.role, g.recommendedId!)}>
              Pakai {g.recommended}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

function AlternativeCard({ alt, weak, onUse }: { alt: Alternative; weak: JourneyPlan["assessments"][number]; onUse: (a: Alternative) => void }) {
  const { stationById, hubById } = useNetwork();
  const via = stationById(alt.viaStationId);
  const weakSt = stationById(alt.replacesStationId);
  const amen = Object.entries(via?.amenities ?? {}) as [AmenityType, string][];
  return (
    <div className="mt-2 rounded-lg border-2 border-dashed border-[var(--warn)] p-3">
      <p className="text-sm">
        <span aria-hidden>⚠</span> Transfer di <b>{weakSt?.name ?? alt.replacesStationId}</b> perlu perhatian (skor {weak.score}).
      </p>
      <p className="mt-2 text-sm font-semibold">Alternatif di Hub {hubById(alt.hubId)?.name}:</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="font-bold">Via {via?.name ?? alt.viaStationId}</span>
        <AccessBadge a={alt.assessment} />
      </div>
      <p className="mt-1 text-xs text-[var(--muted)]">
        {amen
          .filter(([, v]) => v === "available")
          .map(([k]) => `${AMENITY_LABEL[k]} ✔`)
          .join(" · ")}
      </p>
      <button className="btn btn-secondary mt-2" onClick={() => onUse(alt)}>
        Pakai rute ini
      </button>
    </div>
  );
}

function modeIcon(mode: string) {
  return mode === "SUBWAY" ? "🚇" : mode === "TRAM" ? "🚈" : mode === "BUS" ? "🚌" : "🚆";
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
