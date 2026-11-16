-- Hub transfer yang dibuat atau diubah admin (jenis konten 'hub'): anggota hub, jalan kaki antaranggota, atau
-- penonaktifan hub dataset. Hub dari Commute Data API tetap dipakai bila tidak ada isian admin dengan id yang sama.
ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_kind_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_kind_check
  CHECK (kind IN ('facility', 'entrance', 'notice', 'station_info', 'settings', 'map_stop', 'map_track', 'platform', 'route_pattern', 'concourse', 'hub'));
