"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { fetchNotices, fetchStationDetail, planJourney } from "@/lib/api";
import { optionsOf, SORT_LABEL, sortedIndices, type SortPref } from "@/lib/journey";
import { useNetwork } from "@/lib/network";
import type { Alternative, ApiResult, Entrance, GateChoice, JourneyPlan, Mode, Notice, TransferNeed } from "@/lib/types";
import { AboutDialog, SettingsDialog, StationDetail, type DisplaySettings } from "./Dialogs";
import { Chevron, EscalatorIcon, LevelIcon, LiftIcon, ModeIcon, RampIcon, SwapIcon, WalkIcon } from "./Icons";
import { JourneyResults } from "./JourneyResults";
import { NoticeBanner, ResultPanel } from "./ResultPanel";
import { StationCombobox } from "./StationCombobox";
import { TransitMap } from "./TransitMap";

type Phase = { kind: "idle" } | { kind: "loading"; step: number } | { kind: "result"; plan: JourneyPlan; arriveBy?: string } | { kind: "error"; code: string; message: string };

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
/** Lebar panel samping di layar lebar (px), termasuk jarak 12 px dari tepi. */
const PANEL_W = 440;
const PANEL_INSET = PANEL_W + 12;

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

/** Opsi aksesibilitas: fasilitas yang wajib ada di titik pindah; Backend mencari transfer lain bila tidak terpenuhi. */
const NEED_PRESETS: { id: string; label: string; needs?: TransferNeed[]; icon?: ReactNode }[] = [
  { id: "none", label: "Tanpa kebutuhan khusus", needs: [] },
  { id: "eskalator", label: "Pakai eskalator, bukan tangga", needs: ["eskalator"], icon: <EscalatorIcon /> },
  { id: "lift", label: "Pakai lift (kursi roda, kruk, stroller)", needs: ["lift"], icon: <LiftIcon /> },
  { id: "penuh", label: "Bebas tangga penuh (lift dan ramp)", needs: ["lift", "ramp"], icon: <RampIcon /> },
  { id: "custom", label: "Atur sendiri" },
];
const sameNeeds = (a: TransferNeed[], b: TransferNeed[]) => a.length === b.length && a.every((x) => b.includes(x));

const SORT_ICON: Record<SortPref, ReactNode> = {
  aksesibel: (
    <span aria-hidden className="text-lg font-bold text-[var(--accent)]">
      ♿
    </span>
  ),
  tercepat: <Chevron dir="right" />,
  pindah: <LevelIcon />,
  jalan: <WalkIcon size={20} />,
};

/** Jam sekarang, hanya untuk penangan kejadian (bukan saat render). */
const clockNow = () => Date.now();
const WIB = 7 * 3600_000;
const DAY = 86_400_000;
const MIN = 60_000;
/** Tanggal (YYYY-MM-DD) dan jam (HH:MM) WIB untuk waktu `ms`. */
const wibParts = (ms: number) => {
  const iso = new Date(ms + WIB).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
};
const wibIso = (ms: number) => {
  const p = wibParts(ms);
  return `${p.date}T${p.time}:00+07:00`;
};
/** Waktu dibulatkan ke 15 menit berikutnya (pilihan jam bertahap 15 menit). */
const nextQuarter = (ms: number) => wibParts(Math.ceil(ms / (15 * MIN)) * 15 * MIN);
/** Waktu ISO dari tanggal dan jam WIB pilihan pengguna; undefined bila belum lengkap. */
const departIso = (date: string, time: string) => (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) ? `${date}T${time}:00+07:00` : undefined);
/** Batas yang diterima Backend: paling awal 1 hari lalu, paling lambat 90 hari lagi. */
function departProblem(iso: string | undefined, now: number, what: string): string | null {
  if (!iso) return `Isi tanggal dan jam ${what}.`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return `Tanggal atau jam ${what} tidak valid.`;
  if (t < now - DAY) return `Waktu ${what} paling awal kemarin.`;
  if (t > now + 90 * DAY) return `Waktu ${what} paling lambat 90 hari lagi.`;
  return null;
}
const QUARTERS = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);
const dateLabel = (date: string, today: string) => {
  const diff = Math.round((Date.parse(date) - Date.parse(today)) / DAY);
  if (diff === 0) return "Hari ini";
  if (diff === 1) return "Besok";
  if (diff === -1) return "Kemarin";
  return new Date(`${date}T12:00:00+07:00`).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jakarta" });
};

