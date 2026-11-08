# Panduan Pengguna NTD

NTD (Navigasi Transportasi Umum untuk Penyandang Disabilitas) membantu pengguna kursi roda, penyandang keterbatasan fisik, lansia, dan orang tua dengan stroller merencanakan perjalanan multimoda di Jabodetabek. Selain rute dan tarif, NTD menunjukkan apakah stasiun dan titik pindah yang dilalui punya fasilitas yang dibutuhkan (lift, eskalator, toilet aksesibel, ramp) dan menawarkan titik pindah alternatif di hub yang sama.

Dokumen ini terdiri atas panduan untuk **pengguna** (Bagian A), **admin** (Bagian B), dan **pengembang** yang menjalankan sistem secara lokal (Bagian C).

> **Penting:** informasi fasilitas berasal dari data statis dan bukan kondisi real-time. Lift atau eskalator yang tercatat "tersedia" bisa sedang rusak, dan "data tidak tersedia" tidak berarti fasilitasnya tidak ada. Pastikan kondisi sebenarnya dengan petugas stasiun.

---

## Bagian A. Panduan pengguna

### A.1 Yang dibutuhkan

- Peramban modern (Chrome, Edge, Firefox, atau Safari versi terbaru) di komputer atau ponsel.
- Koneksi internet. Layar ponsel dan komputer sama-sama didukung.
- Tidak perlu mendaftar atau masuk.

### A.2 Merencanakan perjalanan

1. Buka alamat aplikasi NTD (secara lokal `http://localhost:3000`). Halaman awal berisi form **Rencanakan perjalanan aksesibel** dan peta transit di sebelahnya (di ponsel, peta berada di bawah form).

   ![Halaman awal](img/01-beranda.jpg)

2. Isi kolom **Dari** dengan mengetik nama atau kode stasiun, misalnya `sudir` atau `C12`. Daftar saran muncul. Pilih dengan klik/ketuk, atau dengan papan ketik: tombol panah atas/bawah untuk berpindah, **Enter** untuk memilih, **Esc** untuk menutup daftar.

   ![Autocomplete stasiun](img/02-autocomplete.jpg)

3. Isi kolom **Ke** dengan cara yang sama. Alternatif: **tekan pemberhentian bertanda lingkaran biru di peta**, lalu pilih **Jadikan Asal** atau **Jadikan Tujuan**. Tombol **⇅ Tukar** menukar asal dan tujuan. Bila asal sama dengan tujuan, muncul pesan "Asal dan tujuan tidak boleh sama." dan tombol Cari Rute nonaktif.

4. Atur preferensi (opsional):
   - **Moda yang dipakai:** matikan moda yang ingin dihindari (KRL, MRT, LRT, TransJakarta, Kalayang). Bila tidak ada rute tanpa moda itu, NTD tetap menampilkan rute yang ada disertai peringatan.
   - **Butuh fasilitas saat pindah:** centang **Lift**, **Eskalator**, dan/atau **Ramp**. NTD mengutamakan titik pindah yang memilikinya dan memberi peringatan bila fasilitas itu tidak tercatat atau rusak.

   ![Form terisi](img/03-form-terisi.jpg)

5. Tekan **Cari Rute**. Muncul indikator proses (mencari rute, memeriksa fasilitas, mencari alternatif, menyusun ringkasan). Tombol **Batalkan** menghentikan pencarian.

### A.3 Membaca hasil

![Hasil rute](img/04-hasil-atas.jpg)

Hasil terdiri atas bagian berikut, dari atas ke bawah.

