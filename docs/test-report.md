# Laporan Pengujian NTD

Laporan ini mengisi deliverable Fase 5 (Testing & QA) pada `pm-plan.md`, Tabel 2.18 (strategi pengujian) dan Tabel 2.19 (KPI). Semua angka di bawah berasal dari proses yang dijalankan langsung pada kode, bukan estimasi.

| Item | Keterangan |
|---|---|
| Versi yang diuji | Cabang `MajorFixBeta`, commit `71b4c96` ("update big"), ditambah skrip `seed-test-cases.mjs` dan workflow CI dari PR yang sama dengan laporan ini |
| Tanggal pengujian | 9 November 2026 (dini hari WIB) |
| Lingkungan | Linux, Node.js 22.23.4, npm 10.9.9, Chromium 1243 lewat Playwright, `axe-core` 4.10.2, Lighthouse 12.6.1 |
| Sumber data | Commute Data API sungguhan (`https://api.commute.shiorilabs.id`, `COMMUTE_SOURCE=http`, 370 stasiun/halte, 40 lini, 15 hub) dan mode `fixture` untuk uji otomatis |
| Basis data | Penyimpanan memori (uji otomatis) dan PostgreSQL (lewat PGlite, lihat batasan di Subbab 10) |
| Penyusun | Pengujian dijalankan dan laporan disusun dengan bantuan Claude Code atas permintaan Pasha. PIC pengujian menurut PM Plan adalah Zaki; hasilnya perlu diperiksa ulang oleh tim sebelum dilaporkan sebagai hasil final |

## 1. Ringkasan

- **Uji otomatis:** 11 suite, **132 tes lulus dari 132**. Dengan PostgreSQL aktif: **136 dari 136**. Cakupan kode backend: pernyataan 85,8%, baris 89,6% (88,6% dan 92,9% dengan PostgreSQL).
- **Build dan tipe:** typecheck Backend, ESLint Frontend, `next build` Frontend, dan build admin lulus tanpa galat.
- **Uji fungsional di browser (data asli):** 20 skenario, **20 lulus** (Subbab 4). Tidak ada galat atau peringatan di konsol browser pada seluruh skenario.
- **Aksesibilitas otomatis:** axe-core **0 pelanggaran** pada halaman pengguna (WCAG 2.0/2.1 A dan AA) dan pada seluruh 10 halaman admin (WCAG 2.0 A dan AA). Lighthouse Accessibility **100** (desktop dan mobile).
- **Kinerja:** rute dengan cache hangat 0,3 sampai 1,3 detik. Permintaan pertama (cache dingin) 8 dari 10 rute uji di bawah 5 detik; 2 rute melebihi (5,4 dan 7,3 detik). Skor Lighthouse performa mobile 48 karena peta SVG berukuran 3,9 MB.
- **Belum dilakukan:** usability testing dengan calon pengguna, uji pembaca layar manual, UAT lapangan, grounding dengan LLM sungguhan, koleksi Postman, dan deployment (Subbab 9).
- **Temuan:** tidak ada bug kritis. Ada 4 temuan sedang yang bersumber dari batasan data dan kinerja (Subbab 8).

## 2. Cara mengulang pengujian

```bash
# dari akar repositori
npm ci

# 1. Unit dan integrasi otomatis (Jest, penyimpanan memori)
npm test -w Backend
npm run typecheck -w Backend

# 2. Dengan PostgreSQL sungguhan (Docker): ikut menguji migrasi 001 sampai 006 dan pg.ts
docker compose -f Backend/docker-compose.yml up -d db
TEST_DATABASE_URL=postgres://ntd:ntd@localhost:5432/ntd npm test -w Backend

# 3. Frontend
npm run lint -w Frontend
npm run typecheck -w Frontend
npm run build -w Frontend

# 4. Kasus uji API lewat halaman admin (membutuhkan backend hidup)
ADMIN_EMAIL=admin@ntd.test ADMIN_PASSWORD='...' node Backend/scripts/seed-test-cases.mjs --run
```