type PlanOpts = Parameters<typeof planJourney>[2];

/**
 * Rencana "Tiba paling lambat": Backend menghitung dari waktu berangkat, jadi waktu berangkat dicari bertahap
 * (paling banyak 4 permintaan) sampai ada pilihan yang tiba sebelum batas dengan selisih kecil.
 */
async function planByArrival(origin: string, destination: string, opts: PlanOpts, target: string): Promise<ApiResult<JourneyPlan>> {
  const T = Date.parse(target);
  const floor = Date.now() - DAY + 5 * MIN;
  let at = Math.max(T - 45 * MIN, floor);
  let best: ApiResult<JourneyPlan> | null = null;
  let last: ApiResult<JourneyPlan> | null = null;
  for (let k = 0; k < 4; k++) {
    const res = await planJourney(origin, destination, { ...opts, at: wibIso(at) });
    last = res;
    if (res.status !== "ok") return best ?? res;
    const arr = optionsOf(res.data)
      .map((o) => o.summary.arrivalAt)
      .filter((x): x is string => !!x)
      .map(Date.parse);
    if (!arr.length) return res;
    const ok = arr.filter((t) => t <= T);
    let next: number;
    if (ok.length) {
      best = res;
      const slack = T - Math.max(...ok);
      if (slack <= 15 * MIN) return res;
      next = at + slack - 5 * MIN;
    } else {
      next = Math.max(at - (Math.min(...arr) - T) - 5 * MIN, floor);
    }
    if (Math.abs(next - at) < MIN) break;
    at = next;
  }
  return best ?? last!;
}

