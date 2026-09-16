//! 开机自启：把本应用登记为「登录时运行」（Windows 的 HKCU\...\Run 注册表项）。
//!
//! 为什么直调注册表而不用 tauri-plugin-autostart：
//! 本项目的分发目标只有 Windows，注册表路径可复用**已有**的 windows-sys 依赖（同 Job Object、
//! 任务栏图标那两处），不新增任何第三方 crate 与下载面；插件则会额外拖入 auto-launch 及其依赖树。
//!
//! 真源约定：系统侧「是否开机自启」的唯一真源就是注册表里那个值是否存在。
//! 刻意**不**在 settings.json 里再存一份镜像——两份状态会各自漂移（用户手工删掉条目后，
//! 镜像仍写着 true，界面就会骗人）。所以 `is_enabled` 每次实查注册表。
//!
//! 只在用户主动勾选时才写注册表：默认不写，即「默认关闭」。

use std::path::Path;

/// 注册表 Run 项下的值名。用户可见（注册表编辑器 / 任务管理器「启动」页会原样显示），
/// 与产品名保持一致；改动它会与旧版本已写入的条目失去关联（旧条目需手工清理）。
#[cfg(windows)]
pub const VALUE_NAME: &str = "Oh My Llama";

/// 当前平台是否支持开机自启。前端据此决定是否渲染设置里的那张卡片。
pub const SUPPORTED: bool = cfg!(windows);

/// 生成写进注册表的启动命令行：带双引号的可执行文件绝对路径。
///
/// 引号不是装饰——安装目录常含空格（`C:\Program Files\Oh My Llama\...`），
/// 不加引号时系统会在第一个空格处截断，等于把路径喂成了 `C:\Program`。
pub fn autostart_command(exe: &Path) -> String {
    format!("\"{}\"", exe.display())
}

/// 查系统侧的自启状态：`Ok(None)` = 本平台不支持；`Ok(Some(true/false))` = 注册表实况。
pub fn is_enabled() -> Result<Option<bool>, String> {
    if !SUPPORTED {
        return Ok(None);
    }
    Ok(Some(read_value()?.is_some()))
}

/// 打开/关闭开机自启。`enabled = true` 时总是按 `exe` 重写条目
/// （顺带修好「便携版被挪过目录、条目仍指向旧路径」的情况）。
pub fn set_enabled(enabled: bool, exe: &Path) -> Result<(), String> {
    if !SUPPORTED {
        return Err("当前平台不支持开机自启。".into());
    }
    if enabled {
        write_value(&autostart_command(exe))
    } else {
        delete_value()
    }
}

// ── 启动自愈 ────────────────────────────────────────────────────────────
// 已开启自启、但条目指向的不是当前这个可执行文件（用户把便携版挪了目录 / 换了安装位置）：
// 静默改指到当前路径。否则开机时系统会去拉起一个不存在的路径，自启**静默失效**，
// 而用户在界面里看到的仍是「已开启」——这种哑失败最难排查，所以宁可在这里悄悄修好。
// 仅在条目已存在且确实不一致时才写，未开启自启时本函数不做任何事。
pub fn heal_stale_entry() -> Result<(), String> {
    if !SUPPORTED {
        return Ok(());
    }
    let Some(current) = read_value()? else {
        return Ok(());
    };
    let exe = std::env::current_exe().map_err(|err| format!("无法定位应用路径: {err}"))?;
    let want = autostart_command(&exe);
    if current == want {
        return Ok(());
    }
    write_value(&want)
}

