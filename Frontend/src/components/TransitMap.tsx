"use client";

import { useEffect, useRef, useState } from "react";
import { MAP_ASSET, legGeometry, ridePath } from "@/lib/map-assets";
import { useNetwork } from "@/lib/network";
import type { Route } from "@/lib/types";
import { AccessBadge } from "./AccessBadge";

type Props = {
  originId: string | null;
  destinationId: string | null;
  route: Route | null;
  onSetOrigin: (id: string) => void;
  onSetDestination: (id: string) => void;
  onShowDetail: (id: string) => void;
};

type View = { x: number; y: number; w: number };

const MIN_W = 450;
const MAX_W = MAP_ASSET.width;
const TOUCH_PX = 22; // radius area sentuh di layar (diameter 44 px)

/**
 * Peta Transit Interaktif. Lapisan dasar = Peta Integrasi Transportasi Umum Jakarta (FDTJ) dalam SVG;
 * di atasnya digambar titik stasiun yang bisa dipilih, sorotan rute, dan status aksesibilitas
 * memakai indeks posisi (kode stasiun -> x, y). Peta hanya untuk memilih dan menyorot, bukan menghitung rute.
 */
export function TransitMap({ originId, destinationId, route, onSetOrigin, onSetDestination, onShowDetail }: Props) {
  const { stations: STATIONS, hubs: HUBS, lineById, assess, positionOf, mapTracks } = useNetwork();
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 520 });
  const [view, setView] = useState<View>({ x: MAP_ASSET.initialView.x, y: MAP_ASSET.initialView.y, w: MAP_ASSET.initialView.width });
  const [loaded, setLoaded] = useState(false);
  const [popup, setPopup] = useState<string | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; x: number; y: number; dist: number; moved: boolean } | null>(null);

  useEffect(() => {
    // Muat aset peta lebih dulu agar status "Memuat peta" akurat (onLoad pada <image> SVG tidak andal).
    const img = new window.Image();
    img.onload = () => setLoaded(true);
    img.src = MAP_ASSET.src;
    return () => {
      img.onload = null;
    };
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const aspect = size.h / Math.max(size.w, 1);
  const viewH = view.w * aspect;
  const scale = size.w / view.w; // px layar per satuan peta
  const px = (n: number) => n / scale; // ukuran tetap di layar, dikonversi ke satuan peta

  const clamp = (v: View): View => {
    const w = Math.min(Math.max(v.w, MIN_W), MAX_W);
    const h = w * aspect;
    return {
      w,
      x: Math.min(Math.max(v.x, -w * 0.25), MAP_ASSET.width - w * 0.75),
      y: Math.min(Math.max(v.y, -h * 0.25), MAP_ASSET.height - h * 0.75),
    };
  };

  const zoomAt = (factor: number, cx = view.x + view.w / 2, cy = view.y + viewH / 2) => {
    setView((v) => {
      const w = Math.min(Math.max(v.w / factor, MIN_W), MAX_W);
      const k = w / v.w;
      return clamp({ w, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
    });
  };

  const toMap = (clientX: number, clientY: number) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: view.x + (clientX - r.left) / scale, y: view.y + (clientY - r.top) / scale };
  };

  const fitRoute = () => {
    if (!route) return;
    const pts = route.legs.flatMap((l) => l.stops).map((s) => positionOf(s)).filter((p) => !!p);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const pad = 220;
    const w = Math.max(Math.max(...xs) - Math.min(...xs) + pad * 2, (Math.max(...ys) - Math.min(...ys) + pad * 2) / aspect, MIN_W);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    setView(clamp({ w, x: cx - w / 2, y: cy - (w * aspect) / 2 }));
  };

  // Saat hasil rute baru tiba, arahkan peta ke rute tersebut.
  const routeKey = route?.legs.map((l) => l.stops.join(">")).join("|") ?? "";
  useEffect(() => {
    if (routeKey) queueMicrotask(fitRoute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  const routeStops = new Set(route?.legs.flatMap((l) => l.stops) ?? []);
  const popupStation = popup ? STATIONS.find((s) => s.id === popup) : null;
  const statusColor = (id: string) => {
    const a = assess(id);
    return !a.dataAvailable ? "var(--muted)" : a.adequate ? "var(--ok)" : "var(--warn)";
  };
  const statusIcon = (id: string) => {
    const a = assess(id);
    return !a.dataAvailable ? "?" : a.adequate ? "✔" : "!";
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-[var(--border)] bg-white">
      <a href="#hasil" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-30 focus:rounded focus:bg-[var(--surface)] focus:p-2">
        Lewati peta
      </a>
      <div ref={boxRef} className="relative h-[360px] w-full md:h-[560px]">
        {!loaded && (
          <p className="absolute inset-0 grid place-items-center text-sm text-[var(--muted)]" role="status">
            Memuat peta…
          </p>
        )}
        <svg
          role="group"
          aria-label="Peta Integrasi Transportasi Umum Jakarta. Stasiun bertanda lingkaran biru dapat dipilih sebagai asal atau tujuan."
          viewBox={`${view.x} ${view.y} ${view.w} ${viewH}`}
          className="absolute inset-0 block h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
          onWheel={(e) => {
            const p = toMap(e.clientX, e.clientY);
            zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, p.x, p.y);
          }}
          onPointerDown={(e) => {
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const ps = [...pointers.current.values()];
            const dist = ps.length === 2 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
            gesture.current = { view, x: e.clientX, y: e.clientY, dist, moved: false };
          }}
          onPointerMove={(e) => {
            const g = gesture.current;
            if (!g || !pointers.current.has(e.pointerId)) return;
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const ps = [...pointers.current.values()];
            if (ps.length === 2 && g.dist > 0) {
              const d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
              const w = Math.min(Math.max((g.view.w * g.dist) / d, MIN_W), MAX_W);
              const k = w / g.view.w;
              const cx = g.view.x + g.view.w / 2;
              const cy = g.view.y + (g.view.w * aspect) / 2;
              g.moved = true;
              setView(clamp({ w, x: cx - (cx - g.view.x) * k, y: cy - (cy - g.view.y) * k }));
              return;
            }
            const dx = (e.clientX - g.x) / scale;
            const dy = (e.clientY - g.y) / scale;
            if (Math.abs(e.clientX - g.x) + Math.abs(e.clientY - g.y) > 4) g.moved = true;
            if (g.moved) setView(clamp({ w: g.view.w, x: g.view.x - dx, y: g.view.y - dy }));
          }}
          onPointerUp={(e) => {
            pointers.current.delete(e.pointerId);
            setTimeout(() => {
              if (pointers.current.size === 0) gesture.current = null;
            }, 0);
          }}
          onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
        >
          {/* Lapisan dasar: peta FDTJ */}
          <image href={MAP_ASSET.src} x={0} y={0} width={MAP_ASSET.width} height={MAP_ASSET.height} />

          {/* Saat ada hasil: redupkan peta, lalu sorot rute */}
          {route && <rect x={0} y={0} width={MAP_ASSET.width} height={MAP_ASSET.height} fill="#ffffff" opacity={0.6} />}

          {route?.legs.map((leg, i) => {
            const placed = leg.stops.flatMap((id) => {
              const p = positionOf(id);
              return p ? [{ id, ...p }] : [];
            });
            const color = leg.type === "RIDE" ? (lineById(leg.lineId!)?.color ?? "#555555") : "#111111";
            // Ruas naik mengikuti bentuk jalur dari admin atau jalur di peta antar pemberhentian; jalur yang tak
            // terbaca memakai bentuk lini kurasi, lalu garis lurus. Perpindahan tetap garis lurus.
            const shaped = leg.type === "RIDE" ? legGeometry(leg.lineId!, leg.stops[0], leg.stops[leg.stops.length - 1]) : [];
            const traced = leg.type === "RIDE" ? ridePath(placed, color, { lineId: leg.lineId, tracks: mapTracks }) : placed.map((p) => [p.x, p.y] as [number, number]);
            const pts = leg.type === "RIDE" && traced.length <= placed.length && shaped.length >= 2 ? shaped : traced;
            if (pts.length < 2 || (leg.type === "TRANSFER" && leg.stops[0] === leg.stops[1])) return null;
            const d = pts.map((p) => p.join(",")).join(" ");
            return (
              <g key={i}>
                <polyline points={d} fill="none" stroke="#ffffff" strokeWidth={px(leg.type === "RIDE" ? 16 : 10)} strokeLinecap="round" strokeLinejoin="round" />
                <polyline
                  points={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={px(leg.type === "RIDE" ? 10 : 4)}
                  strokeDasharray={leg.type === "TRANSFER" ? `${px(8)} ${px(6)}` : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}

          {/* Area hub MVP */}
          {!route &&
            HUBS.map((hub) => {
              const pts = hub.memberIds.map((id) => positionOf(id)).filter((p) => !!p);
              if (!pts.length) return null;
              const xs = pts.map((p) => p.x);
              const ys = pts.map((p) => p.y);
              // Hub yang anggotanya berjauhan di peta skematik tidak diberi bingkai.
              if (Math.max(...xs) - Math.min(...xs) > 700 || Math.max(...ys) - Math.min(...ys) > 700) return null;
              return (
                <rect
                  key={hub.id}
                  x={Math.min(...xs) - 120}
                  y={Math.min(...ys) - 120}
                  width={Math.max(...xs) - Math.min(...xs) + 240}
                  height={Math.max(...ys) - Math.min(...ys) + 240}
                  rx={60}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={px(2)}
                  strokeDasharray={`${px(6)} ${px(5)}`}
                />
              );
            })}

          {/* Stasiun dalam cakupan data: bisa ditekan */}
          {STATIONS.map((s) => {
            const p = positionOf(s.id);
            if (!p) return null;
            const onRoute = routeStops.has(s.id);
            const isOrigin = s.id === originId;
            const isDest = s.id === destinationId;
            const faded = route && !onRoute;
            const bus = s.lineIds.some((l) => lineById(l)?.mode === "BUS");
            return (
              <g
                key={s.id}
                role="button"
                tabIndex={0}
                aria-label={`${s.name} (${s.codes.join(", ")})${isOrigin ? ", asal" : ""}${isDest ? ", tujuan" : ""}. Tekan untuk memilih.`}
                className="cursor-pointer outline-none [&:focus-visible>.focus]:opacity-100"
                opacity={faded ? 0.35 : 1}
                onClick={() => {
                  if (gesture.current?.moved) return;
                  setPopup(s.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setPopup(s.id);
                  }
                }}
              >
                <circle cx={p.x} cy={p.y} r={px(TOUCH_PX)} fill="transparent" />
                <circle className="focus opacity-0" cx={p.x} cy={p.y} r={px(TOUCH_PX)} fill="none" stroke="var(--accent)" strokeWidth={px(4)} />
                {onRoute ? (
                  <>
                    <circle cx={p.x} cy={p.y} r={px(11)} fill="#ffffff" stroke={statusColor(s.id)} strokeWidth={px(4)} />
                    <text x={p.x} y={p.y + px(4.5)} textAnchor="middle" fontSize={px(12)} fontWeight={700} fill={statusColor(s.id)}>
                      {statusIcon(s.id)}
                    </text>
                  </>
                ) : (
                  <circle cx={p.x} cy={p.y} r={px(bus ? 9 : 13)} fill="none" stroke="var(--accent)" strokeWidth={px(bus ? 2 : 3)} opacity={0.85} />
                )}
              </g>
            );
          })}

          {/* Penanda asal dan tujuan */}
          {[
            { id: originId, label: "A", fill: "#0a58ca" },
            { id: destinationId, label: "B", fill: "#b3261e" },
          ].map(({ id, label, fill }) => {
            const p = id ? positionOf(id) : null;
            if (!p) return null;
            return (
              <g key={label} transform={`translate(${p.x} ${p.y}) scale(${1 / scale})`} pointerEvents="none">
                <path d="M0 -14 C -12 -26 -14 -38 -14 -44 a14 14 0 1 1 28 0 c0 6 -2 18 -14 30z" fill={fill} stroke="#fff" strokeWidth={2} />
                <text x={0} y={-39} textAnchor="middle" fontSize={14} fontWeight={800} fill="#fff">
                  {label}
                </text>
              </g>
            );
          })}
        </svg>

        {popupStation && (
          <div
            role="dialog"
            aria-label={`Stasiun ${popupStation.name}`}
            className="absolute left-1/2 top-3 z-20 w-[min(320px,calc(100%-24px))] -translate-x-1/2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-lg font-bold">{popupStation.name}</p>
                <p className="text-sm text-[var(--muted)]">
                  {popupStation.lineIds.map((l) => lineById(l)?.name ?? l).join(" · ")} · {popupStation.codes.join("/")}
                </p>
              </div>
              <button className="icon-btn" aria-label="Tutup" onClick={() => setPopup(null)} autoFocus>
                ✕
              </button>
            </div>
            <p className="mt-2 text-sm">
              Aksesibilitas: <AccessBadge a={assess(popupStation.id)} />
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  onSetOrigin(popupStation.id);
                  setPopup(null);
                }}
              >
                Jadikan Asal
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  onSetDestination(popupStation.id);
                  setPopup(null);
                }}
              >
                Jadikan Tujuan
              </button>
            </div>
            <button
              className="btn btn-link mt-2 w-full"
              onClick={() => {
                onShowDetail(popupStation.id);
                setPopup(null);
              }}
            >
              Lihat fasilitas →
            </button>
          </div>
        )}

        <div className="absolute right-3 top-3 flex flex-col gap-1">
          <button className="map-btn" aria-label="Perbesar peta" onClick={() => zoomAt(1.4)}>
            +
          </button>
          <button className="map-btn" aria-label="Perkecil peta" onClick={() => zoomAt(1 / 1.4)}>
            −
          </button>
          <button
            className="map-btn"
            aria-label={route ? "Tampilkan seluruh rute" : "Kembali ke area hub"}
            onClick={() => (route ? fitRoute() : setView({ x: MAP_ASSET.initialView.x, y: MAP_ASSET.initialView.y, w: MAP_ASSET.initialView.width }))}
          >
            ⟲
          </button>
          <button className="map-btn text-sm" aria-label="Tampilkan seluruh peta" onClick={() => setView({ x: 0, y: 0, w: MAX_W })}>
            ⤢
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs">
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-3 w-3 rounded-full border-2 border-[var(--accent)]" /> stasiun/halte dalam cakupan NTD
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="font-bold text-[var(--ok)]">✔</span> memadai
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="font-bold text-[var(--warn)]">!</span> perlu perhatian
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="font-bold text-[var(--muted)]">?</span> data tidak tersedia
        </span>
        <span className="w-full text-[var(--muted)]">{MAP_ASSET.credit} Data © Commute Data API (ODbL-1.0).</span>
      </div>
    </div>
  );
}
