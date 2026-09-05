"""从 icon/icon_1024.png 生成全套图标（macOS 需要约 10% 透明留白，否则 Dock 图标显得比邻居大）。

用法：python3 scripts/make-icons.py [--source icon/icon_1024.png]
依赖：Pillow；macOS 上额外用 iconutil 生成 .icns。
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "icon"
# Apple 图标模板：1024 画布上主体占 824（约 80.5%），四周留透明边。
CONTENT_RATIO = 824 / 1024
SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]


def padded_master(source: Path) -> Image.Image:
    src = Image.open(source).convert("RGBA")
    if src.size != (1024, 1024):
        src = src.resize((1024, 1024), Image.LANCZOS)
    edge_alpha = src.getpixel((512, 0))[3]
    if edge_alpha == 0:
        return src  # 已经带留白，不再二次缩小
    inner = round(1024 * CONTENT_RATIO)
    scaled = src.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    offset = (1024 - inner) // 2
    canvas.paste(scaled, (offset, offset), scaled)
    return canvas


def write_icns(master: Image.Image) -> None:
    if sys.platform != "darwin" or shutil.which("iconutil") is None:
        print("skip icns: iconutil unavailable")
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            master.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            master.resize((size * 2, size * 2), Image.LANCZOS).save(
                iconset / f"icon_{size}x{size}@2x.png"
            )
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(ICON_DIR / "icon.icns")],
            check=True,
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ICON_DIR / "icon_1024.png")
    args = parser.parse_args()
    master = padded_master(args.source)
    for size in SIZES:
        master.resize((size, size), Image.LANCZOS).save(ICON_DIR / f"icon_{size}.png")
    master.save(ICON_DIR / "icon.png")
    master.save(
        ICON_DIR / "icon.ico",
        sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)],
    )
    write_icns(master)
    print("icons regenerated with", f"{CONTENT_RATIO:.1%}", "content ratio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