| Bagian | Isi |
|---|---|
| **Ringkasan** | Waktu tempuh, jarak, tarif, dan jumlah transfer. Tanda `*` atau "Tidak tersedia" berarti sebagian ruas tidak punya data waktu (lihat A.7). Waktu TransJakarta bertanda `±` karena perkiraan dari jadwal GTFS |
| **Notifikasi** | Ringkasan dalam kalimat: naik apa, dari mana ke mana, pindah di mana, dan status lift di tiap stasiun. Setiap fakta berasal dari data sistem, bukan karangan |
| **Peringatan** | Kotak kuning: data tidak lengkap, waktu perkiraan, fasilitas yang Anda butuhkan tidak tercatat, dan sebagainya |
| **Rute** | Urutan stasiun dan ruas. Tiap stasiun menampilkan status aksesibilitas (lihat tabel di bawah). Ruas naik memuat lin, arah, jumlah pemberhentian, jarak, tarif, peron (bila diketahui), dan perkiraan jarak antar kedatangan. Ruas jalan kaki di hub ditandai dengan jaraknya |
| **Peta** | Rute disorot pada peta. Titik A adalah asal dan B tujuan. Stasiun diberi tanda status |
| **Disclaimer dan atribusi** | Di bagian bawah halaman: sumber data (Commute Data API, FDTJ) dan peringatan data statis |

![Rute dan transfer](img/05-hasil-rute.jpg)

**Status aksesibilitas stasiun**

| Tanda | Arti |
|---|---|
| ✔ **Memadai** (skor 70 atau lebih) | Fasilitas yang tercatat cukup. Skor 0 sampai 100 dihitung dari bobot lift 40, toilet aksesibel 25, eskalator 20, ramp 15 (dapat diubah admin) |
| ⚠ **Perlu perhatian** | Data ada, tetapi skornya di bawah ambang. Misalnya lift tidak tercatat |
| ? **Data tidak tersedia** | Dataset tidak memuat fasilitas stasiun itu. **Bukan berarti fasilitas tidak ada** |

**Titik pindah dan alternatif.** Bila titik pindah kurang memadai, NTD menampilkan kotak **Alternatif di Hub** (misalnya "Via Dukuh Atas BNI") berikut skornya. Tekan **Pakai rute ini** untuk menghitung ulang lewat alternatif itu. Bila tidak ada pilihan yang lebih baik, muncul peringatan "Tidak ada alternatif transfer yang lebih aksesibel di hub ini".

### A.4 Detail stasiun

Tekan nama stasiun pada hasil rute atau pemberhentian di peta, lalu **Lihat fasilitas**. Dialog menampilkan operator, lin, kode stasiun, skor, status tiap fasilitas (Tersedia, Tidak tercatat, Data tidak tersedia, atau Sedang tidak berfungsi), peron, pintu akses, serta pengumuman yang berlaku. Dari sana Anda bisa langsung **Jadikan Asal** atau **Jadikan Tujuan**.

![Detail stasiun](img/06-detail-stasiun.jpg)

### A.5 Peta

- Tombol **+** dan **−** memperbesar dan memperkecil; tombol ⟲ kembali ke area hub atau seluruh rute; tombol ⤢ menampilkan seluruh peta.
- Geser peta dengan mouse atau jari. Cubit untuk memperbesar di layar sentuh.
- Pemberhentian dapat dipilih dengan papan ketik (Tab ke pemberhentian, lalu Enter atau Spasi).
- Peta adalah Peta Integrasi Transportasi Umum Jakarta © FDTJ (edisi 2026-08c). Hanya stasiun/halte dalam cakupan NTD (lingkaran biru) yang dapat dipilih.

### A.6 Pengaturan tampilan

Tekan ikon **Aa** di kanan atas.

![Pengaturan tampilan](img/07-pengaturan-tampilan.jpg)

| Pengaturan | Fungsi |
|---|---|
| Ukuran teks (A, A+, A++) | Memperbesar teks |
| Kontras tinggi | Warna dengan kontras lebih kuat |
| Kurangi animasi | Mematikan gerak dan transisi |

Tombol **ⓘ** membuka penjelasan cakupan dan disclaimer NTD. Tekan **Esc** untuk menutup dialog.

### A.7 Pengumuman

Bila admin menerbitkan pengumuman (misalnya "lift sedang diperbaiki"), pengumuman tampil di halaman awal, pada detail stasiun terkait, dan pada hasil rute yang melewatinya.

![Pengumuman di halaman awal](img/10-pengumuman-publik.jpg)

