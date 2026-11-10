//! 任务栏小窗的原生绘制层（仅 Windows）：把条带画成 32 位预乘 ARGB 位图，再用
//! `UpdateLayeredWindow` 贴到分层窗口上。
//!
//! 为什么自绘：小窗内容只有一行指标，WebView2 却要为它单起一个渲染进程（实测工作集
//! 约 74 MB / 私有约 36 MB）。自绘省掉整个 webview 实例，代价是这里要自己处理字体、
//! DPI 与排版。
//!
//! 关键实现取舍（都是会踩的坑）：
//! - 文字**不能**直接用 GDI 画到彩色位图上：GDI 写 32 位 DIB 时不维护 alpha 通道，画出来
//!   的字在分层窗口里会整片透明。故先在「黑底白字」掩膜位图上取覆盖率（灰度即 alpha），
//!   再由 Rust 侧按预乘 ARGB 合成——透明底与抗锯齿都成立。
//! - 阴影不用 GDI 模糊：整段文字画进掩膜后做三次 box blur 近似高斯（条带只有几百×几十
//!   像素，成本可忽略），还原原 CSS `text-shadow` 的晕影，避免细笔画糊在中间调壁纸上。
//! - 布局一律在**物理像素**下算，再按 DPI 折算回逻辑尺寸交给窗口层：避免「逻辑量一次、
//!   物理量一次」两套取整互相打架（那会让窗口尺寸与位图尺寸差 1px，画面被裁）。
//! - 字体按段选：含中文的标签用微软雅黑 UI，数值走等宽，其余走 Segoe UI Semibold——
//!   沿用原 CSS 的字体栈。GDI 没有 font-family 链（名字不存在会静默回落），且对可变字体
//!   只暴露 Regular 实例（请求粗体就变成合成加粗，满屏狗牙），所以候选要探测后才能定，
//!   见 `resolve_face`。三者**按基线对齐**（不是各自垂直居中），否则中英文会一行高一行低。
//! - 文字按 2 倍尺寸光栅化再下采样（`SUPERSAMPLE`）：GDI 的灰度抗锯齿只有十几级灰阶，
//!   小字号粗体的斜线会露出阶梯；4 个子像素平均后等效灰阶翻两番。

use std::ffi::c_void;
use std::ptr;
use std::slice;
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{HWND, POINT, RECT, SIZE};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, GetDC,
    GetTextExtentPoint32W, GetTextFaceW, GetTextMetricsW, ReleaseDC, SelectObject, SetBkMode,
    SetTextColor, TextOutW, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, FF_DONTCARE, HDC, OUT_TT_PRECIS, TEXTMETRICW,
    TRANSPARENT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowRect, UpdateLayeredWindow, ULW_ALPHA,
};

// ── 样式规格（沿用原 widget.css 的尺寸与配色，改这里等于改外观）────────────

/// 条带内边距（逻辑像素）：横向 8、纵向 2。
const PAD_X: f32 = 8.0;
const PAD_Y: f32 = 2.0;
/// 圆角半径（逻辑像素）。
const RADIUS: f32 = 6.0;
/// 超采样倍率：文字按 N 倍尺寸光栅化，再 box 下采样回目标尺寸。
///
/// GDI 的灰度抗锯齿只有十几级灰阶，小字号下粗体的斜线/转角会露出阶梯（「狗牙」）。
/// 2 倍渲染让每个目标像素由 4 个子像素平均，等效灰阶翻两番，观感接近 DirectWrite。
const SUPERSAMPLE: u32 = 2;

/// 字号（逻辑像素）与行高倍率（CSS `11px/1.5`）。
const FONT_PX: f32 = 11.0;
const LINE_RATIO: f32 = 1.5;
/// 三段横向节奏：标签↔百分比 3，百分比↔「已用/总量」6，项间 10；竖排项间 6，两行行距 1。
const GAP_PART: f32 = 3.0;
const GAP_EXTRA: f32 = 6.0;
const GAP_ITEM: f32 = 10.0;
const GAP_VERT: f32 = 6.0;
const ROW_GAP: f32 = 1.0;

/// 默认样式底色：rgba(10, 10, 10, 0.88)。
const BG: [f32; 4] = [10.0, 10.0, 10.0, 0.88];
/// 默认样式文字色：白。
const FG_DEFAULT: [f32; 4] = [255.0, 255.0, 255.0, 1.0];
/// 透明样式：深色任务栏上的浅字 / 浅色任务栏上的深字（含基础不透明度）。
const FG_TRANSPARENT_DARK: [f32; 4] = [255.0, 255.0, 255.0, 0.95];
const FG_TRANSPARENT_LIGHT: [f32; 4] = [16.0, 16.0, 16.0, 0.92];
/// 高占用红：深底用亮红，浅底换深红（亮红压浅色发飘）。
const HOT_DARK: [f32; 4] = [255.0, 107.0, 107.0, 1.0];
const HOT_LIGHT: [f32; 4] = [180.0, 35.0, 24.0, 1.0];

const WEIGHT_NORMAL: i32 = 400;
const WEIGHT_MEDIUM: i32 = 500;
const WEIGHT_BOLD: i32 = 700;
/// GDI 的 ANTIALIASED_QUALITY（灰度抗锯齿）；windows-sys 未导出该常量。
const ANTIALIASED_QUALITY: u32 = 4;

