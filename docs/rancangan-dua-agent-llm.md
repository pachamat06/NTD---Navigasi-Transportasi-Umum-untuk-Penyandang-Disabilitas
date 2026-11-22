# Rancangan: LLM dengan dua agent (navigasi dan pembaca informasi layanan X)

Status: rancangan + implementasi backend (22 November 2026). UI admin sudah dibuat di folder `RPL\admin` (halaman **Informasi layanan** dan kartu **Agent pembaca** di Pengaturan; folder itu bukan repo git, cadangan dan patch ada di `RPL\backup-admin`). Frontend (pemilih pipeline) belum diubah; kontrak API ada di bagian 7.

## 1. Kebutuhan

1. LLM bekerja dalam dua agent:
   - **Agent navigasi**: mencari jalur ramah disabilitas sesuai rencana perjalanan pengguna.
   - **Agent pembaca**: membaca informasi layanan dari akun X operator (gangguan, keterlambatan, dan sebagainya) sebagai informasi dan acuan tambahan navigasi.
2. Admin dapat menyalakan atau mematikan mode LLM.
3. Bila mode LLM menyala, pengguna memilih pipeline **default** atau **LLM**.
4. Bila pengguna memakai pipeline default, informasi dari agent pembaca **hanya ditampilkan sebagai informasi** dan tidak mengubah navigasi. Navigasi baru berubah **setelah admin menyetujui** informasi itu.

## 2. Keputusan utama

| Topik | Keputusan | Alasan |
| --- | --- | --- |
| Toggle admin | Memakai `settings.llmEnabled` yang sudah ada (Pengaturan, lewat draft lalu publikasi). Artinya diperluas: **sakelar induk semua pemakaian LLM**. | Halaman admin sudah punya toggle ini; tidak perlu dua sakelar yang membingungkan. |
| Pilihan pengguna | Field baru `pipeline: "default" \| "llm"` pada `POST /api/plan` (bawaan `default`). `GET /api/meta` memberi tahu apakah opsi LLM tersedia. | Frontend dapat menampilkan pilihan hanya bila tersedia. |
| Pipeline default | **Tanpa panggilan LLM sama sekali**, termasuk narasi (template statis). Narasi LLM yang dulu otomatis menyala kini menjadi bagian pipeline LLM. | Sesuai maksud "default atau LLM". **Perubahan perilaku**: Frontend yang belum mengirim `pipeline` mendapat notifikasi template sampai pilihan ditambahkan. |
| Bila LLM tidak bisa dipakai | Permintaan `pipeline: "llm"` jatuh ke default dan dilaporkan di `pipeline.reason`, bukan galat. | Pengguna tetap mendapat rute. |
| Agent navigasi LLM | Loop tool-calling yang **hanya bisa memilih dan menjelajah lewat tool domain** (rute dari planner, penilaian fasilitas). LLM tidak pernah menulis rute sendiri. | Fakta rute dan fasilitas tetap berasal dari data; risiko halusinasi dibatasi secara struktural. |
| Pagar pilihan LLM | `checkChoice`: pilihan LLM ditolak (kembali ke pilihan default) bila kebutuhan fasilitas tak terpenuhi lebih banyak dari kandidat terbaik, memakai moda yang dihindari padahal ada rute lain, atau melewati penutupan yang sudah disetujui padahal ada rute lain. Alasan LLM wajib lolos pemeriksaan tautan dan angka. | Penyandang disabilitas yang salah diarahkan lebih berbahaya daripada rute yang kurang optimal. |
| Penyimpanan informasi layanan | Tabel baru `service_advisories`, terpisah dari `content_items`. | Informasi yang belum disetujui harus terlihat pengguna (info saja), padahal draft `content_items` tidak terlihat pengguna. |
| Efek navigasi | Hanya informasi **berstatus disetujui dan masih berlaku** yang mengubah navigasi: pengurangan skor rute (`delay` 8, `disruption` 30, `closure` 60) dan, untuk `disruption`/`closure`, dicarikan rute **tambahan** yang menghindari stasiun terdampak sebagai titik transfer. Rute yang tetap melewatinya tidak dibuang (bisa jadi satu-satunya atau yang paling aksesibel), hanya dikurangi skornya. Setiap rute terdampak diberi peringatan dan label. | Perubahan terukur, bisa dijelaskan, dan bisa diuji. |
| Masa berlaku | Setiap informasi punya `expiresAt` (bawaan: info 24 jam, delay 3 jam, gangguan 6 jam, penutupan 12 jam sejak postingan). Persetujuan tanpa `expiresAt` memakai bawaan itu. | Gangguan yang sudah lewat tidak boleh terus mengubah rute. |
| Admin mematikan LLM | Pembacaan X berhenti dan informasi yang belum disetujui disembunyikan. Informasi yang **sudah disetujui admin** tetap berlaku sampai kedaluwarsa (isinya sudah diperiksa manusia, seperti pengumuman biasa). | Mematikan LLM tidak boleh tiba-tiba membuka kembali rute yang ditutup. |