### A.8 Di ponsel

Susunan halaman: form, peta, lalu hasil. Pada hasil, tombol **Lihat di peta ↑** membawa Anda ke peta.

| Beranda | Hasil rute |
|---|---|
| ![Beranda ponsel](img/08-mobile-beranda.jpg) | ![Hasil di ponsel](img/09-mobile-hasil.jpg) |

### A.9 Pesan galat dan cara mengatasinya

| Pesan | Penyebab | Yang dilakukan |
|---|---|---|
| "Data stasiun belum bisa dimuat. Server NTD tidak dapat dihubungi." | Backend mati atau tidak terjangkau | Periksa koneksi, tekan **Coba lagi**. Pengembang: pastikan backend berjalan dan alamat API benar |
| "Asal dan tujuan tidak boleh sama." | Dua kolom berisi stasiun yang sama | Ganti salah satunya |
| "Terlalu banyak permintaan. Coba lagi sebentar lagi." | Batas 60 permintaan per menit per alamat IP terlampaui | Tunggu satu menit |
| "Data belum bisa dimuat" | Commute Data API bermasalah dan cache kosong | Tekan **Coba lagi**, atau ulangi nanti |
| "Sumber data sedang tidak dapat dihubungi. Menampilkan data tersimpan terakhir" | Commute Data API bermasalah tetapi ada cache | Hasil tetap tampil dari data tersimpan; waspadai data yang mungkin lama |
| Waktu tempuh "Tidak tersedia" | Commute API tidak memberi durasi untuk ruas kereta | Gunakan jarak, tarif, dan jarak antar kedatangan sebagai pegangan |
| Stasiun berlabel "Data tidak tersedia" | Dataset belum memuat fasilitas stasiun | Tanyakan ke petugas stasiun. Tim dapat melengkapinya lewat halaman admin |

### A.10 Batasan

- Fokus pada aksesibilitas mobilitas fisik. Informasi sensorik (misalnya guiding block) hanya ada bila tim sudah mengisinya.
- Data fasilitas statis, bukan status real-time. Tidak ada pelaporan kondisi oleh pengguna dan permintaan bantuan otomatis ke petugas (fase lanjutan).
- Jadwal keberangkatan pasti tidak tersedia; yang ditampilkan adalah perkiraan jarak antar kedatangan.
- Cakupan hub utama adalah Sudirman, Dukuh Atas, dan BNI City. Stasiun lain tersedia, tetapi data fasilitasnya lebih sering kosong.

---

## Bagian B. Panduan admin

Halaman admin adalah proyek terpisah (`ntd-admin`, tertutup) yang memakai API `/api/admin`. Admin melengkapi data yang tidak ada di dataset Commute: koreksi fasilitas, gangguan sementara, pintu akses, peron, concourse, pengumuman, dan posisi peta.

Alamat bawaan lokal: `http://localhost:5173`. Peran:

| Peran | Hak |
|---|---|
| **admin** | Semua, termasuk publikasi dan kelola pengguna |
| **editor** | Menyiapkan draft dan menjalankan uji. Tidak dapat mempublikasikan |

### B.1 Masuk

Masuk dengan email dan kata sandi. Admin pertama dibuat otomatis dari `ADMIN_BOOTSTRAP_EMAIL` dan `ADMIN_BOOTSTRAP_PASSWORD` pada `.env` backend saat basis data belum punya admin. Percobaan masuk dibatasi 10 kali per 15 menit. Token tersimpan di tab peramban dan hilang saat tab ditutup.

![Masuk admin](img/a1-login.jpg)

### B.2 Menu

