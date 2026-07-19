//! 系统性能采集：CPU / 内存 / GPU（NVIDIA，经 NVML）。
//!
//! 设计取舍（与 nano-stat 同思路，按本项目习惯精简为单文件、蛇形序列化）：
//! - CPU 占用率、内存总量/已用：复用项目已有的 `sysinfo`；占用率为两次刷新间的差值。
//! - GPU：经 `nvml-wrapper` 动态加载系统 `nvml.dll`（NVIDIA 驱动自带）。
//!   无 N 卡 / 驱动未装时 `Nvml::init()` 返回 Err，降级为「无 GPU」，绝不崩。
//! - AMD / Intel 的实时利用率与已用显存需走 Windows PDH 计数器，留作下一轮增强。

use serde::Serialize;
use std::sync::{LazyLock, Mutex};
use sysinfo::{CpuRefreshKind, System};

#[derive(Debug, Clone, Serialize)]
pub struct GpuMetrics {
    pub name: String,
    pub usage: f32, // 0-100
    pub vram_total_mb: u64,
    pub vram_used_mb: u64,
    pub temperature: Option<f32>, // Celsius，None 表示取不到
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricsSnapshot {
    pub cpu_usage: f32, // 0-100 全局占用
    pub mem_total_mb: u64,
    pub mem_used_mb: u64,
    pub mem_usage: f32, // 0-100
    pub gpus: Vec<GpuMetrics>,
}

/// 跨请求复用的 System 实例（sysinfo 推荐保持常驻并增量刷新）。
static SYSTEM: LazyLock<Mutex<System>> = LazyLock::new(|| {
    let mut sys = System::new_all();
    sys.refresh_cpu_specifics(CpuRefreshKind::everything());
    Mutex::new(sys)
});

/// 全局 NVML 实例（仅 NVIDIA）。初始化失败则为 None，降级处理。
static NVML: LazyLock<Mutex<Option<nvml_wrapper::Nvml>>> =
    LazyLock::new(|| Mutex::new(nvml_wrapper::Nvml::init().ok()));

/// 枚举所有 NVIDIA GPU（按索引 0..device_count）。
fn collect_gpus() -> Vec<GpuMetrics> {
    let guard = match NVML.lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    let nvml = match guard.as_ref() {
        Some(n) => n,
        None => return Vec::new(),
    };

    let count = match nvml.device_count() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let device = match nvml.device_by_index(i) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let name = device.name().unwrap_or_else(|_| format!("GPU {i}"));
        let (vram_total_mb, vram_used_mb) = device
            .memory_info()
            .map(|m| (m.total / (1024 * 1024), m.used / (1024 * 1024)))
            .unwrap_or((0, 0));
        let usage = device
            .utilization_rates()
            .map(|u| u.gpu as f32)
            .unwrap_or(0.0);
        let temperature = device
            .temperature(nvml_wrapper::enum_wrappers::device::TemperatureSensor::Gpu)
            .ok()
            .map(|t| t as f32);

        out.push(GpuMetrics {
            name,
            usage,
            vram_total_mb,
            vram_used_mb,
            temperature,
        });
    }
    out
}

#[tauri::command]
pub fn get_system_metrics() -> MetricsSnapshot {
    let mut sys = SYSTEM.lock().unwrap();
    sys.refresh_cpu_specifics(CpuRefreshKind::everything());
    sys.refresh_memory();

    let cpu_usage = sys.global_cpu_info().cpu_usage();

    let mem_total = sys.total_memory();
    let mem_used = sys.used_memory();
    let mem_usage = if mem_total > 0 {
        (mem_used as f32 / mem_total as f32) * 100.0
    } else {
        0.0
    };

    // 先释放 SYSTEM 锁，再单独采集 GPU（NVML 独立锁，避免任何嵌套风险）。
    drop(sys);

    let gpus = collect_gpus();

    MetricsSnapshot {
        cpu_usage,
        mem_total_mb: mem_total / (1024 * 1024),
        mem_used_mb: mem_used / (1024 * 1024),
        mem_usage,
        gpus,
    }
}
