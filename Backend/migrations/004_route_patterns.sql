-- Pengaturan rute per arah dari admin: urutan pemberhentian, waktu tempuh antarpemberhentian, tujuan akhir.
-- Titik anak stasiun (posisi per lini) memakai jenis map_stop yang sudah ada dengan field lineId pada data.
ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_kind_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_kind_check
  CHECK (kind IN ('facility', 'entrance', 'notice', 'station_info', 'settings', 'map_stop', 'map_track', 'platform', 'route_pattern'));