Matriks perilaku:

| | LLM mati | LLM menyala + pipeline default | LLM menyala + pipeline LLM |
| --- | --- | --- | --- |
| Pembacaan X berkala | tidak | ya | ya |
| Info belum disetujui ke pengguna | tidak | ya, **info saja** | ya, sebagai info dan konteks agent navigasi (diberi label belum diverifikasi) |
| Info disetujui | tampil + mengubah navigasi | tampil + mengubah navigasi | tampil + mengubah navigasi |
| Pemilihan rute | algoritma default | algoritma default | agent navigasi LLM (dengan pagar) |
| Narasi notifikasi | template | template | LLM (divalidasi Grounding Guard, cadangan template) |

## 3. Arsitektur

```
Pengguna ──POST /api/plan {pipeline}──▶ NavigationAgent
                                          │ resolvePipeline(llmEnabled, klien LLM, permintaan)
                                          ├─ default: tool deterministik ─▶ pilihRute ─▶ narasi template
                                          └─ llm:     tool deterministik ─▶ kandidat rute
                                                       └─▶ LlmNavigator (loop tool) ─▶ checkChoice ─▶ narasi LLM + Grounding Guard
   ▲ informasi layanan disetujui: skor rute berkurang + avoid transfer (semua pipeline)
   │ informasi belum disetujui: hanya muncul di plan.serviceInfo (+ konteks tool agent LLM)
ServiceAdvisoryService ◀── antrean persetujuan admin (setujui / tolak / ubah / kedaluwarsakan)
   ▲
ServiceInfoReaderAgent ◀── PostSource (X API resmi | fixture | input manual admin)
   baca post baru (since_id) ─▶ saring kata kunci ─▶ ekstraksi LLM (JSON) ─▶ pencocokan stasiun/lini deterministik ─▶ status "pending"
```

### 3.1 Agent navigasi (`src/ai/LlmNavigator.ts`)

Kandidat rute dibuat oleh pipeline yang ada (rute dasar, alternatif transfer, variasi), dinilai (skor aksesibilitas, kebutuhan fasilitas, waktu, dampak informasi layanan). Agent LLM menerima rencana pengguna (asal, tujuan, kebutuhan, moda yang dihindari, waktu) dan tool berikut:

| Tool | Fungsi |
| --- | --- |
| `lihat_pilihan_rute` | Ringkasan semua kandidat (moda, stasiun, transfer, menit, skor, kebutuhan tak terpenuhi, dampak informasi layanan). |
| `detail_rute` | Fakta rinci satu kandidat (ruas, peron, status fasilitas stasiun). |
| `cek_fasilitas` | Penilaian fasilitas satu stasiun. |
| `info_layanan` | Informasi layanan yang relevan, berlabel `disetujui` atau `belum_diverifikasi`. |
| `cari_rute_baru` | Meminta rute lain dengan menghindari stasiun/moda atau lewat stasiun tertentu; dihitung planner, paling banyak 2 kali. |
| `pilih_rute` | Mengakhiri loop dengan indeks kandidat dan alasan singkat. |

