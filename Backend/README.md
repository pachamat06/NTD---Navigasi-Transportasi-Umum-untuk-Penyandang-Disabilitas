# NTD Backend

API perencanaan perjalanan aksesibel untuk NTD (Navigasi Transportasi Umum untuk Penyandang Disabilitas), mengikuti rancangan Bab III laporan RPL Kelompok 11.

Stack: Node.js 22+, Express 5, TypeScript, PostgreSQL 16, zod. LLM opsional (Claude atau GPT) hanya untuk menyusun kalimat notifikasi.

## Menjalankan

```bash
cd Backend
cp .env.example .env          # isi ADMIN_TOKEN_SECRET, ADMIN_BOOTSTRAP_EMAIL/PASSWORD
docker compose up -d db       # PostgreSQL lokal (ntd/ntd)
npm install
npm run migrate               # juga dijalankan otomatis saat server start
npm run dev                   # http://localhost:4000
```

Tanpa `DATABASE_URL` (dan bukan production) server memakai penyimpanan memori: cocok untuk coba-coba, data admin hilang saat restart.

| Script | Fungsi |
| --- | --- |
| `npm run dev` | Server dengan reload otomatis |
| `npm run build` / `npm start` | Kompilasi ke `dist/` lalu jalankan |
| `npm test` | Jest (unit + API). Set `TEST_DATABASE_URL` untuk ikut menguji store PostgreSQL |
| `npm run typecheck` | Pemeriksaan tipe |
| `npm run migrate` | Jalankan migrasi `migrations/*.sql` |
| `npm run admin:create -- email@x "Nama" admin` | Tambah admin; kata sandi dari env `NEW_ADMIN_PASSWORD` |
| `npm run admin:reset-password -- email@x` | Reset kata sandi; kata sandi dari env `NEW_ADMIN_PASSWORD` |

Semua variabel lingkungan terdokumentasi di [.env.example](.env.example).

## Arsitektur (pemetaan ke Bab III)

| Lapisan rancangan | Implementasi |
| --- | --- |
| REST Controller / PlanController | `src/http/publicRoutes.ts`, `src/app.ts` |
| Agen Navigasi (Planner) | `src/ai/NavigationAgent.ts`: pipeline tool deterministik, satu panggilan LLM untuk narasi |
| Tool Registry | `src/ai/ToolRegistry.ts`: `cari_stasiun`, `ambil_rute`, `cek_fasilitas`, `cari_alternatif` |
| Layanan domain | `src/domain/StationService.ts`, `RoutePlannerService.ts`, `FacilityAnalysisService.ts`, `AlternativeService.ts` |
| Grounding Guard | `src/ai/GroundingGuard.ts`: cek nama stasiun, angka, dan klaim fasilitas; gagal berarti template statis. Disclaimer ditambahkan sistem |
| Klien LLM | `src/ai/llm/` (`ClaudeClient`, `GptClient`, antarmuka `LlmClient`) |
| CommuteApiClient + cache | `src/data/commute/CommuteApiClient.ts`: cache-first dengan TTL; tarif selalu segar dengan cadangan cache basi (UC-01 E2) |
| Basis data | `src/store/pg.ts` + `migrations/`; alternatif memori `src/store/memory.ts` |

Sumber data Commute (`COMMUTE_SOURCE`):

- `fixture` (bawaan): data dummy yang sama dengan GUI basic, rute dengan Dijkstra. Berjalan tanpa internet.
- `http`: Commute Data API sungguhan (`https://api.commute.shiorilabs.id`, spesifikasi di `/openapi.json`, tanpa kunci API). Adaptornya di `src/data/commute/HttpCommuteSource.ts`. Operator yang dipakai diatur `COMMUTE_OPERATORS` (bawaan semua: KCI, MRTJ, LRTJ, LRTJBDB, APCGK, TJ; rute dari /fares bisa melewati halte TransJakarta) dan wilayah `COMMUTE_REGIONS` (bawaan CGK).

Id stasiun GUI berbentuk slug (mis. `bni-city`) karena posisi di peta dikunci dengan slug. `station-index.ts` mencocokkan slug ke stasiun API lewat operator + nama tampilan atau nama resmi, jadi kode API tidak ditulis tetap. Stasiun di luar tabel memakai id turunan `operator:kode` (mis. `kci:kat`). Slug yang tidak cocok ditampilkan di Ringkasan halaman admin; tambahkan namanya di tabel bila muncul.

Batasan data API: tidak ada jenis fasilitas ramp (status ramp selalu "data tidak tersedia" kecuali diisi tim lewat admin), `TOILET` biasa tidak dihitung sebagai toilet aksesibel, daftar fasilitas kosong berarti data belum ada, dan /hubs tidak memuat jarak jalan kaki antarstasiun.

### Data tambahan dari admin

Dataset tidak memuat semua informasi aksesibilitas, jadi tim melengkapinya lewat halaman admin (proyek terpisah, closed source). Jenis konten (`content_items.kind`):

- `facility`: koreksi status lift, eskalator, toilet aksesibel, ramp, dll. (`available`, `absent`, `out_of_service` dengan `until`, `unknown`). Menimpa dataset untuk jenis yang sama.
- `entrance`: pintu akses stasiun (nama, lokasi, fitur seperti lift/ramp/guiding block, jam buka).
- `station_info`: info lain (kontak layanan, layanan pendampingan, dll.).
- `notice`: pengumuman/notifikasi untuk stasiun, lini, hub, atau global, dengan periode aktif dan tingkat (`info`, `warning`, `critical`).
- `settings`: bobot skor aksesibilitas, ambang memadai, disclaimer, LLM on/off, TTL cache, wajib lulus uji sebelum publikasi.

