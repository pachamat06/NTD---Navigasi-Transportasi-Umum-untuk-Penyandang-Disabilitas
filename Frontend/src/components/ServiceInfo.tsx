"use client";

import { useNetwork } from "@/lib/network";
import type { JourneyPlan, Pipeline, ServiceInfoItem } from "@/lib/types";

const IMPACT_LABEL: Record<string, string> = { info: "Informasi", delay: "Keterlambatan", disruption: "Gangguan", closure: "Penutupan" };

/** Pilihan pipeline di panel preferensi. Hanya dirender bila admin menyalakan mode LLM dan klien LLM tersedia. */
export function PipelineChoice({ value, onChange }: { value: Pipeline; onChange: (p: Pipeline) => void }) {
  return (
    <fieldset>
      <legend className="mb-1 font-semibold">Cara mencari rute</legend>
      <div className="pref-list">
        <label>
          <span aria-hidden className="grid w-6 place-items-center">
            ⚙
          </span>
          <span>Standar (algoritma NTD)</span>
          <input type="radio" name="pipeline" checked={value === "default"} onChange={() => onChange("default")} />
        </label>
        <label>
          <span aria-hidden className="grid w-6 place-items-center">
            ✨
          </span>
          <span>Dengan LLM (agen AI memilih rute)</span>
          <input type="radio" name="pipeline" checked={value === "llm"} onChange={() => onChange("llm")} />
        </label>
      </div>
      {value === "llm" && (
        <p className="mt-1 text-xs text-[var(--muted)]">
          Agen AI memilih dari rute yang disusun NTD dan hasilnya diperiksa terhadap data. Bila AI gagal, rute standar ditampilkan. Pencarian bisa sedikit lebih lama.
        </p>
      )}
    </fieldset>
  );
}

/** Catatan pipeline: kapan permintaan LLM turun ke standar, dan pilihan agen AI beserta alasannya. */
export function PipelineNote({ plan }: { plan: JourneyPlan }) {
  const p = plan.pipeline;
  if (!p || p.requested !== "llm") return null;
  const llmPick = plan.options?.find((o) => o.pickedBy === "llm");
  return (
    <div className={`banner ${p.used === "llm" ? "banner-info" : "banner-warn"}`}>
      <span aria-hidden>{p.used === "llm" ? "✨" : "ⓘ"}</span>{" "}
      <span>
        {p.navigation === "llm" ? (
          <>
            <b>Rute dipilih agen AI.</b> {llmPick?.llmReason ?? "Pilihan pertama adalah rute yang dipilih agen."}
          </>
        ) : p.used === "llm" ? (
          <>
            <b>Narasi disusun AI.</b> Rute dipilih dengan cara standar.
          </>
        ) : (
          <>
            <b>Memakai cara standar.</b> {p.reason ?? "AI tidak dapat dipakai untuk pencarian ini."}
          </>
        )}
        {p.notes.length > 0 && <span className="block text-sm opacity-80">{p.notes.join(" ")}</span>}
      </span>
    </div>
  );
}

/**
 * Informasi layanan operator dari akun resmi (gangguan, keterlambatan, penutupan). "Belum diverifikasi" hanya informasi dan
 * tidak mengubah rute; yang sudah diperiksa admin ikut memengaruhi urutan rute.
 */
export function ServiceInfoList({ items }: { items?: ServiceInfoItem[] }) {
  const { stationById, lineById } = useNetwork();
  if (!items?.length) return null;
  const scope = (i: ServiceInfoItem) => [...i.stationIds.map((id) => stationById(id)?.name ?? id), ...i.lineIds.map((id) => lineById(id)?.name ?? id)].join(", ");
  return (
    <section aria-label="Informasi layanan operator" className="mb-3 flex flex-col gap-2">
      {items.map((i) => (
        <div key={i.id} className={`banner ${i.status === "approved" && i.impact && i.impact !== "info" ? "banner-warn" : "banner-info"}`}>
          <span aria-hidden>{i.status === "approved" ? "⚠" : "ⓘ"}</span>{" "}
          <span>
            <b>
              {i.status === "approved" ? `Informasi layanan${i.impact ? ` (${IMPACT_LABEL[i.impact]?.toLowerCase()})` : ""}.` : "Kabar dari operator, belum diverifikasi."}
            </b>{" "}
            {i.summary}
            <span className="block text-sm opacity-80">
              {scope(i) && <>Terkait: {scope(i)} · </>}
              {i.source.url ? (
                <a href={i.source.url} target="_blank" rel="noopener noreferrer" className="underline">
                  @{i.source.account}
                </a>
              ) : (
                `@${i.source.account}`
              )}{" "}
              · {new Date(i.source.postedAt).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" })} WIB
              {i.status === "pending" && " · hanya informasi, belum memengaruhi rute"}
            </span>
          </span>
        </div>
      ))}
    </section>
  );
}
