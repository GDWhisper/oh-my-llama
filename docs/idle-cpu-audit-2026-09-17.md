# 空闲态（未加载模型）CPU / 内存实测审查

- 审查日期：2026-09-17
- 审查对象：**本机已安装的正式版** `M:\Oh My Llama\oh-my-llama.exe`（v0.2.4，2026-09-15 构建），非 dev 编译产物
- 审查方式：**运行时实测**（非静态推断）——按进程角色采集 CPU 时间（`GetProcessTimes`，psutil），窗口可见 / 托盘隐藏两种状态各采样 20s（0.25s 分辨率），另做一次 60s 复核
- 关键方法：`resolve_app_data()`（`src-tauri/src/lib.rs:872`）直接读 `%APPDATA%` 环境变量 → 用**隔离 APPDATA** 启动，并在隔离副本里置 `minimize_to_tray=true`，再向主窗口发 `WM_CLOSE` 走**真实** `CloseRequested → window.hide()` 路径（用户真实设置未被读写改动，已核对 `minimize_to_tray` 仍为 `null`）
- 结论速览：**会占 CPU，且与模型无关**——空闲态整机口径约 **0.4%**（20 逻辑核机器上约 **7–9% 单核**），**托盘常驻时几乎不降**（7.34% vs 可见 8.59%）。内存全树工作集约 **584 MB**，其中应用自身可控部分只有几十 MB。

---

## 一、实测数据

### 1.1 CPU（按 WebView2 进程角色拆分）

| 进程角色 | 可见段（20s） | 隐藏段·托盘（20s） | 60s 复核（可见） |
|---|---|---|---|
| `renderer`（页面渲染/JS） | **5.07%** 单核 | **4.29%** 单核 | 4.43% 单核 |
| `gpu-process`（光栅/合成） | 2.73% | 1.79% | 2.76% |
| `browser`（WebView2 主进程） | 0.62% | 0.78% | 1.51% |
| `tauri` 主进程（`oh-my-llama.exe`） | 0.16% | 0.47% | **0.026%**（60s 仅 15.6 ms） |
| `utility` / `crashpad` | ≈0 | ≈0 | ≈0.18% |
| **全树合计（单核口径）** | **8.59%** | **7.34%** | 8.93% |
| **全树合计（整机口径，÷20 线程）** | **0.43%** | **0.37%** | 0.45% |

> 单位说明：「单核口径」= 该进程 CPU 时间 ÷ 墙钟（任务管理器口径）；「整机口径」再除以逻辑核数。

### 1.2 CPU 的形态：严格 1.5s 周期的尖峰

0.25s 分辨率的 CPU 时间增量序列（`renderer`，可见段）：

```
[31.2, 31.2, 0, 0, 0, 0, 46.9, 15.6, 0, 0, 0, 0, 31.2, 46.9, 0, 0, 0, 0,
 31.2, 15.6, 0, 0, 0, 0, 31.2, 15.6, 0, 0, 0, 0, 62.5, 15.6, 0, 0, 0, 0,
 62.5, 31.2, 0, 0, 0, 0, 31.2, 15.6, 0, 0, 0, 0, 46.9, 31.2, ...]
```

每 **6 个样本（= 1.5 s）一簇、每簇 15–78 ms**——与 `MetricsPanel` 的轮询间隔（`src/components/MetricsPanel.tsx:24` `INTERVAL = 1500`）**严格同相位**。`gpu-process` 与 `browser` 呈同样节律（每次刷新都伴随合成与 IPC）。

**隐藏段（真实托盘路径）序列不变**——仍是每 6 个样本一簇，没有变成 8s 周期：

```
renderer: [31.2, 31.2, 0, 0, 0, 0, 31.2, 0, 0, 0, 0, 0, 31.2, 15.6, 0, 0, 0, 0, 46.9, 0, ...]
```

### 1.3 内存（未加载模型，窗口可见）

| 进程 | 工作集 | 私有提交 |
|---|---|---|
| `oh-my-llama.exe`（Tauri 主进程） | 70.5 MB | 39.5 MB |
| `msedgewebview2.exe` browser | 191.1 MB | 79.9 MB |
| `msedgewebview2.exe` renderer | 147.4 MB | 101.1 MB |
| `msedgewebview2.exe` gpu-process | 73.9 MB | 93.3 MB |
| `msedgewebview2.exe` utility ×2 | 25.5 + 54.5 MB | 5.1 + 14.4 MB |
| `msedgewebview2.exe` crashpad-handler | 19.6 MB | 7.9 MB |
| **合计** | **≈ 582–585 MB** | **≈ 343 MB** |

窗口隐藏前后内存基本不变（582 → 585 MB）；60s 复核一致。

---

## 二、占用机制（逐条定位）

