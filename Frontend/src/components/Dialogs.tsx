"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { fetchStationDetail } from "@/lib/api";
import { AMENITY_LABEL, useNetwork } from "@/lib/network";
import type { AmenityType, StationDetailData } from "@/lib/types";
import { AccessBadge } from "./AccessBadge";
import { PlatformList, VIA_TEXT, verticalText } from "./PlatformInfo";
import { NoticeBanner } from "./ResultPanel";

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
  absent: { icon: "✖", text: "Tidak tercatat", cls: "text-[var(--bad)]" },
  out_of_service: { icon: "⚠", text: "Sedang tidak berfungsi", cls: "text-[var(--warn)]" },
  unknown: { icon: "?", text: "Data tidak tersedia", cls: "text-[var(--muted)]" },
} as const;

const ENTRANCE_FEATURE: Record<string, string> = {
  lift: "lift",
  ramp: "ramp",
  eskalator: "eskalator",
  tangga: "tangga",
  datar: "jalan datar",
  guiding_block: "guiding block",
};

const INFO_CATEGORY: Record<string, string> = { kontak: "Kontak", jam_operasional: "Jam operasional", layanan: "Layanan", catatan: "Catatan" };

/** L6 Detail Stasiun dan Fasilitas (UC-04), termasuk pintu akses dan info tambahan dari tim NTD. */
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
  const { stationById, lineById, hubById, amenityLabel, meta } = useNetwork();
  const base = stationId ? stationById(stationId) : undefined;
  const [detail, setDetail] = useState<{ id: string; data: StationDetailData | null; error?: string } | null>(null);

  useEffect(() => {
    if (!stationId) return;
    let alive = true;
    fetchStationDetail(stationId).then((r) => {
      if (alive) setDetail({ id: stationId, data: r.status === "ok" ? r.data : null, error: r.status === "error" ? r.message : undefined });
    });
    return () => {
      alive = false;
    };
  }, [stationId]);

  // Data dari /api/network tampil lebih dulu; detail lengkap menyusul.
  const full = detail?.id === stationId ? detail : null;
  const st = full?.data ?? base;
  const a = st?.assessment;
  const details = st?.amenityDetails ?? [];
  const extras = details.filter((d) => !(d.type in AMENITY_LABEL));
  const w = meta?.scoring.weights;

  return (
    <Modal open={!!st} title={st?.name ?? ""} onClose={onClose}>
      {st && a && (
        <div className="flex flex-col gap-4">
          <p className="text-[var(--muted)]">
            {st.operator} · {st.lineIds.map((l) => lineById(l)?.name ?? l).join(", ")} · {st.codes.join("/")}
            {st.hubId && ` · Hub ${hubById(st.hubId)?.name ?? st.hubId}`}
          </p>
          {full?.data?.notices.map((n) => <NoticeBanner key={n.id} notice={n} />)}
          <div>
            <p className="text-sm font-semibold">Skor aksesibilitas</p>
            {a.dataAvailable ? (
              <>
                <div className="mt-1 flex items-center gap-3">
                  <meter min={0} max={100} low={50} high={meta?.scoring.threshold ?? 70} optimum={100} value={a.score} className="h-3 flex-1" aria-label="Skor aksesibilitas" />
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
              {(Object.keys(AMENITY_LABEL) as AmenityType[]).map((k) => {
                const d = details.find((x) => x.type === k);
                const v = d?.status === "out_of_service" ? "out_of_service" : st.amenities[k];
                return <AmenityRow key={k} label={amenityLabel(k)} status={v} note={d?.source === "ntd" ? d.note : undefined} />;
              })}
              {extras.map((d) => (
                <AmenityRow key={d.type} label={amenityLabel(d.type)} status={d.status} note={d.note} />
              ))}
            </ul>
          </div>
          {full?.data?.platforms && full.data.platforms.length > 0 && (
            <div>
              <p className="text-sm font-semibold">Peron ({full.data.platforms.length})</p>
              <PlatformList platforms={full.data.platforms} entrances={full.data.entrances} />
            </div>
          )}
          {full?.data && full.data.entrances.length > 0 && (
            <div>
              <p className="text-sm font-semibold">Pintu akses</p>
              <ul className="mt-1 flex flex-col gap-2">
                {full.data.entrances.map((e) => (
                  <li key={e.id} className="rounded-lg bg-[var(--surface-2)] p-3 text-sm">
                    <p className="font-semibold">
                      {e.name}{" "}
                      <span className={e.accessible ? "text-[var(--ok)]" : "text-[var(--warn)]"}>
                        <span aria-hidden>{e.accessible ? "✔" : "⚠"}</span> {e.accessible ? "Aksesibel" : "Kurang aksesibel"}
                      </span>
                    </p>
                    {e.description && <p>{e.description}</p>}
                    {e.features.length > 0 && <p className="text-[var(--muted)]">Akses: {e.features.map((f) => ENTRANCE_FEATURE[f] ?? f).join(", ")}</p>}
                    {verticalText(e.escalators, e.lift).length > 0 && <p className="text-[var(--muted)]">{verticalText(e.escalators, e.lift).join(" · ")}</p>}
                    {e.platformLinks && e.platformLinks.length > 0 && (
                      <p>Ke peron: {e.platformLinks.map((l) => `${l.platform} ${VIA_TEXT[l.via]}${l.note ? ` (${l.note})` : ""}`).join(" · ")}</p>
                    )}
                    {e.signs && e.signs.length > 0 && <p className="text-[var(--muted)]">Papan petunjuk: {e.signs.join(", ")}</p>}
                    {e.openHours && <p className="text-[var(--muted)]">Buka: {e.openHours}</p>}
                    {e.note && <p className="text-[var(--muted)]">{e.note}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {full?.data && full.data.info.length > 0 && (
            <div>
              <p className="text-sm font-semibold">Informasi lain</p>
              <dl className="mt-1 flex flex-col gap-2 text-sm">
                {full.data.info.map((i) => (
                  <div key={i.id}>
                    <dt className="font-semibold">
                      {i.title} <span className="font-normal text-[var(--muted)]">· {INFO_CATEGORY[i.category] ?? i.category}</span>
                    </dt>
                    <dd className="whitespace-pre-line">{i.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {full?.error && <p className="text-sm text-[var(--muted)]">Detail tambahan belum bisa dimuat: {full.error}</p>}
          <p className="text-sm text-[var(--muted)]">
            Skor dihitung dari fasilitas yang tercatat
            {w && ` (bobot: lift ${w.lift}, toilet aksesibel ${w.toilet}, eskalator ${w.eskalator}, ramp ${w.ramp})`}. &quot;Data tidak tersedia&quot;
            bukan berarti fasilitas tidak ada. {meta?.disclaimer ?? "Data bersifat statis, bukan kondisi real-time."}
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

function AmenityRow({ label, status, note }: { label: string; status: keyof typeof STATUS_TEXT; note?: string }) {
  const t = STATUS_TEXT[status];
  return (
    <li className="flex min-h-11 flex-col justify-center py-1">
      <span className="flex items-center justify-between gap-2">
        <span>{label}</span>
        <span className={t.cls}>
          <span aria-hidden>{t.icon}</span> {t.text}
        </span>
      </span>
      {note && <span className="text-sm text-[var(--muted)]">{note}</span>}
    </li>
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
          dengan izin. Informasi tambahan (pintu akses, kondisi fasilitas, pengumuman) dari tim NTD.
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

export type DisplaySettings = { textSize: 0 | 1 | 2; highContrast: boolean; reduceMotion: boolean };

/** L9 Pengaturan Tampilan [Usulan]. */
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
