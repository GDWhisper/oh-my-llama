"""从唯一真相源 src-tauri/app-icon.svg 生成全部应用图标。

- 矢量母版只维护 app-icon.svg（25 格像素风 OML + 苹果圆角底）
- **所有尺寸一律「整数对齐」渲染**：25 格栅格的边界取整到像素边界、字形不做抗锯齿，
  与母版的 `shape-rendering="crispEdges"` 同构，因此 16~256px 全是同一套字形、
  同一份笔画粗细比例（与标题栏 25px 的 oml-logo.svg 观感一致）。
  实测 32px 与 git HEAD 的 `tauri icon` 产物平均通道差 0.76（等价于原版硬边像素）。
  历史教训（两条都别再走）：
    ① 对 ≥25px 做 8× 超采样 + LANCZOS → 笔画被抹成灰色、整体发糊；
    ② 给 ≤24px 另画一套「加粗 OML」→ 中杠居中的 M 看起来像 H，且比母版重得多，
       任务栏图标与标题栏 logo 明显不是同一个东西。
- **ICO 帧序：48px 放最前**（仅作兜底，见下条）。`tauri-codegen` 的 `CachedIcon::new_ico`
  取 `entries()[0]` 当 `default_window_icon()`，而 tao 只把它设成 `ICON_SMALL`、不设
  `ICON_BIG`（Tauri 也没接 tao 的 `set_taskbar_icon`）。
- **真正的锐化靠运行时「精确尺寸」图标**（本脚本额外产出 `src-tauri/icons/raw/*.rgba`
  + 生成 `src-tauri/src/icon_assets.rs`，由 lib.rs 在 setup / DPI 变化时按 DPI 调用）。
  原因：shell 把拿到的位图**双线性**缩放到自己想要的尺寸，而像素风字形只要不是 1:1
  就会被抹灰。实测（本机 150% DPI，任务栏要 36px）：
    32px 源 → 36px 双线性 = 与真实任务栏截图平均通道差 **0.78**（即 100% 复现「发虚」）；
    48px 源 → 36px 双线性 = 4.28，笔画虽转白但粗细不匀；
    只有 36px 源 1:1 才与标题栏 SVG（37.5px 矢量）同等锐利。
  **两个消费者读的不是同一个槽**（本机实测，别只喂一个）：
    - 任务栏按钮 = 24 × scale → `ICON_BIG`（缺了才回落 `ICON_SMALL`）
    - 任务栏缩略图预览（hover 弹出）头部 = `SM_CXSMICON` = 16 × scale → `ICON_SMALL`
    - 托盘 = 16 × scale → `TrayIconBuilder::icon`
  （100%/125%/150%/175%/200% → BIG 24/30/36/42/48、SMALL 与托盘 16/20/24/28/32）
  历史教训（别再走）：16px 在最前 → 任务栏放大 1.5 倍糊成方块（「任务栏变形」）；
  32px 在最前 → 仍是放大，笔画被双线性抹成 ~57% 灰；
  只喂 `ICON_SMALL` → 按钮锐了但预览头部发虚（24px 是 36px 缩放来的）。
- ICO 使用经典 BMP 多帧（BGRA + AND mask），确保 winres/embed-resource 能嵌入全部尺寸
- 同步 public/oml-logo.svg 供标题栏 25px 1:1

用法（仓库根目录）:
  python scripts/gen_app_icons.py

重生成后必须让构建重新嵌入图标：`tauri-build` **不监听** `.ico` 的变化，
只改图标时它会跳过重编 → exe 里还是旧图标。先 `touch src-tauri/tauri.conf.json`
（或 `cargo clean -p oh-my-llama`），再 `npm run tauri dev` / `tauri build`。
"""
from __future__ import annotations

import struct
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SVG = ROOT / "src-tauri" / "app-icon.svg"
ICONS = ROOT / "src-tauri" / "icons"
PUBLIC = ROOT / "public"

GRID = 25
BG = (10, 10, 10, 255)
FG = (255, 255, 255, 255)
RADIUS_RATIO = 5.6 / GRID

# 全部产出的尺寸
SIZES = [16, 20, 24, 25, 32, 40, 48, 64, 128, 256]
# ICO 帧序：48 必须留在最前（理由见文件头「ICO 帧序」，仅作兜底，勿改）
ICO_ORDER = [48, 16, 20, 24, 25, 32, 40, 64, 128, 256]