| # | 机制 | 位置 | 量级 | 判定 |
|---|---|---|---|---|
| 1 | **1.5s 指标轮询 → 每次都触发指标条宽度动画** | 轮询 `MetricsPanel.tsx:94`（`window.setInterval`，卸载前常驻）；动画 `.meter-fill { transition: width 280ms ease }` `MetricsPanel.css:75` | 每次刷新在 WebView2 侧产生 **45–95 ms** 渲染+合成 CPU（renderer + gpu-process + browser 三者合计） | **主因，占了全部空闲 CPU 的 ~97%** |
| 2 | 后端采集本体 | `metrics.rs:94 get_system_metrics`（sysinfo PDH CPU + 内存 + NVML 5 次驱动查询） | **0.39 ms/次**（60s 内 40 次 = 15.6 ms），折合单核 0.026% | 可忽略；**瓶颈不在 Rust 侧**（Rust 侧空闲无任何常驻线程/定时器，唯一 `spawn` 都在 `start_server` 路径） |
| 3 | **⚠️「隐藏降频到 8s」实际从未生效** | `MetricsPanel.tsx:92-93`（按 `document.visibilityState` 选 1.5s/8s）、`useServer.ts` 的 `hidden` 判定（`POLL_INTERVAL_HIDDEN_MS`） | 托盘态实测仍是 1.5s 节律 | **缺陷**：`window.hide()`（wry `controller.SetIsVisible(false)`，`wry-0.55.1/src/webview2/mod.rs:1487`）不会把页面置为 `hidden`，两个降频分支都进不去 → 隐藏后 CPU 几乎不减（7.34% vs 8.59%） |
| 4 | 日志批量 flush 定时器 | `useServer.ts:359`（`LOG_FLUSH_MS = 200`，5 次/秒） | 静止时仅一次空数组判断，≈0 | 可忽略（但确为一个永不静止的定时器） |
| 5 | 6h 更新自动检查 | `App.tsx:219`（`AUTO_CHECK_INTERVAL_MS = 6h`） | 每 6h 读一次 `settings.json`；开关打开才联网 | 可忽略 |

---

## 三、能否精简（按性价比排序）

### A. 修「隐藏不降频」——收益最大
不再依赖 `document.visibilityState`，改由 **Rust 侧在窗口 hide/show 时 `emit` 事件**（`on_window_event` 已有现成落点，`lib.rs:638`），前端据此**停表**（delay=null）或降到 30–60s，重新显示时立即 tick 一次。
预期：托盘常驻 **7.3% 单核 → <0.5%**（整机口径 0.37% → ~0.02%）。

### B. 削掉「每次刷新的放大系数」
1. `.meter-fill` 的 `transition: width 280ms`（`MetricsPanel.css:75`）：保留观感可缩短到 ~120ms，或仅在变化 > 1% 时才带过渡。
2. 数值无实质变化时**不 setState**：`cpu_usage` 取整、内存按 16 MB 桶、GPU 利用率取整后比较，静止时零重渲染。
预期：可见态每次刷新的 45–95 ms 降到 ~5–15 ms。

### C. 降轮询频率 / 折叠即停表
`expanded`（`MetricsPanel.tsx:77`，折叠只影响渲染、不影响轮询）改为门控条件之一；间隔 1.5s → 3–5s。线性减半到 1/3。

> 本节为初版方案。定稿见第五节 C：靶子收敛为【不可见 / 不使用】——可见态节奏不动，收起降频 3s，隐藏停表。

### D. 顺手清理（量级小，但属根因级洁癖）
- `metrics.rs:34`：`System::new_all()` → `System::new()`。当前为拿 CPU/内存而枚举**整机进程表**并常驻（`HashMap::with_capacity(500)` + 每个 `Process` 的字符串），实测只用到 `refresh_cpu_specifics` + `refresh_memory`。
- `metrics.rs:35/96`：`CpuRefreshKind::everything()` → `with_cpu_usage()`（UI 不显示 CPU 频率，无需刷新频率）。
- `useServer.ts:359`：日志 flush 改事件驱动（收到首行才挂一次 200 ms timeout），空闲期彻底无 200 ms 定时器。

### E. 不建议动
- WebView2 的 ~500 MB 工作集：Chromium 多进程基线，Tauri/应用层压不动，除非不使用系统 WebView。
- `nvml.dll` 常驻映射：指标面板需要，且只占几 MB。
- Rust 侧已无优化空间（空闲 0.026%）。

**推荐组合：A + B**（A 解决"后台常驻仍烧 CPU"的根因，B 解决"看着也烧"的放大系数）；C 作为产品层面的取舍再定；D 可顺带。

---

## 四、复现方法

- 采样脚本：`tmp/probe4.py`（隔离 `%APPDATA%` + `minimize_to_tray=true` + `WM_CLOSE` 真隐藏 + 0.25s 分辨率按角色采样）
- 截图证据：`tmp/oml-idle-visible.png`（应用正常加载、状态「已停止」、未加载模型）

---

## 五、修复实施记录（2026-09-17 当日落地，A+B+C+D 全采纳）

### A. 修「隐藏不降频」——换成后端广播真源 ✅