/// 一条条带的视觉样式（由设置 + 任务栏几何/明暗决定）。
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct StripStyle {
    pub transparent: bool,
    /// 任务栏是否浅色（仅透明样式取色用；读不到时按深色处理，同原 CSS 兜底）。
    pub light: bool,
    /// 竖任务栏：逐项成行。
    pub vertical: bool,
    /// 两行排列（仅横任务栏生效；竖栏本就逐项成行）。
    pub double: bool,
}

/// 一项要显示的文字：标签 + 数值（必选）+ 明细（可选）。
pub(crate) struct Item {
    pub label: String,
    pub value: String,
    pub extra: Option<String>,
    /// 数值达到告警线：只染数值，不染标签与明细。
    pub hot: bool,
}

/// 字体族：界面字体、等宽（数值）、中文字体（含 CJK 的标签）。
#[derive(Clone, Copy, PartialEq)]
enum Face {
    Ui,
    Mono,
    Cjk,
}

/// 一段已定位的文字。
struct Segment {
    text: String,
    x: i32,
    /// 文字顶边（物理像素）。按基线对齐后换算，见 `measure`。
    top: i32,
    font_px: i32,
    face: Face,
    /// 该段的字重：标签 Medium、主数值粗、明细常规——三层拉开主次。
    weight: i32,
    color: [f32; 4],
}

/// 一项的测量宽度（物理像素），布局的纯输入。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ItemWidths {
    label: i32,
    value: i32,
    /// 明细总宽（= `extra_prefix + extra_suffix`；未开启为 0）。
    extra: i32,
    /// 明细里分隔符**之前**那段（"35.3/63.6G" 的 "35.3"）。
    extra_prefix: i32,
    /// 明细里从分隔符起那段（"/63.6G"）。
    extra_suffix: i32,
}

impl ItemWidths {
    /// 一项占的总宽：标签 + 片间距 + 数值 [+ 明细间距 + 明细]。
    fn total(&self, gap_part: i32, gap_extra: i32) -> i32 {
        let mut w = self.label + gap_part + self.value;
        if self.extra > 0 {
            w += gap_extra + self.extra;
        }
        w
    }
}

/// 布局结果（物理像素）。
pub(crate) struct Layout {
    pub(crate) w: u32,
    pub(crate) h: u32,
    segments: Vec<Segment>,
    radius: i32,
    bg: Option<[f32; 4]>,
    shadow: Option<[f32; 4]>,
    scale: f32,
}

/// 一项在条带内的落点：三个片段的左缘 + 本行行顶。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Slot {
    label_x: i32,
    value_x: i32,
    /// 明细前缀（分隔符前）的左缘——右对齐后的位置。
    extra_x: i32,
    /// 明细分隔符起的左缘，两行共用同一点，斜杠自然对齐。
    extra_suffix_x: i32,
    row_top: i32,
}

/// 纯布局：给定每项三段宽度与样式，算出条带尺寸与每项落点。
///
/// 不碰任何 GDI（单测无需显示环境）。三套排布与 CSS 一一对应：单行（横条）、
/// 竖排（逐项成行、居中）、两行（2 列网格、共用轨道宽度、数值右对齐，第 2 列标签
/// 补一个项间距）。
fn layout(style: &StripStyle, widths: &[ItemWidths], scale: f32) -> (u32, u32, Vec<Slot>) {
    let s = f64::from(scale);
    let px = |v: f32| (f64::from(v) * s).round() as i32;

    let (pad_x, pad_y) = (px(PAD_X), px(PAD_Y));
    let line_h = px(FONT_PX * LINE_RATIO).max(1);
    let (gap_part, gap_extra, gap_item) = (px(GAP_PART), px(GAP_EXTRA), px(GAP_ITEM));
    let (gap_vert, row_gap) = (px(GAP_VERT), px(ROW_GAP));

    // 两行排列只对横任务栏生效（竖栏两列会比栏宽还宽，盖住桌面）。
    if style.double && !style.vertical && widths.len() > 1 {
        let rows = widths.len().div_ceil(2) as i32;
        // 轨道宽度**按列各算各的**，不跨列共用。跨列共用时中文标签（内存/显存）会把
        // 轨道撑到两倍全角宽，同列的 CPU/GPU 后面就空出一大截——「间距太远」的主因。
        // 轨道：(标签, 数值, 明细前缀, 明细后缀)。
        let track = |col: usize| -> (i32, i32, i32, i32) {
            let mut t = (0, 0, 0, 0);
            // 跳过本列第一项之前的偏移，再隔一个取一个（= 下标 % 2 == col）。
            for w in widths.iter().skip(col).step_by(2) {
                t.0 = t.0.max(w.label);
                t.1 = t.1.max(w.value);
                t.2 = t.2.max(w.extra_prefix);
                t.3 = t.3.max(w.extra_suffix);
            }
            t
        };
        let tracks = [track(0), track(1)];
        // 列宽：标签 + 3 + 数值 [+ 6 + 明细前缀 + 明细后缀]。
        let col_w = |t: (i32, i32, i32, i32)| {
            let mut w = t.0 + gap_part + t.1;
            if t.2 > 0 || t.3 > 0 {
                w += gap_extra + t.2 + t.3;
            }
            w
        };
        let col_x = [pad_x, pad_x + col_w(tracks[0]) + gap_item];

        let mut slots = Vec::with_capacity(widths.len());
        for (i, w) in widths.iter().enumerate() {
            let (r, c) = (i as i32 / 2, i % 2);
            let (l, v, pre, suf) = tracks[c];
            let x0 = col_x[c];
            let extra_x0 = x0 + l + gap_part + v + gap_extra;
            slots.push(Slot {
                label_x: x0,
                // 数值在列内轨道右对齐：两行的百分号上下对齐（"44%" 与 "3%" 的 % 同列）。
                value_x: x0 + l + gap_part + (v - w.value),
                // 明细在分隔符处对齐：前缀右对齐到轨道右缘，后缀从轨道左缘起排。
                // 这样 "35.3/63.6G" 与 "1.0/15.9G" 的斜杠落在同一点。
                extra_x: if pre > 0 || suf > 0 {
                    extra_x0 + (pre - w.extra_prefix)
                } else {
                    0
                },
                extra_suffix_x: if pre > 0 || suf > 0 {
                    extra_x0 + pre
                } else {
                    0
                },
                row_top: pad_y + r * (line_h + row_gap),
            });
        }
        let w = (col_x[1] + col_w(tracks[1]) + pad_x).max(1) as u32;
        let h = (pad_y * 2 + rows * line_h + (rows - 1).max(0) * row_gap).max(1) as u32;
        return (w, h, slots);
    }

    let slot = |x: i32, row_top: i32, w: &ItemWidths| Slot {
        label_x: x,
        value_x: x + w.label + gap_part,
        extra_x: x + w.label + gap_part + w.value + gap_extra,
        extra_suffix_x: x + w.label + gap_part + w.value + gap_extra + w.extra_prefix,
        row_top,
    };

    if style.vertical {
        let inner = widths
            .iter()
            .map(|w| w.total(gap_part, gap_extra))
            .max()
            .unwrap_or(0);
        let mut slots = Vec::with_capacity(widths.len());
        let mut row_top = pad_y;
        for w in widths {
            // 逐项成行、水平居中（同 CSS `align-items: center`）。
            let x = pad_x + (inner - w.total(gap_part, gap_extra)) / 2;
            slots.push(slot(x, row_top, w));
            row_top += line_h + gap_vert;
        }
        let n = widths.len() as i32;
        let h = pad_y * 2 + n * line_h + (n - 1).max(0) * gap_vert;
        return ((inner + pad_x * 2).max(1) as u32, h.max(1) as u32, slots);
    }

    // 单行：逐项顺排。
    let mut slots = Vec::with_capacity(widths.len());
    let mut x = pad_x;
    for w in widths {
        slots.push(slot(x, pad_y, w));
        x += w.total(gap_part, gap_extra) + gap_item;
    }
    let w = (x - gap_item + pad_x).max(1) as u32;
    let h = (pad_y * 2 + line_h).max(1) as u32;
    (w, h, slots)
}