# shell 实际请求的图标尺寸 = 逻辑尺寸 × DPI 缩放（Windows 标准档位 100%~200%）：
#   任务栏按钮 = 24 × scale，托盘 = SM_CXSMICON = 16 × scale
TASKBAR_SIZES = [24, 30, 36, 42, 48]
TRAY_SIZES = [16, 20, 24, 28, 32]
RAW_SIZES = sorted(set(TASKBAR_SIZES) | set(TRAY_SIZES))
RAW_DIR = ICONS / "raw"
RUST_ASSETS = ROOT / "src-tauri" / "src" / "icon_assets.rs"


def parse_logo_cells(svg_path: Path) -> list[tuple[int, int, int, int]]:
    tree = ET.parse(svg_path)
    root = tree.getroot()
    cells: list[tuple[int, int, int, int]] = []
    for el in root.iter():
        if el.tag.split("}")[-1] != "rect":
            continue
        fill = (el.get("fill") or "").lower()
        if fill in {"#0a0a0a", "#000", "#000000"}:
            continue
        try:
            x, y = float(el.get("x", "0")), float(el.get("y", "0"))
            w, h = float(el.get("width", "0")), float(el.get("height", "0"))
        except ValueError:
            continue
        if w <= 0 or h <= 0:
            continue
        if any(abs(v - round(v)) > 1e-6 for v in (x, y, w, h)):
            continue
        cells.append((int(round(x)), int(round(y)), int(round(w)), int(round(h))))
    if not cells:
        raise SystemExit(f"未从 {svg_path} 解析到任何字母 rect")
    return cells


def rounded_bg(size: int, ss: int = 4) -> Image.Image:
    im = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    r = int(round(size * RADIUS_RATIO * ss))
    draw.rounded_rectangle([0, 0, size * ss - 1, size * ss - 1], radius=r, fill=BG)
    if ss == 1:
        return im
    return im.resize((size, size), Image.LANCZOS)


def render(size: int, cells: list[tuple[int, int, int, int]]) -> Image.Image:
    """整数对齐渲染母版 25 格：字形逐格取整到像素边界（硬边，无抗锯齿）。

    圆角底仍走 `rounded_bg` 的超采样（曲线需要抗锯齿），字形则在缩小后的成品上
    按取整后的像素矩形直接落色 —— 这样 16px 与 256px 的字形、笔画比例完全同构，
    且与标题栏 SVG 的 `crispEdges` 观感一致。
    """
    im = rounded_bg(size)
    draw = ImageDraw.Draw(im)
    k = size / GRID
    for gx, gy, gw, gh in cells:
        x0, y0 = round(gx * k), round(gy * k)
        # 单格笔画在 16/20px 下会算出零宽，钳到 1px 保证笔画不消失
        x1 = max(x0, round((gx + gw) * k) - 1)
        y1 = max(y0, round((gy + gh) * k) - 1)
        draw.rectangle([x0, y0, x1, y1], fill=FG)
    return im


