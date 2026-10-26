// Grounding Guard (Tabel 3.4 no. 6 dan 8): memastikan notifikasi hanya memuat fakta dari hasil tool,
// menyediakan template statis sebagai cadangan, dan menambahkan disclaimer di luar kendali LLM.

import { AMENITY_LABEL } from "../domain/FacilityAnalysisService";
import { CORE_AMENITIES, type Alternative, type Notice, type Notification, type Route, type StationAssessment, type StationDetail } from "../domain/models";

export const ATTRIBUTION =
  "Data stasiun, rute, dan fasilitas: Commute Data API (Shiori Labs), lisensi ODbL-1.0. Informasi tambahan dari tim NTD. Peta: Peta Integrasi Transportasi Umum Jakarta © FDTJ.";

/** Seluruh fakta yang boleh disebut notifikasi. */
export interface PlanFacts {
  route: Route;
  assessments: StationAssessment[];
  alternatives: Alternative[];
  stations: Map<string, StationDetail>;
  /** Nama semua stasiun yang dikenal sistem, untuk mendeteksi stasiun yang tidak ada di hasil. */
  knownStationNames: Map<string, string>;
  notices: Notice[];
}

export interface GuardResult {
  ok: boolean;
  reasons: string[];
}

const POSITIVE = /\b(tersedia|ada|dilengkapi|memiliki|berfungsi|bisa|dapat)\b/i;
const NEGATIVE = /\b(tidak|tak|belum|tanpa|rusak|gangguan|bukan)\b/i;

const AMENITY_WORDS: Record<string, RegExp> = {
  lift: /\b(lift|elevator)\b/i,
  eskalator: /\b(eskalator|escalator|tangga berjalan)\b/i,
  toilet: /\btoilet\b/i,
  ramp: /\b(ramp|ram)\b/i,
};

/**
 * Stasiun yang disebut dalam teks. Nama terpanjang dicocokkan lebih dulu lalu ditutup, agar
 * "Sudirman Baru BNI City" tidak ikut terbaca sebagai "Sudirman".
 */
export function findStations(text: string, names: Map<string, string>): string[] {
  let rest = text.toLowerCase();
  const found = new Set<string>();
  for (const [name, id] of [...names].sort((a, b) => b[0].length - a[0].length)) {
    if (name.length < 4 || !rest.includes(name)) continue;
    found.add(id);
    rest = rest.split(name).join(" \u0000 ");
  }
  return [...found];
}

const formatNumber = (n: number) => n.toLocaleString("id-ID");