| Menu | Fungsi |
|---|---|
| **Ringkasan** | Status basis data, Commute Data API (latensi, slug peta yang belum cocok), LLM, jumlah perubahan yang menunggu terbit, hasil uji terakhir |
| **Stasiun & fasilitas** | Daftar stasiun. Buka satu stasiun untuk mengoreksi fasilitas, mengisi peron, gate, concourse, info stasiun, atau mengisi otomatis dari gambar denah (AI) |
| **Pengumuman** | Gangguan lift, perubahan pintu akses, dan sebagainya, untuk stasiun, lini, hub, atau semua pengguna |
| **Rute & urutan halte** | Mengatur urutan pemberhentian tiap lin per arah |
| **Posisi peta** | Menggeser pemberhentian dan membentuk jalur pada peta |
| **Uji coba API** | Konsol API, perbandingan hasil terbit vs draft, dan kasus uji |
| **Publikasi** | Menerbitkan draft ke pengguna |
| **Pengaturan** | Bobot skor, ambang, disclaimer, TTL cache, opsi LLM dan AI pembaca denah |
| **Pengguna admin** | Tambah dan nonaktifkan admin (hanya admin) |
| **Log aktivitas** | 200 jejak perubahan terbaru |

![Ringkasan](img/a2-ringkasan.jpg)

### B.3 Melengkapi data stasiun

1. Buka **Stasiun & fasilitas**, cari stasiun, lalu buka.
2. Halaman detail menampilkan **Penilaian aksesibilitas** (versi terlihat pengguna dan pratinjau dengan draft) dan tabel fasilitas dengan kolom Dataset, Informasi tim, Terlihat pengguna, dan Pratinjau.
3. Tekan **Isi** pada baris fasilitas untuk menimpa dataset: status Tersedia, Tidak ada, Sedang tidak berfungsi (dengan tanggal berakhir), atau Belum diketahui. Informasi tim menimpa dataset untuk jenis fasilitas yang sama.
4. Simpan. Perubahan menjadi **draft** dan belum terlihat pengguna.

![Detail stasiun di admin](img/a4-detail-stasiun.jpg)

### B.4 Membuat pengumuman

1. **Pengumuman → + Pengumuman baru**.
2. Pilih **Berlaku untuk**. Untuk cakupan selain "Semua pengguna", **pilih stasiun, lini, atau hub** di kolom di bawahnya sebelum menyimpan.
3. Isi **Tingkat** (Info, Peringatan, Penting), **Judul**, dan **Isi**. Periode mulai dan berakhir bersifat opsional.
4. Tekan **Simpan draft**.

![Formulir pengumuman](img/a5-pengumuman-form.jpg)

### B.5 Menguji lalu menerbitkan

1. Buka **Uji coba API**. Tekan **Kirim** dengan "Pakai data draft" aktif untuk melihat persis hasil draft, atau **Bandingkan** hasil rute terbit vs draft.
2. Pada **Kasus uji**, tekan **+ Kasus baru** atau jalankan skrip `Backend/scripts/seed-test-cases.mjs` (Bagian C.4) untuk mengisi 7 kasus bawaan. Tekan **Jalankan semua (draft)**. Setiap kasus menampilkan lulus atau gagal, latensi, dan ringkasan rute.

   ![Kasus uji](img/a8-uji-coba.jpg)

3. Buka **Publikasi**. Perubahan yang menunggu tampil dengan perbedaan antara versi terbit dan draft. Tekan **Publikasikan semua** (atau pilih sebagian). Bila pengaturan "wajib lulus uji" aktif dan ada kasus yang gagal, publikasi ditolak; admin dapat memilih **Publikasikan paksa**.

   ![Publikasi](img/a6-publikasi.jpg)

4. Setelah terbit, pengguna langsung melihatnya (lihat gambar A.7).

![Setelah terbit](img/a7-terbit.jpg)

---

## Bagian C. Menjalankan secara lokal (pengembang)

### C.1 Prasyarat

Node.js 22 atau lebih baru, npm, Git, dan (opsional) Docker untuk PostgreSQL.

### C.2 Pemasangan dan konfigurasi

```bash
git clone https://github.com/pachamat06/NTD---Navigasi-Transportasi-Umum-untuk-Penyandang-Disabilitas.git
cd NTD---Navigasi-Transportasi-Umum-untuk-Penyandang-Disabilitas
npm ci                                   # memasang Backend dan Frontend (npm workspaces)

cp Backend/.env.example Backend/.env     # lalu isi nilai di bawah
echo 'NEXT_PUBLIC_API_URL=http://localhost:4000' > Frontend/.env.local
```

