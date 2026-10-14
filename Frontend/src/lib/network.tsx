"use client";

// Data jaringan (stasiun, lini, hub, fasilitas, skor) dimuat sekali dari Backend lalu dibagikan ke semua komponen.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchMeta, fetchNetwork } from "./api";
import type { AmenityType, Hub, Line, Meta, NetworkStation, StationAssessment } from "./types";

export const AMENITY_LABEL: Record<AmenityType, string> = {
  lift: "Lift",
  eskalator: "Eskalator",
  toilet: "Toilet aksesibel",
  ramp: "Ramp",
};

const UNKNOWN: Omit<StationAssessment, "stationId"> = { score: 0, adequate: false, dataAvailable: false };

export interface NetworkValue {
  stations: NetworkStation[];
  lines: Line[];
  hubs: Hub[];
  meta: Meta | null;
  stationById: (id: string) => NetworkStation | undefined;
  lineById: (id: string) => Line | undefined;
  hubById: (id: string) => Hub | undefined;
  assess: (id: string) => StationAssessment;
  searchStations: (query: string) => NetworkStation[];
  amenityLabel: (type: string) => string;
}

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; value: NetworkValue };

const NetworkContext = createContext<NetworkValue | null>(null);

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function build(stations: NetworkStation[], lines: Line[], hubs: Hub[], meta: Meta | null): NetworkValue {
  const st = new Map(stations.map((s) => [s.id, s]));
  const ln = new Map(lines.map((l) => [l.id, l]));
  const hb = new Map(hubs.map((h) => [h.id, h]));
  return {
    stations,
    lines,
    hubs,
    meta,
    stationById: (id) => st.get(id),
    lineById: (id) => ln.get(id),
    hubById: (id) => hb.get(id),
    assess: (id) => st.get(id)?.assessment ?? { stationId: id, ...UNKNOWN },
    // Sama dengan urutan pencarian Backend (GET /api/stations?q=): kode persis, awalan nama, awalan kata, lalu memuat.
    searchStations: (query) => {
      const q = normalize(query);
      if (q.length < 2) return [];
      return stations
        .map((s) => {
          const name = normalize(s.name);
          const rank = s.codes.some((c) => c.toLowerCase() === q) ? 0 : name.startsWith(q) ? 1 : name.split(" ").some((w) => w.startsWith(q)) ? 2 : name.includes(q) ? 3 : -1;
          return { s, rank };
        })
        .filter((x) => x.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.s.name.localeCompare(b.s.name, "id"))
        .slice(0, 6)
        .map((x) => x.s);
    },
    amenityLabel: (type) => meta?.amenityLabels[type] ?? AMENITY_LABEL[type as AmenityType] ?? type,
  };
}

export function NetworkProvider({ children, fallback }: { children: ReactNode; fallback: (state: { error?: string; retry: () => void }) => ReactNode }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const [net, meta] = await Promise.all([fetchNetwork(), fetchMeta()]);
    if (net.status === "error") return setState({ kind: "error", message: net.message });
    setState({ kind: "ready", value: build(net.data.stations, net.data.lines, net.data.hubs, meta.status === "ok" ? meta.data : null) });
  }, []);

  useEffect(() => {
    queueMicrotask(load);
  }, [load]);

  const value = state.kind === "ready" ? state.value : null;
  const node = useMemo(() => (value ? <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider> : null), [value, children]);
  if (state.kind !== "ready") return <>{fallback({ error: state.kind === "error" ? state.message : undefined, retry: load })}</>;
  return node;
}

export function useNetwork(): NetworkValue {
  const v = useContext(NetworkContext);
  if (!v) throw new Error("useNetwork harus dipakai di dalam NetworkProvider");
  return v;
}
