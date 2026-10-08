import type { StationAssessment } from "@/lib/types";

/** Lencana status aksesibilitas: selalu ikon + teks + warna, tidak hanya warna. */
export function AccessBadge({ a, compact = false }: { a: StationAssessment; compact?: boolean }) {
  if (!a.dataAvailable) {
    return (
      <span className="badge badge-unknown">
        <span aria-hidden>?</span> Data tidak tersedia
      </span>
    );
  }
  if (a.adequate) {
    return (
      <span className="badge badge-ok">
        <span aria-hidden>✔</span> Memadai{compact ? "" : ` · ${a.score}`}
      </span>
    );
  }
  return (
    <span className="badge badge-warn">
      <span aria-hidden>⚠</span> Perlu perhatian{compact ? "" : ` · ${a.score}`}
    </span>
  );
}
