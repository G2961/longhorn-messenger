#!/usr/bin/env python3
"""Генератор иконок Longhorn Messenger (Tauri 2).

Без внешних зависимостей: PNG пишется вручную (zlib + struct),
ICO собирается по спецификации с вложенными PNG (формат Vista+).

Стиль: голубой диагональный градиент + белый круг (плейсхолдер,
заменяется дизайнерской иконкой позже).

Запуск:  python tools/gen_icons.py
Выход:   src-tauri/icons/{icon.png,128x128.png,128x128@2x.png,32x32.png,icon.ico}
"""

import math
import struct
import zlib
from pathlib import Path

# Градиент: светло-голубой -> насыщенный синий (стиль Longhorn)
C_TOP = (0x38, 0xbd, 0xf8)   # sky-400
C_BOT = (0x1d, 0x4e, 0xd8)   # blue-700

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"


# ---------------------------------------------------------------- PNG writer

def png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def render(size: int) -> bytes:
    """Рисует квадрат size x size: диагональный градиент + белый круг.

    Пиксель = смешение C_TOP/C_BOT по диагонали (x+y)/(2*size-2).
    Круг сглаживается 2x2 суперсэмплингом.
    """
    px = bytearray()
    r = size * 0.30  # радиус белого круга
    cx = cy = (size - 1) / 2.0
    denom = 2 * (size - 1) if size > 1 else 1

    for y in range(size):
        px.append(0)  # filter type 0 (None) в начале каждой строки
        for x in range(size):
            # цвет фона
            t = (x + y) / denom
            base = tuple(
                C_TOP[i] + (C_BOT[i] - C_TOP[i]) * t for i in range(3)
            )
            # покрытие круга (сглаживание 2x2)
            cov = 0
            for dx in (0.25, 0.75):
                for dy in (0.25, 0.75):
                    if (x + dx - cx) ** 2 + (y + dy - cy) ** 2 <= r * r:
                        cov += 1
            a = cov / 4.0
            rgb = tuple(base[i] * (1 - a) + 255 * a for i in range(3))
            px += bytes((round(rgb[0]), round(rgb[1]), round(rgb[2]), 255))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # RGBA8
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(bytes(px), 9))
        + png_chunk(b"IEND", b"")
    )


# ---------------------------------------------------------------- ICO writer

def build_ico(images: list[tuple[int, bytes]]) -> bytes:
    """ICO из PNG (PNG-in-ICO, поддерживается начиная с Windows Vista).

    images: [(size, png_bytes), ...] — размер <= 256.
    """
    header = struct.pack("<HHH", 0, 1, len(images))  # reserved, type=icon, count
    entries = b""
    blobs = b""
    offset = 6 + 16 * len(images)
    for size, data in images:
        w = size if size < 256 else 0  # 0 означает 256
        entries += struct.pack(
            "<BBBBHHII",
            w, w,       # width, height
            0,          # palette size (нет палитры)
            0,          # reserved
            1,          # color planes
            32,         # bits per pixel
            len(data),  # размер данных
            offset,     # смещение до данных
        )
        blobs += data
        offset += len(data)
    return header + entries + blobs


# -------------------------------------------------------------------- main

def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    files = {
        "icon.png": render(512),
        "128x128.png": render(128),
        "128x128@2x.png": render(256),
        "32x32.png": render(32),
    }
    for name, data in files.items():
        (OUT / name).write_bytes(data)
        print(f"  {name:16} {len(data):>7} bytes")

    ico = build_ico(
        [(s, render(s)) for s in (16, 32, 48, 256)]
    )
    (OUT / "icon.ico").write_bytes(ico)
    print(f"  {'icon.ico':16} {len(ico):>7} bytes  (16/32/48/256 PNG-in-ICO)")


if __name__ == "__main__":
    main()