/// 测量 + 排版：产出可直接绘制的 [`Layout`]。
pub(crate) fn measure(items: &[Item], style: &StripStyle, scale: f32) -> Option<Layout> {
    // 排版全程在超采样坐标下做：字形宽度必须按同一字号量，否则落位会错开半个像素。
    let s = f64::from(scale) * f64::from(SUPERSAMPLE);
    let font_px = (f64::from(FONT_PX) * s).round().max(1.0) as i32;
    let line_h = (f64::from(FONT_PX * LINE_RATIO) * s).round().max(1.0) as i32;

    // 借一个 1×1 位图的 DC 做字体测量（GDI 的文字度量都需要 DC）。
    let dc = Dib::new(1, 1)?;
    // 参考基线取等宽数值字体：数值是视觉主体，中英文标签都跟它对齐。
    let mono = face_name(Face::Mono);
    let value_font = Font::new(font_px, WEIGHT_BOLD, mono)?;
    // 明细用常规字重：和主数值同粗会让「已用/总量」抢视线。
    let extra_font = Font::new(font_px, WEIGHT_NORMAL, mono);
    // 明细量宽用常规字重；拿不到就退回主数值字体（宁可粗一档，也不要整条不画）。
    let extra_ref = extra_font.as_ref().unwrap_or(&value_font);
    let (ref_ascent, ref_descent) = value_font.metrics(dc.hdc).unwrap_or((font_px, 0));

    let mut widths = Vec::with_capacity(items.len());
    let mut labels: Vec<(Face, Option<Font>)> = Vec::with_capacity(items.len());
    for item in items {
        let face = if !item.label.is_ascii() {
            Face::Cjk
        } else {
            Face::Ui
        };
        // 测量与绘制必须用同一字重：GDI 在不同 weight 下的字面宽度会差一点。
        let name = face_name(face);
        let font = Font::new(font_px, label_weight(name), name);
        let label_w = font.as_ref().map_or(0, |f| f.width(dc.hdc, &item.label));
        // 明细拆成「分隔符前 / 分隔符起」两段：两行之间斜杠要对齐，整段量宽做不到。
        let (pre, suf) = item.extra.as_deref().map_or(("", ""), split_extra);
        let pre_w = extra_ref.width(dc.hdc, pre);
        let suf_w = extra_ref.width(dc.hdc, suf);
        widths.push(ItemWidths {
            label: label_w,
            value: value_font.width(dc.hdc, &item.value),
            extra: pre_w + suf_w,
            extra_prefix: pre_w,
            extra_suffix: suf_w,
        });
        labels.push((face, font));
    }

    let (w_ss, h_ss, slots) = layout(style, &widths, s as f32);
    // 回到物理像素尺寸（窗口与位图都按它分配）。
    let w = w_ss.div_ceil(SUPERSAMPLE);
    let h = h_ss.div_ceil(SUPERSAMPLE);

    let (base, hot) = text_colors(style);
    // 标签/明细的透明度：透明样式叠在壁纸上，比默认样式整体提一档。标签贴近正文色
    // （GDI 没有 gamma 校正，同样的 alpha 比 DirectWrite 看着更淡），明细再低一档，
    // 让「55%」比「35.2/63.6G」抢眼。
    let (label_alpha, extra_alpha) = if style.transparent {
        (0.94, 0.72)
    } else {
        (0.78, 0.75)
    };
    let value_ascent = value_font.metrics(dc.hdc).map_or(font_px, |m| m.0);

    let mut segments = Vec::with_capacity(items.len() * 4);
    for (i, slot) in slots.iter().enumerate() {
        let item = &items[i];
        // 基线对齐：行顶 + 参考字体在行高内的居中位置；各段再按自己的 ascent 顶下来。
        let baseline = slot.row_top + (line_h + ref_ascent - ref_descent) / 2;

        if let Some(font) = labels[i].1.as_ref() {
            let ascent = font.metrics(dc.hdc).map_or(font_px, |m| m.0);
            segments.push(Segment {
                text: item.label.to_string(),
                x: slot.label_x,
                top: baseline - ascent,
                font_px,
                face: labels[i].0,
                weight: labels[i].1.as_ref().map_or(WEIGHT_NORMAL, |f| f.weight),
                color: with_alpha(base, label_alpha),
            });
        }
        segments.push(Segment {
            text: item.value.clone(),
            x: slot.value_x,
            top: baseline - value_ascent,
            font_px,
            face: Face::Mono,
            weight: WEIGHT_BOLD,
            color: if item.hot { hot } else { base },
        });
        if let Some(extra) = item.extra.as_ref() {
            let (pre, suf) = split_extra(extra);
            let extra_color = with_alpha(base, extra_alpha);
            if !pre.is_empty() {
                segments.push(Segment {
                    text: pre.to_string(),
                    x: slot.extra_x,
                    top: baseline - value_ascent,
                    font_px,
                    face: Face::Mono,
                    weight: WEIGHT_NORMAL,
                    color: extra_color,
                });
            }
            if !suf.is_empty() {
                segments.push(Segment {
                    text: suf.to_string(),
                    x: slot.extra_suffix_x,
                    top: baseline - value_ascent,
                    font_px,
                    face: Face::Mono,
                    weight: WEIGHT_NORMAL,
                    color: extra_color,
                });
            }
        }
    }

    Some(Layout {
        w,
        h,
        segments,
        // 圆角作用在 1x 画布上，只按 DPI 缩放，不能再乘超采样倍率。
        radius: (f64::from(RADIUS) * f64::from(scale)).round() as i32,
        bg: (!style.transparent).then_some(BG),
        // 透明样式叠在任务栏/壁纸上，没有晕影细笔画会糊掉；默认样式有底色，不需要。
        shadow: style.transparent.then_some(if style.light {
            [255.0, 255.0, 255.0, 1.0]
        } else {
            [0.0, 0.0, 0.0, 1.0]
        }),
        scale,
    })
}