Loop dibatasi `maxSteps` (8). Bila LLM gagal, melebihi langkah, atau pilihannya ditolak pagar, hasil kembali ke pipeline default dan `pipeline.notes` menjelaskannya. Klien LLM mendapat metode baru `runTools` (Claude dan GPT); `complete` tetap ada untuk narasi dan ekstraksi.

### 3.2 Agent pembaca (`src/ai/reader/`)

1. `ServiceInfoReaderAgent.poll()` berjalan berkala (`ReaderScheduler`, bawaan 15 menit) bila: mode LLM menyala, sumber data bukan `none`, pembacaan diaktifkan admin, ada akun, dan anggaran bulanan belum habis.
2. Per akun: ambil postingan baru sejak `since_id` terakhir; buang yang lebih tua dari `maxAgeHours` (bawaan 12 jam, agar pembacaan pertama tidak memasukkan kabar lama) dan yang sudah pernah diproses.
3. Penyaringan kata kunci murah (gangguan, terlambat, ditutup, dialihkan, lift rusak, dan sebagainya) sebelum LLM, agar biaya LLM kecil.
4. Satu panggilan LLM per akun untuk semua postingan lolos saring; keluaran JSON divalidasi zod: `relevan`, `kategori`, `dampak` (usulan), `ringkasan`, `berlakuSampai`, `keyakinan`.
5. **Pencocokan stasiun/lini dilakukan deterministik pada teks postingan** (nama yang dikenal sistem), bukan dari tebakan LLM. Nama yang disebut LLM tetapi tidak cocok disimpan di `extraction.unmatched` agar admin memperbaikinya. Ringkasan yang memuat tautan atau angka yang tidak ada di postingan diganti potongan teks asli.
6. Hasil disimpan sebagai `pending`. Teks postingan diperlakukan sebagai data tak tepercaya (instruksi di dalamnya diabaikan; keluaran hanya data terstruktur yang lewat pagar dan persetujuan admin).

Mock: antarmuka `PostSource` (`FixturePostSource` untuk tes dan pengembangan, `XApiPostSource` untuk X sungguhan). Tanpa akses X, admin tetap dapat menempelkan teks postingan lewat `POST /api/admin/service-info/ingest`; jalurnya sama sampai antrean persetujuan.

## 4. Pendekatan pengambilan data X dan batasannya

Diperiksa dari dokumentasi resmi X (docs.x.com) pada 22 November 2026. Harga dan batas dapat berubah; rujukan yang berwenang untuk tarif terkini adalah Developer Console X (console.x.com), jadi periksa ulang sebelum anggaran ditetapkan.

| Pendekatan | Penilaian |
| --- | --- |
| **X API v2 resmi, Bearer Token (app-only), baca linimasa akun operator** | **Dipilih.** Stabil, sah menurut ketentuan X. Berbayar. |
| Scraping x.com (peramban otomatis/HTML) | Tidak dipilih: bertentangan dengan ketentuan X, perlu login, rapuh terhadap perubahan situs dan anti-bot, berisiko blokir akun/IP. |
| Layanan scraping pihak ketiga | Tidak dibuat: abu-abu secara hukum, biaya per hasil, bergantung vendor. Bisa menjadi `PostSource` tambahan kelak. |
| RSS/situs pengumuman operator atau GTFS-realtime alerts | Lebih stabil bila ada, tetapi cakupan operator Jabodetabek terbatas. Bisa menjadi `PostSource` tambahan. |
| Input manual admin (tempel teks/URL) | **Dibuat.** Tidak butuh akses X, dan menjadi jalan keluar bila anggaran/akses X belum ada. |

Detail X API resmi yang dipakai:

