//! llama-server 推理性能采集：解析日志中的 timings 行，输出「最近一次净速率」与会话速度估计。
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
//! 原始读数不能直接展示，两类系统性偏差要在线去噪（**不设样本门槛、不丢任何样本**）：
//! - 耗时 ≈ 固定开销 + 每 token 成本 × tokens 中的固定开销（批启动/图构建）让小样本被开销
//!   主导——实测 14-token 缓存命中断只报 48 t/s，而同一批的大请求 ~1650 t/s；
//! - 多 slot 并发、卡顿/换页等只会让请求「变慢」——实测有 2181 tokens 耗 30.7 s 的离群样本。
//!
//! 故对每类样本做下限包络拟合：候选直线必须在所有样本下方（「变慢」只会把点推离包络，不污染
//! 估计），取总残差最小者；其斜率倒数即会话速度估计（等价于本会话能达到的净速度）。小样本
//! 正是钉住截距（固定开销）的关键数据，一律参与拟合。
//!
//! 累计窗口 = 当前 llama-server 进程生命周期：启动即清零、退出即清空并推送空快照，
//! 前端据此隐藏区块。

use std::collections::VecDeque;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 日志缓冲归 Tauri 管理态；本模块的累计器同机制独立存放。
pub type PerfState = std::sync::Mutex<PerfAccumulator>;

/// 续行拼接缓冲上限（字节）：一条完整 timings 行约 150 字节，1024 足够宽容且防失控增长。
const MAX_PENDING_LEN: usize = 1024;

/// 拟合窗口（每类样本数）：只保留最近 N 个样本，更早的样本对「当前速度」参考价值递减。
const FIT_WINDOW: usize = 128;

/// 拟合两点所需的最小 tokens 跨度：两个小样本若靠得太近，斜率完全由单次抖动决定，
/// 不足以作为速度估计（此时估计留空，样本仍照常参与后续拟合与「最近」展示）。
const MIN_FIT_TOKEN_SPAN: u64 = 64;

/// 从一行日志解析出的 timings 样本。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct TimingSample {
    pub is_prompt: bool, // true = prompt eval（预处理/prefill），false = eval（生成）
    pub tokens: u64,
    pub ms: f64,
    pub tps: f64,
}

/// 下限包络模型：耗时 ≈ overhead_ms + ms_per_token × tokens。落在包络上方的额外耗时
/// （并发挤占、卡顿等「只变慢」的噪声）不参与速度估计。
#[derive(Debug, Clone, Copy, PartialEq)]
struct RateModel {
    overhead_ms: f64,
    ms_per_token: f64,
}

impl RateModel {
    /// 会话速度估计：包络斜率倒数。
    fn tps(&self) -> f64 {
        1000.0 / self.ms_per_token
    }

    /// 单样本的净速率：扣掉固定开销。净时间下限为纯计算时间（浮点兜底；包络保证实际不触发）。
    fn corrected_tps(&self, s: &TimingSample) -> f64 {
        let net_ms = (s.ms - self.overhead_ms).max(s.tokens as f64 * self.ms_per_token);
        s.tokens as f64 / (net_ms / 1000.0)
    }
}

/// 下限包络拟合：枚举过任意两点的候选直线与「固定开销 = 0」的边界候选，
/// 保留「所有样本都在线上方且固定开销 ≥ 0」者，取总残差最小；并列取斜率较大者（更保守的速度估计）。
fn fit_model(samples: &VecDeque<TimingSample>) -> Option<RateModel> {
    let mut best: Option<(f64, RateModel)> = None;
    for (i, a) in samples.iter().enumerate() {
        for b in samples.iter().skip(i + 1) {
            let ((t1, m1), (t2, m2)) = if a.tokens <= b.tokens {
                ((a.tokens, a.ms), (b.tokens, b.ms))
            } else {
                ((b.tokens, b.ms), (a.tokens, a.ms))
            };
            if t2 - t1 < MIN_FIT_TOKEN_SPAN {
                continue;
            }
            let ms_per_token = (m2 - m1) / (t2 - t1) as f64;
            let overhead_ms = m1 - ms_per_token * t1 as f64;
            if !ms_per_token.is_finite() || ms_per_token <= 0.0 || overhead_ms < 0.0 {
                continue;
            }
            // 包络条件：所有样本都在线上方（否则不是可行直线）。
            let mut slack = 0.0;
            let mut feasible = true;
            for s in samples {
                let residual = s.ms - (overhead_ms + ms_per_token * s.tokens as f64);
                if residual < -1e-9 {
                    feasible = false;
                    break;
                }
                slack += residual;
            }
            if !feasible {
                continue;
            }
            offer_candidate(
                &mut best,
                slack,
                RateModel {
                    overhead_ms,
                    ms_per_token,
                },
            );
        }
    }
    // 边界候选：生成侧每 token 成本随长度增长时，过任意两点的直线都带负固定开销
    // （被上面否决）——此时最优包络落在固定开销 = 0 的边界上、只经过一个样本。
    // 斜率取全体样本的最小每 token 耗时：这是 O = 0 时唯一不穿过任何样本的斜率。
    let mut min_ratio = f64::INFINITY;
    let mut min_tokens = u64::MAX;
    let mut max_tokens = 0u64;
    for s in samples {
        min_ratio = min_ratio.min(s.ms / s.tokens as f64);
        min_tokens = min_tokens.min(s.tokens);
        max_tokens = max_tokens.max(s.tokens);
    }
    if max_tokens.saturating_sub(min_tokens) >= MIN_FIT_TOKEN_SPAN {
        let slack: f64 = samples
            .iter()
            .map(|s| s.ms - min_ratio * s.tokens as f64)
            .sum();
        offer_candidate(
            &mut best,
            slack,
            RateModel {
                overhead_ms: 0.0,
                ms_per_token: min_ratio,
            },
        );
    }
    best.map(|(_, model)| model)
}