/// 把「已用/总量」按第一个分隔符拆开：前缀右对齐、后缀左对齐，两行的斜杠才落在同一点。
///
/// 没有分隔符时整段算后缀（前缀为空），调用处只画一段。
fn split_extra(s: &str) -> (&str, &str) {
    match s.find('/') {
        Some(i) => (&s[..i], &s[i..]),
        None => ("", s),
    }
}

/// 文字配色：返回（正文色, 高占用色）。标签/明细的透明度在调用处叠。
fn text_colors(style: &StripStyle) -> ([f32; 4], [f32; 4]) {
    if style.transparent {
        if style.light {
            (FG_TRANSPARENT_LIGHT, HOT_LIGHT)
        } else {
            (FG_TRANSPARENT_DARK, HOT_DARK)
        }
    } else {
        (FG_DEFAULT, HOT_DARK)
    }
}

fn with_alpha(mut color: [f32; 4], factor: f32) -> [f32; 4] {
    color[3] *= factor;
    color
}

/// 各字族的候选字体，按优先级排列。GDI 没有字体链（不像 CSS 的 `font-family` 列表），
/// 名字不存在时会**静默回落**到系统默认字体，所以逐个探测后再定（见 `resolve_face`）。
const UI_CANDIDATES: &[&str] = &["Segoe UI Semibold", "Segoe UI Variable Text", "Segoe UI"];
/// 等宽候选。Cascadia 是可变字体，GDI 只暴露 Regular 实例（没有真粗体），通常会落到
/// Consolas——它的 Bold 是独立设计的字形，小字号下干净得多。
const MONO_CANDIDATES: &[&str] = &["Cascadia Mono", "Cascadia Code", "Consolas"];
const CJK_CANDIDATES: &[&str] = &["Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC"];

/// 选定的字体名：探测一次，进程内复用。
fn face_name(face: Face) -> &'static str {
    static RESOLVED: OnceLock<[&'static str; 3]> = OnceLock::new();
    RESOLVED.get_or_init(|| {
        [
            resolve_face(UI_CANDIDATES, false),
            // 数值要半粗：必须挑有真粗体的，否则就是合成加粗的锯齿。
            resolve_face(MONO_CANDIDATES, true),
            resolve_face(CJK_CANDIDATES, false),
        ]
    })[face as usize]
}

