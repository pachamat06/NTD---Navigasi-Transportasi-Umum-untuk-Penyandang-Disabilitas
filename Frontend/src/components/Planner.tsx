"use client";

import { useEffect, useRef, useState } from "react";
import { stationById } from "@/lib/dummy-data";
import { planJourney } from "@/lib/mock-planner";
import type { Alternative, JourneyPlan } from "@/lib/types";
import { AboutDialog, SettingsDialog, StationDetail, type DisplaySettings } from "./Dialogs";
import { ResultPanel } from "./ResultPanel";
import { StationCombobox } from "./StationCombobox";
import { TransitMap } from "./TransitMap";

type Phase =
  | { kind: "idle" }
  | { kind: "loading"; step: number }
  | { kind: "result"; plan: JourneyPlan }
  | { kind: "error"; code: string; message: string };

const STEPS = ["Mencari rute", "Memeriksa fasilitas stasiun", "Mencari alternatif transfer", "Menyusun ringkasan"];
const SETTINGS_KEY = "ntd-display";
const DEFAULT_SETTINGS: DisplaySettings = { textSize: 0, highContrast: false, reduceMotion: false, demoMode: "normal" };

function loadSettings(): DisplaySettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw), demoMode: "normal" } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function Planner() {
  const [origin, setOrigin] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<DisplaySettings>(DEFAULT_SETTINGS);
  const runId = useRef(0);
  const mapRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = loadSettings();
    if (saved !== DEFAULT_SETTINGS) queueMicrotask(() => setSettings(saved));
  }, []);

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
    for (let step = 0; step < STEPS.length; step++) {
      setPhase({ kind: "loading", step });
      await wait(450);
      if (runId.current !== id) return;
    }
    const res = await planJourney(origin, destination, { avoid, demoMode: settings.demoMode });
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
                  <span aria-hidden>✖</span> {phase.code === "NOT_FOUND" ? "Rute tidak ditemukan" : phase.code === "API_DOWN" ? "Data belum bisa dimuat" : "Input tidak valid"}
                </h2>
                <p className="mt-1">{phase.message}</p>
                {phase.code === "NOT_FOUND" && <p className="mt-1 text-sm text-[var(--muted)]">NTD baru mencakup hub Dukuh Atas. Coba stasiun lain di hub yang sama.</p>}
                <div className="mt-3 flex gap-2">
                  {phase.code === "API_DOWN" && (
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
        ⚠ Data fasilitas bersifat statis, bukan kondisi real-time · Data © Commute Data API (ODbL-1.0)
      </footer>

      <StationDetail stationId={detailId} onClose={() => setDetailId(null)} onSetOrigin={chooseOrigin} onSetDestination={chooseDestination} />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} value={settings} onChange={setSettings} />
    </div>
  );
}
