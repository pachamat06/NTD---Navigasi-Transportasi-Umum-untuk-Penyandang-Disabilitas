# NTD Backend

API perencanaan perjalanan aksesibel untuk NTD (Navigasi Transportasi Umum untuk Penyandang Disabilitas), mengikuti rancangan Bab III laporan RPL Kelompok 11.

Stack: Node.js 22+, Express 5, TypeScript, PostgreSQL 16, zod. LLM opsional (Claude atau GPT), dipakai dua agent pada mode LLM: agent navigasi dan agent pembaca informasi layanan akun X operator (lihat [Mode LLM dengan dua agent](#mode-llm-dengan-dua-agent)).

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
| Agen Navigasi (Planner) | `src/ai/NavigationAgent.ts`: pipeline tool deterministik (default, tanpa LLM). Pipeline LLM (opsional, `pipeline: "llm"`): `src/ai/LlmNavigator.ts` memilih rute lewat tool-calling, ditambah satu panggilan LLM untuk narasi |
| Agen Pembaca | `src/ai/reader/`: membaca akun X operator, mengekstrak informasi layanan, antrean persetujuan admin (`src/domain/serviceAdvisory.ts`) |
| Tool Registry | `src/ai/ToolRegistry.ts`: `cari_stasiun`, `ambil_rute`, `cek_fasilitas`, `cari_alternatif` |
| Layanan domain | `src/domain/StationService.ts`, `RoutePlannerService.ts`, `FacilityAnalysisService.ts`, `AlternativeService.ts` |
| Grounding Guard | `src/ai/GroundingGuard.ts`: cek nama stasiun, angka, dan klaim fasilitas; gagal berarti template statis. Disclaimer ditambahkan sistem |
| Klien LLM | `src/ai/llm/` (`ClaudeClient`, `GptClient`, antarmuka `LlmClient`) |
| CommuteApiClient + cache | `src/data/commute/CommuteApiClient.ts`: cache-first dengan TTL, satu permintaan per kunci (single-flight), salinan kedaluwarsa < 7 hari disajikan sambil diperbarui di latar belakang; tarif selalu segar dengan cadangan cache basi (UC-01 E2). HTTP 429 dari Commute menahan permintaan sampai `Retry-After` |
| Basis data | `src/store/pg.ts` + `migrations/`; alternatif memori `src/store/memory.ts` |

Sumber data Commute (`COMMUTE_SOURCE`):

- `fixture` (bawaan): data dummy yang sama dengan GUI basic, rute dengan Dijkstra. Berjalan tanpa internet.
- `http`: Commute Data API sungguhan (`https://api.commute.shiorilabs.id`, spesifikasi di `/openapi.json`, tanpa kunci API). Adaptornya di `src/data/commute/HttpCommuteSource.ts`. Operator yang dipakai diatur `COMMUTE_OPERATORS` (bawaan semua: KCI, MRTJ, LRTJ, LRTJBDB, APCGK, TJ; rute dari /fares bisa melewati halte TransJakarta) dan wilayah `COMMUTE_REGIONS` (bawaan CGK).

Id stasiun GUI berbentuk slug (mis. `bni-city`) karena posisi di peta dikunci dengan slug. `station-index.ts` mencocokkan slug ke stasiun API lewat operator + nama tampilan atau nama resmi, jadi kode API tidak ditulis tetap. Stasiun di luar tabel memakai id turunan `operator:kode` (mis. `kci:kat`). Slug yang tidak cocok ditampilkan di Ringkasan halaman admin; tambahkan namanya di tabel bila muncul.

Pelengkap GTFS Transjakarta (`src/data/gtfs/`): khusus koridor BRT 1–14 yang tercantum di NTD. Ruas naik TransJakarta tanpa jadwal di `/fares` diberi waktu tempuh dari jadwal GTFS (`minutesEstimated: true`, rute `timeEstimated: true`, disertai peringatan bahwa itu perkiraan); halte yang dilewati lin tetapi tidak ada di `/stations` ditambahkan dengan nama dan koordinat GTFS; koridor yang berhenti di halte menurut GTFS ditambahkan ke `lineIds`. Data dibuat ulang dari GTFS baru dengan `python3 scripts/build-tj-gtfs.py path/gtfs.zip`.

Batasan data API: tidak ada jenis fasilitas ramp (status ramp selalu "data tidak tersedia" kecuali diisi tim lewat admin), `TOILET` biasa tidak dihitung sebagai toilet aksesibel, daftar fasilitas kosong berarti data belum ada, dan /hubs tidak memuat jarak jalan kaki antarstasiun.

### Data tambahan dari admin

Dataset tidak memuat semua informasi aksesibilitas, jadi tim melengkapinya lewat halaman admin (proyek terpisah, closed source). Jenis konten (`content_items.kind`):

- `facility`: koreksi status lift, eskalator, toilet aksesibel, ramp, dll. (`available`, `absent`, `out_of_service` dengan `until`, `unknown`). Menimpa dataset untuk jenis yang sama.
- `entrance`: pintu akses/gate stasiun (nama, lokasi, fitur seperti lift/ramp/guiding block, jam buka, jumlah dan arah eskalator, lift). Dengan `exitRef`, isian tim melengkapi pintu dataset yang sama (`/exits` Commute) dan mewarisi papan petunjuknya. `platformLinks` mencatat peron yang dicapai dari gate itu dan caranya (`langsung`, `crosswalk`, `sebidang`, `jpo`, `terowongan`). Gate yang tidak langsung ke peron memakai `concourseLinks`: concourse yang dicapai dan cara berpindah ke sana (`means`: `datar`, `ramp`, `lift`, `eskalator`, `tangga`, plus `lift` berisi jumlah/status dan `dedicated`). Satu gate boleh punya keduanya.
- `concourse` (migrasi `006_concourses.sql`): area penghubung antara gate dan peron, satu entri per `code` per stasiun (`name`, `level`, `paid` untuk area setelah gerbang tiket). `platformLinks` berisi ruas concourse ke tiap peron dengan `means`, lift, eskalator, dan `dedicated` yang sama seperti ruas gate. Data pintu lama tanpa concourse tetap berlaku apa adanya. Ruas concourse → peron juga mengisi akses peron secara otomatis (`platform.accessFromConcourse`): lift, eskalator, dan ramp yang tercantum pada ruas, jumlah/lokasi lift, dan kelompok eskalatornya diturunkan ke peron terkait tanpa input ganda (`domain/concourseAccess.ts`). Hanya fakta yang dicatat yang diturunkan (ruas tanpa lift tidak membuat peron 'tidak ada lift'), isian tim pada data peron menang per field, dan turunan tidak disimpan sehingga ikut berubah bila concourse diubah. Fasilitas umum stasiun ikut terisi dari peron itu seperti isian peron biasa.
- `platform`: peron hasil survei (`code`, jenis `island`/`side`/`bay`, nomor jalur, lin dan arah yang dilayani, fasilitas per peron, eskalator `{count, direction: naik|turun|bergantian, connects}`, lift, dan celah peron dengan kendaraan `{level: sejajar|sedikit|tangga, steps, horizontalCm, verticalCm, boardingAid}`). Nomor peron dan arah diambil dari dataset (`/timetable/grouped`); isian tim menimpa dataset untuk nomor peron yang sama. Butuh migrasi `003_platforms.sql`.
- `station_info`: info lain (kontak layanan, layanan pendampingan, dll.).
- `notice`: pengumuman/notifikasi untuk stasiun, lini, hub, atau global, dengan periode aktif dan tingkat (`info`, `warning`, `critical`).
- `map_stop`: posisi pemberhentian pada Aset Peta Transit (`{x, y}`, satuan pt peta FDTJ), menang atas posisi otomatis.
- `map_track`: bentuk jalur satu lini antara dua pemberhentian bersebelahan (`{lineId, fromStationId, toStationId, points}`).
- `settings`: bobot skor aksesibilitas, ambang memadai, disclaimer, LLM on/off, TTL cache, wajib lulus uji sebelum publikasi.

Setiap konten punya versi **draft** dan **terbit**. Pengguna hanya melihat versi terbit. Admin bisa melihat hasil API dengan draft memakai header `X-NTD-Preview: 1` plus token admin. Publikasi menyalin draft ke terbit dan (opsional) menjalankan semua kasus uji API terlebih dahulu.

Skor aksesibilitas = jumlah bobot fasilitas yang tersedia, dinormalisasi 0 sampai 100 (bawaan: lift 40, eskalator 20, toilet 25, ramp 15; ambang 70). Stasiun "memadai" bila datanya ada dan skornya mencapai ambang. Fasilitas tambahan (guiding block 10, petugas bantuan 10, kursi roda, gerbang lebar, area prioritas, informasi audio, informasi visual masing-masing 5) hanya dihitung bila statusnya sudah diisi tim, sehingga stasiun yang belum disurvei tidak dirugikan. Bila tim sudah mengisi jalur gate ke semua peron (`platformLinks`) dan semuanya tanpa anak tangga (langsung, crosswalk, pelintasan sebidang, atau JPO/terowongan bertanda `stepFree`), lift dan eskalator dianggap terpenuhi pada skor stasiun (`assessment.layout`). Jalur bertanda `dedicated` (khusus pengguna disabilitas) dipakai walau gate-nya tidak aksesibel untuk umum. Rincian bobot ada di `assessment.factors`. Peron dari dataset ikut diperiksa; bila ada peron yang belum dihubungkan ke gate, faktor jalur diabaikan dan skor memakai bobot fasilitas biasa. Celah peron dengan kendaraan memotong skor (bawaan: anak tangga 15, beda tinggi kecil 5; setengahnya bila ada pelat/ramp dari petugas; `assessment.penalties`): skor stasiun memakai celah terburuk, skor perjalanan hanya celah peron yang dipakai. Jalur gate → concourse → peron dinilai sama: tanpa anak tangga bila kedua ruas `datar`/`ramp` (`via: "concourse"`, `layout.concourse`); bila ada ruas yang pindah lantai, status lift dan eskalator di ruas itu (`pathLift`, `pathEscalator`, terburuk di antara ruas yang pindah lantai) menggantikan status stasiun/peron pada skor. Jalur ber-lift diutamakan atas jalur tangga saja. Pada kebutuhan pindah (`needs`), lift/eskalator ditandai `notNeeded` bila peron yang dipakai dicapai tanpa anak tangga, sehingga tidak diperingatkan; untuk jalur lewat concourse yang pindah lantai, status lift diambil dari ruas itu. Semua bobot dan potongan dapat diatur di halaman Pengaturan admin.

Pada `POST /api/plan`, skor stasiun asal, tujuan, dan ujung perpindahan yang keluar stasiun disesuaikan dengan jalur gate ke peron yang dipakai (`assessment.journey`). Bila semua peron itu dapat dicapai tanpa pindah lantai (langsung, crosswalk, pelintasan sebidang), lift dan eskalator tidak dibutuhkan dan dianggap terpenuhi. Bila hanya lewat JPO/terowongan, lift dan eskalator menentukan skor, memakai fasilitas peron bila sudah diisi. Tanpa data `platformLinks`, skor stasiun dipakai apa adanya. Penyeberangan sebidang, crosswalk, dan JPO/terowongan tanpa lift diberi peringatan.

## API

Respons sukses `{"status":"ok","data":...}`; gagal `{"status":"error","code","message","details?"}` dengan kode `INVALID` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `RATE_LIMITED` 429, `INTERNAL` 500, `API_DOWN` 503.

### Publik

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/health` | Cek hidup |
| GET | `/api/meta` | Disclaimer, atribusi, bobot skor, label fasilitas, sumber data, dan `llm` (`available`, `pipelines`, `defaultPipeline`, `reason?`): pilihan pipeline LLM hanya ada bila admin menyalakan mode LLM dan klien LLM tersedia |
| GET | `/api/service-info?stationId=&lineId=&hubId=` | Informasi layanan operator yang boleh dilihat pengguna: yang disetujui admin dan, selama mode LLM menyala, yang belum diverifikasi (`status: "pending"`, info saja) |
| GET | `/api/stations?q=&limit=` | Daftar stasiun, atau pencarian untuk autocomplete |
| GET | `/api/stations/:id` | Detail stasiun: fasilitas tergabung, skor, peron (`platforms`), pintu akses, info, pengumuman |
| GET | `/api/network` | Data awal GUI: semua stasiun (fasilitas + skor, `commuteIds` untuk posisi peta), lini, hub, dan `map` (posisi stop dan bentuk jalur dari admin) |
| GET | `/api/map` | Posisi stop dan bentuk jalur dari admin saja |
| GET | `/api/lines`, `/api/hubs` | Lini dan hub antarmoda |
| GET | `/api/notices?stationId=&lineId=&hubId=` | Pengumuman aktif |
| POST | `/api/plan` | Rencana perjalanan (UC-01). Body `{originId, destinationId, viaStationId?, avoid?, avoidModes?, needs?, at?, pipeline?}`; `avoidModes` berisi moda yang dihindari (`RAIL`, `SUBWAY`, `TRAM`, `BUS`, `MONORAIL`); `needs` berisi fasilitas yang wajib ada saat pindah (`lift`, `eskalator`, `ramp`); `pipeline` = `default` (bawaan) atau `llm` |

Dengan `avoidModes`, bila rute dataset memakai moda yang dihindari, backend mencari rute sendiri di atas urutan stasiun lini yang diizinkan (`/lines`, termasuk cabang) dan perpindahan di hub, lalu meminta `/fares` untuk tiap ruas naik agar tarif dan jadwalnya tetap dari dataset. Ruas yang tarifnya tidak tersedia disusun dari urutan stasiun lini (tarif 0, waktu kosong) dan diberi peringatan. Bila tidak ada rute yang lolos, rute dataset tetap ditampilkan dengan peringatan.

Dengan `needs`, tiap ruas pindah memuat `access` (status tiap fasilitas di kedua ujung), titik pindah yang tidak memenuhi dicarikan alternatif di hub yang sama, jalan kaki diberi bobot lebih berat, dan peringatan ditambahkan bila fasilitas tidak tercatat, rusak, atau belum ada datanya. **Lift menggantikan eskalator**: stasiun yang hanya punya lift tetap memenuhi kebutuhan `eskalator` (ruas pindah diberi `substitute: "lift"`); sebaliknya tidak berlaku. Pindah lini di stasiun yang sama tanpa ruas pindah dari dataset tetap dihitung sebagai titik pindah. Pilihan "paling aksesibel" mendahulukan rute dengan paling sedikit kebutuhan yang **pasti** tidak terpenuhi (`summary.unmetCertain`: tercatat tidak ada atau rusak) sebelum membandingkan skor, sehingga rute yang hanya belum diketahui datanya mengalahkan rute yang pasti gagal.

Rute dilengkapi dari Commute: jarak, petunjuk, dan pintu keluar jalan kaki saat pindah (`/stations/{op}/{code}/transfers`); lin paralel yang berhenti di pemberhentian yang sama dengan tarif sama sebagai `options` (mis. TJ 4, 4D, 5, 5C dari Matraman ke Kesatrian; dari `serviceLines` /fares, atau urutan halte lin operator yang sama); dan `frequency` (headway gabungan, `/stations/{op}/{code}/headway`) karena /fares tidak memberi jam keberangkatan. `at` diteruskan ke /fares untuk tarif peak/off-peak.

Ruas naik memuat `platform` (nomor peron dari /fares) dan `boardAt` (peron beserta fasilitas dan celahnya) bila peron dapat dipastikan. Pengecekan `needs` memakai fasilitas peron tempat naik/turun bila tim sudah mengisinya, dan peringatan ditambahkan bila naik kendaraan perlu menaiki anak tangga.

`POST /api/plan` mengembalikan rute (bentuk sama dengan `Frontend/src/lib/types.ts`), penilaian fasilitas tiap stasiun transit, hingga 3 alternatif via stasiun lain di hub yang sama, pengumuman terkait, narasi notifikasi, peringatan (mis. data dari cache), disclaimer, dan atribusi. Tambahan: `pipeline` (diminta dan dipakai) dan `serviceInfo` (informasi layanan operator yang relevan dengan rute).

### Mode LLM dengan dua agent

Rancangan lengkap: [`docs/rancangan-dua-agent-llm.md`](../docs/rancangan-dua-agent-llm.md).

- **Sakelar admin**: `llmEnabled` pada `/settings` (draft, lalu `/publish`). Mati = tidak ada pemakaian LLM sama sekali (agent navigasi, narasi, dan pembacaan X). Menyala + klien LLM ada = pengguna boleh memilih `pipeline: "llm"`.
- **Pipeline default** (bawaan, tanpa LLM): algoritma deterministik dan notifikasi template. Pipeline **LLM**: agent navigasi memilih satu rute dari kandidat planner lewat tool-calling (`lihat_pilihan_rute`, `detail_rute`, `cek_fasilitas`, `info_layanan`, `cari_rute_baru`, `pilih_rute`), pilihannya melewati pagar (`checkChoice`), lalu LLM menyusun narasi yang divalidasi Grounding Guard. Bila LLM mati atau gagal, permintaan turun ke default (`pipeline.reason` / `pipeline.notes`).
- **Agent pembaca** membaca postingan akun operator (X API resmi, berbayar per postingan; atau fixture; atau teks yang ditempel admin lewat `/service-info/ingest`), mengekstrak informasi layanan dengan LLM, dan mengantre sebagai `pending`. Informasi `pending` hanya tampil sebagai info (`serviceInfo`, `/api/service-info`) dan **tidak mengubah navigasi**. Setelah admin menyetujui (`/service-info/:id/approve`), rute yang melewati stasiun/lini terdampak dikurangi skornya (delay 8, gangguan 30, penutupan 60), dicarikan rute tambahan yang menghindari stasiun terganggu sebagai titik pindah (rute yang tetap melewatinya tidak dibuang), dan peringatan ditambahkan, sampai `expiresAt`.
- **Kunci API**: diisi di admin (Pengaturan, kartu LLM dan kartu Agent pembaca) agar mudah diganti dan tidak perlu ada di `.env`. Disimpan **terenkripsi** (AES-256-GCM, kunci turunan `ADMIN_TOKEN_SECRET`) di tabel `server_config`, berlaku tanpa restart, dan tidak pernah dikirim ke browser atau dicatat di log aktivitas (hanya empat karakter terakhir). Kunci di `.env` (`LLM_API_KEY`, `X_API_BEARER_TOKEN`) tetap berfungsi sebagai cadangan; kunci admin menang. Bila `ADMIN_TOKEN_SECRET` berubah, kunci tersimpan tidak terbaca dan harus diisi ulang. Catatan: cadangan basis data memuat kunci terenkripsi, jadi simpan `ADMIN_TOKEN_SECRET` terpisah dari cadangan.
- **X API**: token dari admin atau `X_API_BEARER_TOKEN`; `SERVICE_INFO_SOURCE=fixture` hanya untuk uji. Harga (per 22 November 2026): baca postingan US$0,005 dan baca pengguna US$0,010 per sumber daya yang dikembalikan, tanpa tier gratis; hanya postingan baru (`since_id`) yang ditagih. Pembacaan bawaan **mati**; admin mengaktifkannya, mengisi akun, dan menetapkan anggaran bulanan di `/ai/reader`.

Endpoint admin tambahan (peran admin kecuali ditandai):

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/ai/status` | Mode LLM (terbit dan draft), klien, ketersediaan, status pembaca, jumlah informasi pending |
| GET, PUT | `/ai/llm` | Penyedia, model, batas waktu, dan kunci API LLM (kunci tidak pernah dikembalikan); PUT hanya admin |
| POST | `/ai/llm/test` | Uji koneksi LLM dengan satu panggilan singkat; galat penyedia ditampilkan apa adanya (hanya admin, dibatasi laju) |
| GET, PUT | `/ai/reader` | Konfigurasi pembaca (akun, interval, anggaran, saring kata kunci, token X `xBearerToken`/`clearXToken`) dan status; PUT hanya admin |
| GET | `/service-info?status=&limit=` | Antrean informasi layanan (editor boleh melihat) |
| GET, PATCH | `/service-info/:id` | Detail (termasuk teks asli postingan); ubah isian selama `pending` (editor boleh) |
| POST | `/service-info/:id/approve` · `/reject` · `/expire` | Setujui (dengan perubahan opsional; dampak selain `info` wajib punya stasiun/lini), tolak, atau akhiri lebih awal (hanya admin) |
| POST | `/service-info/ingest` · `/service-info/poll` | Tempel postingan manual; baca akun sekarang (hanya admin, dibatasi laju) |

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
| GET | `/routes` · `/routes/:lineId/defaults?source=gtfs\|commute` | Urutan stasiun lini; rute bawaan dua arah untuk sinkron (urutan, waktu antarpemberhentian, frekuensi, jam layanan, `notes` ringkasan) |
| POST | `/routes/sync` | `{lineIds (1–10), source: auto\|gtfs\|commute}`: sinkron banyak rute sekaligus dan simpan sebagai draft kedua arah; catatan admin dipertahankan |
| GET | `/hubs` · `/hubs/defaults?hubId=&members=&source=commute\|gtfs` | Hub yang berlaku (pratinjau) dan hub bawaan; data Commute untuk satu hub (anggota dan jalan kaki dari `/transfers`), atau halte koridor BRT GTFS dalam `radius` (bawaan 300 m) dari anggotanya |
| GET | `/lines` | Lini yang berlaku di pratinjau (dataset + rute tambahan/koreksi admin) |
| GET | `/hubs/suggestions?source=gtfs&radius=` | Usulan hub dari GTFS: halte koridor BRT dalam 250 m dari stasiun rel yang belum satu hub dengannya |
| POST | `/dataset/refresh` | `{parts?: stations\|lines\|hubs}` (admin): muat ulang dari Commute sekarang juga tanpa menunggu cache; balikan perubahan (`diff`), pengaturan rute yang tertinggal (`stalePatterns`) |
| GET | `/stations/candidates?source=commute\|gtfs` | Usulan stasiun yang belum ada di NTD: stasiun di lin Commute yang belum di `/stations`, atau halte GTFS (plus halte yang nama/koordinatnya berbeda) |
| GET | `/stations/defaults?stationId=&source=commute\|gtfs` | Isian form stasiun dari Commute atau GTFS |
| GET | `/routes/candidates?source=gtfs` | Koridor BRT GTFS yang belum menjadi rute NTD (untuk tambah rute) |
| GET | `/system` · POST `/cache/purge` · GET `/audit` | Status layanan, kosongkan cache, log aktivitas |
| POST | `/stations/:id/floor-plan` | `{images: [{data, name?}]}` (1–4 gambar base64, maks. 5 MB/gambar) → usulan fasilitas, peron, gate, dan info dari AI. Tidak menyimpan apa pun; dibatasi 20 kali per 10 menit |
| GET, PUT | `/ai/vision` | Penyedia AI pembaca denah (provider, model, endpoint, batas waktu, kunci API). Kunci tidak pernah dikembalikan; PUT hanya admin |

#### Sinkron rute dan hub transfer

- Sinkron rute dari GTFS Transjakarta mengisi waktu antarhalte, frekuensi rata-rata (ditimbang lama jendela frekuensi), dan jam layanan. Dari Commute, moda rel memakai jadwal hari kerja (`/stations/{op}/{code}/timetable`): waktu = median selisih jam berangkat pada nomor perjalanan yang sama di dua stasiun berurutan, frekuensi = rata-rata jarak keberangkatan dari stasiun awal, jam layanan = keberangkatan pertama–terakhir. TransJakarta lewat Commute memakai GTFS untuk waktu dan `/headway` (pukul 08.00) untuk frekuensi dan jam layanan. Pemberhentian yang belum dikenal NTD dibuang.
- Hub transfer berlaku = `/hubs` Commute + hub bawaan NTD (`CURATED_HUBS`, mis. halte TransJakarta Cawang ↔ stasiun LRT Cawang, 170 m dari `/transfers`) + konten `hub` dari admin (id sama menggantikan, `disabled` menonaktifkan). Hub dipakai pencarian rute topologi, alternatif di hub, dan `hubId` stasiun. Hub tanpa data jalan kaki memakai jarak garis lurus antarkoordinat.

#### Stasiun dan rute manual, sinkron dataset

- Konten `station` (satu per stasiun, `stationId` = id stasiun) menambah stasiun yang belum ada di dataset (id baru, mis. `ntd:halte-baru`, atau id turunan `lrtj:kym` dari usulan) atau mengoreksi nama/operator/nomor/lini/koordinat stasiun dataset dengan id sama. Konten `line` (satu per `lineId`) menambah rute baru atau mengoreksi nama/operator/moda/warna. Urutan pemberhentian tetap lewat `route_pattern`.
- Stasiun yang tidak dikenal Commute (`source` `admin` atau `ntd`) dirutekan di atas urutan lini (pengaturan rute admin + dataset); waktu dari pengaturan rute bila diisi.
- Stasiun bawaan NTD (`BUILTIN_STATIONS`, `src/domain/datasetOverlay.ts`): LRT Jakarta Pramuka (S08, beroperasi 12 November 2026). Hanya dipakai bila lini `lrtj:s` ada di dataset tetapi stasiunnya belum (mis. cache lama); Commute Data API sudah memuatnya sejak 11 November.
- `GET /routes` memberi `missing` untuk lini yang pengaturan rutenya tertinggal dari dataset (mis. urutan LRT Jakarta yang disinkron sebelum Pramuka dikenal). Sinkron ulang rute itu untuk memasukkannya.

#### Isi fasilitas dari gambar denah

Halaman stasiun di admin punya "Isi otomatis dari gambar denah": foto papan denah per lantai (dengan legenda), peta lokalitas, dan angkutan lanjutan dikirim ke backend, diteruskan ke penyedia AI, lalu jawabannya dipetakan ke skema konten NTD (`facility`, `platform`, `entrance`, `station_info`) dan divalidasi. Admin memeriksa, menyunting, dan memilih usulan; yang dipilih disimpan sebagai draft lewat `/content` dan baru terlihat pengguna setelah publikasi.

- Penyedia bawaan Claude (`claude-sonnet-5-5`, structured output JSON, cadangan sisi server bila model menolak). Alternatif: `openai` = endpoint apa pun yang kompatibel dengan OpenAI Chat Completions.
- Konfigurasi dari `AI_VISION_*` (lihat `.env.example`), dapat ditimpa admin di Pengaturan → AI pembaca denah. Disimpan di tabel `server_config` (migrasi 005), di luar alur draft/publikasi.
- Kunci API hanya dipakai untuk penyedia dan endpoint tempat kunci itu diisi; mengganti penyedia/endpoint tidak mengirim kunci lama ke tujuan baru.
- Body besar (hingga 24 MB) hanya diurai untuk token admin yang valid; endpoint lain tetap 100 kB.

## Deployment

- Set `NODE_ENV=production`, `DATABASE_URL` (pakai `?sslmode=require` untuk TLS), `ADMIN_TOKEN_SECRET` (min. 32 karakter, `openssl rand -hex 32`), `CORS_ORIGINS`, dan `ADMIN_ORIGINS`.
- Isi `ADMIN_BOOTSTRAP_EMAIL/PASSWORD` sekali untuk membuat admin pertama, lalu hapus.
- `npm run build && npm start`. Migrasi berjalan otomatis saat start (dikunci dengan advisory lock).
- Tanpa `LLM_API_KEY`, notifikasi memakai template statis dan pilihan pipeline LLM tidak tersedia. Model Claude bawaan `claude-opus-5-5`; ganti lewat `LLM_MODEL`.
- Pembacaan akun X (`SERVICE_INFO_SOURCE=x`) berjalan di satu instance saja (penjadwal dalam proses). Jangan menyalakannya di lebih dari satu replika.

Catatan: perbaikan npm workspaces di root (`Backend`/`Frontend`) ada di patch Fase 0.
