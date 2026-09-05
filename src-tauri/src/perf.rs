//! llama-server 推理性能采集：解析日志中的 timings 行，维护「最近一次」与「累计平均」。
//!
//! 数据源是 llama-server 每次请求完成后默认打印的日志行（无需 --metrics 等额外参数）：
//! ```text
//! prompt eval time =    1097.82 ms /   512 tokens (    2.14 ms per token,   466.39 tokens per second)
//!      eval time =   17398.56 ms /   506 tokens (   34.39 ms per token,    29.08 tokens per second)
//! ```
//! 现实比示例脏两处，解析都必须扛住：
//! - 新版 llama.cpp 行首带时间戳与 slot 前缀：`0.45.539.510 I slot print_timing: id  0 | task 0 | `；
//! - 伪终端（ConPTY）按 80 列把长行拦腰折断，一行 timings 可能拆成多条日志（数字从中间断开），
//!   续行紧跟其后且无前缀，需拼接后解析（见 `PerfAccumulator::feed`）。
//!
//! 「平均」按 Σtokens / Σ时间 聚合——这是吞吐量的真实平均，而非各请求 TPS 的算术平均
//! （后者会被小请求过度加权）。累计窗口 = 当前 llama-server 进程生命周期：
//! 启动即清零、退出即清空并推送空快照，前端据此隐藏区块。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 日志缓冲归 Tauri 管理态；本模块的累计器同机制独立存放。
pub type PerfState = std::sync::Mutex<PerfAccumulator>;

/// 续行拼接缓冲上限（字节）：一条完整 timings 行约 150 字节，1024 足够宽容且防失控增长。
const MAX_PENDING_LEN: usize = 1024;

/// 从一行日志解析出的 timings 样本。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct TimingSample {
    pub is_prompt: bool, // true = prompt eval（预处理/prefill），false = eval（生成）
    pub tokens: u64,
    pub ms: f64,
    pub tps: f64,
}

/// 前端可见的推理性能快照（perf://update 载荷 / get_perf_stats 返回值）。
/// last_* 为最近一次请求；*_total 为当前服务进程生命周期内的累计（平均由前端派生）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PerfSnapshot {
    pub last_prompt_tokens: Option<u64>,
    pub last_prompt_ms: Option<f64>,
    pub last_prompt_tps: Option<f64>,
    pub last_gen_tokens: Option<u64>,
    pub last_gen_ms: Option<f64>,
    pub last_gen_tps: Option<f64>,
    pub prompt_tokens_total: u64,
    pub prompt_ms_total: f64,
    pub gen_tokens_total: u64,
    pub gen_ms_total: f64,
    pub requests: u64,
}

/// 未完成的 timings 行（被 PTY 折断），挂起等下一行拼接。
#[derive(Debug)]
struct PendingTiming {
    is_prompt: bool,
    body: String,
}

/// 在一行里定位 timings 的起始，返回 (是否 prompt 行, "=" 起的剩余正文)。
/// 行首可能有时间戳/slot 等任意前缀，故用 find 而非前缀匹配；
/// 「prompt eval time」包含「eval time」子串，必须先匹配更长者。
fn locate_timing(line: &str) -> Option<(bool, &str)> {
    if let Some(i) = line.find("prompt eval time") {
        Some((true, &line[i + "prompt eval time".len()..]))
    } else if let Some(i) = line.find("eval time") {
        Some((false, &line[i + "eval time".len()..]))
    } else {
        None
    }
}

/// 解析 timings 正文（"= ... ms / N tokens ( ... ms per token, ... tokens per second)"）。
/// 返回 None 的情形：正文不完整（折断行）、或数值非法（0 tokens / inf 速度等脏值）。
fn parse_timing_body(is_prompt: bool, body: &str) -> Option<TimingSample> {
    let rest = body.trim_start().strip_prefix('=')?.trim_start();
    let (ms_raw, tail) = rest.split_once(" ms / ")?;
    let ms = ms_raw.trim().parse::<f64>().ok()?;
    let (tokens_raw, detail) = tail.split_once(" tokens (")?;
    let tokens = tokens_raw.trim().parse::<u64>().ok()?;
    // 括号内逗号后的第二段 "... tokens per second)"，首个空白分隔字段即 TPS。
    let tps_seg = detail.rsplit_once(", ")?.1.trim();
    let tps = tps_seg.split_whitespace().next()?.parse::<f64>().ok()?;
    // 过滤非法行（如缓存全命中可能打印 0 tokens / inf 速度）。
    if tokens == 0 || !ms.is_finite() || ms < 0.0 || !tps.is_finite() || tps <= 0.0 {
        return None;
    }
    Some(TimingSample {
        is_prompt,
        tokens,
        ms,
        tps,
    })
}