export class GroundingGuard {
  /** Angka yang sah: tarif, jarak (m dan km), waktu, jumlah transfer, skor. Angka kecil 0–10 bebas dipakai. */
  private allowedNumbers(f: PlanFacts): Set<string> {
    const nums = new Set<string>();
    const add = (n: number | null | undefined) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return;
      nums.add(String(n));
      nums.add(formatNumber(n));
    };
    const addRoute = (r: Route) => {
      add(r.totalFare);
      add(r.totalDistanceM);
      add(r.totalMinutes);
      add(r.transfers);
      add(Number((r.totalDistanceM / 1000).toFixed(1)));
      nums.add((r.totalDistanceM / 1000).toFixed(1).replace(".", ","));
      for (const l of r.legs) {
        add(l.fare);
        add(l.distanceM);
        add(l.minutes);
        add(l.frequency?.headwayMinutes);
        for (const o of l.options ?? []) {
          add(o.frequency?.headwayMinutes);
          // Nomor koridor/lin (mis. "13E", "4D") boleh disebut.
          for (const n of `${o.lineId} ${o.lineName ?? ""}`.match(/\d+/g) ?? []) nums.add(n);
        }
        for (const n of `${l.lineId ?? ""} ${l.lineName ?? ""} ${l.notes ?? ""}`.match(/\d+/g) ?? []) nums.add(n);
        add(Number((l.distanceM / 1000).toFixed(1)));
        nums.add((l.distanceM / 1000).toFixed(1).replace(".", ","));
      }
    };
    addRoute(f.route);
    for (const a of f.alternatives) if (a.route) addRoute(a.route);
    for (const a of [...f.assessments, ...f.alternatives.map((x) => x.assessment)]) add(a.score);
    for (const s of f.stations.values()) for (const c of s.codes) nums.add(c.replace(/\D/g, ""));
    return nums;
  }

  validate(text: string, f: PlanFacts): GuardResult {
    const reasons: string[] = [];
    if (!text.trim()) reasons.push("teks kosong");
    if (text.length > 700) reasons.push("teks terlalu panjang");
    if (/https?:\/\//i.test(text)) reasons.push("memuat tautan");

    // 1. Stasiun yang disebut harus ada pada rute atau alternatif.
    for (const id of findStations(text, f.knownStationNames)) {
      if (!f.stations.has(id)) reasons.push(`menyebut stasiun di luar hasil: ${id}`);
    }

    // 2. Angka harus berasal dari hasil tool.
    const allowed = this.allowedNumbers(f);
    for (const m of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
      const raw = m[0];
      const plain = raw.replace(/\.(?=\d{3}\b)/g, "");
      if (Number(plain.replace(",", ".")) <= 10) continue;
      if (!allowed.has(raw) && !allowed.has(plain)) reasons.push(`angka tidak berasal dari data: ${raw}`);
    }

    // 3. Klaim fasilitas per kalimat harus sesuai status pada data.
    for (const sentence of text.split(/(?<=[.!?;])\s+/)) {
      const stationsHere = findStations(sentence, f.knownStationNames);
      if (!stationsHere.length) continue;
      for (const [type, re] of Object.entries(AMENITY_WORDS)) {
        if (!re.test(sentence)) continue;
        const negative = NEGATIVE.test(sentence);
        const positive = POSITIVE.test(sentence) && !negative;
        for (const id of stationsHere) {
          const st = f.stations.get(id);
          if (!st) continue;
          const status = st.amenities[type as (typeof CORE_AMENITIES)[number]];
          if (positive && status !== "available") reasons.push(`klaim ${type} tersedia di ${st.name} tidak sesuai data (${status})`);
          if (negative && status === "available" && !/data/i.test(sentence)) reasons.push(`klaim ${type} tidak ada di ${st.name} tidak sesuai data`);
        }
      }
    }
    return { ok: reasons.length === 0, reasons };
  }

  /** Template statis: hanya menyebut fakta yang ada pada hasil tool. */
  fallback(f: PlanFacts, lineName: (lineId: string) => { name: string; operator: string } | undefined): Notification {
    const name = (id: string) => f.stations.get(id)?.name ?? id;
    const parts: string[] = [];
    f.route.legs.forEach((leg, i) => {
      if (leg.type === "RIDE") {
        const line = leg.lineId ? lineName(leg.lineId) : undefined;
        const what = line ? `${line.operator} ${line.name}` : (leg.lineName ?? "kereta");
        const choices = leg.options && leg.options.length > 1 ? leg.options.map((o) => lineName(o.lineId)?.name ?? o.lineName ?? o.lineId) : null;
        const pick = choices ? ` (bisa juga ${choices.slice(1).join(", ")})` : "";
        const freq = leg.frequency ? `, biasanya tiap sekitar ${leg.frequency.headwayMinutes} menit` : "";
        parts.push(`${i === 0 ? "Naik" : "lalu naik"} ${what}${pick} dari ${name(leg.stops[0])} ke ${name(leg.stops[leg.stops.length - 1])}${freq}`);
      } else {
        parts.push(
          leg.stops[0] === leg.stops[1] ? `pindah lini di dalam Stasiun ${name(leg.stops[0])}` : `${i === 0 ? "Berjalan" : "pindah dengan berjalan kaki"} ke ${name(leg.stops[1])}`,
        );
      }
    });
    const key = new Set(f.route.legs.flatMap((l) => [l.stops[0], l.stops[l.stops.length - 1]]));
    const notes: string[] = [];
    for (const a of f.assessments.filter((x) => key.has(x.stationId))) {
      const st = f.stations.get(a.stationId);
      if (!st) continue;
      const liftNtd = st.amenityDetails.find((d) => d.type === "lift" && d.source === "ntd");
      if (liftNtd?.status === "out_of_service") notes.push(`Lift di ${st.name} dilaporkan sedang tidak berfungsi.`);
      else if (!a.dataAvailable) notes.push(`Data fasilitas ${st.name} belum tersedia.`);
      else if (st.amenities.lift === "available") notes.push(`Lift tercatat tersedia di ${st.name}.`);
      else if (st.amenities.lift === "unknown") notes.push(`Data lift di ${st.name} tidak tersedia.`);
      else notes.push(`Lift tidak tercatat di ${st.name}.`);
    }
    for (const leg of f.route.legs)
      for (const a of leg.access ?? [])
        if (a.status !== "available") {
          const label = AMENITY_LABEL[a.need] ?? a.need;
          const st = name(a.stationId);
          notes.push(a.status === "out_of_service" ? `${label} di ${st} untuk pindah dilaporkan tidak berfungsi.` : a.status === "absent" ? `${label} untuk pindah tidak tercatat di ${st}.` : `Data ${label.toLowerCase()} untuk pindah di ${st} belum tersedia.`);
        }
    if (f.alternatives.length) {
      const alt = f.alternatives[0];
      notes.push(`Alternatif transfer yang lebih aksesibel: melalui ${name(alt.viaStationId)}.`);
    }
    const urgent = f.notices.filter((n) => n.severity !== "info");
    if (urgent.length) notes.push(`Ada ${urgent.length} pengumuman penting terkait rute ini.`);
    return { text: `${parts.join(", ")}. ${notes.join(" ")}`.trim(), source: "TEMPLATE", grounded: true };
  }
}