/// 返回第一个 GDI 真正认得的字体名。
///
/// `CreateFontW` 对不存在的字体名不会失败，而是回落到系统默认字体，故必须用
/// `GetTextFaceW` 读回实际选中的 face 名来判定——这是唯一可靠的探测方式。
fn resolve_face(candidates: &[&'static str], need_real_bold: bool) -> &'static str {
    let Some(dc) = Dib::new(1, 1) else {
        return candidates[candidates.len() - 1];
    };
    candidates
        .iter()
        .copied()
        .find(|name| face_matches(dc.hdc, name) && (!need_real_bold || has_real_bold(dc.hdc, name)))
        // 全都不满足：用最后一个（Consolas / Segoe UI / 雅黑，任何 Windows 都有的兜底）。
        .unwrap_or(candidates[candidates.len() - 1])
}

/// 用给定字重创建字体，读回 GDI **实际选中**的面名。
fn face_of(hdc: HDC, name: &str, weight: i32) -> Option<String> {
    let font = Font::new(12, weight, name)?;
    let mut buf = [0u16; 64];
    let n = unsafe {
        let old = SelectObject(hdc, font.handle);
        let n = GetTextFaceW(hdc, buf.len() as i32, buf.as_mut_ptr());
        SelectObject(hdc, old);
        n
    };
    // 返回值是写入的字符数（含结尾 NUL）。
    if n <= 1 || n as usize > buf.len() {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..n as usize - 1]))
}

fn face_matches(hdc: HDC, name: &str) -> bool {
    face_of(hdc, name, WEIGHT_NORMAL).is_some_and(|f| f.eq_ignore_ascii_case(name))
}

/// 该字体族是否有**真**粗体，而不是 GDI 的合成加粗。
///
/// 合成粗体是在原字形上硬叠一笔，转角出方块、斜线出阶梯——小字号下就是「狗牙」。
/// 判定方式：同样请求 400 与 700，看实际选中的面名是否变化（合成不会改面名）。
fn has_real_bold(hdc: HDC, name: &str) -> bool {
    match (
        face_of(hdc, name, WEIGHT_NORMAL),
        face_of(hdc, name, WEIGHT_BOLD),
    ) {
        (Some(a), Some(b)) => !a.eq_ignore_ascii_case(&b),
        _ => false,
    }
}

/// 标签字重：族名本身已带字重（"Segoe UI Semibold"）时传 400，否则 GDI 会在它上面
/// 再合成一层粗体，直接糊成 Bold。
fn label_weight(name: &str) -> i32 {
    if name.contains("Semibold") || name.contains("Bold") || name.contains("Light") {
        WEIGHT_NORMAL
    } else {
        WEIGHT_MEDIUM
    }
}

// ── 绘制 ───────────────────────────────────────────────────────────────

/// 把一帧画到分层窗口上。返回是否贴图成功。
///
/// 窗口尺寸与位图不一致时返回 false 且**不**调用 `UpdateLayeredWindow`：ULW 会按传入的
/// 尺寸反向改窗口大小，与 tao 的尺寸记账打架。调用方应先让窗口落位，再触发重画。
pub(crate) fn paint(hwnd: HWND, layout: &Layout) -> bool {
    if layout.w == 0 || layout.h == 0 {
        return false;
    }
    let (mask_w, mask_h) = (layout.w * SUPERSAMPLE, layout.h * SUPERSAMPLE);
    let (Some(mut out), Some(mut mask)) = (Dib::new(layout.w, layout.h), Dib::new(mask_w, mask_h))
    else {
        return false;
    };

    out.clear();
    if let Some(bg) = layout.bg {
        fill_rounded(&mut out, layout.radius, bg);
    }

    if let Some(color) = layout.shadow {
        // 阴影画在文字之下：整段文字进掩膜 → 糊开 → 叠两个层次（对应 CSS 的两段 shadow）。
        mask.clear();
        for seg in &layout.segments {
            mask.draw_text(seg);
        }
        let cov = downsample(&mask.coverage(), mask_w, mask_h, SUPERSAMPLE);
        let (w, h) = (layout.w as usize, layout.h as usize);
        let r_near = (2.0 * layout.scale).round().max(1.0) as usize;
        let r_far = (6.0 * layout.scale).round().max(1.0) as usize;
        let dy = layout.scale.round().max(1.0) as i32;
        let near = blur(&cov, w, h, r_near);
        composite_coverage(&mut out, &near, with_alpha(color, 0.70), 0, dy);
        let far = blur(&cov, w, h, r_far);
        composite_coverage(&mut out, &far, with_alpha(color, 0.45), 0, 0);
    }

    for seg in &layout.segments {
        mask.clear();
        mask.draw_text(seg);
        let cov = downsample(&mask.coverage(), mask_w, mask_h, SUPERSAMPLE);
        composite_coverage(&mut out, &cov, seg.color, 0, 0);
    }

    let mut rect: RECT = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetClientRect(hwnd, &mut rect) };
    if ok == 0
        || (rect.right - rect.left) != layout.w as i32
        || (rect.bottom - rect.top) != layout.h as i32
    {
        return false;
    }
    out.present(hwnd)
}

// ── 位图与 GDI 封装 ─────────────────────────────────────────────────────

/// 32 位 top-down DIB 与其内存 DC。像素按 BGRA 排列（小端），内部一律预乘 alpha。
struct Dib {
    hdc: HDC,
    bmp: *mut c_void,
    ptr: *mut u8,
    w: u32,
    h: u32,
}

