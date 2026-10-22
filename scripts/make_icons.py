"""Generate the toolbar icons (a gauge on a rounded square) without dependencies."""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")
BG = (16, 163, 127)
FG = (255, 255, 255)
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor for anti-aliasing


def coverage(x, y, s):
    """Return (bg_alpha, fg_alpha) for a point in a unit square of size s."""
    r = s * 0.22
    cx, cy = min(max(x, r), s - r), min(max(y, r), s - r)
    if math.hypot(x - cx, y - cy) > r:
        return 0.0, 0.0

    c = s / 2
    dist = math.hypot(x - c, y - c)
    angle = (math.degrees(math.atan2(y - c, x - c)) + 360) % 360
    ring_outer, ring_inner = s * 0.34, s * 0.24
    # Gauge arc: 270 degrees with the gap at the bottom.
    on_arc = ring_inner <= dist <= ring_outer and not (45 < angle < 135)
    # Needle pointing to roughly 70%.
    needle_angle = math.radians(135 + 270 * 0.7)
    nx, ny = math.cos(needle_angle), math.sin(needle_angle)
    t = (x - c) * nx + (y - c) * ny
    perp = abs((x - c) * ny - (y - c) * nx)
    on_needle = 0 <= t <= ring_inner * 0.95 and perp <= s * 0.045
    on_hub = dist <= s * 0.07
    return 1.0, 1.0 if (on_arc or on_needle or on_hub) else 0.0


def render(size):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            bg_a = fg_a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    b, f = coverage(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS, size)
                    bg_a += b
                    fg_a += f
            bg_a /= SS * SS
            fg_a /= SS * SS
            mix = fg_a / bg_a if bg_a else 0
            rgb = [round(BG[i] * (1 - mix) + FG[i] * mix) for i in range(3)]
            row += bytes(rgb + [round(bg_a * 255)])
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        with open(os.path.join(OUT_DIR, f"icon{size}.png"), "wb") as fh:
            fh.write(png(size, render(size)))
    print("Wrote icons:", ", ".join(f"icon{s}.png" for s in SIZES))