/// 累计器：当前服务进程生命周期内的最近一次 + 累计值，兼持折断行的拼接状态。
#[derive(Debug, Default)]
pub struct PerfAccumulator {
    pending: Option<PendingTiming>,
    last_prompt: Option<TimingSample>,
    last_gen: Option<TimingSample>,
    prompt_tokens_total: u64,
    prompt_ms_total: f64,
    gen_tokens_total: u64,
    gen_ms_total: f64,
    requests: u64,
}

impl PerfAccumulator {
    /// 喂入一行日志；该行（或与此前折断行的拼接）命中 timings 则记录并返回 true。
    pub fn feed(&mut self, line: &str) -> bool {
        if let Some(pending) = self.pending.take() {
            let joined = format!("{}{}", pending.body, line);
            if let Some(sample) = parse_timing_body(pending.is_prompt, &joined) {
                self.record(sample);
                return true;
            }
            // 拼接后仍不完整。若本行自身是新的 timings 起始，说明 pending 是坏行
            // （如被过滤的 0 tokens / inf 行），丢弃并按新行处理；否则继续等续行。
            if locate_timing(line).is_none() && joined.len() <= MAX_PENDING_LEN {
                self.pending = Some(PendingTiming {
                    is_prompt: pending.is_prompt,
                    body: joined,
                });
                return false;
            }
            // 超长仍未拼完整：同样丢弃 pending，本行落回常规处理。
        }
        let Some((is_prompt, body)) = locate_timing(line) else {
            return false;
        };
        let body = body.trim_start();
        if let Some(sample) = parse_timing_body(is_prompt, body) {
            self.record(sample);
            return true;
        }
        // 起始行自身不完整（PTY 折断）：挂起等续行。
        if body.len() <= MAX_PENDING_LEN {
            self.pending = Some(PendingTiming {
                is_prompt,
                body: body.to_string(),
            });
        }
        false
    }

    fn record(&mut self, s: TimingSample) {
        if s.is_prompt {
            self.last_prompt = Some(s);
            self.prompt_tokens_total += s.tokens;
            self.prompt_ms_total += s.ms;
        } else {
            self.last_gen = Some(s);
            self.gen_tokens_total += s.tokens;
            self.gen_ms_total += s.ms;
            // 每条 eval 行对应一次请求完成（缓存全命中时可能没有 prompt 行）。
            self.requests += 1;
        }
    }

    pub fn snapshot(&self) -> PerfSnapshot {
        let lp = self.last_prompt.as_ref();
        let lg = self.last_gen.as_ref();
        PerfSnapshot {
            last_prompt_tokens: lp.map(|s| s.tokens),
            last_prompt_ms: lp.map(|s| s.ms),
            last_prompt_tps: lp.map(|s| s.tps),
            last_gen_tokens: lg.map(|s| s.tokens),
            last_gen_ms: lg.map(|s| s.ms),
            last_gen_tps: lg.map(|s| s.tps),
            prompt_tokens_total: self.prompt_tokens_total,
            prompt_ms_total: self.prompt_ms_total,
            gen_tokens_total: self.gen_tokens_total,
            gen_ms_total: self.gen_ms_total,
            requests: self.requests,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// 消费线程每收到一行日志调用：命中 timings 行则累计并向前端推送快照。
pub fn record_log_line(app: &AppHandle, line: &str) {
    let maybe_snap = {
        let state = app.state::<PerfState>();
        let mut acc = state.lock().unwrap_or_else(|e| e.into_inner());
        if acc.feed(line) {
            Some(acc.snapshot())
        } else {
            None
        }
    };
    if let Some(snap) = maybe_snap {
        let _ = app.emit("perf://update", snap);
    }
}

/// 服务进程启动/退出时清零累计窗口，并推送空快照让前端同步隐藏区块。
pub fn reset_perf(app: &AppHandle) {
    if let Some(state) = app.try_state::<PerfState>() {
        state.lock().unwrap_or_else(|e| e.into_inner()).reset();
    }
    let _ = app.emit("perf://update", PerfSnapshot::default());
}

#[tauri::command]
pub fn get_perf_stats(app: AppHandle) -> PerfSnapshot {
    let state = app.state::<PerfState>();
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.snapshot()
}