def _bmp_frame(im: Image.Image) -> bytes:
    """经典 ICO 内嵌 BMP：BITMAPINFOHEADER + 32bit BGRA + AND mask。"""
    im = im.convert("RGBA")
    w, h = im.size
    pixels = [im.getpixel((x, y)) for y in range(h) for x in range(w)]

    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = pixels[y * w + x]
            xor += bytes((b, g, r, a))

    row_bytes = ((w + 31) // 32) * 4
    and_mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(row_bytes)
        for x in range(w):
            if pixels[y * w + x][3] < 128:
                row[x // 8] |= 0x80 >> (x % 8)
        and_mask += row

    header = struct.pack(
        "<IiiHHIIiiII",
        40,
        w,
        h * 2,
        1,
        32,
        0,
        len(xor) + len(and_mask),
        0,
        0,
        0,
        0,
    )
    return header + bytes(xor) + bytes(and_mask)


def write_ico(path: Path, frames: list[Image.Image]) -> None:
    blobs = [_bmp_frame(im) for im in frames]
    count = len(frames)
    offset = 6 + 16 * count
    entries = b""
    data = b""
    for im, blob in zip(frames, blobs):
        w, h = im.size
        entries += struct.pack(
            "<BBBBHHII",
            w if w < 256 else 0,
            h if h < 256 else 0,
            0,
            0,
            1,
            32,
            len(blob),
            offset,
        )
        data += blob
        offset += len(blob)
    path.write_bytes(struct.pack("<HHH", 0, 1, count) + entries + data)


def sync_public_svg() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    text = SOURCE_SVG.read_text(encoding="utf-8")
    if "shape-rendering" not in text:
        text = text.replace("<g fill=", '<g shape-rendering="crispEdges" fill=', 1)
    (PUBLIC / "oml-logo.svg").write_text(text, encoding="utf-8")
    print("wrote public/oml-logo.svg")


def write_raw_assets(images: dict[int, Image.Image], cells: list[tuple[int, int, int, int]]) -> None:
    """产出 shell 精确尺寸所需的原始 RGBA（行优先、自上而下、无文件头）。

    供 lib.rs 用 `tauri::image::Image::new()` 直接构造，省掉 PNG 解码依赖，
    也避免 shell 再做一次双线性缩放把像素字形抹灰。
    """
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for s in RAW_SIZES:
        im = images.get(s)
        if im is None:
            im = render(s, cells)
            images[s] = im
        (RAW_DIR / f"{s}.rgba").write_bytes(im.convert("RGBA").tobytes())
    print(f"wrote icons/raw/*.rgba {RAW_SIZES}")


def write_rust_assets() -> None:
    """生成 `src-tauri/src/icon_assets.rs`（尺寸表与 RAW_SIZES 永远同源）。"""
    rows = "\n".join(
        f'    ({s}, include_bytes!("../icons/raw/{s}.rgba")),' for s in RAW_SIZES
    )
    RUST_ASSETS.write_text(
        f"""//! 由 `scripts/gen_app_icons.py` 生成，**请勿手改**。
//!
//! shell（任务栏 / 托盘）会把自己拿到的位图**双线性**缩放到它想要的尺寸，而像素风
//! 字形只要不是 1:1 就会被抹成灰色（实测 32px 源 → 36px 任务栏，笔画掉到 ~57% 灰）。
//! 所以这里把各 DPI 档位下 shell 实际请求的尺寸各存一份原始 RGBA，运行时按 DPI 取
//! **精确尺寸**那张，1:1 落色 —— 与标题栏的矢量 SVG 同等锐利。
//!
//! 尺寸 = 逻辑尺寸 × DPI 缩放，且**任务栏按钮与缩略图预览头部读的不是同一个图标槽**：
//!   - 任务栏按钮     24 × scale → ICON_BIG（缺了才回落 ICON_SMALL）
//!   - 缩略图预览头部 16 × scale → ICON_SMALL（= SM_CXSMICON，标题栏同源）
//!   - 托盘           16 × scale → 托盘图标（同为 SM_CXSMICON）

/// 已收录的尺寸 → 原始 RGBA（行优先、自上而下、无文件头）。
static ASSETS: &[(u32, &[u8])] = &[
{rows}
];

/// 取与 `px` 最接近的已收录尺寸及其原始 RGBA。
pub fn nearest(px: u32) -> (&'static [u8], u32) {{
    let (size, bytes) = ASSETS
        .iter()
        .min_by_key(|(s, _)| s.abs_diff(px))
        .expect("icon_assets 不应为空");
    (bytes, *size)
}}

/// 是否精确收录了 `px`（否则调用方应知悉会发生一次轻微缩放）。
pub fn is_exact(px: u32) -> bool {{
    ASSETS.iter().any(|(s, _)| *s == px)
}}
""",
        encoding="utf-8",
    )
    print(f"wrote {RUST_ASSETS.relative_to(ROOT)}")


def main() -> None:
    cells = parse_logo_cells(SOURCE_SVG)
    print(f"parsed {len(cells)} glyph rects from {SOURCE_SVG.name}")

    # 全尺寸同一套字形（母版整数对齐），不再按大小分叉出第二套设计
    images: dict[int, Image.Image] = {}
    for s in SIZES:
        im = render(s, cells)
        images[s] = im
        out = ICONS / f"{s}x{s}.png"
        im.save(out)
        print(f"wrote {out.name}")

    images[32].save(ICONS / "32x32.png")
    images[128].save(ICONS / "128x128.png")
    images[256].save(ICONS / "128x128@2x.png")
    images[256].save(ICONS / "icon.png")
    images[256].save(ROOT / "src-tauri" / "app-icon.png")
    images[128].save(PUBLIC / "llama.png")

    write_ico(ICONS / "icon.ico", [images[s] for s in ICO_ORDER])
    print("wrote icons/icon.ico", ICO_ORDER, "（首帧 = 兜底窗口图标，勿改）")

    # 运行时按 DPI 取「精确尺寸」图标所需的原始 RGBA + 对应的 Rust 尺寸表
    write_raw_assets(images, cells)
    write_rust_assets()

    sync_public_svg()
    print("done")


if __name__ == "__main__":
    main()