Langkah 1 sampai 3 juga dijalankan otomatis oleh GitHub Actions (`.github/workflows/ci.yml`) pada setiap push dan pull request.

## 3. Pengujian per jenis (Tabel 2.18)

| Jenis | Alat | Status | Hasil |
|---|---|---|---|
| Unit | Jest | Selesai | 132 dari 132 lulus (Subbab 3.1) |
| Integrasi | Jest + supertest, kasus uji admin | Selesai sebagian | API publik dan admin diuji lewat supertest dan 7 kasus uji admin lulus. **Koleksi Postman belum ada** |
| Grounding (AI) | Skenario Jest | Selesai sebagian | Lulus dengan LLM tiruan. **Belum dengan LLM sungguhan** (tidak ada kunci API) (Subbab 5) |
| Aksesibilitas UI | axe-core, Lighthouse | Selesai sebagian | 0 pelanggaran axe, Lighthouse 100. **Uji pembaca layar manual belum** (Subbab 6) |
| Usability | Sesi dengan calon pengguna | **Belum** | Dijadwalkan Aridho |
| Regresi | Manual + checklist | Selesai | Checklist di Subbab 7 dijalankan sekali pada commit ini |
| UAT | Skenario perjalanan nyata di hub | **Belum** | Fase 6, PIC Pasha |

### 3.1 Uji otomatis (Jest)

| Suite | Tes | Fokus |
|---|---:|---|
| `api.test.ts` | 21 | Endpoint publik (`/health`, `/api/stations`, `/api/network`, `/api/plan`), galat `INVALID`/`NOT_FOUND`, cache saat Commute API mati, CORS, API admin (login, peran, draft dan publikasi, validasi, pengguna), Grounding Guard dengan LLM tiruan |
| `domain.test.ts` | 15 | Indeks stasiun, pencarian, perencana rute, analisis fasilitas dan skor, Grounding Guard |
| `commute-http.test.ts` | 17 | Adaptor Commute Data API asli (bentuk respons, id stasiun, fasilitas, rute lintas operator), filter moda |
| `commute-features.test.ts` | 15 | Lin paralel, frekuensi, jarak transfer, cache (single-flight, stale-while-revalidate, HTTP 429), fasilitas yang dibutuhkan saat pindah, peron dan gate |
| `gtfs-tj.test.ts` | 13 | Data GTFS koridor BRT dan perkiraan waktu TransJakarta |
| `concourse.test.ts` | 12 | Jalur gate, concourse, dan peron |
| `floor-plan.test.ts` | 16 | Pembacaan denah stasiun oleh AI (klien tiruan) dan endpoint admin terkait |
| `navigation-fixes.test.ts` | 7 | Jalan kaki di hub, stasiun yang dihindari, pembacaan cache |
| `route-patterns.test.ts` | 7 | Urutan halte per arah dari admin |
| `loop-through.test.ts` | 5 | Lin berbentuk putaran (Lin Cikarang, koridor 1) |
| `store.test.ts` | 4 (8 dengan PostgreSQL) | Cache ber-TTL, konten draft dan terbit, pengguna, kasus uji |
| **Jumlah** | **132 (136)** | |

Cakupan kode (`jest --coverage`):

| Metrik | Penyimpanan memori | Dengan PostgreSQL |
|---|---:|---:|
| Pernyataan | 85,8% | 88,6% |
| Cabang | 76,3% | 77,7% |
| Fungsi | 84,8% | 88,9% |
| Baris | 89,6% | 92,9% |

Cakupan terendah: `ClaudeClient.ts` 12% dan `GptClient.ts` 5,9% (butuh kunci LLM sungguhan), `ToolRegistry.ts` 66,7%, `pg.ts` 4,3% tanpa PostgreSQL (83,5% dengan PostgreSQL). Komponen utama: `NavigationAgent` 97%, `RoutePlannerService` 93,5%, `FacilityAnalysisService` 93,8%, `CommuteApiClient` 93,2%.

### 3.2 Kasus uji API di halaman admin

