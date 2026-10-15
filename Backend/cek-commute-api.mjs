// Pemeriksa Commute Data API untuk NTD.
// Jalankan dari folder Backend:  node --env-file-if-exists=.env cek-commute-api.mjs
// Hasil: commute-api-sampel.json (contoh respons asli, dipotong) untuk menyesuaikan HttpCommuteSource.
// Tidak mengirim apa pun selain permintaan GET ke COMMUTE_API_BASE_URL.

import { writeFileSync } from "node:fs";

const BASE = (process.env.COMMUTE_API_BASE_URL || "https://api.commute.shiorilabs.id").replace(/\/$/, "");
const KEY = process.env.COMMUTE_API_KEY || "";
const headers = { Accept: "application/json" };
if (KEY) Object.assign(headers, { Authorization: `Bearer ${KEY}`, "X-API-Key": KEY });

// Dokumentasi yang mungkin tersedia, lalu endpoint yang dipakai NTD (Bab III).
const PATHS = [
  "/", "/docs", "/openapi.json", "/swagger.json", "/api", "/v1", "/health",
  "/operators", "/lines", "/stations", "/hubs",
  "/stations/KCI/C12", "/stations/KCI/SUD", "/stations?q=sudirman", "/stations?search=sudirman",
  "/lines/KCI", "/fares/KCI:C12/MRTJ:M12", "/fares?from=KCI:C12&to=MRTJ:M12",
  "/v1/operators", "/v1/stations", "/v1/lines", "/v1/hubs",
  "/api/operators", "/api/stations", "/api/lines", "/api/hubs",
];

const cut = (v, depth = 0) => {
  if (Array.isArray(v)) return v.length > 3 ? [...v.slice(0, 3).map((x) => cut(x, depth + 1)), `… (${v.length} item)`] : v.map((x) => cut(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, depth > 6 ? "…" : cut(x, depth + 1)]));
  if (typeof v === "string" && v.length > 400) return v.slice(0, 400) + "…";
  return v;
};

const results = { base: BASE, pakaiKunci: Boolean(KEY), waktu: new Date().toISOString(), hasil: [] };
for (const p of PATHS) {
  const url = BASE + p;
  const t = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let body;
    try { body = cut(JSON.parse(text)); } catch { body = text.slice(0, 1500); }
    results.hasil.push({ path: p, status: res.status, contentType: res.headers.get("content-type"), ms: Date.now() - t, body });
    console.log(`${res.status}  ${p}`);
  } catch (e) {
    results.hasil.push({ path: p, error: String(e?.cause?.code || e?.message || e) });
    console.log(`ERR  ${p}  ${e?.cause?.code || e?.message}`);
  }
}
writeFileSync("commute-api-sampel.json", JSON.stringify(results, null, 2));
console.log("\nTersimpan: commute-api-sampel.json. Kirim file ini ke thread NTD (kunci API tidak ikut disimpan).");
