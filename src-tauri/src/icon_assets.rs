//! 由 `scripts/gen_app_icons.py` 生成，**请勿手改**。
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
    (16, include_bytes!("../icons/raw/16.rgba")),
    (20, include_bytes!("../icons/raw/20.rgba")),
    (24, include_bytes!("../icons/raw/24.rgba")),
    (28, include_bytes!("../icons/raw/28.rgba")),
    (30, include_bytes!("../icons/raw/30.rgba")),
    (32, include_bytes!("../icons/raw/32.rgba")),
    (36, include_bytes!("../icons/raw/36.rgba")),
    (42, include_bytes!("../icons/raw/42.rgba")),
    (48, include_bytes!("../icons/raw/48.rgba")),
];

/// 取与 `px` 最接近的已收录尺寸及其原始 RGBA。
pub fn nearest(px: u32) -> (&'static [u8], u32) {
    let (size, bytes) = ASSETS
        .iter()
        .min_by_key(|(s, _)| s.abs_diff(px))
        .expect("icon_assets 不应为空");
    (bytes, *size)
}

/// 是否精确收录了 `px`（否则调用方应知悉会发生一次轻微缩放）。
pub fn is_exact(px: u32) -> bool {
    ASSETS.iter().any(|(s, _)| *s == px)
}
