-- Skema awal basis data NTD (PostgreSQL 14+).
-- Prinsip Tabel 3.4 no. 12: tidak ada tabel identitas atau riwayat lokasi pengguna.

-- Cache data Commute Data API (stasiun, fasilitas, hub, lini, operator) ber-TTL,
-- ditambah salinan rute terakhir sebagai cadangan saat API tidak dapat dihubungi (UC-01 E2).
CREATE TABLE cache_entries (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  stored_at   timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX cache_entries_expires_idx ON cache_entries (expires_at);

-- Konten yang dikelola tim lewat halaman admin: koreksi/tambahan fasilitas, pintu akses,
-- pengumuman (notifikasi), info stasiun lain, dan pengaturan. Draft vs published.
CREATE TABLE content_items (
  id            text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('facility', 'entrance', 'notice', 'station_info', 'settings')),
  station_id    text,
  draft         jsonb,
  published     jsonb,
  draft_deleted boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  updated_by    text
);
CREATE INDEX content_items_kind_station_idx ON content_items (kind, station_id);

CREATE TABLE content_meta (
  id      boolean PRIMARY KEY DEFAULT true CHECK (id),
  version bigint NOT NULL DEFAULT 0
);
INSERT INTO content_meta (id, version) VALUES (true, 0);

CREATE TABLE admins (
  id             text PRIMARY KEY,
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin', 'editor')),
  password_hash  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

-- Uji coba API sebelum publikasi.
CREATE TABLE api_test_cases (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  request     jsonb NOT NULL,
  expect      jsonb NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_test_runs (
  id            text PRIMARY KEY,
  mode          text NOT NULL CHECK (mode IN ('preview', 'published')),
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  passed        integer NOT NULL,
  failed        integer NOT NULL,
  results       jsonb NOT NULL,
  triggered_by  text NOT NULL
);
CREATE INDEX api_test_runs_started_idx ON api_test_runs (started_at DESC);

CREATE TABLE audit_log (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL,
  action  text NOT NULL,
  target  text,
  detail  jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
