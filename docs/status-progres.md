# Status Progres NTD terhadap Proposal dan PM Plan

Posisi: 9 November 2026 (awal Minggu 6 dari 14; Sprint 1 menurut Tabel 2.7), kode pada cabang `MajorFixBeta` commit `71b4c96`. Lambang: ✅ terpenuhi, 🟡 sebagian, ⬜ belum, ❔ tidak dapat diverifikasi dari repositori (konfirmasi tim).

**Kesimpulan singkat:** implementasi kode jauh mendahului jadwal (backend inti yang dijadwalkan M3, 29 November, sudah berjalan dan melampaui lingkup), tetapi dokumentasi proses, pengujian manusia (usability, UAT), dan deployment tertinggal.

## 1. Lingkup MVP (Proposal Subbab 1.4 dan PM Plan 2.2.1)

| Butir | Status | Bukti |
|---|---|---|
| Modul Pencarian Stasiun | ✅ | `GET /api/stations?q=`, combobox dengan papan ketik, pemilihan lewat peta |
| Modul Perencana Rute | ✅ | `POST /api/plan` dari Commute Data API (`/fares`), lintas operator termasuk TransJakarta, filter moda |
| Modul Analisis Fasilitas dan skor | ✅ | Skor 0 sampai 100 berbobot, dapat diatur admin; membedakan "tidak ada" dari "data tidak tersedia" |
| Modul Rekomendasi Alternatif | ✅ | Alternatif transfer di hub yang sama ("Via Dukuh Atas BNI") dan tombol "Pakai rute ini" |
| Modul Notifikasi (statis) dengan grounding | ✅ | Template statis, Grounding Guard, LLM opsional. Teruji dengan LLM tiruan, belum dengan LLM sungguhan |
| Peta interaktif FDTJ dengan sorotan rute dan anotasi fasilitas | ✅ | Peta SVG, pan/zoom, tanda status stasiun, atribusi FDTJ |
| Disclaimer data statis dan atribusi | ✅ | Tampil pada hasil, footer, dan dialog Tentang |
| Cakupan 1 sampai 2 hub | ✅ | Hub Sudirman–Dukuh Atas–BNI City; jaringan seluruh dataset (370 stasiun/halte) ikut tersedia |
| Antarmuka WCAG 2.1 AA | 🟡 | axe 0 pelanggaran, Lighthouse 100. Uji pembaca layar manual belum |
| Aplikasi web di-deploy pada hosting produksi | ⬜ | Belum ada deployment (Vercel, Render/Railway) |
| Dokumentasi: teknis dan API, panduan pengguna, laporan akhir, video demo, presentasi | 🟡 | `Backend/README.md` memuat referensi API; `user-manual.md` dan `test-report.md` ditambahkan PR ini; Bab IV laporan ada. Video demo ⬜ |

Di luar lingkup MVP namun sudah ada (nilai tambah, perlu dijelaskan sebagai perluasan): halaman admin lengkap (draft, publikasi, uji coba, audit), data peron, gate, dan concourse, perkiraan waktu TransJakarta dari GTFS, pembacaan denah stasiun oleh AI, dan pengaturan rute per arah.

Tetap di luar lingkup sesuai rencana (belum dibuat): pelaporan kondisi oleh pengguna, permintaan bantuan petugas otomatis, notifikasi real-time, aksesibilitas sensorik terstruktur, sensor IoT, aplikasi mobile native.

## 2. Milestone (PM Plan Tabel 2.8)

