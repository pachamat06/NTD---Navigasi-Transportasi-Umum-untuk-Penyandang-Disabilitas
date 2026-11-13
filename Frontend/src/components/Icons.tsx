// Piktogram sederhana (SVG) untuk langkah perjalanan dan fasilitas. Selalu dekoratif (aria-hidden): makna
// disampaikan lewat teks di sebelahnya.

import type { ReactNode } from "react";
import type { Mode } from "@/lib/types";

type P = { className?: string; size?: number };

const svg = (size: number, className: string | undefined, children: ReactNode) => (
  <svg aria-hidden viewBox="0 0 24 24" width={size} height={size} className={className} focusable="false">
    {children}
  </svg>
);

export function WalkIcon({ className, size = 22 }: P) {
  return svg(
    size,
    className,
    <>
      <circle cx="13.5" cy="3.8" r="2.2" fill="currentColor" />
      <path
        d="M11.5 8 9.6 14.2 6.5 21M11.5 8l2.6 4.6 3.4 1.2M10.2 13.6l3.3 2.6 1 4.8M11.5 8 8.3 9.7 7 13"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>,
  );
}

function TrainShape({ variant }: { variant: "rail" | "metro" | "tram" | "mono" }) {
  return (
    <>
      {variant === "tram" && <path d="M8 2.5h8M12 2.5v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      {variant === "mono" && <rect x="4" y="19.2" width="16" height="2.6" rx="1" fill="currentColor" />}
      <rect x="5" y={variant === "tram" ? 5 : 3} width="14" height={variant === "tram" ? 13 : 15} rx={variant === "metro" ? 5 : 3} fill="currentColor" />
      <rect x="7.2" y={variant === "tram" ? 7.2 : 5.6} width="9.6" height="5" rx="1.2" fill="var(--icon-bg, #fff)" />
      <circle cx="8.7" cy="15" r="1.2" fill="var(--icon-bg, #fff)" />
      <circle cx="15.3" cy="15" r="1.2" fill="var(--icon-bg, #fff)" />
      {variant !== "mono" && <path d="M8.5 18.5 6.5 21.5M15.5 18.5l2 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </>
  );
}

export function BusIcon({ className, size = 22 }: P) {
  return svg(
    size,
    className,
    <>
      <rect x="4" y="2.5" width="16" height="16" rx="2.5" fill="currentColor" />
      <rect x="6" y="5" width="12" height="6" rx="1" fill="var(--icon-bg, #fff)" />
      <circle cx="8" cy="15" r="1.2" fill="var(--icon-bg, #fff)" />
      <circle cx="16" cy="15" r="1.2" fill="var(--icon-bg, #fff)" />
      <rect x="5.5" y="18" width="3" height="3.5" rx="1" fill="currentColor" />
      <rect x="15.5" y="18" width="3" height="3.5" rx="1" fill="currentColor" />
    </>,
  );
}

/** Ikon moda; warna mengikuti warna lin bila diberikan. */
export function ModeIcon({ mode, color, className, size = 22 }: P & { mode: Mode | string; color?: string }) {
  const style = color ? { color } : undefined;
  if (mode === "BUS")
    return (
      <span style={style} className="inline-flex">
        <BusIcon className={className} size={size} />
      </span>
    );
  const variant = mode === "SUBWAY" ? "metro" : mode === "TRAM" ? "tram" : mode === "MONORAIL" ? "mono" : "rail";
  return (
    <span style={style} className="inline-flex">
      {svg(size, className, <TrainShape variant={variant} />)}
    </span>
  );
}

export function LiftIcon({ className, size = 20 }: P) {
  return svg(
    size,
    className,
    <>
      <rect x="4" y="2.5" width="16" height="19" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 2.5v19" stroke="currentColor" strokeWidth="1" />
      <path d="M8 7.5l-2.2 3h4.4zM16 16.5l-2.2-3h4.4z" fill="currentColor" />
    </>,
  );
}

export function EscalatorIcon({ className, size = 20 }: P) {
  return svg(
    size,
    className,
    <>
      <path d="M2.5 19.5h4.5L17 8.5h4.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11.5" cy="4.5" r="1.7" fill="currentColor" />
      <path d="M11 7.5v5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>,
  );
}

export function StairsIcon({ className, size = 20 }: P) {
  return svg(size, className, <path d="M2.5 20.5h5v-5h5v-5h5v-5h4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />);
}

export function RampIcon({ className, size = 20 }: P) {
  return svg(size, className, <path d="M2.5 19.5 21.5 9.5v10z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />);
}

export function LevelIcon({ className, size = 20 }: P) {
  return svg(
    size,
    className,
    <path d="M2.5 12h19M6 8.5 2.5 12 6 15.5M18 8.5l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  );
}

export function WarnIcon({ className, size = 22 }: P) {
  return svg(
    size,
    className,
    <>
      <path d="M12 2.8 22 20.5H2z" fill="#ffd400" stroke="#1a1a1a" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M12 9v5.5" stroke="#1a1a1a" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="17.3" r="1.3" fill="#1a1a1a" />
    </>,
  );
}

export function SwapIcon({ className, size = 22 }: P) {
  return svg(
    size,
    className,
    <path
      d="M8 20V4M8 4 4.5 7.5M8 4l3.5 3.5M16 4v16M16 20l-3.5-3.5M16 20l3.5-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />,
  );
}

export function Chevron({ dir = "down", className, size = 18 }: P & { dir?: "down" | "up" | "left" | "right" }) {
  const rot = { down: 0, up: 180, left: 90, right: -90 }[dir];
  return svg(
    size,
    className,
    <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" transform={`rotate(${rot} 12 12)`} />,
  );
}
