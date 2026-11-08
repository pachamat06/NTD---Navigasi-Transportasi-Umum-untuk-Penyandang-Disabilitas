-- Concourse (area penghubung) untuk stasiun yang gate-nya tidak langsung ke peron: gate → concourse → peron.
-- Isi concourse (kode, lantai, ruas ke peron beserta lift/eskalator/tangga/ramp) disimpan sebagai konten jenis
-- 'concourse'; ruas gate → concourse disimpan pada konten pintu akses (field concourseLinks), jadi data pintu lama
-- yang langsung ke peron (platformLinks) tetap berlaku tanpa perubahan.
ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_kind_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_kind_check
  CHECK (kind IN ('facility', 'entrance', 'notice', 'station_info', 'settings', 'map_stop', 'map_track', 'platform', 'route_pattern', 'concourse'));