/// 候选入池：总残差更小者优先；并列取斜率更慢者（更保守）。
fn offer_candidate(best: &mut Option<(f64, RateModel)>, slack: f64, model: RateModel) {
    let better = match best {
        None => true,
        Some((best_slack, best_model)) => {
            slack < *best_slack - 1e-9
                || ((slack - *best_slack).abs() <= 1e-9
                    && model.ms_per_token > best_model.ms_per_token)
        }
    };
    if better {
        *best = Some((slack, model));
    }
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

/// 累计器：持有最近样本、包络模型与折断行的拼接状态。
#[derive(Debug, Default)]
pub struct PerfAccumulator {
    pending: Option<PendingTiming>,
    last_prompt: Option<TimingSample>,
    last_gen: Option<TimingSample>,
    prompt_samples: VecDeque<TimingSample>,
    gen_samples: VecDeque<TimingSample>,
    prompt_model: Option<RateModel>,
    gen_model: Option<RateModel>,
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
            Self::push_sample(&mut self.prompt_samples, s);
            self.prompt_model = fit_model(&self.prompt_samples);
        } else {
            // 每条 eval 行对应一次请求完成（缓存全命中时可能没有 prompt 行）。
            self.requests += 1;
            self.last_gen = Some(s);
            Self::push_sample(&mut self.gen_samples, s);
            self.gen_model = fit_model(&self.gen_samples);
        }
    }

    /// 样本入窗口（含包络拟合用的历史）；超出窗口丢最旧的一个。
    fn push_sample(samples: &mut VecDeque<TimingSample>, s: TimingSample) {
        if samples.len() >= FIT_WINDOW {
            samples.pop_front();
        }
        samples.push_back(s);
    }

    pub fn snapshot(&self) -> PerfSnapshot {
        // 无模型（样本跨度不足）时「最近」给原始读数：不隐藏数据；估计列以 null 呈现。
        let last_tps = |s: Option<&TimingSample>, model: Option<RateModel>| match (s, model) {
            (Some(s), Some(model)) => Some(model.corrected_tps(s)),
            (Some(s), None) => Some(s.tps),
            (None, _) => None,
        };
        PerfSnapshot {
            last_prompt_tokens: self.last_prompt.map(|s| s.tokens),
            last_prompt_ms: self.last_prompt.map(|s| s.ms),
            last_prompt_tps: last_tps(self.last_prompt.as_ref(), self.prompt_model),
            prompt_tps_est: self.prompt_model.map(|m| m.tps()),
            last_gen_tokens: self.last_gen.map(|s| s.tokens),
            last_gen_ms: self.last_gen.map(|s| s.ms),
            last_gen_tps: last_tps(self.last_gen.as_ref(), self.gen_model),
            gen_tps_est: self.gen_model.map(|m| m.tps()),
            requests: self.requests,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// 前端可见的推理性能快照（perf://update 载荷 / get_perf_stats 返回值）。
/// last_* = 最近一次样本（tps 为扣固定开销后的净速率）；*_tps_est = 会话速度估计
/// （下限包络拟合的斜率倒数，对并发挤占/卡顿等「只变慢」噪声稳健；拟合未就绪为 null）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PerfSnapshot {
    pub last_prompt_tokens: Option<u64>,
    pub last_prompt_ms: Option<f64>,
    pub last_prompt_tps: Option<f64>,
    pub prompt_tps_est: Option<f64>,
    pub last_gen_tokens: Option<u64>,
    pub last_gen_ms: Option<f64>,
    pub last_gen_tps: Option<f64>,
    pub gen_tps_est: Option<f64>,
    pub requests: u64,
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
