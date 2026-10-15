# Membaca Aset Peta Transit (PDF peta FDTJ) menjadi src/lib/map-stops.ts:
# - RAIL_STOPS: posisi stasiun rel dari nomor di dalam penanda (huruf di atas angka, mis. C / 12);
# - BUS_STOPS: halte TransJakarta dari label "koridor-urutan nama" (mis. "1-13 Kebon Sirih"), posisinya
#   pada penanda halte (lingkaran/segitiga putih bergaris hitam) terdekat;
# - TRACKS: bentuk jalur di peta antara dua pemberhentian yang bersebelahan, dilacak dari gambar
#   raster peta mengikuti warna jalurnya (termasuk tikungan), agar garis rute mengikuti peta.
#
# Pemakaian (butuh poppler-utils, numpy, scipy, Pillow):
#   pdftotext -bbox-layout peta.pdf layout.html
#   pdftocairo -svg peta.pdf peta-penuh.svg
#   pdftocairo -png -r 36 -singlefile peta.pdf peta36      # 0,5 piksel per pt
#   python3 scripts/extract-map-stops.py layout.html peta-penuh.svg peta36.png src/lib/map-stops.ts

import collections
import html
import json
import math
import re
import sys

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

layout_path, svg_path, png_path, out_path = sys.argv[1:5]
L = open(layout_path).read()
S = open(svg_path).read()
CODE = re.compile(r"^\d{1,2}[A-Z]?-\d{1,2}[A-Z]?$")
PX = 0.5  # piksel raster per pt