- `GET /2/users/by/username/:username` sekali per akun (id disimpan). Biaya baca pengguna: **US$0,010** per sumber daya. Batas 300 permintaan/15 menit per aplikasi.
- `GET /2/users/:id/tweets?since_id=…&exclude=retweets,replies&max_results=…` (5 sampai 100). Biaya baca postingan: **US$0,005** per postingan yang dikembalikan; permintaan tanpa data baru tidak ditagih. Postingan yang sama dalam satu hari UTC ditagih sekali. Batas 10.000 permintaan/15 menit per aplikasi.
- Tidak ada tier gratis untuk membaca. Bayar sesuai pemakaian (kredit prabayar), tanpa langganan dan tanpa belanja minimum. Batas 3 juta pembacaan postingan per bulan.
- Tarif "owned reads" (US$0,001) hanya untuk akun yang dimiliki pemilik aplikasi; tidak berlaku untuk akun operator.
- Hanya 3.200 postingan terakhir yang bisa dijangkau dan teks yang panjang dapat terpotong.
- Nama parameter bidang di dokumentasi sekarang `post.fields` (dulu `tweet.fields`). Klien mencoba `post.fields` dahulu dan beralih ke `tweet.fields` bila X menolaknya. **Klien X belum diuji ke X sungguhan** (tidak ada token); hanya diuji dengan respons tiruan.

Perkiraan biaya (dengan `since_id`, hanya postingan baru yang ditagih): 5 akun x 15 postingan/hari = 75 postingan/hari, sekitar US$0,375/hari atau **US$11 per bulan**; 5 akun x 40 postingan/hari sekitar **US$30 per bulan**. Ditambah US$0,05 sekali untuk pencarian id akun. Biaya LLM terpisah dan kecil karena penyaringan kata kunci dan satu panggilan per akun per siklus. Pagar anggaran: `monthlyPostBudget` (bawaan 3.000 postingan, sekitar US$15) menghentikan pembacaan saat tercapai.

Catatan kepatuhan: simpan hanya ringkasan, potongan teks untuk admin, tautan, dan waktu postingan; tampilkan ke pengguna ringkasan + tautan sumber (atribusi). Pastikan pemakaian ini sesuai Developer Agreement X sebelum produksi.

Akun yang dibaca diatur admin (`PUT /api/admin/ai/reader`). Tidak ada akun yang ditanam di kode. Contoh akun operator publik yang umum (verifikasi sebelum dipakai): `CommuterLine` (KRL), `mrtjakarta`, `LRTJakarta`, `PT_Transjakarta`.

## 5. Model data

`service_advisories` (migrasi `010_service_info.sql`): id, status (`pending` | `approved` | `rejected`), sumber (akun, id postingan, tautan, waktu, teks potongan), operator, kategori, dampak, ringkasan, `stationIds`, `lineIds`, `validFrom`, `expiresAt`, info ekstraksi (`llm` | `fallback` | `manual`, model, keyakinan, `unmatched`), pemeriksa dan waktu. Kunci unik pada (sumber, akun, id postingan) mencegah duplikat.

Dampak: `info` (tidak mengubah navigasi), `delay`, `disruption`, `closure`. Menyetujui dampak selain `info` mewajibkan stasiun atau lini terdampak ditentukan.

## 6. Pengujian

- `test/dua-agent-llm.test.ts`: pipeline (toggle admin, jatuh ke default, default tanpa LLM), agent navigasi dengan LLM tiruan (memilih, ditolak pagar, alasan karangan dibuang, `cari_rute_baru`, gagal, tanpa tool-calling), informasi layanan yang belum disetujui tidak mengubah navigasi lalu mengubahnya setelah disetujui dan berhenti setelah kedaluwarsa, mode LLM mati, dan antrean admin (peran, validasi, siklus status, input manual).
- `test/pembaca-x.test.ts`: agent pembaca dengan sumber fixture (saring, ekstraksi, pencocokan deterministik, duplikat dan `since_id`, anggaran, galat sumber, injeksi prompt, syarat pembacaan), klien X dengan respons tiruan, klien Claude dan GPT tool-calling dengan respons tiruan, konfigurasi, dan penjadwal.
- `test/store.test.ts`: repositori informasi layanan (memori; PostgreSQL bila `TEST_DATABASE_URL` diisi). Jangan arahkan `TEST_DATABASE_URL` ke basis data kerja: tes itu menghapus skema `public`.
- Repositori PostgreSQL juga diverifikasi pada PostgreSQL 18.2 lokal di dalam transaksi yang di-rollback (tanpa menyimpan apa pun).

