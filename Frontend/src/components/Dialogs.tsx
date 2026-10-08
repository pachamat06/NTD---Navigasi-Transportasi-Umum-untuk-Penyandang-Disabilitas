"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { hubById, lineById, stationById } from "@/lib/dummy-data";
import { AMENITY_LABEL, assess, type DemoMode } from "@/lib/mock-planner";
import type { AmenityType } from "@/lib/types";
import { AccessBadge } from "./AccessBadge";

/** Dialog modal berbasis <dialog> bawaan peramban (fokus terkunci, Esc menutup). */
export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="dialog-title" className="modal">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-5 py-3">
        <h2 id="dialog-title" className="text-lg font-bold">
          {title}
        </h2>
        <button className="icon-btn" aria-label="Tutup" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
    </dialog>
  );
}

const STATUS_TEXT = {
  available: { icon: "✔", text: "Tersedia", cls: "text-[var(--ok)]" },
  absent: { icon: "✖", text: "Tidak ada", cls: "text-[var(--bad)]" },
  unknown: { icon: "?", text: "Data tidak tersedia", cls: "text-[var(--muted)]" },
} as const;

/** L6 Detail Stasiun dan Fasilitas (UC-04). */
export function StationDetail({
  stationId,
  onClose,
  onSetOrigin,
  onSetDestination,
}: {
  stationId: string | null;
  onClose: () => void;
  onSetOrigin: (id: string) => void;
  onSetDestination: (id: string) => void;
}) {
  const st = stationId ? stationById(stationId) : null;
  const a = stationId ? assess(stationId) : null;
  return (
    <Modal open={!!st} title={st?.name ?? ""} onClose={onClose}>
      {st && a && (
        <div className="flex flex-col gap-4">
          <p className="text-[var(--muted)]">
            {st.operator} · {st.lineIds.map((l) => lineById(l)!.name).join(", ")} · {st.codes.join("/")}
            {st.hubId && ` · Hub ${hubById(st.hubId)!.name}`}
          </p>
          <div>
            <p className="text-sm font-semibold">Skor aksesibilitas</p>
            {a.dataAvailable ? (
              <>
                <div className="mt-1 flex items-center gap-3">
                  <meter min={0} max={100} low={50} high={70} optimum={100} value={a.score} className="h-3 flex-1" aria-label="Skor aksesibilitas" />
                  <span className="font-bold">{a.score} / 100</span>
                </div>
                <div className="mt-2">
                  <AccessBadge a={a} compact />
                </div>
              </>
            ) : (
              <p className="banner banner-muted mt-1">
                <span aria-hidden>?</span> Data fasilitas stasiun ini belum tersedia. Ini bukan berarti fasilitasnya tidak ada.
              </p>
            )}
          </div>
          <div>
            <p className="text-sm font-semibold">Fasilitas</p>
            <ul className="mt-1 divide-y divide-[var(--border)]">
              {(Object.entries(st.amenities) as [AmenityType, keyof typeof STATUS_TEXT][]).map(([k, v]) => (
                <li key={k} className="flex min-h-11 items-center justify-between">
                  <span>{AMENITY_LABEL[k]}</span>
                  <span className={STATUS_TEXT[v].cls}>
                    <span aria-hidden>{STATUS_TEXT[v].icon}</span> {STATUS_TEXT[v].text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-sm text-[var(--muted)]">
            Skor dihitung dari fasilitas yang tercatat di data (bobot sementara: lift 40, toilet aksesibel 25, eskalator 20, ramp 15). &quot;Data tidak
            tersedia&quot; bukan berarti fasilitas tidak ada. Data bersifat statis, bukan kondisi real-time.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              className="btn btn-secondary"
              onClick={() => {
                onSetOrigin(st.id);
                onClose();
              }}
            >
              ● Jadikan Asal
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                onSetDestination(st.id);
                onClose();
              }}
            >
              ◆ Jadikan Tujuan
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** L8 Tentang, Sumber Data, Privasi. */
export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} title="Tentang NTD" onClose={onClose}>
      <div className="prose-sm flex flex-col gap-4">
        <p>
          NTD (Navigasi Transportasi Umum untuk Penyandang Disabilitas) membantu pengguna kursi roda, penyandang keterbatasan fisik, lansia, dan
          orang tua dengan stroller merencanakan perjalanan transportasi umum di Jabodetabek.
        </p>
        <Section title="Cakupan saat ini">Hub Sudirman–Dukuh Atas–BNI City, fokus aksesibilitas mobilitas fisik.</Section>
        <Section title="Sumber data">
          Commute Data API, Shiori Labs (lisensi ODbL-1.0). Peta: Peta Integrasi Transportasi Umum Jakarta © FDTJ (edisi 2026-08c), digunakan
          dengan izin. Versi GUI basic ini memakai data dummy.
        </Section>
        <Section title="Keterbatasan">Data fasilitas bersifat statis, bukan status real-time. Selalu konfirmasi ke petugas stasiun bila ragu.</Section>
        <Section title="Privasi">NTD tidak meminta akun dan tidak menyimpan identitas atau riwayat lokasi Anda.</Section>
        <Section title="Segera hadir (Fase Lanjutan)">
          <ul className="list-disc pl-5">
            <li>Lapor kondisi fasilitas</li>
            <li>Minta bantuan petugas sebelum tiba</li>
            <li>Notifikasi real-time</li>
          </ul>
        </Section>
        <p className="text-sm text-[var(--muted)]">Proyek RPL Kelompok 11.</p>
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-bold uppercase tracking-wide text-[var(--muted)]">{title}</h3>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export type DisplaySettings = { textSize: 0 | 1 | 2; highContrast: boolean; reduceMotion: boolean; demoMode: DemoMode };

/** L9 Pengaturan Tampilan [Usulan] + pilihan simulasi kondisi data untuk demo. */
export function SettingsDialog({
  open,
  onClose,
  value,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  value: DisplaySettings;
  onChange: (v: DisplaySettings) => void;
}) {
  return (
    <Modal open={open} title="Tampilan" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <fieldset>
          <legend className="mb-2 font-semibold">Ukuran teks</legend>
          <div className="flex gap-2">
            {(["A", "A+", "A++"] as const).map((l, i) => (
              <button
                key={l}
                aria-pressed={value.textSize === i}
                className={`btn ${value.textSize === i ? "btn-primary" : "btn-secondary"}`}
                onClick={() => onChange({ ...value, textSize: i as 0 | 1 | 2 })}
              >
                {l}
              </button>
            ))}
          </div>
        </fieldset>
        <Toggle label="Kontras tinggi" checked={value.highContrast} onChange={(v) => onChange({ ...value, highContrast: v })} />
        <Toggle label="Kurangi animasi" checked={value.reduceMotion} onChange={(v) => onChange({ ...value, reduceMotion: v })} />
        <fieldset className="rounded-lg border border-dashed border-[var(--border)] p-3">
          <legend className="px-1 text-sm font-semibold">Simulasi kondisi data (khusus demo)</legend>
          {(
            [
              ["normal", "Normal"],
              ["cache", "API tidak bisa dihubungi, pakai cache"],
              ["down", "API tidak bisa dihubungi, tanpa cache"],
            ] as const
          ).map(([k, l]) => (
            <label key={k} className="flex min-h-11 items-center gap-2">
              <input type="radio" name="demo" checked={value.demoMode === k} onChange={() => onChange({ ...value, demoMode: k })} className="h-5 w-5" />
              {l}
            </label>
          ))}
        </fieldset>
      </div>
    </Modal>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3">
      <span className="font-semibold">{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-6 w-6" />
    </label>
  );
}