Setiap konten punya versi **draft** dan **terbit**. Pengguna hanya melihat versi terbit. Admin bisa melihat hasil API dengan draft memakai header `X-NTD-Preview: 1` plus token admin. Publikasi menyalin draft ke terbit dan (opsional) menjalankan semua kasus uji API terlebih dahulu.

Skor aksesibilitas = jumlah bobot fasilitas yang tersedia, dinormalisasi 0 sampai 100 (bawaan: lift 40, eskalator 20, toilet 25, ramp 15; ambang 70). Stasiun "memadai" bila datanya ada dan skornya mencapai ambang.

## API

Respons sukses `{"status":"ok","data":...}`; gagal `{"status":"error","code","message","details?"}` dengan kode `INVALID` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `RATE_LIMITED` 429, `INTERNAL` 500, `API_DOWN` 503.

### Publik

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/health` | Cek hidup |
| GET | `/api/meta` | Disclaimer, atribusi, bobot skor, label fasilitas, sumber data |
| GET | `/api/stations?q=&limit=` | Daftar stasiun, atau pencarian untuk autocomplete |
| GET | `/api/stations/:id` | Detail stasiun: fasilitas tergabung, skor, pintu akses, info, pengumuman |
| GET | `/api/network` | Data awal GUI: semua stasiun (fasilitas + skor), lini, dan hub |
| GET | `/api/lines`, `/api/hubs` | Lini dan hub antarmoda |
| GET | `/api/notices?stationId=&lineId=&hubId=` | Pengumuman aktif |
| POST | `/api/plan` | Rencana perjalanan (UC-01). Body `{originId, destinationId, viaStationId?, avoid?, avoidModes?, at?}`; `avoidModes` berisi moda yang dihindari (`RAIL`, `SUBWAY`, `TRAM`, `BUS`, `MONORAIL`) |

Dengan `avoidModes`, bila rute dataset memakai moda yang dihindari, backend mencari rute sendiri di atas urutan stasiun lini yang diizinkan (`/lines`, termasuk cabang) dan perpindahan di hub, lalu meminta `/fares` untuk tiap ruas naik agar tarif dan jadwalnya tetap dari dataset. Ruas yang tarifnya tidak tersedia disusun dari urutan stasiun lini (tarif 0, waktu kosong) dan diberi peringatan. Bila tidak ada rute yang lolos, rute dataset tetap ditampilkan dengan peringatan.

`POST /api/plan` mengembalikan rute (bentuk sama dengan `Frontend/src/lib/types.ts`), penilaian fasilitas tiap stasiun transit, hingga 3 alternatif via stasiun lain di hub yang sama, pengumuman terkait, narasi notifikasi, peringatan (mis. data dari cache), disclaimer, dan atribusi.

### Admin (`/api/admin`, Bearer token)

Hanya origin di `ADMIN_ORIGINS` yang boleh memanggil lewat browser. Peran `admin` bisa semuanya; `editor` hanya menyiapkan draft dan menjalankan uji.

| Method | Path | Keterangan |
| --- | --- | --- |
| POST | `/auth/login` | `{email, password}` → `{token, user}` (dibatasi 10 kali per 15 menit) |
| GET | `/auth/me` · POST `/auth/password` | Profil dan ganti kata sandi |
| GET, POST | `/users` · PATCH `/users/:id` | Kelola pengguna admin (admin) |
| GET | `/stations` · `/stations/:id` | Ringkasan stasiun; detail dengan versi terbit, pratinjau, dataset mentah, dan item konten |
| GET, POST | `/content` · PUT, DELETE `/content/:id` · POST `/content/:id/discard` | CRUD draft konten |
| GET, PUT | `/settings` | Pengaturan (draft) |
| GET | `/pending` · POST `/publish` | Perubahan menunggu dan publikasi `{ids?, force?}` (admin) |
| GET, POST | `/tests` · PUT, DELETE `/tests/:id` | Kasus uji API |
| POST | `/tests/run`, `/tests/:id/run`, `/tests/adhoc` · GET `/tests/runs` | Jalankan uji pada data `published` atau `preview` |
| GET | `/system` · POST `/cache/purge` · GET `/audit` | Status layanan, kosongkan cache, log aktivitas |

## Deployment

- Set `NODE_ENV=production`, `DATABASE_URL` (pakai `?sslmode=require` untuk TLS), `ADMIN_TOKEN_SECRET` (min. 32 karakter, `openssl rand -hex 32`), `CORS_ORIGINS`, dan `ADMIN_ORIGINS`.
- Isi `ADMIN_BOOTSTRAP_EMAIL/PASSWORD` sekali untuk membuat admin pertama, lalu hapus.
- `npm run build && npm start`. Migrasi berjalan otomatis saat start (dikunci dengan advisory lock).
- Tanpa `LLM_API_KEY`, notifikasi memakai template statis. Model Claude bawaan `claude-opus-5-5`; ganti lewat `LLM_MODEL`.

Catatan: perbaikan npm workspaces di root (`Backend`/`Frontend`) ada di patch Fase 0.
