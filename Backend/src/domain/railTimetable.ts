// Waktu tempuh dan frekuensi moda rel (KRL, MRT, LRT Jabodebek, LRT Jakarta, Kalayang) dari jadwal Commute
// (/stations/{op}/{code}/timetable). /fares tidak memuat jam, tetapi jadwal tiap stasiun memuat nomor perjalanan
// (tripNumber) dan jam berangkatnya: waktu tempuh = jam berangkat di stasiun tujuan dikurangi jam berangkat di stasiun
// asal pada nomor perjalanan yang sama. Frekuensi = rata-rata selisih keberangkatan berurutan yang sampai ke tujuan.
// TransJakarta tetap memakai GTFS (RoutePlannerService.withGtfsTimes).

import type { UpDeparture } from "../data/commute/types";

/** Satu perjalanan yang berhenti di stasiun asal lalu di stasiun tujuan ruas. Menit sejak tengah malam (Jakarta). */
export interface TripMatch {
  trip: string;
  depart: number;
  /** Bisa lebih dari 1440 bila perjalanan melewati tengah malam. */
  arrive: number;
  /** Ganti kereta di stasiun ini (kereta pertama berakhir di sana), lalu kereta sambungan berangkat `changeDepart`. */
  changeAt?: string;
  changeDepart?: number;
}

/** Ruas rel paling lama yang masuk akal (menit); di atasnya nomor perjalanan dianggap kebetulan sama. */
const MAX_RIDE_MINUTES = 240;

/**
 * Perjalanan yang berangkat dari `from` lalu tiba di `to` (nomor perjalanan sama, jam di `to` setelah jam di `from`).
 * Arah sebaliknya otomatis tersaring karena jam di `to` lebih awal. Urut menurut jam berangkat.
 */
export function matchTrips(from: UpDeparture[], to: UpDeparture[]): TripMatch[] {
  const at = new Map<string, number>();
  for (const d of to) if (!at.has(d.tripNumber)) at.set(d.tripNumber, d.minutes);
  const out: TripMatch[] = [];
  for (const d of from) {
    const t = at.get(d.tripNumber);
    if (t === undefined) continue;
    const arrive = t >= d.minutes ? t : t + 1440;
    const minutes = arrive - d.minutes;
    if (minutes <= 0 || minutes > MAX_RIDE_MINUTES) continue;
    out.push({ trip: d.tripNumber, depart: d.minutes, arrive });
  }
  return out.sort((a, b) => a.depart - b.depart || a.arrive - b.arrive);
}

/**
 * Stasiun tujuan ruas adalah stasiun akhir perjalanan (mis. Bundaran HI untuk MRT arah utara): kereta yang berakhir di
 * sana tidak tercantum di jadwal keberangkatannya. Dipakai keberangkatan di stasiun asal yang tujuan akhirnya stasiun
 * itu (`endsAt`); jam tiba dari `arriveFinal` bila dataset memuatnya, selain itu dari waktu tempuh arah sebaliknya.
 */
export function terminusTrips(from: UpDeparture[], reverse: TripMatch[], endsAt: (boundFor?: string) => boolean): TripMatch[] {
  const back = reverse.map((m) => m.arrive - m.depart).sort((a, b) => a - b);
  const typical = back.length ? back[Math.floor(back.length / 2)] : undefined;
  const out: TripMatch[] = [];
  for (const d of from) {
    if (!endsAt(d.boundFor)) continue;
    const final = d.arriveFinal !== undefined ? (d.arriveFinal >= d.minutes ? d.arriveFinal : d.arriveFinal + 1440) : undefined;
    const arrive = final !== undefined && final - d.minutes <= MAX_RIDE_MINUTES ? final : typical !== undefined ? d.minutes + typical : undefined;
    if (arrive === undefined || arrive <= d.minutes) continue;
    out.push({ trip: d.tripNumber, depart: d.minutes, arrive });
  }
  return out.sort((a, b) => a.depart - b.depart);
}

/** Perjalanan pertama yang berangkat pada atau setelah `ready` (menit sejak tengah malam). */
export function nextTrip(matches: TripMatch[], ready: number): TripMatch | undefined {
  return matches.find((m) => m.depart >= ready);
}

/** Waktu tempuh yang umum (median) di sekitar `ready`, untuk ruas yang tidak punya perjalanan lagi hari itu. */
export function typicalMinutes(matches: TripMatch[], ready: number): number | undefined {
  if (!matches.length) return undefined;
  const near = matches.filter((m) => Math.abs(m.depart - ready) <= 120);
  const list = (near.length ? near : matches).map((m) => m.arrive - m.depart).sort((a, b) => a - b);
  return list[Math.floor(list.length / 2)];
}

/**
 * Rata-rata jarak antarkeberangkatan (menit) dalam dua jam sejak `ready`; bila keberangkatannya kurang dari dua,
 * rata-rata sehari. undefined bila hanya ada satu perjalanan.
 */
export function headwayAround(matches: TripMatch[], ready: number): number | undefined {
  const departs = [...new Set(matches.map((m) => m.depart))].sort((a, b) => a - b);
  const window = departs.filter((d) => d >= ready && d < ready + 120);
  const list = window.length >= 2 ? window : departs;
  if (list.length < 2) return undefined;
  return Math.max(1, Math.round((list[list.length - 1] - list[0]) / (list.length - 1)));
}

const hhmm = (min: number) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Jam operasional ruas ini: keberangkatan pertama sampai terakhir, mis. "04:41–23:55". */
export function serviceHours(matches: TripMatch[]): string | undefined {
  if (!matches.length) return undefined;
  return `${hhmm(matches[0].depart)}–${hhmm(matches[matches.length - 1].depart)}`;
}

/** Menit sejak tengah malam waktu Jakarta (UTC+7) untuk waktu `d`. */
export function jakartaMinutes(d: Date): number {
  const local = new Date(d.getTime() + 7 * 3600_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** Waktu ISO untuk `min` menit sejak tengah malam (Jakarta) pada hari yang sama dengan `ref`. */
export function isoAt(ref: Date, min: number): string {
  const local = new Date(ref.getTime() + 7 * 3600_000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 7 * 3600_000;
  return new Date(midnight + min * 60_000).toISOString();
}

/** Rata-rata jarak antarkeberangkatan (menit) sepanjang hari layanan; undefined bila kurang dari dua keberangkatan. */
export function averageHeadway(matches: TripMatch[]): number | undefined {
  const departs = [...new Set(matches.map((m) => m.depart))].sort((a, b) => a - b);
  if (departs.length < 2) return undefined;
  return Math.max(1, Math.round((departs[departs.length - 1] - departs[0]) / (departs.length - 1)));
}

/** Waktu tempuh yang umum (median, menit) dari semua perjalanan. */
export function medianMinutes(matches: TripMatch[]): number | undefined {
  if (!matches.length) return undefined;
  const list = matches.map((m) => m.arrive - m.depart).sort((a, b) => a - b);
  return list[Math.floor(list.length / 2)];
}
