# Tautan transfer antar stasiun (di luar hub)

Sebagian stasiun/halte bisa dipakai pindah dengan berjalan kaki walau tidak satu hub transfer, misalnya halte BRT Bali Mester dengan halte BRT Stasiun Jatinegara, atau halte BRT Matraman Baru dengan Stasiun Matraman. Fitur ini mencatat pasangan seperti itu sebagai **tautan transfer** beserta **akses yang tersedia di jalan itu** (tangga, eskalator, lift, ramp, datar), lalu perencana rute memakainya sebagai titik pindah dan memeriksa aksesnya terhadap kebutuhan pengguna.

## Model data

Jenis konten admin baru `station_link` (migrasi `011_station_links.sql`, hanya menambah jenis yang diizinkan). Satu isian per **pasangan** stasiun (urutan tidak berpengaruh), memakai alur draf lalu publikasi yang sama dengan data lain.

| Field | Arti |
| --- | --- |
| `fromId`, `toId` | Dua stasiun/halte (id NTD, mis. `tj:h00104p`, `kci:mtr`). Harus dikenal dan berbeda. |
| `oneWay` | `true` = hanya dari `fromId` ke `toId`. Bawaan: dua arah. |
| `distanceM`, `minutes` | Jarak dan waktu jalan kaki. Kosong (`null`) = jarak garis lurus antar koordinat stasiun / waktu belum diketahui. |
| `access` | Akses di jalan itu, boleh lebih dari satu: `datar`, `ramp`, `lift`, `eskalator`, `tangga`. Kosong = **belum diketahui** (bukan "tidak ada"). |
| `dedicated` | Jalur khusus pengguna disabilitas. |
| `source` | `manual` (diisi sendiri) atau `dataset` (usulan otomatis yang dikonfirmasi admin). |
| `disabled` | Menonaktifkan tautan bawaan NTD yang keliru. |
| `note` | Petunjuk jalan (maks. 300 karakter). |

Sumber tautan yang berlaku: tautan bawaan NTD (`CURATED_LINKS` di `Backend/src/domain/stationLinks.ts`), lalu isian admin. Isian dengan pasangan yang sama menggantikan tautan bawaan. Tautan dengan stasiun yang tidak dikenal dataset dibuang.

### Contoh bawaan

| Tautan | Id |
| --- | --- |
| BRT Bali Mester ↔ BRT Stasiun Jatinegara | `tj:h00148p` ↔ `tj:h00225p` |
| BRT Matraman Baru ↔ Stasiun Matraman (KRL) | `tj:h00104p` ↔ `kci:mtr` |

Akses keduanya **belum disurvei** (`access` kosong), jadi pengguna yang butuh lift/eskalator/ramp mendapat peringatan "akses belum tercatat" sampai tim melengkapinya di admin (Detail stasiun → *Terhubung ke stasiun lain* → *Lengkapi*, lalu publikasikan).

## Aturan akses terhadap kebutuhan pengguna

Kebutuhan yang dikenal: `lift`, `eskalator`, `ramp` (sama dengan pemeriksaan titik pindah yang sudah ada). Untuk satu tautan:

| Kebutuhan | Terpenuhi bila | Tidak ada bila |
| --- | --- | --- |
| lift | ada `lift`, atau jalan tanpa anak tangga (`datar`/`ramp`) sehingga lift tidak dibutuhkan | hanya `tangga` dan/atau `eskalator` |
| eskalator | ada `eskalator`, atau jalan `datar`/`ramp`; **lift menggantikan eskalator** | hanya `tangga` |
| ramp | ada `ramp` atau `datar` (lift saja tidak menggantikan ramp) | selainnya |

`access` kosong = `unknown`. Hasil pemeriksaan masuk ke `leg.access` ruas pindah (dengan `link: { toId, means }`), sehingga ikut dihitung seperti pemeriksaan stasiun lain: tidak ada = potongan skor besar dan dihitung "pasti gagal" (kalah dari yang hanya belum diketahui), belum diketahui = potongan kecil, plus peringatan bagi pengguna.

## Perencana rute

- **Pencarian topologi** (`findRides`) memperlakukan tautan sebagai jalan kaki antar stasiun (dua arah kecuali `oneWay`), dengan biaya yang sama seperti jalan kaki hub. Dengan kebutuhan pengguna, tautan yang **pasti** gagal dilewati; bila tidak ada rute lain, tautan itu tetap dipakai dan diberi peringatan.
- **Variasi rute** menambah satu rencana dengan biaya pindah biasa bila ada tautan, supaya pindah lewat tautan ikut ditawarkan sebagai pilihan (aksesibel/moderat/tercepat dipilih seperti biasa).
- **Rute dasar dari dataset**: ruas pindah antarstasiun yang kebetulan sama dengan sebuah tautan diberi keterangan tautan (`leg.link`), jarak/waktu/petunjuk dari tautan bila diisi.
- **Pasangan yang tidak dirutekan dataset** (`/fares` tidak menemukan rute) tetap dicari lewat tautan, disusun dari urutan stasiun lini.
- Ruas pindah membawa `link: { access, dedicated?, source }`. Frontend menampilkannya di langkah "Jalan kaki ke …" dan di detail stasiun (*Terhubung ke stasiun lain*).

Belum dicakup: Rekomendasi Alternatif (`cari_alternatif`) masih hanya memakai anggota hub, bukan tautan.

## API

Publik:

- `GET /api/station-links[?stationId=]` — tautan yang berlaku (dengan `stationId`: dilihat dari stasiun itu, beserta jarak/akses).
- `GET /api/stations/:id` — sekarang memuat `links`.

Admin (`/api/admin`):

- `POST /content` / `PUT /content/:id` dengan `kind: "station_link"` — draf; satu isian per pasangan (409 bila ada, urutan terbalik pun), stasiun tak dikenal/sama/akses ganda ditolak (400).
- `GET /station-links` — `{ links, base }` (pratinjau dengan draf, dan tautan bawaan sebelum isian admin).
- `GET /station-links/suggestions?stationId=&radius=300` — **usulan dari dataset**: stasiun/halte berdekatan (jarak garis lurus) yang belum satu hub, belum bertaut, dan tidak sama-sama melayani satu lini (halte berurutan satu lini bukan titik pindah). Dengan `stationId`, dilengkapi jarak/waktu/petunjuk dari Commute (`/transfers`) bila tercatat. Hanya usulan; tidak ada yang tersimpan sampai admin menyimpannya sebagai draf lalu mempublikasikannya.

## Admin

Detail stasiun → kartu **Terhubung ke stasiun lain**: daftar tautan stasiun itu (akses, jarak, waktu, arah), tombol *Usulkan dari dataset*, *+ Tambah manual*, *Lengkapi* (untuk tautan bawaan), *Nonaktifkan*. Perubahan masuk ke draf dan terbit lewat halaman Publikasi seperti data lain.

## Tes

`Backend/test/tautan-stasiun.test.ts` (21 tes): contoh bawaan, penggantian/penonaktifan oleh admin, satu arah, aturan akses (lift menggantikan eskalator), usulan dari dataset, pencarian rute dan tautan satu arah, total rute, alur admin draf → publikasi (validasi dan konflik), serta rute Bendungan Hilir → Rasuna Said yang melewati tautan Setiabudi Astra ↔ Setiabudi LRT dengan berbagai akses dan kebutuhan.
