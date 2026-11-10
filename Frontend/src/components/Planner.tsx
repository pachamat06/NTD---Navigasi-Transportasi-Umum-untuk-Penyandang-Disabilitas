"use client";

import { useEffect, useRef, useState } from "react";
import { fetchNotices, fetchStationDetail, planJourney } from "@/lib/api";
import { useNetwork } from "@/lib/network";
import type { Alternative, Entrance, GateChoice, JourneyPlan, Mode, Notice, TransferNeed } from "@/lib/types";
import { AboutDialog, SettingsDialog, StationDetail, type DisplaySettings } from "./Dialogs";
import { NoticeBanner, planForOption, ResultPanel } from "./ResultPanel";
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

const WIB = 7 * 3600_000;
const DAY = 86_400_000;
/** Tanggal (YYYY-MM-DD) dan jam (HH:MM) WIB untuk waktu `ms`. */
const wibParts = (ms: number) => {
  const iso = new Date(ms + WIB).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
};
/** Isian awal "pilih waktu": sekarang, dibulatkan ke 5 menit berikutnya (WIB). */
const nextFiveMinutes = () => wibParts(Math.ceil(Date.now() / 300_000) * 300_000);
/** Waktu ISO dari tanggal dan jam WIB pilihan pengguna; undefined bila belum lengkap. */
const departIso = (date: string, time: string) => (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) ? `${date}T${time}:00+07:00` : undefined);
/** Batas yang diterima Backend: paling awal 1 hari lalu, paling lambat 90 hari lagi. */
function departProblem(iso: string | undefined, now: number): string | null {
  if (!iso) return "Isi tanggal dan jam berangkat.";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Tanggal atau jam berangkat tidak valid.";
  if (t < now - DAY) return "Waktu berangkat paling awal kemarin.";
  if (t > now + 90 * DAY) return "Waktu berangkat paling lambat 90 hari lagi.";
  return null;
}
const longDate = (iso: string) =>
  new Date(iso).toLocaleString("id-ID", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });

export function Planner() {
  const { stationById, lineById, hubById, meta, lines } = useNetwork();
  // Moda yang ada di jaringan, urut tetap agar pilihan tidak berpindah tempat.
  const modes = MODE_ORDER.filter((m) => lines.some((l) => l.mode === m));
  const [avoidModes, setAvoidModes] = useState<Mode[]>([]);
  // Fasilitas yang wajib ada di titik pindah; Backend mencari transfer lain bila tidak terpenuhi.
  const [needs, setNeeds] = useState<TransferNeed[]>([]);
  // Waktu berangkat: sekarang, atau tanggal dan jam tertentu (WIB). Jadwal dan rute tercepat dihitung dari waktu ini.
  const [timeMode, setTimeMode] = useState<"now" | "at">("now");
  const [departDate, setDepartDate] = useState("");
  const [departTime, setDepartTime] = useState("");
  // Waktu saat pengguna terakhir mengubah pilihan waktu: acuan batas tanggal (render tidak membaca jam).
  const [timeRef, setTimeRef] = useState(0);
  const chosenAt = timeMode === "at" ? departIso(departDate, departTime) : undefined;
  const timeProblem = timeMode === "at" ? departProblem(chosenAt, timeRef) : null;
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
  // Pintu masuk (asal) dan keluar (tujuan) pilihan pengguna; kosong = otomatis (jalur paling aksesibel).
  const [entranceId, setEntranceId] = useState("");
  const [exitId, setExitId] = useState("");
  const originGates = useGates(origin);
  const destinationGates = useGates(destination);
  // Pilihan rute yang ditampilkan (0 = paling aksesibel).
  const [optionIndex, setOptionIndex] = useState(0);
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
  // Stasiun yang sudah tidak beroperasi (ditandai tim NTD) tidak bisa dipakai untuk rute.
  const closed = [origin, destination].map((id) => (id ? stationById(id) : undefined)).filter((s) => s?.inactive);
  const canSearch = origin !== null && destination !== null && !sameStation && !timeProblem && closed.length === 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, settings.reduceMotion ? 0 : ms));

  async function search(avoid: string[] = [], gates: { entranceId?: string; exitId?: string } = {}) {
    if (!origin || !destination) return;
    const id = ++runId.current;
    const gate = { entranceId: gates.entranceId ?? entranceId, exitId: gates.exitId ?? exitId };
    // Permintaan ke Backend berjalan sejak awal; langkah di layar hanya penanda kemajuan.
    const request = planJourney(origin, destination, { avoid, avoidModes, needs, entranceId: gate.entranceId || undefined, exitId: gate.exitId || undefined, at: chosenAt });
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
    setOptionIndex(0);
    setPhase(res.status === "ok" ? { kind: "result", plan: res.data } : { kind: "error", code: res.code, message: res.message });
    requestAnimationFrame(() => resultRef.current?.focus());
  }

  const reset = () => {
    runId.current++;
    setPhase({ kind: "idle" });
  };

  const chooseOrigin = (id: string | null) => {
    setOrigin(id);
    setEntranceId("");
    if (phase.kind !== "idle") reset();
  };
  const chooseDestination = (id: string | null) => {
    setDestination(id);
    setExitId("");
    if (phase.kind !== "idle") reset();
  };
  // Pakai pintu yang disarankan pada hasil: pilih pintu itu lalu cari ulang.
  const applyGate = (role: GateChoice["role"], gateId: string) => {
    if (role === "masuk") setEntranceId(gateId);
    else setExitId(gateId);
    search([], role === "masuk" ? { entranceId: gateId } : { exitId: gateId });
  };

  const plan = phase.kind === "result" ? phase.plan : null;
  const shown = plan ? planForOption(plan, optionIndex) : null;

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
              <GateSelect
                label="Masuk lewat pintu"
                gates={originGates}
                value={entranceId}
                onChange={(v) => {
                  setEntranceId(v);
                  if (phase.kind !== "idle") reset();
                }}
              />
              <button
                type="button"
                className="btn btn-link self-center"
                aria-label="Tukar asal dan tujuan"
                onClick={() => {
                  setOrigin(destination);
                  setDestination(origin);
                  setEntranceId("");
                  setExitId("");
                  if (phase.kind !== "idle") reset();
                }}
              >
                ⇅ Tukar
              </button>
              <StationCombobox label="Ke" marker="◆" value={destination} onChange={chooseDestination} />
              <GateSelect
                label="Keluar lewat pintu"
                gates={destinationGates}
                value={exitId}
                onChange={(v) => {
                  setExitId(v);
                  if (phase.kind !== "idle") reset();
                }}
              />
              {sameStation && (
                <p className="text-sm text-[var(--bad)]" role="alert">
                  Asal dan tujuan tidak boleh sama.
                </p>
              )}
              {closed.map((s) => (
                <p key={s!.id} className="text-sm text-[var(--bad)]" role="alert">
                  Stasiun {s!.name} sudah tidak beroperasi.{s!.inactiveNote ? ` ${s!.inactiveNote}` : ""} Pilih stasiun lain.
                </p>
              ))}
              <fieldset className="mt-2">
                <legend className="mb-1 font-semibold">Waktu berangkat</legend>
                <div className="flex flex-wrap gap-2">
                  {(["now", "at"] as const).map((m) => {
                    const on = timeMode === m;
                    return (
                      <label key={m} className={`choice-chip ${on ? "mode-chip-on" : ""}`}>
                        <input
                          type="radio"
                          name="waktu-berangkat"
                          className="sr-only"
                          checked={on}
                          onChange={() => {
                            setTimeMode(m);
                            setTimeRef(Date.now());
                            if (m === "at" && (!departDate || !departTime)) {
                              const d = nextFiveMinutes();
                              setDepartDate(d.date);
                              setDepartTime(d.time);
                            }
                            if (phase.kind !== "idle") reset();
                          }}
                        />
                        <span aria-hidden>{on ? "●" : "○"}</span> {m === "now" ? "Sekarang" : "Pilih waktu"}
                      </label>
                    );
                  })}
                </div>
                {timeMode === "at" && (
                  <>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="font-semibold">Tanggal</span>
                        <input
                          type="date"
                          className="min-h-11 rounded-lg border-2 border-[var(--border)] bg-[var(--surface)] px-2"
                          value={departDate}
                          min={wibParts(timeRef - DAY).date}
                          max={wibParts(timeRef + 90 * DAY).date}
                          onChange={(e) => {
                            setDepartDate(e.target.value);
                            setTimeRef(Date.now());
                            if (phase.kind !== "idle") reset();
                          }}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="font-semibold">Jam (WIB)</span>
                        <input
                          type="time"
                          className="min-h-11 rounded-lg border-2 border-[var(--border)] bg-[var(--surface)] px-2"
                          value={departTime}
                          step={300}
                          onChange={(e) => {
                            setDepartTime(e.target.value);
                            setTimeRef(Date.now());
                            if (phase.kind !== "idle") reset();
                          }}
                        />
                      </label>
                    </div>
                    {timeProblem ? (
                      <p className="mt-1 text-sm text-[var(--bad)]" role="alert">
                        {timeProblem}
                      </p>
                    ) : (
                      chosenAt && <p className="mt-1 text-sm text-[var(--muted)]">Rute tercepat dan jam kendaraan dihitung dari jadwal {longDate(chosenAt)} WIB.</p>
                    )}
                  </>
                )}
              </fieldset>
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
            route={shown?.route ?? null}
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
                selected={optionIndex}
                onSelect={setOptionIndex}
                onShowDetail={setDetailId}
                onUseAlternative={(alt: Alternative) => search(alt.avoid)}
                onUseGate={applyGate}
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

/** Pintu/gate stasiun (dataset dan isian tim) untuk pilihan pintu masuk/keluar. */
function useGates(stationId: string | null): Entrance[] {
  const [gates, setGates] = useState<{ id: string; list: Entrance[] } | null>(null);
  useEffect(() => {
    if (!stationId) return;
    let alive = true;
    fetchStationDetail(stationId).then((r) => alive && setGates({ id: stationId, list: r.status === "ok" ? r.data.entrances : [] }));
    return () => {
      alive = false;
    };
  }, [stationId]);
  return gates && gates.id === stationId ? gates.list : [];
}

/** Pilihan pintu masuk/keluar; "Otomatis" = Backend memilih jalur paling aksesibel ke peron. */
function GateSelect({ label, gates, value, onChange }: { label: string; gates: Entrance[]; value: string; onChange: (id: string) => void }) {
  if (gates.length < 2) return null;
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-semibold">{label}</span>
      <select className="min-h-11 rounded-lg border-2 border-[var(--border)] bg-[var(--surface)] px-2" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Otomatis (jalur paling aksesibel)</option>
        {gates.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
            {g.accessible ? " ♿" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