def words_of(s):
    return [(float(a), float(b), float(c), float(d), html.unescape(w)) for a, b, c, d, w in
            re.findall(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', s)]


# --- 1. Stasiun rel: huruf kecil tepat di atas angka dua digit di dalam penanda -----------------
allw = words_of(L)
letters = [w for w in allw if re.fullmatch(r"[A-Z]{1,2}", w[4]) and (w[3] - w[1]) < 20]
nums = [w for w in allw if re.fullmatch(r"\d{2}", w[4]) and (w[3] - w[1]) < 30]
rail_raw = collections.defaultdict(list)
for l in letters:
    lc = (l[0] + l[2]) / 2
    below = [n for n in nums if abs((n[0] + n[2]) / 2 - lc) < 6 and 0 < n[1] - l[1] < 16]
    if below:
        n = min(below, key=lambda n: n[1])
        rail_raw[l[4] + n[4]].append((lc, (l[1] + n[3]) / 2))
# Kode ganda (mis. contoh penanda di legenda): pilih yang terdekat dengan nomor tetangganya.
rail = {}
for code, pts in rail_raw.items():
    if len(pts) == 1:
        rail[code] = pts[0]
        continue
    m = re.match(r"([A-Z]+)(\d+)", code)
    p, n = m.group(1), int(m.group(2))
    nb = [rail_raw[f"{p}{n + k:02d}"][0] for k in (-1, 1, -2, 2) if len(rail_raw.get(f"{p}{n + k:02d}", [])) == 1]
    if nb:
        rail[code] = min(pts, key=lambda c: min(math.dist(c, b) for b in nb))

# --- 2. Penanda halte: bentuk putih kecil dengan garis tepi hitam (lingkaran atau segitiga) -------
white, dark = [], collections.defaultdict(list)
for m in re.finditer(r'<path [^>]*?fill="rgb\(([\d.]+)%, ([\d.]+)%, ([\d.]+)%\)"[^>]*?d="([^"]+)"', S):
    r, g, b = map(float, m.group(1, 2, 3))
    v = [float(x) for x in re.findall(r"-?[\d.]+", m.group(4))]
    if not 6 <= len(v) <= 200:
        continue
    xs, ys = v[0::2], v[1::2]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    c = ((max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2)
    if r > 99 and g > 99 and b > 99 and 10 < w < 30 and 10 < h < 30:
        white.append((c, w))
    elif r < 15 and g < 15 and b < 15 and 12 < w < 36 and 12 < h < 36:
        dark[(int(c[0] // 20), int(c[1] // 20))].append((c, w))
markers = []
for c, w in white:
    gx, gy = int(c[0] // 20), int(c[1] // 20)
    if any(math.dist(c, d[0]) < 3 and 1 < d[1] - w < 9 for i in (-1, 0, 1) for j in (-1, 0, 1) for d in dark[(gx + i, gy + j)]):
        markers.append(c)

# --- 3. Label halte per baris dalam blok teks ----------------------------------------------------
labels = []
for blk in re.findall(r"<block[^>]*>(.*?)</block>", L, re.S):
    lines = [words_of(x) for x in re.findall(r"<line[^>]*>(.*?)</line>", blk, re.S)]
    carry = []
    for i, ln in enumerate(lines):
        codes = [w for w in ln if CODE.match(w[4])]
        if not codes:
            carry = []
            continue
        # Baris berisi kode saja yang diikuti baris berkode lain = satu halte dengan beberapa koridor
        # (mis. "1-20" lalu "12-6 Kota").
        only_codes = all(CODE.match(w[4]) or re.fullmatch(r"L?\d+[A-Z]?", w[4]) for w in ln)
        if only_codes and i + 1 < len(lines) and any(CODE.match(w[4]) for w in lines[i + 1]):
            carry += codes
            continue
        codes = carry + codes
        carry = []
        namew = [w for w in ln if not CODE.match(w[4]) and not re.fullmatch(r"L?\d+[A-Z]?", w[4])]
        box = codes + namew
        j = i + 1
        # Nama di baris berikutnya: bila baris kode tanpa nama, atau lanjutan nama (mis. "ASTRA").
        while j < len(lines) and not any(CODE.match(w[4]) for w in lines[j]) and (not namew or j == i + 1):
            extra = [w for w in lines[j] if not re.fullmatch(r"L?\d+[A-Z]?", w[4])]
            if namew and len(extra) > 1:
                break
            namew += extra
            box += extra
            j += 1
            if len(namew) >= 2:
                break
        name = " ".join(w[4] for w in namew).strip()
        if "Fase" in name or name.startswith("MRT Jakarta"):
            continue
        labels.append({
            "codes": [w[4] for w in codes], "name": name,
            "rows": sorted({round((w[1] + w[3]) / 2) for w in box}),
            "box": (min(w[0] for w in box), min(w[1] for w in box), max(w[2] for w in box), max(w[3] for w in box)),
        })


def box_dist(box, p):
    x0, y0, x1, y1 = box
    return math.hypot(max(x0 - p[0], 0, p[0] - x1), max(y0 - p[1], 0, p[1] - y1))


def score(lab, c):
    d = box_dist(lab["box"], c)
    if d < 90:
        return d
    gap = max(lab["box"][0] - c[0], 0, c[0] - lab["box"][2])
    if any(abs(r - c[1]) < 18 for r in lab["rows"]) and gap < 260:
        return 90 + gap
    # Penanda bertumpuk tepat di bawah/atas label (mis. halte di jalur sejajar).
    dy = max(lab["box"][1] - c[1], 0, c[1] - lab["box"][3])
    if gap < 25 and dy < 170:
        return 120 + dy
    return None


# Pasangkan label dan penanda mulai dari yang terdekat. Penanda yang menempel (pasangan "oo" satu halte)
# ikut ditandai terpakai agar tidak diambil label tetangga.
pairs = sorted((sc, li, mi) for li, lab in enumerate(labels) for mi, c in enumerate(markers) if (sc := score(lab, c)) is not None)
used_l, used_m = {}, set()
for _, li, mi in pairs:
    if li in used_l or mi in used_m:
        continue
    used_l[li] = mi
    used_m.add(mi)
    near = [k for k, c in enumerate(markers) if k not in used_m and math.dist(c, markers[mi]) < 27]
    if near:
        used_m.add(min(near, key=lambda k: math.dist(markers[k], markers[mi])))
bus = []
for li, lab in enumerate(labels):
    if li in used_l:
        x, y = markers[used_l[li]]
    else:
        x, y = ((lab["box"][0] + lab["box"][2]) / 2, (lab["box"][1] + lab["box"][3]) / 2)
    bus.append({"codes": lab["codes"], "name": lab["name"], "at": (x, y), "exact": li in used_l})

# --- 4. Bentuk jalur antar pemberhentian bersebelahan (raster) -----------------------------------
img = np.asarray(Image.open(png_path).convert("RGB")).astype(np.int16)
H, Wd = img.shape[:2]
nodes = [(code, p, 17) for code, p in rail.items()] + [(b["codes"][0], b["at"], 11) for b in bus if b["exact"]]
node_px = [((p[0] * PX, p[1] * PX), rad * PX) for _, p, rad in nodes]
yy, xx = np.mgrid[-14:15, -14:15]
ring_r = np.hypot(yy, xx)


def ring_colors(i):
    (cx, cy), r = node_px[i]
    sel = (ring_r > r + 2) & (ring_r < r + 9)
    ys, xs = (yy[sel] + round(cy)).clip(0, H - 1), (xx[sel] + round(cx)).clip(0, Wd - 1)
    px = img[ys, xs]
    sat = px.max(1) - px.min(1)
    keep = px[(sat > 70) & (px.max(1) > 60)]
    q = collections.Counter(tuple(int(v) // 24 for v in c) for c in keep)
    out = []
    for key, n in q.most_common():
        if n < 4:
            break
        members = keep[[tuple(int(v) // 24 for v in c) == key for c in keep]]
        out.append(members.mean(0))
    return out


WIN = 360  # piksel (720 pt) di tiap sisi
tracks = {}
for i, (code_a, pa, _) in enumerate(nodes):
    (ax, ay), ar = node_px[i]
    x0, y0 = max(int(ax) - WIN, 0), max(int(ay) - WIN, 0)
    x1, y1 = min(int(ax) + WIN, Wd), min(int(ay) + WIN, H)
    sub = img[y0:y1, x0:x1]
    others = [k for k, ((bx, by), _) in enumerate(node_px) if k != i and x0 <= bx < x1 and y0 <= by < y1]
    zone = np.zeros(sub.shape[:2], bool)
    zone_id = np.full(sub.shape[:2], -1, int)
    gy, gx = np.mgrid[0:sub.shape[0], 0:sub.shape[1]]
    for k in [i] + others:
        (bx, by), br = node_px[k]
        z = (gx - (bx - x0)) ** 2 + (gy - (by - y0)) ** 2 <= (br + 3) ** 2
        zone |= z
        zone_id[z & (zone_id < 0)] = k
    for col in ring_colors(i):
        mask = np.abs(sub - col).sum(2) < 70
        bridge = ndimage.binary_dilation(mask, iterations=4)
        ok = bridge | zone
        idx = -np.ones(ok.shape, int)
        idx[ok] = np.arange(ok.sum())
        rows, cols, wts = [], [], []
        hh, ww = ok.shape
        P = np.pad(idx, 1, constant_values=-1)
        Mp = np.pad(mask, 1, constant_values=False)
        for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
            ia, ib = P[1:-1, 1:-1], P[1 + dy: hh + 1 + dy, 1 + dx: ww + 1 + dx]
            ma, mb = Mp[1:-1, 1:-1], Mp[1 + dy: hh + 1 + dy, 1 + dx: ww + 1 + dx]
            both = (ia >= 0) & (ib >= 0)
            step = math.hypot(dx, dy)
            rows.append(ia[both])
            cols.append(ib[both])
            wts.append(np.where(ma & mb, step, step * 4)[both])
        n = int(ok.sum())
        g = coo_matrix((np.concatenate(wts), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n)).tocsr()
        src = idx[zone_id == i]
        src = src[src >= 0]
        if not len(src):
            continue
        dist, pred, _ = dijkstra(g, directed=False, indices=src, min_only=True, return_predecessors=True, limit=1400)
        flat = np.full(ok.shape, np.inf)
        flat[ok] = dist
        coords = np.argwhere(ok)
        for k in others:
            zk = zone_id == k
            if not np.isfinite(flat[zk]).any():
                continue
            end = np.argwhere(zk)[np.argmin(flat[zk])]
            node = idx[end[0], end[1]]
            path = []
            while node >= 0 and len(path) < 5000:
                path.append(coords[node])
                node = pred[node]
            path = np.array(path[::-1])
            # Lewat penanda lain = bukan pemberhentian yang bersebelahan.
            passed = {zone_id[p[0], p[1]] for p in path} - {-1, i, k}
            if passed:
                continue
            on_line = mask[path[:, 0], path[:, 1]].mean()
            straight = math.dist(node_px[i][0], node_px[k][0])
            if on_line < 0.6 or len(path) > straight * 2.5 + 40:
                continue
            key = tuple(sorted((code_a, nodes[k][0])))
            hexcol = "#%02x%02x%02x" % tuple(int(v) for v in col)
            pts = [((p[1] + x0) / PX, (p[0] + y0) / PX) for p in path]
            if key[0] != code_a:
                pts = pts[::-1]
            prev = tracks.get((key, hexcol))
            if prev is None or len(pts) < len(prev):
                tracks[(key, hexcol)] = pts


def simplify(pts, tol=3.0):
    if len(pts) < 3:
        return pts
    (x0, y0), (x1, y1) = pts[0], pts[-1]
    dx, dy = x1 - x0, y1 - y0
    L2 = math.hypot(dx, dy) or 1
    d = [abs(dy * (x - x0) - dx * (y - y0)) / L2 for x, y in pts]
    i = max(range(len(pts)), key=d.__getitem__)
    if d[i] <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[: i + 1], tol)[:-1] + simplify(pts[i:], tol)


track_out = collections.defaultdict(list)
for (key, col), pts in tracks.items():
    track_out["|".join(key)].append({"color": col, "points": [[round(x), round(y)] for x, y in simplify(pts)]})

# --- 5. Tulis TypeScript ---------------------------------------------------------------------
out = [
    "// Indeks posisi pemberhentian dan bentuk jalur pada Aset Peta Transit (FDTJ 2026-08c), dibaca otomatis",
    "// dari PDF peta dengan scripts/extract-map-stops.py (jangan diubah manual). Satuan pt.",
    "// - RAIL_STOPS: nomor stasiun rel di dalam penanda (mis. C12, M13);",
    "// - BUS_STOPS: halte TransJakarta (kode koridor-urutan, mis. 1-13, dan nama di peta) pada penanda halte.",
    "//   `exact: false` = penanda tidak ditemukan, posisi memakai letak label;",
    "// - TRACKS: garis jalur di peta antara dua pemberhentian bersebelahan (kunci \"A|B\" urut abjad, titik",
    "//   dari A ke B), per warna jalur.",
    "",
    "export const RAIL_STOPS: Record<string, [number, number]> = " + json.dumps({k: [round(v[0]), round(v[1])] for k, v in sorted(rail.items())}, separators=(",", ":")) + ";",
    "",
    "export interface BusStopLabel {\n  codes: string[];\n  name: string;\n  at: [number, number];\n  exact: boolean;\n}",
    "",
    "export const BUS_STOPS: BusStopLabel[] = [",
]
for b in bus:
    out.append("  { codes: %s, name: %s, at: [%d, %d], exact: %s }," % (json.dumps(b["codes"]), json.dumps(b["name"], ensure_ascii=False), round(b["at"][0]), round(b["at"][1]), "true" if b["exact"] else "false"))
out.append("];")
out.append("")
out.append("export const TRACKS: Record<string, { color: string; points: [number, number][] }[]> = " + json.dumps(dict(sorted(track_out.items())), separators=(",", ":")) + ";")
open(out_path, "w").write("\n".join(out) + "\n")
print("rel", len(rail), "halte", len(bus), "tepat di penanda", sum(b["exact"] for b in bus), "penanda", len(markers), "ruas jalur", len(track_out))
