-- Informasi layanan operator (gangguan, keterlambatan, penutupan, ...) dari agent pembaca akun X operator atau input
-- manual admin. Berstatus pending sampai admin menyetujui; hanya yang approved dan belum kedaluwarsa mengubah navigasi.
-- Tabel ini terpisah dari content_items agar informasi yang belum disetujui tetap bisa tampil ke pengguna (hanya sebagai info).
CREATE TABLE service_advisories (
  id          text PRIMARY KEY,
  status      text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  -- "{x|manual}:{akun}:{id postingan}" agar postingan yang sama tidak diproses dua kali; NULL bila tanpa id postingan.
  source_key  text UNIQUE,
  posted_at   timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  -- Sumber, operator, kategori, dampak, ringkasan, stasiun/lini terdampak, info ekstraksi, dan catatan pemeriksaan.
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_advisories_status_idx ON service_advisories (status, expires_at DESC);
CREATE INDEX service_advisories_posted_idx ON service_advisories (posted_at DESC);