/** Ringkasan fakta untuk prompt LLM (tanpa data yang tidak dibutuhkan). */
export function factsForPrompt(f: PlanFacts): unknown {
  const st = (id: string) => f.stations.get(id);
  return {
    rute: f.route.legs.map((l) => ({
      jenis: l.type === "RIDE" ? "naik" : l.stops[0] === l.stops[1] ? "pindah lini di stasiun yang sama" : "jalan kaki pindah stasiun",
      lini: l.lineName,
      operator: l.operator,
      dari: st(l.stops[0])?.name,
      ke: st(l.stops[l.stops.length - 1])?.name,
      jarakMeter: l.distanceM,
      menit: l.minutes,
      tarif: l.fare,
      ...(l.options && l.options.length > 1 ? { pilihanLin: l.options.map((o) => o.lineName ?? o.lineId) } : {}),
      ...(l.frequency ? { frekuensiMenit: l.frequency.headwayMinutes } : {}),
      ...(l.notes ? { petunjuk: l.notes } : {}),
      ...(l.access?.length ? { aksesPindah: l.access.map((a) => ({ stasiun: st(a.stationId)?.name ?? a.stationId, fasilitas: AMENITY_LABEL[a.need], status: a.status })) } : {}),
    })),
    totalTarif: f.route.totalFare,
    totalMenit: f.route.timeComplete ? f.route.totalMinutes : null,
    jumlahTransfer: f.route.transfers,
    stasiun: f.assessments.map((a) => {
      const s = st(a.stationId);
      return {
        nama: s?.name ?? a.stationId,
        skor: a.score,
        memadai: a.adequate,
        dataTersedia: a.dataAvailable,
        fasilitas: Object.fromEntries(CORE_AMENITIES.map((t) => [AMENITY_LABEL[t], s?.amenities[t] ?? "unknown"])),
        catatan: a.notes,
      };
    }),
    alternatif: f.alternatives.map((a) => ({ melalui: st(a.viaStationId)?.name, menggantikan: st(a.replacesStationId)?.name, skor: a.assessment.score })),
    pengumuman: f.notices.map((n) => ({ tingkat: n.severity, judul: n.title, isi: n.message })),
  };
}