impl Dib {
    fn new(w: u32, h: u32) -> Option<Self> {
        if w == 0 || h == 0 {
            return None;
        }
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            // 负高度 = top-down：行序与内存顺序一致，省掉逐行翻转。
            biHeight: -(h as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0, // BI_RGB
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut bits: *mut c_void = ptr::null_mut();
        unsafe {
            let hdc = CreateCompatibleDC(ptr::null_mut());
            if hdc.is_null() {
                return None;
            }
            let bmp = CreateDIBSection(hdc, &info, DIB_RGB_COLORS, &mut bits, ptr::null_mut(), 0);
            if bmp.is_null() || bits.is_null() {
                DeleteDC(hdc);
                return None;
            }
            SelectObject(hdc, bmp);
            Some(Self {
                hdc,
                bmp,
                ptr: bits as *mut u8,
                w,
                h,
            })
        }
    }

    fn len(&self) -> usize {
        (self.w as usize) * (self.h as usize) * 4
    }

    fn pixels(&mut self) -> &mut [u8] {
        unsafe { slice::from_raw_parts_mut(self.ptr, self.len()) }
    }

    fn clear(&mut self) {
        unsafe { ptr::write_bytes(self.ptr, 0, self.len()) };
    }

    /// 把一段文字画成掩膜：黑底白字，R 通道即覆盖率。
    fn draw_text(&mut self, seg: &Segment) {
        let Some(font) = Font::new(seg.font_px, seg.weight, face_name(seg.face)) else {
            return;
        };
        let wide: Vec<u16> = seg.text.encode_utf16().collect();
        unsafe {
            let old = SelectObject(self.hdc, font.handle);
            SetBkMode(self.hdc, TRANSPARENT as i32);
            SetTextColor(self.hdc, 0x00FF_FFFF);
            TextOutW(self.hdc, seg.x, seg.top, wide.as_ptr(), wide.len() as i32);
            SelectObject(self.hdc, old);
        }
    }

    /// 覆盖率（单通道）。
    fn coverage(&self) -> Vec<u8> {
        let src = unsafe { slice::from_raw_parts(self.ptr, self.len()) };
        src.chunks_exact(4).map(|p| p[2]).collect()
    }

    /// 贴到分层窗口（UpdateLayeredWindow：一次整窗合成，不走 WM_PAINT）。
    fn present(&self, hwnd: HWND) -> bool {
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            return false;
        }
        let dst = POINT {
            x: rect.left,
            y: rect.top,
        };
        let size = SIZE {
            cx: self.w as i32,
            cy: self.h as i32,
        };
        let src = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: BLEND_OP_SRC_OVER,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: ALPHA_FORMAT_SRC,
        };
        unsafe {
            let screen = GetDC(ptr::null_mut());
            if screen.is_null() {
                return false;
            }
            let ok = UpdateLayeredWindow(
                hwnd, screen, &dst, &size, self.hdc, &src, 0, &blend, ULW_ALPHA,
            );
            ReleaseDC(ptr::null_mut(), screen);
            ok != 0
        }
    }
}

impl Drop for Dib {
    fn drop(&mut self) {
        unsafe {
            DeleteObject(self.bmp);
            DeleteDC(self.hdc);
        }
    }
}

/// GDI 字体。句柄在选中它的 DC 上有效，用完必须换回旧对象再删（`Drop` 里删）。
struct Font {
    handle: *mut c_void,
    weight: i32,
}

impl Font {
    fn new(px: i32, weight: i32, face: &str) -> Option<Self> {
        let face: Vec<u16> = face.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe {
            CreateFontW(
                -px,
                0,
                0,
                0,
                weight,
                0,
                0,
                0,
                u32::from(DEFAULT_CHARSET),
                u32::from(OUT_TT_PRECIS),
                u32::from(CLIP_DEFAULT_PRECIS),
                // 灰度抗锯齿：掩膜取 R 当覆盖率，ClearType 的亚像素彩边会污染 alpha。
                ANTIALIASED_QUALITY,
                u32::from(DEFAULT_PITCH | FF_DONTCARE),
                face.as_ptr(),
            )
        };
        (!handle.is_null()).then_some(Self { handle, weight })
    }

    fn width(&self, hdc: HDC, text: &str) -> i32 {
        let wide: Vec<u16> = text.encode_utf16().collect();
        let mut size = SIZE { cx: 0, cy: 0 };
        unsafe {
            let old = SelectObject(hdc, self.handle);
            let ok = GetTextExtentPoint32W(hdc, wide.as_ptr(), wide.len() as i32, &mut size);
            SelectObject(hdc, old);
            if ok == 0 {
                0
            } else {
                size.cx
            }
        }
    }

    /// 字体度量：(ascent, descent)，用于基线对齐。
    fn metrics(&self, hdc: HDC) -> Option<(i32, i32)> {
        let mut tm: TEXTMETRICW = unsafe { std::mem::zeroed() };
        unsafe {
            let old = SelectObject(hdc, self.handle);
            let ok = GetTextMetricsW(hdc, &mut tm);
            SelectObject(hdc, old);
            (ok != 0).then_some((tm.tmAscent, tm.tmDescent))
        }
    }
}

impl Drop for Font {
    fn drop(&mut self) {
        unsafe { DeleteObject(self.handle) };
    }
}

const BLEND_OP_SRC_OVER: u8 = 0;
const ALPHA_FORMAT_SRC: u8 = 1;

// ── 合成（全部预乘 alpha）─────────────────────────────────────────────

