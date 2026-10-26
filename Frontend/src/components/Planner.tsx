"use client";

import { useEffect, useRef, useState } from "react";
import { fetchNotices, planJourney } from "@/lib/api";
import { useNetwork } from "@/lib/network";
import type { Alternative, JourneyPlan, Mode, Notice, TransferNeed } from "@/lib/types";
import { AboutDialog, SettingsDialog, StationDetail, type DisplaySettings } from "./Dialogs";
import { NoticeBanner, ResultPanel } from "./ResultPanel";
import { StationCombobox } from "./StationCombobox";
import { TransitMap } from "./TransitMap";

type Phase =
  | { kind: "idle" }
  | { kind: "loading"; step: number }
  | { kind: "result"; plan: JourneyPlan }
  | { kind: "error"; code: string; message: string };

const ERROR_TITLE: Record<string, string> = {
  NOT_FOUND: "Rute tidak ditemukan",
  INVALID: "Input tidak valid",
  API_DOWN: "Data belum bisa dimuat",
  NETWORK: "Server tidak dapat dihubungi",
  RATE_LIMITED: "Terlalu banyak permintaan",
};
const RETRYABLE = ["API_DOWN", "NETWORK", "RATE_LIMITED", "INTERNAL"];

const STEPS = ["Mencari rute", "Memeriksa fasilitas stasiun", "Mencari alternatif transfer", "Menyusun ringkasan"];
const SETTINGS_KEY = "ntd-display";
const DEFAULT_SETTINGS: DisplaySettings = { textSize: 0, highContrast: false, reduceMotion: false };

function loadSettings(): DisplaySettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const MODE_ORDER: Mode[] = ["RAIL", "SUBWAY", "TRAM", "BUS", "MONORAIL"];
const MODE_LABEL: Record<Mode, string> = { RAIL: "KRL", SUBWAY: "MRT", TRAM: "LRT", BUS: "TransJakarta", MONORAIL: "Kalayang" };
const NEED_LABEL: Record<TransferNeed, string> = { lift: "Lift", eskalator: "Eskalator", ramp: "Ramp" };