Skrip `Backend/scripts/seed-test-cases.mjs` mengisi tujuh kasus uji ke halaman **Uji coba API** (idempoten) dan menjalankannya. Hasil pada data Commute asli, mode data terbit:

| Kasus | Ekspektasi | Hasil | Latensi |
|---|---|---|---:|
| TC-01 Sudirman → Manggarai | 0 transfer, melewati kedua stasiun | Lulus | 321 ms |
| TC-02 Tanah Abang → Sudirman Baru BNI City | 0 transfer | Lulus | 1284 ms |
| TC-03 Manggarai → Jakarta Kota | 0 transfer | Lulus | 902 ms |
| TC-04 Bundaran HI → Manggarai | maksimal 1 transfer di hub Dukuh Atas | Lulus | 656 ms |
| TC-05 Dukuh Atas MRT → Bundaran HI | 0 transfer | Lulus | 772 ms |
| TC-06 Asal sama dengan tujuan | galat `INVALID` | Lulus | 12 ms |
| TC-07 Stasiun tidak dikenal | galat `INVALID` | Lulus | 11 ms |

Skrip yang sama juga lulus 7 dari 7 pada sumber `fixture`. Ini memenuhi syarat NTD-15 (minimal 5 pasangan asal-tujuan uji tercatat).

## 4. Pengujian fungsional di browser (data Commute asli)

Dijalankan dengan Playwright (Chromium) terhadap `next build` + `next start` dan backend dengan `COMMUTE_SOURCE=http`.

| ID | Skenario | Hasil yang diharapkan | Hasil aktual | Status |
|---|---|---|---|---|
| F-01 | Buka beranda | Form, peta FDTJ, dan atribusi tampil; tanpa galat konsol | Sesuai (muat 1,3 detik di mesin uji) | Lulus |
| F-02 | Autocomplete dengan papan ketik (ketik "bundaran", panah bawah, Enter) | Terisi "Bundaran HI Bank Jakarta" | Sesuai | Lulus |
| F-03 | Tombol Tukar | Asal dan tujuan bertukar | Sesuai | Lulus |
| F-04 | Pilih asal sama dengan tujuan | Pesan "Asal dan tujuan tidak boleh sama." dan tombol Cari Rute nonaktif | Sesuai | Lulus |
| F-05 | Sudirman → Manggarai | Rute 1 lin: tarif Rp 3.000, 3,2 km, 0 transfer, naik dari peron 2 | Sesuai. Waktu tempuh "Tidak tersedia" (lihat T-01) | Lulus |
| F-06 | Bundaran HI Bank Jakarta → Manggarai | MRT, jalan kaki di hub Dukuh Atas, lalu KRL Lin Cikarang; 1 transfer; tarif Rp 6.000 | Sesuai | Lulus |
| F-07 | Bundaran HI Astra (TransJakarta) → Manggarai | Alternatif transfer ditawarkan | "Via Dukuh Atas BNI, Memadai · 85" dengan tombol "Pakai rute ini" | Lulus |
| F-08 | Matikan moda KRL pada rute yang hanya bisa lewat KRL | Rute tetap tampil dengan peringatan | "Rute tanpa kereta (KRL) tidak ditemukan; ditampilkan rute dataset" | Lulus |
| F-09 | Centang "Butuh Lift" | Peringatan bila lift di titik pindah tidak tercatat | "Lift tidak tercatat di Sudirman, padahal Anda membutuhkannya untuk pindah. Pertimbangkan alternatif atau minta bantuan petugas." | Lulus |
| F-10 | Buka detail stasiun dari hasil rute | Dialog dengan skor, fasilitas, tombol Jadikan Asal/Tujuan | Sesuai | Lulus |
| F-11 | Detail stasiun tanpa data (Bogor) | Tidak menyimpulkan "tidak ada fasilitas" | "Data fasilitas stasiun ini belum tersedia. Ini bukan berarti fasilitasnya tidak ada." | Lulus |
| F-12 | Dialog pengaturan tampilan | Ukuran teks, kontras tinggi, kurangi animasi; tutup dengan Esc | Sesuai | Lulus |
| F-13 | Dialog Tentang NTD | Cakupan dan disclaimer tampil | Sesuai | Lulus |
| F-14 | Backend dimatikan lalu halaman dibuka | Pesan galat dan tombol "Coba lagi", tanpa layar kosong | "Data stasiun belum bisa dimuat. Server NTD tidak dapat dihubungi." | Lulus |
| F-15 | Layar ponsel 390 × 844 | Tidak ada gulir horizontal | Sesuai | Lulus |
| F-16 | Validasi input API (13 kasus: body kosong, JSON rusak, tipe salah, id lebih dari 80 karakter, `at` bukan ISO 8601, `needs` tidak dikenal, array/null, stasiun tidak dikenal, endpoint tidak ada, dan lainnya) | Galat terstruktur `INVALID` atau `NOT_FOUND`, tanpa 500 | Sesuai pada seluruh kasus | Lulus |
| F-17 | Admin: login benar, login salah, akses tanpa token | Token, `UNAUTHORIZED`, `UNAUTHORIZED` | Sesuai | Lulus |
| F-18 | Admin: buka 10 halaman (Ringkasan sampai Log aktivitas) | Termuat tanpa galat konsol, 0 pelanggaran axe | Sesuai | Lulus |
| F-19 | Admin: buat pengumuman draft, publikasikan, buka beranda pengguna | Pengumuman tampil di beranda hanya setelah terbit | Sesuai | Lulus |
| F-20 | Server dengan PostgreSQL pada basis data kosong | Migrasi 001 sampai 006 berjalan, admin awal dibuat, login dan `/api/admin/system` melaporkan `store: postgres, ok` | Sesuai | Lulus |