/// 圆角矩形底色：逐像素算覆盖率（1px 抗锯齿），比 GDI 的 RoundRect 干净。
fn fill_rounded(dst: &mut Dib, radius: i32, color: [f32; 4]) {
    let (w, h) = (dst.w as i32, dst.h as i32);
    let r = radius.max(0) as f32;
    let (hw, hh) = (w as f32 / 2.0, h as f32 / 2.0);
    let px = dst.pixels();
    for y in 0..h {
        for x in 0..w {
            // 圆角矩形的有符号距离：内部 < 0，边缘 0，外部 > 0。
            let dx = (x as f32 + 0.5 - hw).abs() - (hw - r);
            let dy = (y as f32 + 0.5 - hh).abs() - (hh - r);
            let (qx, qy) = (dx.max(0.0), dy.max(0.0));
            let dist = (qx * qx + qy * qy).sqrt() - r;
            let cov = (0.5 - dist).clamp(0.0, 1.0);
            if cov <= 0.0 {
                continue;
            }
            let i = ((y as usize) * (w as usize) + x as usize) * 4;
            put_premultiplied(&mut px[i..i + 4], color, color[3] * cov);
        }
    }
}

/// 用单通道覆盖率叠阴影（可带偏移）。
fn composite_coverage(dst: &mut Dib, cov: &[u8], color: [f32; 4], dx: i32, dy: i32) {
    let (w, h) = (dst.w as usize, dst.h as usize);
    let dst_px = dst.pixels();
    for y in 0..h {
        let ty = y as i32 + dy;
        if ty < 0 || ty >= h as i32 {
            continue;
        }
        for x in 0..w {
            let tx = x as i32 + dx;
            if tx < 0 || tx >= w as i32 {
                continue;
            }
            let a = color[3] * (f32::from(cov[y * w + x]) / 255.0);
            if a <= 0.0 {
                continue;
            }
            let i = (ty as usize * w + tx as usize) * 4;
            put_premultiplied(&mut dst_px[i..i + 4], color, a);
        }
    }
}

/// source-over 叠加一个预乘颜色（dst 也是预乘）。
fn put_premultiplied(dst: &mut [u8], color: [f32; 4], a: f32) {
    let inv = 1.0 - a;
    let (b, g, r, da) = (dst[0], dst[1], dst[2], dst[3]);
    let blend = |src: f32, dst: u8| -> u8 {
        let v = src / 255.0 * a + f32::from(dst) / 255.0 * inv;
        (v.clamp(0.0, 1.0) * 255.0).round() as u8
    };
    dst[0] = blend(color[2], b); // B
    dst[1] = blend(color[1], g); // G
    dst[2] = blend(color[0], r); // R
    dst[3] = ((a + f32::from(da) / 255.0 * inv).clamp(0.0, 1.0) * 255.0).round() as u8;
}

/// 把超采样的单通道覆盖率盒式下采样回目标尺寸（每像素取 f×f 子像素的平均）。
fn downsample(src: &[u8], w: u32, h: u32, f: u32) -> Vec<u8> {
    let (f, dw, dh) = (f as usize, w as usize / f as usize, h as usize / f as usize);
    let mut out = vec![0u8; dw * dh];
    let norm = (f * f) as u32;
    for y in 0..dh {
        for x in 0..dw {
            let mut sum = 0u32;
            for dy in 0..f {
                let row = (y * f + dy) * w as usize + x * f;
                for dx in 0..f {
                    sum += u32::from(src[row + dx]);
                }
            }
            out[y * dw + x] = (sum / norm) as u8;
        }
    }
    out
}

/// 三次 box blur 近似高斯（分离式：先横后纵，各跑三遍）。
fn blur(src: &[u8], w: usize, h: usize, radius: usize) -> Vec<u8> {
    if radius == 0 || w == 0 || h == 0 {
        return src.to_vec();
    }
    let mut a = src.to_vec();
    let mut b = vec![0u8; src.len()];
    for _ in 0..3 {
        box_h(&a, &mut b, w, h, radius);
        box_v(&b, &mut a, w, h, radius);
    }
    a
}

fn box_h(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize) {
    let win = (2 * r + 1) as u32;
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let mut sum = 0u32;
            for dx in 0..=2 * r {
                let sx = (x + dx).saturating_sub(r).min(w - 1);
                sum += u32::from(src[row + sx]);
            }
            dst[row + x] = (sum / win) as u8;
        }
    }
}

fn box_v(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize) {
    let win = (2 * r + 1) as u32;
    for x in 0..w {
        for y in 0..h {
            let mut sum = 0u32;
            for dy in 0..=2 * r {
                let sy = (y + dy).saturating_sub(r).min(h - 1);
                sum += u32::from(src[sy * w + x]);
            }
            dst[y * w + x] = (sum / win) as u8;
        }
    }
}

