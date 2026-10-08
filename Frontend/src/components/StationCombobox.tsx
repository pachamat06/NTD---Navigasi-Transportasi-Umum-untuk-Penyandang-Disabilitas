"use client";

import { useId, useState } from "react";
import { lineById, stationById } from "@/lib/dummy-data";
import { searchStations } from "@/lib/mock-planner";

/** Form Pencarian Stasiun (UC-02): combobox dengan autocomplete, bisa dipakai penuh dengan papan ketik. */
export function StationCombobox({
  label,
  marker,
  value,
  onChange,
}: {
  label: string;
  marker: string;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const id = useId();
  const selectedName = value ? stationById(value)?.name ?? "" : "";
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const text = draft ?? selectedName;
  const results = draft !== null ? searchStations(draft) : [];
  const showList = open && draft !== null && draft.trim().length >= 2;

  const choose = (stationId: string) => {
    onChange(stationId);
    setDraft(null);
    setOpen(false);
  };

  return (
    <div className="relative">
      <label htmlFor={id} className="mb-1 block text-sm font-semibold">
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-lg border-2 border-[var(--border)] bg-[var(--surface)] px-3 focus-within:border-[var(--accent)]">
        <span aria-hidden className="text-lg">
          {marker}
        </span>
        <input
          id={id}
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={showList && results[active] ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          placeholder="Ketik nama stasiun…"
          className="min-h-12 w-full bg-transparent text-base outline-none"
          value={text}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
            setActive(0);
            if (value) onChange(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (!showList) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && results[active]) {
              e.preventDefault();
              choose(results[active].id);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        {text && (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Kosongkan ${label}`}
            onClick={() => {
              setDraft(null);
              onChange(null);
            }}
          >
            ✕
          </button>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {showList ? `${results.length} saran tersedia` : ""}
      </p>
      {showList && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg"
        >
          {results.length === 0 && (
            <li className="px-3 py-3 text-sm text-[var(--muted)]">Stasiun tidak ditemukan dalam cakupan NTD saat ini.</li>
          )}
          {results.map((s, i) => {
            const line = lineById(s.lineIds[0])!;
            return (
              <li
                key={s.id}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={`flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 ${i === active ? "bg-[var(--accent-soft)]" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(s.id);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ background: line.color }} />
                <span>
                  <span className="block font-medium">{s.name}</span>
                  <span className="block text-sm text-[var(--muted)]">
                    {line.operator} · {line.name}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