// ── Windows 实现 ────────────────────────────────────────────────────────
// 全部用 `unsafe` 直调 advapi32：句柄的取得/释放严格成对（RegCreateKeyExW/RegOpenKeyExW →
// RegCloseKey），且只在返回 ERROR_SUCCESS 时使用句柄；缓冲区由 Vec 拥有，长度随 API 回填。
#[cfg(windows)]
mod platform {
    use super::VALUE_NAME;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    /// &str → NUL 结尾的 UTF-16（Win32 W 系列 API 的入参形态）。
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 读 Run 项下本应用的值数据。键或值不存在都返回 None（= 未开启，不是错误）。
    pub fn read_value() -> Result<Option<String>, String> {
        let sub_key = wide(RUN_KEY);
        let name = wide(VALUE_NAME);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: sub_key/name 均为 NUL 结尾的 UTF-16 缓冲且在调用期间存活；
        // key 仅在 rc == ERROR_SUCCESS 时才被 RegOpenKeyExW 写入，故失败分支不解引用。
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                sub_key.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut key,
            )
        };
        if rc != ERROR_SUCCESS {
            return Ok(None);
        }
        // 先问长度（lpdata 传空），再按长度分配缓冲读回——避免猜一个可能不够大的固定尺寸。
        let mut kind = 0u32;
        let mut bytes = 0u32;
        // SAFETY: key 有效；lpreserved/lpdata 允许为空指针；bytes 由 API 回填。
        let rc = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut bytes,
            )
        };
        if rc != ERROR_SUCCESS {
            // SAFETY: key 来自成功的 RegOpenKeyExW，此处释放一次。
            unsafe { RegCloseKey(key) };
            return Ok(None);
        }
        // Vec<u16> 保证 2 字节对齐（API 期望 UTF-16 数据），再借成 *mut u8 交给它。
        let mut buf = vec![0u16; (bytes as usize).div_ceil(2)];
        // SAFETY: buf 至少能放下 bytes 个字节，cbData 也已如实告知其容量。
        let rc = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buf.as_mut_ptr() as *mut u8,
                &mut bytes,
            )
        };
        // SAFETY: 同上，句柄用毕即释放（此后不再使用 key）。
        unsafe { RegCloseKey(key) };
        if rc != ERROR_SUCCESS {
            return Err(format!("读取开机自启设置失败（错误码 {rc}）。"));
        }
        // REG_SZ 的数据含结尾 NUL，去掉后再解码。
        while buf.last() == Some(&0) {
            buf.pop();
        }
        String::from_utf16(&buf)
            .map(Some)
            .map_err(|err| format!("读取开机自启设置失败: {err}"))
    }

    /// 写 Run 项下本应用的值。用 RegCreateKeyExW 而非 OpenKeyExW：
    /// 万一 Run 项被清理工具删掉，这里能自建，而不是留下一个「永远写不进去」的功能。
    pub fn write_value(command: &str) -> Result<(), String> {
        let sub_key = wide(RUN_KEY);
        let name = wide(VALUE_NAME);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: sub_key/name 存活至调用结束；lpsecurityattributes 传空 = 默认安全描述符；
        // phkresult 仅在成功时被写入。
        let rc = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                sub_key.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(format!("打开开机自启注册表项失败（错误码 {rc}）。"));
        }
        let data: Vec<u16> = wide(command);
        // SAFETY: data 是 NUL 结尾的 UTF-16，字节数按 len * size_of::<u16>() 如实给出。
        let rc = unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr() as *const u8,
                (data.len() * std::mem::size_of::<u16>()) as u32,
            )
        };
        // SAFETY: key 来自成功的 RegCreateKeyExW，此处释放一次。
        unsafe { RegCloseKey(key) };
        if rc != ERROR_SUCCESS {
            return Err(format!("写入开机自启注册表项失败（错误码 {rc}）。"));
        }
        Ok(())
    }

    /// 删除 Run 项下本应用的值。条目本就不存在（ERROR_FILE_NOT_FOUND）视为已达成目标。
    pub fn delete_value() -> Result<(), String> {
        let sub_key = wide(RUN_KEY);
        let name = wide(VALUE_NAME);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: 同 read_value 的开键分支。
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                sub_key.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut key,
            )
        };
        if rc != ERROR_SUCCESS {
            return Ok(());
        }
        // SAFETY: key 有效；name 为 NUL 结尾 UTF-16。
        let rc = unsafe { RegDeleteValueW(key, name.as_ptr()) };
        // SAFETY: key 来自成功的 RegOpenKeyExW，此处释放一次。
        unsafe { RegCloseKey(key) };
        if rc != ERROR_SUCCESS && rc != ERROR_FILE_NOT_FOUND {
            return Err(format!("关闭开机自启失败（错误码 {rc}）。"));
        }
        Ok(())
    }
}

#[cfg(windows)]
use platform::{delete_value, read_value, write_value};

// ── 非 Windows 兜底 ─────────────────────────────────────────────────────
// 不提供 XDG autostart / LaunchAgents 实现：本项目的分发产物只有 Windows，
// 为不存在的目标平台写一套无法自测的代码没有意义。此处一律视为「不支持」，
// 前端据 SUPPORTED 隐藏卡片，不会给用户一个点了必然报错的开关。
#[cfg(not(windows))]
fn read_value() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(windows))]
fn write_value(_command: &str) -> Result<(), String> {
    Err("当前平台不支持开机自启。".into())
}

#[cfg(not(windows))]
fn delete_value() -> Result<(), String> {
    Err("当前平台不支持开机自启。".into())
}
