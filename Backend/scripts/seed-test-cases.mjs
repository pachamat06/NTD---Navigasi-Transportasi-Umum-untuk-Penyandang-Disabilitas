#!/usr/bin/env node
// Mengisi kasus uji bawaan ke halaman admin "Uji coba API" lalu menjalankannya (Tabel 2.18 PM Plan: uji integrasi).
// Aman dijalankan berulang: kasus dengan nama yang sama diperbarui, bukan digandakan.
//
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/seed-test-cases.mjs [--run] [--mode=published|preview]
//
// Variabel: API_URL (bawaan http://localhost:4000), ADMIN_EMAIL, ADMIN_PASSWORD.
// --run menjalankan semua kasus setelah disimpan dan keluar dengan kode 1 bila ada yang gagal.
// Id stasiun memakai slug GUI yang ada pada sumber fixture maupun Commute Data API sungguhan.

const API = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const run = process.argv.includes("--run");
const mode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "published";

if (!email || !password) {
  console.error("Isi ADMIN_EMAIL dan ADMIN_PASSWORD (admin atau editor).");
  process.exit(2);
}

/** Kasus uji. `maxLatencyMs` mengikuti KPI PM Plan (Tabel 2.19): respons < 5 detik pada cache hangat. */
const CASES = [
  { name: "TC-01 Sudirman → Manggarai (satu lin KRL, tanpa transfer)", request: { originId: "sudirman", destinationId: "manggarai" }, expect: { status: "ok", maxTransfers: 0, mustPassStations: ["sudirman", "manggarai"], maxLatencyMs: 5000 } },
  { name: "TC-02 Tanah Abang → Sudirman Baru BNI City", request: { originId: "tanah-abang", destinationId: "bni-city" }, expect: { status: "ok", maxTransfers: 0, mustPassStations: ["tanah-abang", "bni-city"], maxLatencyMs: 5000 } },
  { name: "TC-03 Manggarai → Jakarta Kota", request: { originId: "manggarai", destinationId: "jakarta-kota" }, expect: { status: "ok", maxTransfers: 0, maxLatencyMs: 5000 } },
  { name: "TC-04 Bundaran HI → Manggarai (transfer di hub Dukuh Atas)", request: { originId: "bundaran-hi", destinationId: "manggarai" }, expect: { status: "ok", maxTransfers: 1, mustPassStations: ["bundaran-hi", "manggarai"], maxLatencyMs: 5000 } },
  { name: "TC-05 Dukuh Atas MRT → Bundaran HI", request: { originId: "dukuh-atas-mrt", destinationId: "bundaran-hi" }, expect: { status: "ok", maxTransfers: 0, maxLatencyMs: 5000 } },
  { name: "TC-06 Asal sama dengan tujuan ditolak", request: { originId: "sudirman", destinationId: "sudirman" }, expect: { status: "error", errorCode: "INVALID" } },
  { name: "TC-07 Stasiun tidak dikenal ditolak", request: { originId: "stasiun-tidak-ada", destinationId: "manggarai" }, expect: { status: "error", errorCode: "INVALID" } },
];

async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (json?.status !== "ok") throw new Error(`${method} ${path} → ${res.status} ${json?.code ?? ""} ${json?.message ?? ""}`);
  return json.data;
}

const login = await call("POST", "/api/admin/auth/login", { email, password });
const token = login.token;
const existing = await call("GET", "/api/admin/tests", undefined, token);
for (const c of CASES) {
  const prev = existing.find((e) => e.name === c.name);
  const saved = await call(prev ? "PUT" : "POST", prev ? `/api/admin/tests/${prev.id}` : "/api/admin/tests", { ...c, enabled: true }, token);
  console.log(`${prev ? "diperbarui" : "ditambah  "}  ${saved.name}`);
}

if (run) {
  const result = await call("POST", "/api/admin/tests/run", { mode }, token);
  console.log(`\nHasil (${mode}): ${result.passed} lulus, ${result.failed} gagal`);
  for (const r of result.results) console.log(`${r.passed ? "LULUS" : "GAGAL"}  ${String(r.latencyMs).padStart(5)} ms  ${r.name}${r.failures.length ? "\n        - " + r.failures.join("\n        - ") : ""}`);
  process.exit(result.failed ? 1 : 0);
}
