// Perhitungan bantu untuk daftar dan detail perjalanan (sidebar gaya perencana perjalanan).

import type { JourneyPlan, Route, RouteLeg, RouteOption } from "./types";

/** Urutan hasil yang dipilih pengguna ("Tampilkan"). */
export type SortPref = "aksesibel" | "tercepat" | "pindah" | "jalan";

export const SORT_LABEL: Record<SortPref, string> = {
  aksesibel: "Rute paling aksesibel",
  tercepat: "Rute tercepat",
  pindah: "Paling sedikit pindah",
  jalan: "Paling sedikit jalan kaki",
};

/** Jam WIB dari waktu ISO, mis. "08.03". */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
/** Tanggal WIB (YYYY-MM-DD) dari waktu ISO. */
export const wibDate = (iso: string) => new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(0, 10);
export const rupiah = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
export const km = (m: number) => `${(m / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} km`;
/** Durasi ringkas, mis. "1 j 5 mnt" atau "56 mnt". */
export const duration = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} j ${m % 60} mnt` : `${m} mnt`);

/** Ruas pindah yang berjalan kaki ke stasiun/halte lain (bukan pindah lini di stasiun yang sama). */
export const isWalk = (l: RouteLeg) => l.type === "TRANSFER" && l.stops[0] !== l.stops[l.stops.length - 1] && !l.turnaround;

/** Total jalan kaki antarpemberhentian: menit dan meter. */
export function walking(route: Route) {
  const legs = route.legs.filter(isWalk);
  return {
    minutes: legs.reduce((s, l) => s + (l.minutes ?? 0), 0),
    meters: legs.reduce((s, l) => s + l.distanceM, 0),
    count: legs.length,
    /** false = ada ruas jalan kaki tanpa data waktu. */
    complete: legs.every((l) => l.minutes !== null),
  };
}

/** Durasi pilihan rute: dari jam berangkat sampai tiba bila jadwal diketahui, selain itu total waktu tempuh. */
export function spanMinutes(o: Pick<RouteOption, "summary">): number | null {
  const s = o.summary;
  return s.departureAt && s.arrivalAt ? Math.round((Date.parse(s.arrivalAt) - Date.parse(s.departureAt)) / 60_000) : s.minutes;
}

/** Pilihan rute sebagai daftar (rencana lama tanpa `options` dianggap satu pilihan). */
export function optionsOf(plan: JourneyPlan): RouteOption[] {
  if (plan.options?.length) return plan.options;
  const first = plan.route.legs.find((l) => l.type === "RIDE" && l.departureAt);
  const last = [...plan.route.legs].reverse().find((l) => l.type === "RIDE" && l.arrivalAt);
  return [
    {
      kinds: ["aksesibel"],
      origin: "dataset",
      route: plan.route,
      assessments: plan.assessments,
      warnings: plan.warnings,
      summary: {
        accessScore: Math.round(plan.assessments.reduce((s, a) => s + a.score, 0) / Math.max(plan.assessments.length, 1)),
        minScore: Math.min(...plan.assessments.map((a) => a.score)),
        minutes: plan.route.totalMinutes,
        departureAt: first?.departureAt,
        arrivalAt: last?.arrivalAt,
        transfers: plan.route.transfers,
        unmetNeeds: 0,
        usesAvoidedModes: false,
      },
      notification: plan.notification,
      alternatives: plan.alternatives,
    },
  ];
}

/**
 * Urutan tampil pilihan rute (indeks ke `options`). "aksesibel" mengikuti urutan Backend (paling aksesibel dulu).
 * Pada mode "Tiba", pilihan yang tiba setelah batas waktu ditaruh di akhir.
 */
export function sortedIndices(options: RouteOption[], pref: SortPref, arriveBy?: string): number[] {
  const idx = options.map((_, i) => i);
  const end = (i: number) => (options[i].summary.arrivalAt ? Date.parse(options[i].summary.arrivalAt!) : Infinity);
  const mins = (i: number) => spanMinutes(options[i]) ?? Infinity;
  const time = (i: number) => (Number.isFinite(end(i)) ? end(i) : mins(i));
  const walk = (i: number) => walking(options[i].route).minutes;
  const late = (i: number) => (arriveBy && options[i].summary.arrivalAt && Date.parse(options[i].summary.arrivalAt!) > Date.parse(arriveBy) ? 1 : 0);
  const by: Record<SortPref, (a: number, b: number) => number> = {
    aksesibel: (a, b) => a - b,
    tercepat: (a, b) => time(a) - time(b) || mins(a) - mins(b) || a - b,
    pindah: (a, b) => options[a].summary.transfers - options[b].summary.transfers || time(a) - time(b) || a - b,
    jalan: (a, b) => walk(a) - walk(b) || time(a) - time(b) || a - b,
  };
  return idx.sort((a, b) => late(a) - late(b) || by[pref](a, b));
}

/** Jam di awal tiap ruas dan jam tiba di tujuan, dari jadwal ruas naik (bila diketahui). */
export function legTimes(route: Route): { start: (string | undefined)[]; end: string | undefined } {
  const start: (string | undefined)[] = [];
  let t: number | undefined;
  for (const l of route.legs) {
    if (l.type === "RIDE" && l.departureAt) {
      start.push(l.departureAt);
      t = l.arrivalAt ? Date.parse(l.arrivalAt) : undefined;
    } else {
      start.push(t !== undefined ? new Date(t).toISOString() : undefined);
      if (t !== undefined) t = l.type === "RIDE" ? (l.arrivalAt ? Date.parse(l.arrivalAt) : undefined) : t + (l.minutes ?? 0) * 60_000;
    }
  }
  return { start, end: t !== undefined ? new Date(t).toISOString() : undefined };
}

/** Kode rute bus dari id lin, mis. "tj:13e" → "13E"; undefined bila bukan kode pendek. */
export function busCode(lineId?: string): string | undefined {
  const code = lineId?.split(":").pop();
  return code && code.length <= 5 ? code.toUpperCase() : undefined;
}

/** Nama ruas naik: "Bus 1" untuk bus (nama koridor di `title`), nama lin untuk kereta. */
export function rideName(mode: string, lineId: string | undefined, lineName: string | undefined): string {
  if (mode !== "BUS") return lineName ?? lineId ?? "";
  const code = busCode(lineId);
  return code ? `Bus ${code}` : `Bus ${lineName ?? lineId ?? ""}`;
}
