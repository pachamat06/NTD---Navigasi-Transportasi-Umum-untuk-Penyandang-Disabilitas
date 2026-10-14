// Klien Backend NTD. Semua respons berbentuk {status, data} atau {status: "error", code, message} (Bab III 3.2.3).

import type { ApiResult, ErrorCode, JourneyPlan, Meta, Network, Notice, StationDetailData } from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

const KNOWN: ErrorCode[] = ["NOT_FOUND", "INVALID", "API_DOWN", "RATE_LIMITED", "INTERNAL"];

async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API_URL}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
    const body = await res.json().catch(() => null);
    if (body?.status === "ok") return { status: "ok", data: body.data as T };
    const code = KNOWN.includes(body?.code) ? (body.code as ErrorCode) : "INTERNAL";
    return { status: "error", code, message: body?.message ?? `Server NTD mengembalikan galat (${res.status}).` };
  } catch {
    return { status: "error", code: "NETWORK", message: "Server NTD tidak dapat dihubungi. Periksa koneksi internet lalu coba lagi." };
  }
}

export const fetchNetwork = () => call<Network>("/api/network");
export const fetchMeta = () => call<Meta>("/api/meta");
export const fetchNotices = () => call<Notice[]>("/api/notices");
export const fetchStationDetail = (id: string) => call<StationDetailData>(`/api/stations/${encodeURIComponent(id)}`);

export function planJourney(originId: string, destinationId: string, opts: { avoid?: string[]; signal?: AbortSignal } = {}) {
  const body = { originId, destinationId, ...(opts.avoid?.length ? { avoid: opts.avoid } : {}) };
  return call<JourneyPlan>("/api/plan", { method: "POST", body: JSON.stringify(body), signal: opts.signal });
}
