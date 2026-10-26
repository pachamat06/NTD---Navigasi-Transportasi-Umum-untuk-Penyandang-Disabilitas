-- Peron hasil survei (jenis peron, lin/arah yang dilayani, fasilitas per peron, eskalator dan arahnya,
-- lift, celah peron dengan kendaraan). Data bawaan tetap dari dataset; entri ini melengkapinya.
ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_kind_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_kind_check
  CHECK (kind IN ('facility', 'entrance', 'notice', 'station_info', 'settings', 'map_stop', 'map_track', 'platform'));