Tangkapan layar skenario ini ada di [`user-manual.md`](user-manual.md).

## 5. Pengujian grounding (AI)

Tujuan (KPI 2.19): jawaban agen sesuai data tool call, 100% pada skenario uji.

| Skenario | Dasar | Hasil |
|---|---|---|
| Narasi sesuai data diterima | `domain.test.ts` GroundingGuard | Lulus |
| Narasi dengan stasiun, angka, atau klaim fasilitas yang tidak ada di data ditolak | `domain.test.ts` GroundingGuard | Lulus |
| Nama stasiun terpanjang dicocokkan lebih dulu (mencegah kecocokan parsial) | `domain.test.ts` GroundingGuard | Lulus |
| LLM menghasilkan teks yang lolos validasi, teks dipakai | `api.test.ts` | Lulus |
| LLM berhalusinasi atau gagal, sistem beralih ke template statis | `api.test.ts` | Lulus |
| Data tidak tersedia tidak ditulis sebagai "tidak ada" | `F-11` dan `FacilityAnalysisService` | Lulus |
| Pada seluruh rute uji data asli, notifikasi berasal dari template dan `grounded: true` | uji manual API | 10 dari 10 |

**Batasan:** LLM pada seluruh pengujian adalah tiruan atau dinonaktifkan (`LLM_PROVIDER=none`). Tidak ada kunci API Claude atau GPT pada lingkungan uji, sehingga perilaku model sungguhan (halusinasi nyata, latensi, biaya) belum terukur. Notifikasi pada demo memakai template statis.

## 6. Aksesibilitas UI

| Alat | Cakupan | Hasil |
|---|---|---|
| axe-core 4.10.2 | Beranda dan hasil rute (WCAG 2.0 dan 2.1, level A dan AA); 10 halaman admin (WCAG 2.0 A dan AA) | **0 pelanggaran** |
| Lighthouse 12.6.1 | Beranda, desktop dan mobile | Accessibility **100**, Best Practices **100**, SEO **100** |
| Papan ketik | Combobox asal/tujuan diuji dengan panah dan Enter; dialog ditutup dengan Esc. Pemberhentian di peta dan kartu moda/fasilitas dirancang dapat difokus (Enter/Spasi) | Combobox dan dialog lulus. Menelusuri seluruh halaman hanya dengan papan ketik belum diuji menyeluruh |
| Pembaca layar (NVDA/VoiceOver/TalkBack) | - | **Belum diuji.** Kode memakai `role="combobox"`, `aria-live`, `aria-label` pada peta dan tombol, tetapi hasil nyata di pembaca layar belum diverifikasi |
| Kontras warna pada mode kontras tinggi | - | Belum diukur; hanya dialog pengaturan yang diperiksa tampil |