## 7. Kontrak API untuk Frontend dan Admin

Publik:
- `GET /api/meta` memuat `llm: { available, pipelines, defaultPipeline, reason? }`.
- `POST /api/plan` menerima `pipeline` (`"default"` atau `"llm"`). Respons memuat `pipeline` (`requested`, `used`, `navigation`, `narration`, `reason?`, `notes[]`, `model?`) dan `serviceInfo` (daftar informasi layanan relevan dengan status `approved` atau `pending`). Ringkasan tiap pilihan rute memuat `advisoryImpact` dan `advisoryIds`.
- `GET /api/service-info?stationId=&lineId=&hubId=` daftar informasi layanan yang boleh dilihat pengguna.

Admin (`/api/admin`):
- `GET /ai/status` ringkasan mode LLM, klien, dan pembaca. Toggle tetap lewat `PUT /settings` (`llmEnabled`) lalu `POST /publish`.
- `GET|PUT /ai/reader` konfigurasi pembaca (akun, interval, anggaran, saring kata kunci) dan statusnya. PUT hanya peran admin.
- `GET /service-info?status=`, `GET /service-info/:id`, `PATCH /service-info/:id` (ubah isian, saat `pending`).
- `POST /service-info/:id/approve` | `reject` | `expire` (peran admin).
- `POST /service-info/ingest` (tempel postingan manual) dan `POST /service-info/poll` (baca sekarang), peran admin, dibatasi laju.

## 8. Batasan yang perlu diketahui

- **Informasi belum disetujui ikut ke agent LLM** sebagai data berlabel `belum_diverifikasi`. Teks yang bersumber dari postingan publik tak tepercaya, jadi risiko injeksi prompt dibatasi oleh: ringkasan hanya data (bukan instruksi), pagar pilihan, pemeriksaan alasan, dan fakta rute yang selalu dari tool domain. Bila risiko ini tidak dapat diterima, informasi `pending` dapat dikeluarkan dari tool `info_layanan`.
- **Stasiun ditutup atau terganggu (`closure`/`disruption`) hanya dihindari sebagai titik transfer** lewat rute tambahan; stasiun naik/turun tetap bisa dipilih pengguna. Rute yang melewatinya dikurangi skornya dan diberi peringatan, tetapi tidak dibuang. Ditemukan saat uji UI: bila semua rute pindah di stasiun itu, versi awal yang membuang kandidat justru menghilangkan rute yang paling aksesibel.
- **Pencocokan nama stasiun** memakai nama yang tercatat di NTD (mis. "Setiabudi (LRT)" hanya cocok bila ditulis lengkap). Nama yang disebut LLM tetapi tidak cocok dicatat di `extraction.unmatched` agar admin melengkapi saat menyetujui.
- **Kuota X per siklus tagihan** diperkirakan dengan bulan kalender UTC; tagihan resmi mengikuti siklus akun X.
- **Satu instance**: penjadwal pembacaan berjalan dalam proses server, jadi hanya satu replika yang boleh menyalakan pembacaan.
- **Pilihan pertama agent LLM** bisa berupa pilihan tanpa jenis (`kinds` kosong) bila bukan salah satu dari aksesibel, moderat, dan tercepat. Frontend perlu menampilkan `pickedBy` dan `llmReason`.

## 9. Di luar cakupan (tindak lanjut)

- UI Frontend untuk pemilih pipeline (dan menampilkan `serviceInfo`, `pickedBy`, `llmReason`).
- Pratinjau admin "bagaimana rute berubah jika disetujui".
- Penutupan otomatis informasi lama saat operator memposting "kembali normal".
- Pengujian klien X ke akun X sungguhan dan pengujian migrasi pada PostgreSQL sungguhan di lingkungan terpisah.