export function Planner() {
  const { stationById, lineById, hubById, meta, lines } = useNetwork();
  // Moda yang ada di jaringan, urut tetap agar pilihan tidak berpindah tempat.
  const modes = MODE_ORDER.filter((m) => lines.some((l) => l.mode === m));
  const [avoidModes, setAvoidModes] = useState<Mode[]>([]);
  // Fasilitas yang wajib ada di titik pindah; Backend mencari transfer lain bila tidak terpenuhi.
  const [needs, setNeeds] = useState<TransferNeed[]>([]);
  const noticeTarget = (n: Notice) =>
    n.scope === "station" ? stationById(n.targetId ?? "")?.name : n.scope === "line" ? lineById(n.targetId ?? "")?.name : n.scope === "hub" ? `Hub ${hubById(n.targetId ?? "")?.name ?? n.targetId}` : undefined;
  const [origin, setOrigin] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<DisplaySettings>(DEFAULT_SETTINGS);
  const [notices, setNotices] = useState<Notice[]>([]);
  const runId = useRef(0);
  const mapRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = loadSettings();
    if (saved !== DEFAULT_SETTINGS) queueMicrotask(() => setSettings(saved));
  }, []);

  // Pengumuman aktif dari tim NTD, dimuat ulang setiap kembali ke layar awal agar perubahan dari admin cepat terlihat.
  useEffect(() => {
    if (phase.kind !== "idle") return;
    let alive = true;
    fetchNotices().then((r) => alive && r.status === "ok" && setNotices(r.data));
    return () => {
      alive = false;
    };
  }, [phase.kind]);

  useEffect(() => {
    const html = document.documentElement;
    html.style.fontSize = ["100%", "112.5%", "125%"][settings.textSize];
    html.dataset.contrast = settings.highContrast ? "high" : "normal";
    html.dataset.motion = settings.reduceMotion ? "reduce" : "normal";
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* penyimpanan tidak tersedia: abaikan */
    }
  }, [settings]);

  const sameStation = origin !== null && origin === destination;
  const canSearch = origin !== null && destination !== null && !sameStation;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, settings.reduceMotion ? 0 : ms));

  async function search(avoid: string[] = []) {
    if (!origin || !destination) return;
    const id = ++runId.current;
    // Permintaan ke Backend berjalan sejak awal; langkah di layar hanya penanda kemajuan.
    const request = planJourney(origin, destination, { avoid, avoidModes, needs });
    let done = false;
    request.finally(() => (done = true));
    for (let step = 0; step < STEPS.length - 1 && !done; step++) {
      setPhase({ kind: "loading", step });
      await wait(300);
      if (runId.current !== id) return;
    }
    setPhase({ kind: "loading", step: STEPS.length - 1 });
    const res = await request;
    if (runId.current !== id) return;
    setPhase(res.status === "ok" ? { kind: "result", plan: res.data } : { kind: "error", code: res.code, message: res.message });
    requestAnimationFrame(() => resultRef.current?.focus());
  }

  const reset = () => {
    runId.current++;
    setPhase({ kind: "idle" });
  };

  const chooseOrigin = (id: string | null) => {
    setOrigin(id);
    if (phase.kind !== "idle") reset();
  };
  const chooseDestination = (id: string | null) => {
    setDestination(id);
    if (phase.kind !== "idle") reset();
  };

  const plan = phase.kind === "result" ? phase.plan : null;

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-2">
          <p className="flex items-center gap-2 text-xl font-extrabold">
            <span aria-hidden className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--accent)] text-white">
              ♿
            </span>
            NTD
            <span className="hidden text-sm font-normal text-[var(--muted)] sm:inline">Navigasi Transportasi Umum Aksesibel</span>
          </p>
          <nav className="flex gap-1" aria-label="Menu">
            <button className="icon-btn" aria-label="Pengaturan tampilan" onClick={() => setSettingsOpen(true)}>
              Aa
            </button>
            <button className="icon-btn" aria-label="Tentang NTD" onClick={() => setAboutOpen(true)}>
              ⓘ
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-7xl flex-1 content-start gap-4 px-4 py-4 md:grid-cols-[400px_1fr] md:grid-rows-[auto_1fr]">
        {/* Urutan DOM: form, peta, hasil (mobile). Desktop: form dan hasil di kiri, peta di kanan. */}
          <section aria-labelledby="judul-form" className="card md:col-start-1 md:row-start-1">
            <h1 id="judul-form" className="mb-3 text-xl font-bold">
              Rencanakan perjalanan aksesibel
            </h1>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSearch) search();
              }}
            >
              <StationCombobox label="Dari" marker="●" value={origin} onChange={chooseOrigin} />
              <button
                type="button"
                className="btn btn-link self-center"
                aria-label="Tukar asal dan tujuan"
                onClick={() => {
                  setOrigin(destination);
                  setDestination(origin);
                  if (phase.kind !== "idle") reset();
                }}
              >
                ⇅ Tukar
              </button>
              <StationCombobox label="Ke" marker="◆" value={destination} onChange={chooseDestination} />
              {sameStation && (
                <p className="text-sm text-[var(--bad)]" role="alert">
                  Asal dan tujuan tidak boleh sama.
                </p>
              )}
              {modes.length > 1 && (
                <fieldset className="mt-2">
                  <legend className="mb-1 font-semibold">Moda yang dipakai</legend>
                  <div className="flex flex-wrap gap-2">
                    {modes.map((m) => {
                      const on = !avoidModes.includes(m);
                      return (
                        <label key={m} className={`mode-chip ${on ? "mode-chip-on" : ""}`}>
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={on}
                            onChange={() => {
                              setAvoidModes((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
                              if (phase.kind !== "idle") reset();
                            }}
                          />
                          <span aria-hidden>{on ? "✓" : "✕"}</span> {MODE_LABEL[m]}
                        </label>
                      );
                    })}
                  </div>
                  {avoidModes.length > 0 && (
                    <p className="mt-1 text-sm text-[var(--muted)]">Rute akan menghindari {avoidModes.map((m) => MODE_LABEL[m]).join(", ")} bila memungkinkan.</p>
                  )}
                </fieldset>
              )}
              <fieldset className="mt-2">
                <legend className="mb-1 font-semibold">Butuh fasilitas saat pindah</legend>
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(NEED_LABEL) as TransferNeed[]).map((n) => {
                    const on = needs.includes(n);
                    return (
                      <label key={n} className={`mode-chip ${on ? "mode-chip-on" : ""}`}>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={on}
                          onChange={() => {
                            setNeeds((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]));
                            if (phase.kind !== "idle") reset();
                          }}
                        />
                        <span aria-hidden>{on ? "✓" : "+"}</span> {NEED_LABEL[n]}
                      </label>
                    );
                  })}
                </div>
                {needs.length > 0 && (
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    Titik pindah dipilih yang punya {needs.map((n) => NEED_LABEL[n].toLowerCase()).join(" dan ")} bila memungkinkan.
                  </p>
                )}
              </fieldset>
              <button type="submit" className="btn btn-primary mt-2 min-h-14 text-lg" disabled={!canSearch || phase.kind === "loading"}>
                Cari Rute
              </button>
              <p className="text-sm text-[var(--muted)]">Atau tekan pemberhentian di peta.</p>
            </form>
          </section>

        {/* Peta transit */}
        <div ref={mapRef} className="scroll-mt-16 md:sticky md:top-20 md:col-start-2 md:row-span-2 md:row-start-1 md:self-start">
          <TransitMap
            originId={origin}
            destinationId={destination}
            route={plan?.route ?? null}
            onSetOrigin={chooseOrigin}
            onSetDestination={chooseDestination}
            onShowDetail={setDetailId}
          />
        </div>

          <div id="hasil" ref={resultRef} tabIndex={-1} aria-live="polite" className="outline-none md:col-start-1 md:row-start-2">
            {phase.kind === "idle" && notices.length > 0 && (
              <section aria-label="Pengumuman" className="mb-3 flex flex-col gap-2">
                {[...notices]
                  .sort((a, b) => (a.scope === "global" ? 0 : 1) - (b.scope === "global" ? 0 : 1))
                  .map((n) => (
                    <NoticeBanner key={n.id} notice={n} target={noticeTarget(n)} />
                  ))}
              </section>
            )}

            {phase.kind === "idle" && (
              <p className="banner banner-muted">
                <span aria-hidden>ⓘ</span> Cakupan saat ini: hub Sudirman–Dukuh Atas–BNI City. Data fasilitas bersifat statis, bukan kondisi
                real-time. Coba: <b>Manggarai → Bundaran HI Bank Jakarta</b> atau <b>Jakarta Kota → Kuningan (LRT)</b>.
              </p>
            )}

            {phase.kind === "loading" && (
              <section className="card" aria-label="Sedang memuat">
                <p className="mb-2 font-semibold">
                  {stationById(origin!)?.name} → {stationById(destination!)?.name}
                </p>
                <ol className="flex flex-col gap-1">
                  {STEPS.map((s, i) => (
                    <li key={s} className={i > phase.step ? "text-[var(--muted)]" : ""}>
                      <span aria-hidden className={i === phase.step ? "spin inline-block" : ""}>
                        {i < phase.step ? "✔" : i === phase.step ? "◌" : "○"}
                      </span>{" "}
                      {s}
                      {i === phase.step ? "…" : ""}
                    </li>
                  ))}
                </ol>
                <button className="btn btn-secondary mt-3" onClick={reset}>
                  Batalkan
                </button>
              </section>
            )}

            {phase.kind === "error" && (
              <section className="card border-l-4 border-l-[var(--bad)]" role="alert">
                <h2 className="text-lg font-bold">
                  <span aria-hidden>✖</span> {ERROR_TITLE[phase.code] ?? "Terjadi kesalahan"}
                </h2>
                <p className="mt-1">{phase.message}</p>
                {phase.code === "NOT_FOUND" && <p className="mt-1 text-sm text-[var(--muted)]">NTD baru mencakup hub Dukuh Atas. Coba stasiun lain di hub yang sama.</p>}
                <div className="mt-3 flex gap-2">
                  {RETRYABLE.includes(phase.code) && (
                    <button className="btn btn-primary" onClick={() => search()}>
                      Coba lagi
                    </button>
                  )}
                  <button className="btn btn-secondary" onClick={reset}>
                    Ubah pencarian
                  </button>
                </div>
              </section>
            )}

            {plan && (
              <ResultPanel
                plan={plan}
                onShowDetail={setDetailId}
                onUseAlternative={(alt: Alternative) => search(alt.avoid)}
                onShowMap={() => mapRef.current?.scrollIntoView({ behavior: settings.reduceMotion ? "auto" : "smooth" })}
              />
            )}
          </div>
      </main>

      <footer className="border-t border-[var(--border)] px-4 py-3 text-center text-xs text-[var(--muted)]">
        ⚠ Data fasilitas bersifat statis, bukan kondisi real-time · {meta?.attribution ?? "Data © Commute Data API (ODbL-1.0)"}
      </footer>

      <StationDetail stationId={detailId} onClose={() => setDetailId(null)} onSetOrigin={chooseOrigin} onSetDestination={chooseDestination} />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} value={settings} onChange={setSettings} />
    </div>
  );
}

/** Tampilan sementara saat data jaringan dari Backend sedang dimuat atau gagal dimuat. */
export function NetworkStatus({ error, retry }: { error?: string; retry: () => void }) {
  return (
    <main className="grid min-h-full place-items-center p-4">
      <section className="card w-full max-w-md text-center" role={error ? "alert" : "status"} aria-live="polite">
        <p className="mb-2 text-xl font-extrabold">NTD</p>
        {error ? (
          <>
            <p className="font-semibold">Data stasiun belum bisa dimuat.</p>
            <p className="mt-1 text-sm text-[var(--muted)]">{error}</p>
            <button className="btn btn-primary mt-3" onClick={retry}>
              Coba lagi
            </button>
          </>
        ) : (
          <p>
            <span aria-hidden className="spin inline-block">
              ◌
            </span>{" "}
            Memuat data stasiun…
          </p>
        )}
      </section>
    </main>
  );
}