| 位置 | 改动 |
|---|---|
| `src-tauri/src/lib.rs` | 新增 `emit_window_visible(app, visible)`：广播 `window://visible`（bool），注释写明「为什么必须由后端广播」。在**全部 3 处** hide/show 调用点调用：`resolve_close_choice` 的 `win.hide()`、`CloseRequested` 分支的 `window.hide()`、`show_main_window` 的 `win.show()` |
| `src/hooks/useWindowHidden.ts`（新） | 共享 hook：后端事件 + `document.visibilityState` 双真源取「或」（任一为不可见即隐藏）。后端事件是托盘隐藏的唯一真源，document 兜底最小化/切虚拟桌面 |
| `src/lib/listenGuarded.ts`（新） | 从 `useServer.ts` 抽出 `listenGuarded`，供日志与窗口可见性两处订阅共用（原为模块内私有，避免复制竞态防护后漂移） |
| `src/components/MetricsPanel.tsx` | 窗口不可见即**停表**（不再是隐藏 8s）；恢复时 effect 重建并立即 tick |
| `src/hooks/useServer.ts` | 状态轮询的 hidden 判定改用同一 hook——**此前失效的「隐藏 8s」这条现在真正生效** |

### B. 收敛每次刷新的重绘代价 ✅（过渡时长已按用户要求还原）

- `src/components/MetricsPanel.tsx`：新增 `sameSnapshot`（CPU/GPU 利用率、温度、功耗取整；内存/显存按 16MB 桶），等价时 `setSnap(prev => prev)` 复用旧引用 → React 跳过重渲染。**数值无变化时条子连滑都不滑**，这是 B 的收益主体。
- `src/components/MetricsPanel.css`：`.meter-fill` 的 `transition` 一度压到 120ms，**经用户裁定还原为 280ms**——「丝滑」是用户看得见的体验，优先级高于本次优化（本次靶子是不可见/不使用场景）。该行注释已写明：这部分开销是有意接受的，可见态的主要开销来源仍在它。

### C. 降频 ✅（范围收敛为「不可见 / 不使用」，可见态节奏不动）

**定稿口径（用户明确）**：本次优化的靶子是【用户不可见】（托盘/最小化）与【用户不使用】（面板收起）两个场景；**用户正在看的时候不牺牲刷新节奏**。

| 状态 | 修前 | 定稿 | 说明 |
|---|---|---|---|
| 展开 + 窗口可见 | 1500ms | **1500ms（不动）** | 用户正在看，保持原节奏 |
| 收起 + 窗口可见 | 1500ms（无区分） | **3000ms** | 用户没在看细节，只剩一行摘要要更新 |
| 窗口隐藏 / 托盘 | 1500ms（8s 分支失效） | **完全停表** | 收益主体：7.34% → ≈0 |

- 删除 `INTERVAL_HIDDEN`（隐藏改为**完全停表**，不再降频）。
- **修正记录（两条，均来自实施期）**：
  1. 原方案 C 写「折叠即停表」是错的——收起态**本身仍渲染一行紧凑摘要**（CPU / 内存 / GPU / 显存 / 功耗，`MetricsPanel.tsx` 的非 expanded 分支），停表会把摘要冻在旧值上，属可见回归。故收起只降频、不停表。
  2. 收起降频值一度设为 10s，按上面的定稿口径回调为 **3000ms**。
- 隐藏（托盘/最小化）→ 停表（effect 直接 return）；恢复可见/展开时立即 tick 一次。

### D. 顺手清理 ✅

- `src-tauri/src/metrics.rs`：`System::new_all()` → `System::new()`（不再枚举并常驻整机进程表），`CpuRefreshKind::everything()` → `new().with_cpu_usage()`（不再刷主频，面板不显示主频），两者收敛为 `cpu_refresh_kind()`。
- `src-tauri/src/metrics.rs`：新增单测 `snapshot_reads_cpu_and_memory_without_process_list`——验证「空 System + 只刷占用」仍能产出合法快照（内存总量可读、占用均为 0-100 的有限值）。
- `src/hooks/useServer.ts`：日志 flush 由常驻 200ms `setInterval` 改为**事件驱动**（首行到达才挂一次 `setTimeout`，`flushSoon` / `cancelFlush`），空闲期彻底没有 200ms 心跳。

### 预期效果与验证状态

| 场景 | 修前（实测） | 修后（预期） |
|---|---|---|
| 托盘常驻（无模型）——**收益主体** | 7.34% 单核 | **≈0**（停表；仅剩 6h 更新检查与唤醒即查） |
| 可见 + 面板收起（用户不看细节） | 8.59% 单核 | **~5%**（间隔 1.5s→3s + `sameSnapshot` 少重渲染） |
| 可见 + 面板展开（用户正在看） | 8.59% 单核 | **~7%**（间隔与过渡均不动，只吃 `sameSnapshot`） |

**验证状态**：静态门禁已过（`npm run check` 全绿：tsc / eslint / prettier / CSS 选择器 + `cargo fmt --check` + `clippy -D warnings`；`cargo test --lib` **31 passed**，含新增 metrics 用例）；**运行时复核待做**——需 `npm run tauri dev` 启动后按同一套采样脚本（`tmp/probe4.py`）复测「可见 / 托盘」两段。
