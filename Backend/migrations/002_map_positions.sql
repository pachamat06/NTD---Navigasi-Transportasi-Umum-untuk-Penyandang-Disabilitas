-- Penetapan manual oleh admin pada Aset Peta Transit (satuan pt peta FDTJ, bukan lintang-bujur):
-- posisi titik pemberhentian (map_stop) dan bentuk jalur antara dua pemberhentian (map_track).
ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_kind_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_kind_check
  CHECK (kind IN ('facility', 'entrance', 'notice', 'station_info', 'settings', 'map_stop', 'map_track'));
