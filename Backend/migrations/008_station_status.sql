-- Status operasional stasiun dari admin (jenis konten 'station_status'): stasiun yang sudah tidak beroperasi
-- (mis. Karet) ditandai nonaktif agar pencarian rute memberi pesan yang jelas, atau diaktifkan kembali.
ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_kind_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_kind_check
  CHECK (kind IN ('facility', 'entrance', 'notice', 'station_info', 'settings', 'map_stop', 'map_track', 'platform', 'route_pattern', 'concourse', 'hub', 'station_status'));