Nilai penting di `Backend/.env` (selengkapnya di `Backend/.env.example`):

| Variabel | Keterangan |
|---|---|
| `COMMUTE_SOURCE` | `fixture` (data dummy, tanpa internet) atau `http` (Commute Data API sungguhan, tanpa kunci API) |
| `DATABASE_URL` | Kosong untuk penyimpanan memori (data admin hilang saat backend berhenti). Contoh PostgreSQL: `postgres://ntd:ntd@localhost:5432/ntd` |
| `CORS_ORIGINS` | Alamat web pengguna, harus sama dengan alamat yang dibuka di peramban (bawaan `http://localhost:3000`) |
| `ADMIN_ORIGINS` | Alamat halaman admin (bawaan `http://localhost:5173`) |
| `ADMIN_TOKEN_SECRET` | Wajib minimal 32 karakter di production (`openssl rand -hex 32`) |
| `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` | Admin pertama. Hapus setelah login pertama |
| `LLM_PROVIDER`, `LLM_API_KEY` | `none` atau tanpa kunci: notifikasi memakai template statis |

### C.3 Menjalankan

```bash
docker compose -f Backend/docker-compose.yml up -d db   # opsional, bila memakai PostgreSQL
npm run dev                                              # Backend :4000 dan Frontend :3000

# halaman admin (proyek terpisah, folder admin di samping folder repositori)
cd ../admin && npm install && npm run dev                # :5173
```

Pemeriksaan cepat: `curl http://localhost:4000/health` harus menjawab `{"status":"ok"}`, dan `http://localhost:3000` menampilkan form rute.

### C.4 Persiapan sebelum demo

1. Jalankan backend dengan `COMMUTE_SOURCE=http` bila internet tersedia (atau `fixture` bila tidak).
2. Isi kasus uji dan panaskan cache sekaligus:

   ```bash
   ADMIN_EMAIL=admin@ntd.test ADMIN_PASSWORD='...' node Backend/scripts/seed-test-cases.mjs --run
   ```

3. Lengkapi data lift, eskalator, dan toilet aksesibel stasiun hub Sudirman, Dukuh Atas BNI, Manggarai, dan Tanah Abang lewat admin, lalu publikasikan.
4. Buka sekali rute yang akan didemokan agar cache hangat (permintaan pertama bisa memakan 5 sampai 7 detik).
5. Pastikan `CORS_ORIGINS` memuat alamat yang dipakai di peramban bila demo bukan di `localhost`.

### C.5 Pengujian dan build

```bash
npm test -w Backend            # 132 tes Jest
npm run typecheck -w Backend
npm run lint -w Frontend
npm run typecheck -w Frontend
npm run build                  # build Backend dan Frontend
```

Hasil lengkap pengujian ada di [`test-report.md`](test-report.md). Dokumentasi endpoint ada di [`Backend/README.md`](../Backend/README.md).

### C.6 Pertanyaan umum

**Mengapa waktu tempuh "Tidak tersedia"?** Commute Data API hanya memberi jarak dan tarif untuk ruas kereta. Durasi TransJakarta diperkirakan dari GTFS dan ditandai `±`.

**Mengapa banyak stasiun berlabel "Data tidak tersedia"?** Dataset publik belum memuat fasilitas semua stasiun. Admin melengkapinya lewat halaman admin.

**Apakah ada notifikasi dari AI?** Notifikasi disusun dari template statis. Bila `LLM_PROVIDER` dan `LLM_API_KEY` diisi, model hanya menyusun kalimat, dan Grounding Guard menolak teks yang memuat stasiun, angka, atau klaim fasilitas yang tidak ada di data (otomatis kembali ke template).

**Data admin hilang setelah backend dimulai ulang?** Itu terjadi bila `DATABASE_URL` kosong (penyimpanan memori). Isi `DATABASE_URL` dengan PostgreSQL.
