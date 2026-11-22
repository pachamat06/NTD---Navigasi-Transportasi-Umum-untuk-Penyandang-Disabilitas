-- Tautan transfer antar stasiun/halte di luar hub (jenis konten 'station_link'): dua stasiun yang bisa dipakai pindah
-- dengan berjalan kaki beserta akses yang tersedia (tangga, eskalator, lift, ramp, datar), mis. halte BRT Bali Mester
-- dengan halte BRT Stasiun Jatinegara. Hanya menambah jenis konten yang diizinkan; data yang ada tidak diubah.
ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_kind_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_kind_check
  CHECK (kind IN ('facility', 'entrance', 'notice', 'station_info', 'settings', 'map_stop', 'map_track', 'platform', 'route_pattern', 'concourse', 'hub', 'station_status', 'station', 'line', 'station_link'));