## 7. Checklist regresi

Dijalankan sekali pada commit `71b4c96`. Ulangi setiap kali ada penggabungan fitur (centang di PR).

- [x] `npm ci` berhasil dari awal
- [x] `npm run typecheck -w Backend` tanpa galat
- [x] `npm test -w Backend` hijau (132/132)
- [x] `npm run lint -w Frontend` tanpa temuan
- [x] `npm run typecheck -w Frontend` dan `npm run build -w Frontend` berhasil
- [x] Backend start dengan `COMMUTE_SOURCE=http`, `GET /health` dan `GET /api/network` berhasil
- [x] Rute 1 lin, rute dengan transfer, rute TransJakarta, alternatif, filter moda, kebutuhan lift
- [x] Galat: asal sama dengan tujuan, id tidak dikenal, backend mati
- [x] Admin: login, draft, publikasi, tampil di beranda pengguna, kasus uji admin hijau
- [x] Ponsel 390 px tanpa gulir horizontal

## 8. Kinerja (KPI waktu respons < 5 detik)

Permintaan `POST /api/plan` ke backend lokal dengan Commute Data API sungguhan. "Dingin" berarti permintaan pertama setelah backend dinyalakan (cache kosong), "hangat" berarti pengulangan.

| Rute | Dingin | Hangat |
|---|---:|---:|
| Sudirman → Manggarai | 3,1 s | 0,3 s |
| Tanah Abang → BNI City | 1,7 s | - |
| Bundaran HI → Manggarai (1 transfer) | 5,4 s | 0,27 s |
| Sudirman → Bogor | 1,3 s | - |
| Dukuh Atas MRT → Blok M | 1,4 s | - |
| Manggarai → Jakarta Kota | 1,1 s | - |
| Tanah Abang → Tebet | 1,2 s | - |
| BNI City → halte TransJakarta (Kota) | 7,3 s | 1,3 s |
| Bogor → Jakarta Kota (23 pemberhentian) | 0,9 s | 0,5 s |
| LRT Manggarai → Blok M (2 transfer) | 3,2 s | - |

Rute yang melewati TransJakarta paling lambat pada permintaan pertama karena butuh banyak panggilan ke Commute API. Sumber `fixture` menjawab dalam puluhan milidetik.

Lighthouse (beranda, throttling bawaan):

| Perangkat | Performa | FCP | LCP | TBT | CLS |
|---|---:|---:|---:|---:|---:|
| Desktop | 71 | 0,2 s | 1,1 s | 780 ms | 0,055 |
| Mobile | 48 | 0,8 s | 6,0 s | 3,6 s | 0 |

Penyebabnya adalah aset peta `public/peta/fdtj-2026-08c.svg` (3,9 MB, 622 KB setelah gzip) yang dirender sebagai `<image>` berukuran 9513 × 6727 pt; 78% waktu LCP adalah penundaan render. Acceptance criteria NTD-16 ("SVG termuat kurang dari 3 detik di ponsel") belum terpenuhi pada simulasi ponsel Lighthouse.

## 9. Temuan

Tingkat: **Kritis** (menghalangi demo), **Sedang** (terlihat saat demo, ada pemecahan), **Rendah** (kosmetik atau proses).