// ── 单元测试（纯布局，无需显示环境）────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn widths(parts: &[(i32, i32, i32)]) -> Vec<ItemWidths> {
        parts
            .iter()
            .map(|&(label, value, extra)| ItemWidths {
                label,
                value,
                extra,
                // 这里的明细整段算前缀（不拆分）；要验分隔符对齐用 `item`。
                extra_prefix: extra,
                extra_suffix: 0,
            })
            .collect()
    }

    /// 显式构造明细已拆分的项：前缀是分隔符之前那段，后缀从分隔符起。
    fn item(label: i32, value: i32, prefix: i32, suffix: i32) -> ItemWidths {
        ItemWidths {
            label,
            value,
            extra: prefix + suffix,
            extra_prefix: prefix,
            extra_suffix: suffix,
        }
    }

    /// 单行：宽度 = 内边距 + 各项（标签+3+数值）+ 项间 10；高度 = 内边距 + 行高。
    /// 100% DPI 下：内边距 8/2、行高 round(11×1.5)=17。
    #[test]
    fn single_row_accumulates_widths() {
        let ws = widths(&[(30, 40, 0), (30, 40, 0)]);
        let (w, h, slots) = layout(&StripStyle::default(), &ws, 1.0);
        assert_eq!(w, 8 + 73 + 10 + 73 + 8);
        assert_eq!(h, 2 + 17 + 2);
        assert_eq!(slots[0].label_x, 8);
        assert_eq!(slots[0].value_x, 8 + 30 + 3);
        assert_eq!(slots[1].label_x, 8 + 73 + 10);
    }

    /// 明细开启：多出 6 + 明细宽；未开启的项不占这段空档。
    #[test]
    fn detailed_adds_gap_only_when_present() {
        let ws = widths(&[(30, 40, 50), (30, 40, 0)]);
        let (w, _, slots) = layout(&StripStyle::default(), &ws, 1.0);
        assert_eq!(w, 8 + (30 + 3 + 40 + 6 + 50) + 10 + (30 + 3 + 40) + 8);
        assert_eq!(slots[0].extra_x, 8 + 30 + 3 + 40 + 6);
    }

    /// 竖排：逐项成行、水平居中；窄项按最宽项居中。
    #[test]
    fn vertical_centers_items_and_stacks() {
        let ws = widths(&[(30, 40, 0), (20, 20, 0)]);
        let style = StripStyle {
            vertical: true,
            double: true, // 竖栏忽略两行排列
            ..Default::default()
        };
        let (w, h, slots) = layout(&style, &ws, 1.0);
        assert_eq!(w, 73 + 16);
        assert_eq!(h, 2 + 17 + 6 + 17 + 2);
        assert_eq!(slots[0].label_x, 8);
        assert_eq!(slots[1].label_x, 8 + (73 - 43) / 2);
        assert_eq!(slots[1].row_top, 2 + 17 + 6);
    }

    /// 两行：**每列独立**取轨道宽度（跨列共用会被中文标签撑宽，英文标签后面空一大截）；
    /// 数值在列内右对齐，两行的百分号落在同一列。
    #[test]
    fn double_aligns_values_vertically() {
        let ws = widths(&[(30, 40, 0), (60, 50, 0), (30, 25, 0), (60, 30, 0)]);
        let style = StripStyle {
            double: true,
            ..Default::default()
        };
        let (w, h, slots) = layout(&style, &ws, 1.0);
        // 列 0：30 + 3 + 40 = 73；列 1：60 + 3 + 50 = 113。
        assert_eq!(w, 8 + 73 + 10 + 113 + 8);
        // 4 项 → 2 行（行距 1）。
        assert_eq!(h, 2 + 17 + 1 + 17 + 2);
        assert_eq!(slots[1].label_x, 8 + 73 + 10);
        assert_eq!(slots[2].row_top, 2 + 17 + 1);
        // 数值右对齐：列 0 轨道 40，第二行只有 25 → 右移 15，百分号上下对齐。
        assert_eq!(slots[0].value_x, 8 + 30 + 3);
        assert_eq!(slots[2].value_x, 8 + 30 + 3 + 15);
    }

    /// 明细在分隔符处对齐：「35.3/63.6G」与「1.0/15.9G」的斜杠落在同一点。
    #[test]
    fn double_aligns_extra_separator() {
        let ws = vec![
            item(30, 40, 0, 0),
            item(60, 50, 40, 70), // 前缀「35.3」、后缀「/63.6G」
            item(30, 25, 0, 0),
            item(60, 30, 30, 60), // 前缀「1.0」、后缀「/15.9G」
        ];
        let style = StripStyle {
            double: true,
            ..Default::default()
        };
        let (w, _, slots) = layout(&style, &ws, 1.0);
        // 列 1：60 + 3 + 50 + 6 + 前缀 40 + 后缀 70 = 229。
        assert_eq!(w, 8 + 73 + 10 + 229 + 8);
        let extra_x0 = 8 + 73 + 10 + 60 + 3 + 50 + 6;
        // 前缀右对齐到轨道右缘：40 - 40 = 0；40 - 30 = 10。
        assert_eq!(slots[1].extra_x, extra_x0);
        assert_eq!(slots[3].extra_x, extra_x0 + 10);
        // 后缀共用同一起点 —— 斜杠对齐。
        assert_eq!(slots[1].extra_suffix_x, extra_x0 + 40);
        assert_eq!(slots[3].extra_suffix_x, extra_x0 + 40);
    }

    /// DPI 缩放：只放大内边距 / 片间距 / 行高，文字宽度本身就是物理像素（调用方按 DPI
    /// 量出来再喂进来），不参与这里的放缩。
    #[test]
    fn scale_grows_padding_not_text() {
        let ws = widths(&[(30, 40, 0)]);
        let one = layout(&StripStyle::default(), &ws, 1.0);
        assert_eq!(one.0, 8 + 73 + 8);
        assert_eq!(one.1, 2 + 17 + 2);
        let two = layout(&StripStyle::default(), &ws, 2.0);
        // 内边距 8→16、片间距 3→6（文字仍是 30/40）；行高 round(11×1.5×2)=33。
        assert_eq!(two.0, 16 + (30 + 6 + 40) + 16);
        assert_eq!(two.1, 4 + 33 + 4);
    }
}