| Milestone | Target | Status | Catatan |
|---|---|---|---|
| M1 Perencanaan disetujui | 18 Okt | 🟡 | PM Plan, risk register, backlog, dan checklist Fase 0 selesai sebagai draf. Belum: board Jira ❔, branch `develop` dan proteksi branch, notulen kickoff, sign-off tim dan dosen |
| M2 Desain final | 1 Nov | 🟡 | Skema database ada (6 migrasi). Belum: `arsitektur-ai.md` (masih kerangka), ADR-002 (LLM) dan ADR-003 (basis data), wireframe Figma ❔ |
| M3 MVP backend fungsional | 29 Nov | 🟡 | Kelima modul berjalan dan lulus 132 tes. Belum: tag `v0.1` (belum ada tag di repositori) |
| M4 MVP terintegrasi | 13 Des | 🟡 | Frontend dan backend terintegrasi dan demo end-to-end berjalan. Belum: tag `v0.2` |
| M5 Rilis siap uji | 27 Des | ⬜ | Belum live, belum UAT |
| M6 Proyek selesai | 10 Jan 2027 | ⬜ | Dokumentasi final, retrospective, lessons learned |

## 3. Kualitas (PM Plan 2.11)

| Butir | Status | Catatan |
|---|---|---|
| DoD 1: kode di-review anggota lain sebelum merge | ⬜ | Belum ada pull request pada repositori; semua commit langsung ke cabang. Mulailah memakai PR dan template PR |
| DoD 2: lulus unit test, CI (lint, typecheck, build) | 🟡 | Seluruhnya lulus secara lokal. Workflow CI ditambahkan pada PR ini |
| DoD 3: dokumentasi termasuk `api-reference.md` dan `changelog.md` | 🟡 | Referensi API ada di `Backend/README.md`; `changelog.md` terakhir diperbarui 8 Oktober |
| DoD 5: tanpa kunci atau data sensitif di repositori | ✅ | `.env` dan `.env.local` diabaikan Git; tidak ditemukan kunci sungguhan pada kode |
| KPI: modul MVP tepat waktu | ✅ | 5 dari 5 modul, lebih awal dari jadwal |
| KPI: bug kritis saat demo = 0 | ✅ | Tidak ada bug kritis pada pengujian ini |
| KPI: waktu respons < 5 detik | 🟡 | Hangat 0,3 sampai 1,3 detik; permintaan pertama 2 dari 10 rute 5,4 dan 7,3 detik |
| KPI: kesesuaian jawaban agen dengan data tool call 100% | 🟡 | 100% pada skenario uji dengan LLM tiruan dan template; LLM sungguhan belum |
| KPI: precision rekomendasi aksesibel ≥ 80% | ⬜ | Butuh verifikasi lapangan dan data fasilitas yang lebih lengkap |
| Pengujian Tabel 2.18: unit, integrasi, grounding | ✅ / 🟡 | Lihat [`test-report.md`](test-report.md) |
| Pengujian Tabel 2.18: usability, UAT, pembaca layar | ⬜ | Belum dijalankan |

## 4. Hal yang perlu diselesaikan, berurutan prioritas

**Sebelum demo hari ini**

1. Lengkapi data fasilitas (lift, eskalator, toilet aksesibel) stasiun yang akan didemokan lewat admin, lalu publikasikan. Tanpa itu banyak hasil berlabel "Data tidak tersedia" atau "Perlu perhatian".
2. Jalankan `Backend/scripts/seed-test-cases.mjs --run` untuk mengisi dan menjalankan 7 kasus uji, sekaligus memanaskan cache agar respons di bawah 5 detik.
3. Siapkan penjelasan untuk dua hal yang tampak seperti galat padahal batasan data: waktu tempuh "Tidak tersedia" pada rute kereta, dan stasiun berlabel "Data tidak tersedia".
4. Jalankan backend dengan `COMMUTE_SOURCE=http` bila internet tersedia, dan cadangkan mode `fixture` bila tidak.

**Sebelum akhir sprint**

5. Lakukan usability testing dengan calon pengguna dan uji pembaca layar (Aridho).
6. Tulis `arsitektur-ai.md`, ADR-002 (model LLM), dan ADR-003 (basis data); perbarui `changelog.md`.
7. Mulai memakai pull request dan review silang; buat branch `develop` dan proteksi; beri tag `v0.1`.
8. Uji grounding dengan LLM sungguhan (butuh kunci API) dan catat latensi serta biaya.
9. Siapkan staging (Vercel dan Render/Railway) dan perkecil aset peta SVG untuk ponsel.