| ID | Tingkat | Temuan | Status |
|---|---|---|---|
| T-01 | Sedang | Waktu tempuh "Tidak tersedia" untuk rute KRL, MRT, dan LRT. Respons `/fares` Commute tidak memuat durasi untuk kereta (hanya jarak dan tarif); durasi TransJakarta diperkirakan dari GTFS. UI sudah memberi catatan "Total belum lengkap". | Terbuka (batasan data). Jelaskan saat demo atau pakai `/timetable` pada iterasi berikut |
| T-02 | Sedang | Data fasilitas kosong untuk banyak stasiun pada data asli. Contoh: lift Sudirman (KRL) tidak tercatat sehingga skor 20 "Perlu perhatian"; Tanah Abang, BNI City, serta seluruh 23 stasiun pada rute Bogor → Jakarta Kota "data belum tersedia". Alternatif transfer sering "tidak ada" karena data ini. | Terbuka. Lengkapi lewat halaman admin sebelum demo, terutama hub Sudirman, Dukuh Atas, Manggarai |
| T-03 | Sedang | 2 dari 10 rute uji melebihi 5 detik pada permintaan pertama (KPI < 5 s). | Mitigasi: jalankan `seed-test-cases.mjs --run` atau buka rute demo sekali sebelum sesi agar cache hangat |
| T-04 | Sedang | Performa mobile rendah (Lighthouse 48, LCP 6,0 s) karena peta SVG 3,9 MB. | Terbuka. Opsi: sajikan SVG dengan kompresi di hosting, pecah peta, atau tampilkan area hub lebih dulu |
| T-05 | Rendah | `tsc --noEmit` di Frontend gagal pada checkout bersih (`Cannot find name 'LayoutProps'`) karena tipe rute Next.js 16 dibuat oleh `next typegen`/`next build`. `next build` sendiri lulus. | **Diperbaiki** di PR ini: skrip `npm run typecheck -w Frontend` |
| T-06 | Rendah | Repositori belum memiliki workflow CI (DoD butir 2). | **Diperbaiki** di PR ini: `.github/workflows/ci.yml` |
| T-07 | Rendah | Daftar kasus uji admin kosong secara bawaan, sehingga "Jalankan semua" dan gerbang publikasi menampilkan 0 lulus · 0 gagal. | **Diperbaiki** di PR ini: `Backend/scripts/seed-test-cases.mjs` |
| T-08 | Rendah | Admin: formulir Pengumuman baru memakai cakupan "Stasiun" sebagai bawaan tanpa stasiun terpilih dan kolomnya tidak wajib; simpan tanpa memilih menghasilkan galat server "targetId wajib untuk scope selain global" alih-alih validasi di formulir. | Terbuka. Admin berada di proyek terpisah; perbaikan: tambahkan `required` pada pemilih stasiun |
| T-09 | Rendah | `docs/test-report.md` dan `docs/user-manual.md` hanya kerangka. | **Diperbaiki** di PR ini |
| T-10 | Rendah | Pengujian PostgreSQL memakai PGlite (Postgres dalam WebAssembly), bukan Docker Postgres 16 seperti pada README. | Terbuka. Jalankan ulang perintah nomor 2 di Subbab 2 pada mesin tim |

Tidak ada temuan yang membuat alur utama (cari rute, lihat status aksesibilitas, alternatif, notifikasi, admin) gagal.

## 10. Belum dilakukan dan batasan laporan

1. **Usability testing** dengan calon pengguna (WBS 5.3) dan **UAT** lapangan (WBS 6.2).
2. **Pembaca layar manual** (NVDA, VoiceOver, TalkBack) dan pengukuran kontras mode kontras tinggi.
3. **LLM sungguhan**: grounding dengan kunci Claude/GPT, latensi, dan biaya per permintaan. ADR-002 dan ADR-003 juga belum ditulis.
4. **Koleksi Postman** (WBS 5.2). Kasus uji admin dan supertest menutup fungsi serupa untuk saat ini.
5. **Precision rekomendasi "aksesibel" vs kondisi lapangan** (target ≥ 80%): butuh verifikasi manual di stasiun.
6. **Deployment** (Vercel dan Render/Railway) dan pengujian di hosting produksi.
7. Uji PostgreSQL memakai PGlite, bukan Docker Postgres (T-10).
8. Pengujian dijalankan satu kali pada satu mesin dan satu waktu; data Commute API dapat berubah.
