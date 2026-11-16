-- Stasiun dan lini dari admin (jenis konten 'station' dan 'line'): menambah stasiun/rute yang belum ada di dataset
-- (tambah manual atau impor dari GTFS / Commute), atau mengoreksi data stasiun/lini dataset dengan id yang sama.
ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_kind_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_kind_check
  CHECK (kind IN ('facility', 'entrance', 'notice', 'station_info', 'settings', 'map_stop', 'map_track', 'platform', 'route_pattern', 'concourse', 'hub', 'station_status', 'station', 'line'));
