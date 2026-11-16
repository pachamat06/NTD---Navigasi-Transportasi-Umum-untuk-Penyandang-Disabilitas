#!/usr/bin/env python3
"""Membuat src/data/gtfs/tj-brt-data.ts dari GTFS Transjakarta (folder hasil ekstrak atau berkas .zip).

Hanya rute BRT yang dipakai NTD yang diambil: koridor 1 sampai 14 pada Peta Integrasi FDTJ (lihat
Frontend/src/lib/map-stops.ts BUS_STOPS) dan lin BRT turunannya di bawah. Rute lain di GTFS diabaikan.

Pemakaian:  python3 scripts/build-tj-gtfs.py path/ke/gtfs-transjakarta.zip
"""
import csv, io, json, os, sys, zipfile

ROUTES = [str(i) for i in range(1, 15)] + [
    "2A", "3F", "3H", "4D", "5C", "6A", "6B", "6V", "7F", "9A", "9C", "9N", "10H", "13B", "13E", "L13E",
]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "data", "gtfs", "tj-brt-data.ts")


def reader(src):
    if os.path.isdir(src):
        return lambda name: list(csv.DictReader(open(os.path.join(src, name), encoding="utf-8-sig")))
    z = zipfile.ZipFile(src)
    return lambda name: list(csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig")))


def secs(t):
    h, m, s = (int(x) for x in t.split(":"))
    return h * 3600 + m * 60 + s


def main(src):
    rd = reader(src)
    stops = {s["stop_id"]: s for s in rd("stops.txt")}
    parent = lambda sid: stops[sid]["parent_station"] or sid
    routes = {r["route_id"]: r for r in rd("routes.txt") if r["route_id"] in ROUTES}
    trips = {t["trip_id"]: t for t in rd("trips.txt") if t["route_id"] in ROUTES}
    times = {}
    for r in rd("stop_times.txt"):
        if r["trip_id"] in trips:
            times.setdefault(r["trip_id"], []).append(r)
    freqs = {}
    for f in rd("frequencies.txt"):
        if f["trip_id"] in trips:
            freqs.setdefault(f["trip_id"], []).append([f["start_time"][:5], f["end_time"][:5], int(f["headway_secs"])])

    used = set()
    out_routes = {}
    for rid in ROUTES:
        r = routes[rid]
        patterns = []
        for tid in sorted(t for t in trips if trips[t]["route_id"] == rid):
            rows = sorted(times.get(tid, []), key=lambda x: int(x["stop_sequence"]))
            if len(rows) < 2:
                continue
            t0 = secs(rows[0]["departure_time"])
            codes = [parent(x["stop_id"]) for x in rows]
            used.update(codes)
            patterns.append({
                "trip": tid,
                "service": trips[tid]["service_id"],
                "headsign": trips[tid]["trip_headsign"],
                "stops": codes,
                "arr": [secs(x["arrival_time"]) - t0 for x in rows],
                "dep": [secs(x["departure_time"]) - t0 for x in rows],
                "freq": freqs.get(tid, []),
            })
        out_routes[rid] = {"name": r["route_long_name"], "color": "#" + r["route_color"].upper(), "patterns": patterns}

    out_stops = {c: [stops[c]["stop_name"], float(stops[c]["stop_lat"]), float(stops[c]["stop_lon"])] for c in sorted(used)}
    agency = rd("agency.txt")[0]
    meta = {"agency": agency["agency_name"], "routes": ROUTES, "stops": len(out_stops), "patterns": sum(len(r["patterns"]) for r in out_routes.values())}
    body = (
        "// DIBUAT OTOMATIS oleh scripts/build-tj-gtfs.py dari GTFS Transjakarta; jangan diubah manual.\n"
        "// Hanya koridor BRT 1 sampai 14 dan lin BRT turunannya yang dipakai NTD. Waktu (detik) dihitung dari keberangkatan\n"
        "// pertama tiap pola trip dan merupakan waktu JADWAL (perkiraan), bukan waktu nyata.\n"
        "// Kode halte = stop_id halte induk GTFS = kode TJ di Commute Data API (TJ-<kode>).\n\n"
        "import type { TjGtfsData } from \"./TjGtfs\";\n\n"
        f"export const TJ_BRT_GTFS: TjGtfsData = {json.dumps({'meta': meta, 'stops': out_stops, 'routes': out_routes}, ensure_ascii=False, separators=(',', ':'))};\n"
    )
    open(OUT, "w", encoding="utf-8").write(body)
    print(f"{OUT}: {meta}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