export function Planner() {
  const { stationById, lineById, hubById, meta, lines } = useNetwork();
  // Moda yang ada di jaringan, urut tetap agar pilihan tidak berpindah tempat.
  const modes = MODE_ORDER.filter((m) => lines.some((l) => l.mode === m));
  const [avoidModes, setAvoidModes] = useState<Mode[]>([]);
  // Fasilitas yang wajib ada di titik pindah; Backend mencari transfer lain bila tidak terpenuhi.
  const [needs, setNeeds] = useState<TransferNeed[]>([]);
  const [customNeeds, setCustomNeeds] = useState(false);
  const preset = customNeeds ? "custom" : (NEED_PRESETS.find((p) => p.needs && sameNeeds(p.needs, needs))?.id ?? "custom");
  const [sort, setSort] = useState<SortPref>("aksesibel");
  const [prefsOpen, setPrefsOpen] = useState(false);
  // Waktu: berangkat sekarang, atau berangkat/tiba pada tanggal dan jam tertentu (WIB).
  const [timeKind, setTimeKind] = useState<"depart" | "arrive">("depart");
  const [timeMode, setTimeMode] = useState<"now" | "at">("now");
  const [departDate, setDepartDate] = useState("");
  const [departTime, setDepartTime] = useState("");
  // Waktu saat pengguna terakhir mengubah pilihan waktu: acuan batas tanggal (render tidak membaca jam).
  const [timeRef, setTimeRef] = useState(0);
  const chosenAt = timeMode === "at" ? departIso(departDate, departTime) : undefined;
  const timeWord = timeKind === "arrive" ? "tiba" : "berangkat";
  const timeProblem = timeMode === "at" ? departProblem(chosenAt, timeRef, timeWord) : null;
  const noticeTarget = (n: Notice) =>
    n.scope === "station"
      ? stationById(n.targetId ?? "")?.name
      : n.scope === "line"
        ? lineById(n.targetId ?? "")?.name
        : n.scope === "hub"
          ? `Hub ${hubById(n.targetId ?? "")?.name ?? n.targetId}`
          : undefined;
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
  // Pilihan rute yang dipilih (indeks ke `options`) dan tampilan panel: daftar hasil atau detail satu perjalanan.
  const [optionIndex, setOptionIndex] = useState(0);
  const [view, setView] = useState<"list" | "detail">("list");
  // Panel samping: di layar sempit menutupi peta, bisa disembunyikan untuk melihat peta.
  const [panelOpen, setPanelOpen] = useState(true);
  const [wide, setWide] = useState(true);
  const [fitSignal, setFitSignal] = useState(0);
  const runId = useRef(0);
  const resultRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = loadSettings();
    if (saved !== DEFAULT_SETTINGS) queueMicrotask(() => setSettings(saved));
    queueMicrotask(() => setTimeRef(Date.now()));
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
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
  const noMode = modes.length > 0 && modes.every((m) => avoidModes.includes(m));
  const canSearch = origin !== null && destination !== null && !sameStation && !timeProblem && closed.length === 0 && !noMode;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, settings.reduceMotion ? 0 : ms));

  async function search(opts: { avoid?: string[]; entranceId?: string; exitId?: string; at?: string; kind?: "depart" | "arrive" } = {}) {
    if (!origin || !destination) return;
    const id = ++runId.current;
    const gate = { entranceId: opts.entranceId ?? entranceId, exitId: opts.exitId ?? exitId };
    const at = opts.at ?? chosenAt;
    const kind = opts.kind ?? timeKind;
    const arriveBy = kind === "arrive" && at ? at : undefined;
    const base: PlanOpts = { avoid: opts.avoid ?? [], avoidModes, needs, entranceId: gate.entranceId || undefined, exitId: gate.exitId || undefined };
    // Permintaan ke Backend berjalan sejak awal; langkah di layar hanya penanda kemajuan.
    const request = arriveBy ? planByArrival(origin, destination, base, arriveBy) : planJourney(origin, destination, { ...base, at });
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
    if (res.status === "ok") {
      setOptionIndex(sortedIndices(optionsOf(res.data), sort, arriveBy)[0] ?? 0);
      setView("list");
      setPhase({ kind: "result", plan: res.data, arriveBy });
    } else setPhase({ kind: "error", code: res.code, message: res.message });
    // Gulir panel ke hasil (formulir tetap di atasnya, bisa digulir kembali).
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: Math.max((resultRef.current?.offsetTop ?? 0) - 8, 0) }));
    requestAnimationFrame(() => resultRef.current?.focus({ preventScroll: true }));
  }

  const reset = () => {
    runId.current++;
    setPhase({ kind: "idle" });
  };
  const changed = () => {
    if (phase.kind !== "idle") reset();
  };

  const chooseOrigin = (id: string | null) => {
    setOrigin(id);
    setEntranceId("");
    changed();
  };
  const chooseDestination = (id: string | null) => {
    setDestination(id);
    setExitId("");
    changed();
  };
  // Pakai pintu yang disarankan pada hasil: pilih pintu itu lalu cari ulang.
  const applyGate = (role: GateChoice["role"], gateId: string) => {
    if (role === "masuk") setEntranceId(gateId);
    else setExitId(gateId);
    search(role === "masuk" ? { entranceId: gateId } : { exitId: gateId });
  };

  // Tanggal dan jam pada formulir.
  const today = wibParts(timeRef || 0).date;
  const dateValue = timeMode === "now" ? today : departDate || today;
  const dateOptions = timeRef ? Array.from({ length: 31 }, (_, i) => wibParts(timeRef + i * DAY).date) : [];
  if (dateValue && !dateOptions.includes(dateValue)) dateOptions.unshift(dateValue);
  const timeValue = timeMode === "now" ? "now" : departTime;
  const timeOptions = departTime && !QUARTERS.includes(departTime) ? [...QUARTERS, departTime].sort() : QUARTERS;
  const showNow = timeKind === "depart" && dateValue === today;

  const setAt = (ms: number) => {
    const p = wibParts(ms);
    setTimeMode("at");
    setDepartDate(p.date);
    setDepartTime(p.time);
    setTimeRef(clockNow());
  };
  const chooseKind = (k: "depart" | "arrive") => {
    setTimeKind(k);
    if (k === "arrive" && timeMode === "now") {
      const p = nextQuarter(clockNow() + 60 * MIN);
      setTimeMode("at");
      setDepartDate(p.date);
      setDepartTime(p.time);
    }
    setTimeRef(clockNow());
    changed();
  };
  const chooseDate = (d: string) => {
    if (timeMode === "now") {
      setTimeMode("at");
      setDepartTime(nextQuarter(clockNow()).time);
    }
    setDepartDate(d);
    setTimeRef(clockNow());
    changed();
  };
  const chooseTime = (t: string) => {
    if (t === "now") setTimeMode("now");
    else {
      setTimeMode("at");
      setDepartTime(t);
      if (!departDate || timeMode === "now") setDepartDate(dateValue);
    }
    setTimeRef(clockNow());
    changed();
  };

  const result = phase.kind === "result" ? phase : null;
  const plan = result?.plan ?? null;
  const shownRoute = plan ? (optionsOf(plan)[optionIndex] ?? optionsOf(plan)[0]).route : null;

  // Perjalanan lebih awal/lebih akhir: geser waktu lalu cari ulang (mode tetap Berangkat atau Tiba).
  function shift(dir: -1 | 1) {
    if (!plan) return;
    const run = (ms: number, kind: "depart" | "arrive") => {
      if (departProblem(wibIso(ms), Date.now(), "berangkat")) return;
      setAt(ms);
      setTimeKind(kind);
      search({ at: wibIso(ms), kind });
    };
    if (result?.arriveBy) return run(Date.parse(result.arriveBy) + dir * 15 * MIN, "arrive");
    const base = plan.departAt ? Date.parse(plan.departAt) : Date.now();
    if (dir < 0) return run(base - 15 * MIN, "depart");
    const deps = optionsOf(plan)
      .map((o) => o.summary.departureAt)
      .filter((x): x is string => !!x)
      .map(Date.parse);
    const firstDep = deps.length ? Math.min(...deps) : base;
    run(Math.max(base + 5 * MIN, firstDep + MIN), "depart");
  }

  const showOnMap = (i: number) => {
    setOptionIndex(i);
    setFitSignal((n) => n + 1);
    if (!wide) setPanelOpen(false);
  };

  const modeColor = (m: Mode) => lines.find((l) => l.mode === m)?.color;
  const prefSummary = [
    avoidModes.length ? `Tanpa ${avoidModes.map((m) => MODE_LABEL[m]).join(", ")}` : "Semua moda",
    SORT_LABEL[sort],
    NEED_PRESETS.find((p) => p.id === preset)?.id === "custom"
      ? `Butuh ${needs.map((n) => NEED_LABEL[n].toLowerCase()).join(", ") || "-"}`
      : NEED_PRESETS.find((p) => p.id === preset)?.label,
  ].join(" · ");

  return (
    <div className="fixed inset-0 overflow-hidden bg-[var(--map-bg)]">
      {/* Peta transportasi penuh sebagai latar belakang */}
      <TransitMap
        fullscreen
        insetLeft={wide && panelOpen ? PANEL_INSET : 0}
        fitSignal={fitSignal}
        originId={origin}
        destinationId={destination}
        route={shownRoute}
        onSetOrigin={(id) => {
          chooseOrigin(id);
          if (!wide) setPanelOpen(true);
        }}
        onSetDestination={(id) => {
          chooseDestination(id);
          if (!wide) setPanelOpen(true);
        }}
        onShowDetail={setDetailId}
      />

      {!panelOpen && (
        <button type="button" className="btn btn-primary absolute left-3 top-3 z-20 shadow-lg" onClick={() => setPanelOpen(true)}>
          <Chevron dir="right" size={18} /> {plan ? "Kembali ke perjalanan" : "Rencanakan perjalanan"}
        </button>
      )}

      <aside
        aria-label="Perencana perjalanan"
        hidden={!panelOpen}
        className="side-panel absolute inset-0 z-20 flex flex-col overflow-hidden md:inset-auto md:bottom-3 md:left-3 md:top-3 md:rounded-xl"
        style={wide ? { width: PANEL_W } : undefined}
      >
        <header className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
          <p className="flex items-center gap-2 text-lg font-extrabold">
            <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--accent)] text-white">
              ♿
            </span>
            NTD
            <span className="text-xs font-normal leading-tight text-[var(--muted)]">
              Navigasi Transportasi
              <br />
              Umum Aksesibel
            </span>
          </p>
          <nav className="flex gap-1" aria-label="Menu">
            <button className="icon-btn" aria-label="Pengaturan tampilan" onClick={() => setSettingsOpen(true)}>
              Aa
            </button>
            <button className="icon-btn" aria-label="Tentang NTD" onClick={() => setAboutOpen(true)}>
              ⓘ
            </button>
            <button className="icon-btn" aria-label={wide ? "Sembunyikan panel" : "Tampilkan peta"} onClick={() => setPanelOpen(false)}>
              {wide ? <Chevron dir="left" /> : "Peta"}
            </button>
          </nav>
        </header>

        <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
          <section aria-labelledby="judul-form" className="form-zone px-4 pb-3 pt-3">
            <h1 id="judul-form" className="mb-2 text-xl font-bold">
              Rencanakan perjalanan
            </h1>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSearch) search();
              }}
            >
              <div className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <StationCombobox label="Dari" marker="●" value={origin} onChange={chooseOrigin} />
                  <StationCombobox label="Ke" marker="◆" value={destination} onChange={chooseDestination} />
                </div>
                <button
                  type="button"
                  className="icon-btn mt-6 text-[var(--accent)]"
                  aria-label="Tukar asal dan tujuan"
                  title="Tukar asal dan tujuan"
                  onClick={() => {
                    setOrigin(destination);
                    setDestination(origin);
                    setEntranceId("");
                    setExitId("");
                    changed();
                  }}
                >
                  <SwapIcon />
                </button>
              </div>
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

              <fieldset>
                <legend className="sr-only">Waktu perjalanan</legend>
                <div className="seg">
                  {(["depart", "arrive"] as const).map((k) => (
                    <label key={k}>
                      <input type="radio" name="jenis-waktu" className="sr-only" checked={timeKind === k} onChange={() => chooseKind(k)} />
                      {timeKind === k && <span aria-hidden>✓</span>}
                      {k === "depart" ? "Berangkat" : "Tiba"}
                    </label>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-[1fr_8rem] gap-2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="sr-only">Tanggal</span>
                    <select className="field" value={dateValue} onChange={(e) => chooseDate(e.target.value)}>
                      {dateOptions.map((d) => (
                        <option key={d} value={d}>
                          {dateLabel(d, today)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="sr-only">Jam (WIB)</span>
                    <select className="field" value={timeValue} onChange={(e) => chooseTime(e.target.value)}>
                      {showNow && <option value="now">Sekarang</option>}
                      {timeMode === "now" && !showNow && <option value="now">Pilih jam</option>}
                      {timeOptions.map((t) => (
                        <option key={t} value={t}>
                          {t.replace(":", ".")}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {timeProblem ? (
                  <p className="mt-1 text-sm text-[var(--bad)]" role="alert">
                    {timeProblem}
                  </p>
                ) : timeKind === "arrive" ? (
                  <p className="mt-1 text-xs text-[var(--muted)]">Waktu berangkat dihitung mundur dari jadwal agar tiba sebelum jam ini (WIB).</p>
                ) : (
                  <p className="mt-1 text-xs text-[var(--muted)]">Rute tercepat dan jam kendaraan dihitung dari jadwal pada waktu ini (WIB).</p>
                )}
              </fieldset>

              <button type="submit" className="btn btn-primary min-h-12 text-lg" disabled={!canSearch || phase.kind === "loading"}>
                Cari rute
              </button>
            </form>
          </section>

          {/* Preferensi: bisa disembunyikan, ringkasannya tetap terlihat */}
          <section className="border-b border-[var(--border)] px-4 py-2" aria-label="Preferensi perjalanan">
            <button
              type="button"
              className="link-sm flex w-full items-center justify-center gap-1 no-underline"
              aria-expanded={prefsOpen}
              aria-controls="preferensi"
              onClick={() => setPrefsOpen((v) => !v)}
            >
              {prefsOpen ? "Sembunyikan preferensi" : "Tampilkan preferensi"}
              <Chevron dir={prefsOpen ? "up" : "down"} size={16} />
            </button>
            {!prefsOpen && <p className="text-center text-xs text-[var(--muted)]">{prefSummary}</p>}
            <div id="preferensi" hidden={!prefsOpen} className="mt-2 flex flex-col gap-4 pb-2">
              {modes.length > 1 && (
                <fieldset>
                  <div className="mb-1 flex items-end justify-between">
                    <legend className="font-semibold">Naik moda</legend>
                    <span className="text-sm">
                      <button type="button" className="link-sm" onClick={() => (setAvoidModes([]), changed())}>
                        pilih semua
                      </button>
                      <span aria-hidden className="mx-1 text-[var(--muted)]">
                        |
                      </span>
                      <button type="button" className="link-sm" onClick={() => (setAvoidModes(modes), changed())}>
                        hapus semua
                      </button>
                    </span>
                  </div>
                  <div className="pref-list">
                    {modes.map((m) => (
                      <label key={m}>
                        <ModeIcon mode={m} color={modeColor(m)} />
                        <span>{MODE_LABEL[m]}</span>
                        <input
                          type="checkbox"
                          checked={!avoidModes.includes(m)}
                          onChange={() => {
                            setAvoidModes((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
                            changed();
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  {noMode ? (
                    <p className="mt-1 text-sm text-[var(--bad)]" role="alert">
                      Pilih minimal satu moda.
                    </p>
                  ) : (
                    avoidModes.length > 0 && (
                      <p className="mt-1 text-xs text-[var(--muted)]">Rute menghindari {avoidModes.map((m) => MODE_LABEL[m]).join(", ")} bila memungkinkan.</p>
                    )
                  )}
                </fieldset>
              )}

              <fieldset>
                <legend className="mb-1 font-semibold">Tampilkan</legend>
                <div className="pref-list">
                  {(Object.keys(SORT_LABEL) as SortPref[]).map((k) => (
                    <label key={k}>
                      <span className="grid w-6 place-items-center">{SORT_ICON[k]}</span>
                      <span>{SORT_LABEL[k]}</span>
                      <input type="radio" name="urutan" checked={sort === k} onChange={() => setSort(k)} />
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-1 font-semibold">Opsi aksesibilitas</legend>
                <div className="pref-list">
                  {NEED_PRESETS.map((p) => (
                    <label key={p.id}>
                      <span className="grid w-6 place-items-center text-[var(--accent)]">{p.icon}</span>
                      <span>{p.label}</span>
                      <input
                        type="radio"
                        name="akses"
                        checked={preset === p.id}
                        onChange={() => {
                          setCustomNeeds(!p.needs);
                          if (p.needs) setNeeds(p.needs);
                          changed();
                        }}
                      />
                    </label>
                  ))}
                </div>
                {preset === "custom" && (
                  <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Fasilitas yang dibutuhkan saat pindah">
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
                              changed();
                            }}
                          />
                          <span aria-hidden>{on ? "✓" : "+"}</span> {NEED_LABEL[n]}
                        </label>
                      );
                    })}
                  </div>
                )}
                {needs.length > 0 && (
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Titik pindah dipilih yang punya {needs.map((n) => NEED_LABEL[n].toLowerCase()).join(" dan ")} bila memungkinkan.
                  </p>
                )}
              </fieldset>

              {(originGates.length > 1 || destinationGates.length > 1) && (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 font-semibold">Pintu stasiun</legend>
                  <GateSelect label="Masuk lewat pintu" gates={originGates} value={entranceId} onChange={(v) => (setEntranceId(v), changed())} />
                  <GateSelect label="Keluar lewat pintu" gates={destinationGates} value={exitId} onChange={(v) => (setExitId(v), changed())} />
                </fieldset>
              )}
            </div>
          </section>

          <div id="hasil" ref={resultRef} tabIndex={-1} aria-live="polite" className="px-4 py-4 outline-none">
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
              <p className="text-sm text-[var(--muted)]">
                Pilih asal dan tujuan, atau tekan pemberhentian di peta. Data fasilitas bersifat statis, bukan kondisi real-time. Coba: <b>Manggarai → Bundaran HI Bank Jakarta</b>{" "}
                atau <b>Jakarta Kota → Kuningan (LRT)</b>.
              </p>
            )}

            {phase.kind === "loading" && (
              <section aria-label="Sedang memuat">
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

            {plan && view === "list" && (
              <JourneyResults
                plan={plan}
                sort={sort}
                arriveBy={result?.arriveBy}
                selected={optionIndex}
                onSelect={setOptionIndex}
                onDetail={(i) => {
                  setOptionIndex(i);
                  setView("detail");
                  scrollRef.current?.scrollTo({ top: resultRef.current?.offsetTop ?? 0 });
                }}
                onShowMap={showOnMap}
                onEarlier={() => shift(-1)}
                onLater={() => shift(1)}
              />
            )}

            {plan && view === "detail" && (
              <ResultPanel
                plan={plan}
                selected={optionIndex}
                onShowDetail={setDetailId}
                onUseAlternative={(alt: Alternative) => search({ avoid: alt.avoid })}
                onUseGate={applyGate}
                onShowMap={() => showOnMap(optionIndex)}
                onBack={() => setView("list")}
              />
            )}
          </div>

          <footer className="border-t border-[var(--border)] px-4 py-3 text-xs text-[var(--muted)]">
            ⚠ Data fasilitas bersifat statis, bukan kondisi real-time · {meta?.attribution ?? "Data © Commute Data API (ODbL-1.0)"}
          </footer>
        </div>
      </aside>

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
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
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
