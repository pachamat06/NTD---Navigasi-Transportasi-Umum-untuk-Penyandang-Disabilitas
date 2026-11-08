-- Konfigurasi server yang dikelola admin di luar alur draft/publikasi, mis. penyedia AI pembaca denah
-- (provider, model, endpoint, kunci API). Nilai hanya dibaca backend; kunci API tidak pernah dikirim ke browser.
CREATE TABLE server_config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
