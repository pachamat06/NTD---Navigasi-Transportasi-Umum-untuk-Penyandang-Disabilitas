"use client";

import { AMENITY_LABEL, useNetwork } from "@/lib/network";
import type { Alternative, AmenityType, JourneyPlan, Notice } from "@/lib/types";
import { AccessBadge } from "./AccessBadge";

const km = (m: number) => `${(m / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} km`;
const rupiah = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;

/** Hasil Rute dan Status Aksesibilitas (UC-03, UC-04, UC-05, UC-06, UC-07). */
export function ResultPanel({
  plan,
  onShowDetail,
  onUseAlternative,
  onShowMap,
}: {
  plan: JourneyPlan;
  onShowDetail: (id: string) => void;
  onUseAlternative: (alt: Alternative) => void;
  onShowMap: () => void;
}) {
  const { stationById, lineById, positionOf } = useNetwork();
  const { route } = plan;
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

      <section aria-labelledby="ringkasan" className="card">
        <h3 id="ringkasan" className="card-title">
          Ringkasan
        </h3>
        <dl className="grid grid-cols-2 gap-3">
          <Stat icon="⏱" label="Waktu tempuh" value={route.totalMinutes === null ? "Tidak tersedia" : `${route.totalMinutes} mnt${route.timeComplete ? "" : "*"}`} />
          <Stat icon="📏" label="Jarak" value={km(route.totalDistanceM)} />
          <Stat icon="💳" label="Tarif" value={rupiah(route.totalFare)} />
          <Stat icon="⇄" label="Transfer" value={`${route.transfers}×`} />
        </dl>
        {!route.timeComplete && <p className="mt-2 text-sm text-[var(--muted)]">* Total belum lengkap karena ada ruas tanpa data waktu tempuh.</p>}
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
                />
                <div className="leg-body">
                  {leg.type === "RIDE" ? (
                    <>
                      <p className="font-semibold">
                        {modeIcon(line?.mode ?? leg.mode ?? "RAIL")} {line ? `${line.operator} · ${line.name}` : leg.lineId}
                      </p>
                      <p className="text-sm text-[var(--muted)]">
                        {leg.stops.length - 1} pemberhentian · {km(leg.distanceM)} · {leg.minutes === null ? "waktu tidak tersedia" : `${leg.minutes} mnt`} · {rupiah(leg.fare)}
                      </p>
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
                      {leg.stops[0] === leg.stops[1] ? (
                        <>⇄ Pindah lini di dalam stasiun · waktu tidak tersedia</>
                      ) : (
                        <>
                          🚶 Jalan kaki di dalam hub ke <b>{name(leg.stops[1])}</b> · {km(leg.distanceM)} ·{" "}
                          {leg.minutes === null ? "waktu tidak tersedia" : `${leg.minutes} mnt`}
                        </>
                      )}
                    </p>
                  )}
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
            <StopRow id={plan.destinationId} label="Tiba" a={assessmentOf(plan.destinationId)} onShowDetail={onShowDetail} />
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

function StopRow({ id, name, label, a, onShowDetail }: { id: string; name?: string; label?: string; a: JourneyPlan["assessments"][number]; onShowDetail: (id: string) => void }) {
  const stationName = useNetwork().stationById(id)?.name ?? name ?? id;
  // Catatan dari tim NTD, mis. lift sedang tidak berfungsi.
  const notes = a.dataAvailable ? (a.notes ?? []) : [];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="stop-dot" aria-hidden />
      <button className="btn-link text-left font-bold" onClick={() => onShowDetail(id)} aria-label={`${stationName}, lihat fasilitas`}>
        {stationName}
      </button>
      {label && <span className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</span>}
      <AccessBadge a={a} />
      {notes.map((n) => (
        <p key={n} className="w-full text-sm text-[var(--warn)]">
          <span aria-hidden>ⓘ</span> {n}
        </p>
      ))}
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
