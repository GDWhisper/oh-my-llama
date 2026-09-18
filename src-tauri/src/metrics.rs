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
    pub temperature: Option<f32>,   // Celsius，None 表示取不到
    pub power_usage_w: Option<f32>, // 当前功耗（瓦），None 表示取不到
    pub power_limit_w: Option<f32>, // 功率上限（瓦），功耗条填充比例的基准；None 表示取不到
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricsSnapshot {
    pub cpu_usage: f32,    // 0-100 全局占用
    pub cpu_brand: String, // CPU 型号（sysinfo 的 CPUID 品牌串）；非 x86 等取不到时为空串
    pub mem_total_mb: u64,
    pub mem_used_mb: u64,
    pub mem_usage: f32, // 0-100
    pub gpus: Vec<GpuMetrics>,
}

/// 跨请求复用的 System 实例（sysinfo 推荐保持常驻并增量刷新）。
///
/// 刻意用 `System::new()` 而非 `new_all()`：本模块只读 CPU 占用与内存总量/已用，
/// 不需要整机进程表。`new_all()` 会把所有进程（含各自的 cmd/exe/环境字符串）枚举进
/// `HashMap<Pid, Process>` 并常驻到进程结束——纯属白占内存。CPU 列表由
/// `refresh_cpu_specifics` 在首次刷新时惰性建立（sysinfo 的 `CpusWrapper::init_if_needed`），
/// 空 System 同样能拿到全局 CPU 占用。
static SYSTEM: LazyLock<Mutex<System>> = LazyLock::new(|| {
    let mut sys = System::new();
    sys.refresh_cpu_specifics(cpu_refresh_kind());
    Mutex::new(sys)
});

/// 只刷 CPU 占用（不刷频率）：面板不展示主频，`everything()` 的频率刷新纯属浪费。
fn cpu_refresh_kind() -> CpuRefreshKind {
    CpuRefreshKind::new().with_cpu_usage()
}

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
        // NVML 返回毫瓦；消费卡多数支持，驱动/机型不支持时为 None。
        let power_usage_w = device.power_usage().ok().map(|mw| mw as f32 / 1000.0);
        // 功耗条基准取「当前生效上限」（用户在 nvidia-smi -pl 里改过就跟随），
        // 取不到再退回配置上限；仍为 0 视为不可用（避免前端除以 0）。
        let power_limit_w = device
            .power_management_limit()
            .or_else(|_| device.enforced_power_limit())
            .ok()
            .map(|mw| mw as f32 / 1000.0)
            .filter(|w| *w > 0.0);

        out.push(GpuMetrics {
            name,
            usage,
            vram_total_mb,
            vram_used_mb,
            temperature,
            power_usage_w,
            power_limit_w,
        });
    }
    out
}

#[tauri::command]
pub fn get_system_metrics() -> MetricsSnapshot {
    let mut sys = SYSTEM.lock().unwrap();
    sys.refresh_cpu_specifics(cpu_refresh_kind());
    sys.refresh_memory();

    let cpu_usage = sys.global_cpu_info().cpu_usage();
    // 品牌串随 CPU 列表在首次刷新时一并填充，此后只是读取常驻字符串（无需额外轮询开销）。
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_default();

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
        cpu_brand,
        mem_total_mb: mem_total / (1024 * 1024),
        mem_used_mb: mem_used / (1024 * 1024),
        mem_usage,
        gpus,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 空 System（不枚举整机进程表）+ 只刷 CPU 占用的组合，仍须产出合法快照。
    /// 首次调用建立 PDH 计数器（首个样本的差值为 0/无意义），故以第二次为准。
    #[test]
    fn snapshot_reads_cpu_and_memory_without_process_list() {
        let _ = get_system_metrics();
        std::thread::sleep(std::time::Duration::from_millis(150));
        let s = get_system_metrics();

        assert!(s.mem_total_mb > 0, "内存总量应可读");
        assert!(
            s.mem_used_mb > 0 && s.mem_used_mb <= s.mem_total_mb,
            "已用内存应在 (0, 总量] 内"
        );
        assert!((0.0..=100.0).contains(&s.mem_usage), "内存占用应为百分比");
        assert!(
            s.cpu_usage.is_finite() && (0.0..=100.0).contains(&s.cpu_usage),
            "CPU 占用应为 0-100 的有限值，实际 {}",
            s.cpu_usage
        );
    }
}
