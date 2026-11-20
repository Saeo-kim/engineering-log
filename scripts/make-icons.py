"""Generates the PWA icons (no third-party dependencies).

Run once: python3 scripts/make-icons.py
A plain green tile with three white "ruled lines", like a notebook page.
"""
import struct
import zlib
from pathlib import Path

BG = (47, 93, 80)
FG = (255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "public" / "icons"


def png(size: int) -> bytes:
    rows = []
    # Layout is proportional to the icon size so every size looks the same.
    margin = size * 0.24
    bar_h = max(2, round(size * 0.07))
    bars = [0.36, 0.52, 0.68]
    for y in range(size):
        row = bytearray([0])  # filter type: none
        for x in range(size):
            color = BG
            if margin <= x <= size - margin:
                for b in bars:
                    top = round(size * b)
                    if top <= y < top + bar_h:
                        # shorter last line, like a note that is still being written
                        limit = size - margin if b != bars[-1] else margin + (size - 2 * margin) * 0.6
                        if x <= limit:
                            color = FG
            row.extend(color)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
        (OUT / name).write_bytes(png(size))
        print("wrote", OUT / name)
