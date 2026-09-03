# CPU 占用与内存泄露审查报告

- 审查日期：2026-09-03
- 审查范围：`src/`（React/TS 前端）、`src-tauri/src/`（Rust 后端）全部运行期代码路径
- 审查方式：静态代码审查（定时器/监听器/线程/缓冲区/轮询/渲染路径逐项核对），未做运行时 profiling
- 结论速览：**未发现真正的内存泄露**；发现 **2 处高优先级 CPU 热点**、**2 处中优先级持续开销**、若干低优先级杂项。**同日已按第五节顺序全部实施修复（门禁全绿），实施记录见文末。**

---

## 一、高优先级 CPU 热点

### 1.1 日志面板：每行日志触发整树重渲染 + 全量 DOM diff + 强制回流

前端最大的 CPU 消耗点，三个因素叠加：

1. **`logs` 状态位于顶层**（`src/hooks/useServer.ts:295`）
   `log://line` 事件每来一行就 `setLogs`，而 `logs` 由 `useServer` 返回、在 `App` 顶层解构——意味着**每一行日志都让整个 App 重渲染**，包括侧栏全部参数面板、配置管理器（`AdvancedParamsPanel` 单组件 558 行）等与日志无关的子树。

2. **无虚拟化、全量渲染**（`src/components/LogPanel.tsx:164`）
   上限 5000 行 × 每行 4 个 DOM 节点 ≈ 2 万节点，每追加一行就对全表做一次 React reconciliation。

3. **每行强制回流**（`src/components/LogPanel.tsx:96-110`）
   `useLayoutEffect([logs, mode])` 每行执行一次：`findScroller` 内部调 `getComputedStyle`，随后 `scrollTop = scrollHeight`（读 `scrollHeight` 强制同步布局）。

叠加效应在**模型加载阶段最明显**：llama-server 用 `\r` 原地刷新进度条，`pump_reader`（`src-tauri/src/lib.rs:1237-1244`）把每个 `\r` 切成独立一行，加载期每秒可产生几十行；每行都完整走一遍上述流程，且恰好发生在机器正被模型加载打满的时刻。

**隐藏放大器（最接近"内存问题"的表现）**：缓冲达到 5000 行上限后，`next.shift()`（`src/hooks/useServer.ts:297`）使所有行下标前移，而列表 key 为 `${line.ts}-${index}`（`src/components/LogPanel.tsx:165`）——**此后每追加一行，全部 5000 行的 key 都会变化，React 将整个列表卸载重建（约 2 万节点）**，形成持续的分配/GC 压力。这是循环分配而非泄露，内存有界，但开销模式最差。

### 1.2 `is_process_running` 每次调用都 `System::new_all()` 全量枚举进程表

`src-tauri/src/lib.rs:1589-1600`：每次调用新建 `System::new_all()`（枚举整机所有进程并刷新 CPU/内存/磁盘/网络，几十毫秒级 + 大量分配），用完即弃。调用频率很高：

- `get_status` 每次轮询都调用（`lib.rs:761`）——服务受管期间**每 1.5 秒一次**；
- `wait_until_ready` 启动等待循环每 500ms 调用一次（`lib.rs:1578`），上限 90 秒 ≈ **180 次连续全量枚举**。

即模型加载期间，launcher 自身额外贡献每秒约 2 次的全量进程表扫描，与 llama-server 争抢 CPU。

**修复参照已在项目内**：`src-tauri/src/metrics.rs:32-36` 的 `static SYSTEM: LazyLock<Mutex<System>>` 就是 sysinfo 推荐的复用写法。sysinfo 0.30 提供 `refresh_process(pid)` 单进程刷新，改为静态复用 + 定点刷新即可，无需新增依赖。

---

## 二、中优先级：持续性开销

### 2.1 `get_status` 持状态锁做阻塞探测

`src-tauri/src/lib.rs:753-760`：拿到 `Mutex<ServerStatus>` 之后才调用 `probe_health`（同步阻塞 TCP：连接超时 800ms + 读超时 1500ms）。

- 常规路径无害：回环端口未开时 connect 立即 refused（<1ms）。
- 劣化路径：端口被"TCP 可连但不回 HTTP"的服务占用时，每次轮询持锁最长约 2.3s，期间 `stop_server` / `start_server` / `open_preview` 都要排队等锁；同时阻塞调用占用 tokio worker 线程。

建议：先 clone 状态、释放锁，再做探测；或改异步连接 + 超时。

### 2.2 1.5s 轮询的恒定基线开销（且窗口隐藏时不降频）

- `loadStatus` 每次 `setStatus(新对象)`（`src/hooks/useServer.ts:196-197`），即使 `running/managed/pid/port/host` 全未变——status 引用每 1.5s 必变，**全树每 1.5s 必然重渲染一次**（静止时为纯浪费）。
- 轮询在**窗口隐藏 / 托盘常驻期间满频运行**：本应用设计上长期驻留托盘，隐藏后仍有两个 1.5s 定时器（状态轮询 `useServer.ts:420` + `MetricsPanel.tsx:48` 指标轮询）、每 1.5s 一次 `/health` TCP 探测、以及模型文件 stat（`checkModelExists` / `loadModelSize`，`useServer.ts:411-413`）。

建议：`setStatus` 前做浅比较；`document.hidden` 时将轮询降到 5-10s（已有 `tauri://resume` 唤醒即查兜底，`useServer.ts:426-448`，不受影响）。

---

## 三、低优先级杂项

| 位置 | 说明 |
|---|---|
| `src-tauri/src/lib.rs:1198` | `stop_server_inner` 在 async 命令里 `std::thread::sleep(1.5s)`，阻塞 worker 线程；一次性调用，影响小 |
| `src/hooks/useServer.ts:887` | `isDirty` 每次渲染做两次 `JSON.stringify`；单独可忽略，但与 1.1/2.2 的"每行日志 / 每 1.5s 全树渲染"是乘法关系 |
| `src-tauri/src/lib.rs:1222-1264` | `pump_reader` 逐字节读；有 `BufReader` 摊薄系统调用，实际开销可忽略，**不必改** |
| `src/components/MetricsPanel.tsx` | 每 1.5s 走 NVML / sysinfo 增量刷新，后端实现（共享静态实例）已是正确模式，保持现状 |

---

## 四、内存泄露专项：未发现泄露

逐项核对证据：

| 检查项 | 结论 |
|---|---|
| Tauri 事件监听 | `listenGuarded` 正确处理 StrictMode 双挂载（`useServer.ts:47-58`）；`App.tsx:219` 有 disposed 守卫；LogPanel 滚动监听卸载时解绑（`LogPanel.tsx:113-117`） |
| DOM 监听器 | 全部成对 `removeEventListener`（ConfigManager、ModelSelect、PathField、各弹窗 keydown） |
| 定时器 | `useInterval`、MetricsPanel、6h 更新检查（`App.tsx:196-205`）、ModelSelect focus、RawParams 防抖均有 clear |
| ResizeObserver | `App.tsx:144` disconnect ✓ |
| 后端日志缓冲 | 有界 5000（`lib.rs:1424`）✓；前端同样有界 5000（`useServer.ts:297`）✓ |
| 子进程监管线程 | pump / consumer / waiter 三线程均有 join 或由 channel 关闭自然退出（`lib.rs:1372-1384`）；PTY master、JobHandle 随 `wait_process` 结束正确 Drop |
| 其他缓冲 | `recent_servers` 上限 10（`lib.rs:319`）；配置库由用户文件决定；无无界 HashMap/Vec/channel |

结论：不存在随时间无界增长的内存路径。唯一值得留意的内存现象是 1.1 节所述"日志满载后整列表重挂载"带来的 GC 压力（WebView 侧），属于分配模式问题而非泄露。

---

## 五、修复实施记录（2026-09-03 已全部实施）

按 1.2 → 1.1 → 轮询治理顺序逐项落地，每步过全量门禁（`npm run check` + `cargo test --lib`，22 测试全绿）。

### 5.1 `is_process_running`（对应 1.2）✅

`lib.rs`：新增 `static PROCESS_PROBE_SYS: LazyLock<Mutex<System>>`（与 `metrics.rs` 的 SYSTEM 分离、互不干扰），函数体改为 `sys.refresh_process(pid)` 单进程定点刷新——返回值即「该 pid 是否存在」，与原语义一致。全量枚举降为 <1ms 单点刷新，无新增依赖。

### 5.2 日志渲染链路（对应 1.1）✅

- **批量 flush**（`useServer.ts`）：`log://line` 不再逐行 `setLogs`，增量行先进 `logBufferRef`（ref 不参与渲染），200ms 定时器批量 flush（缓冲非空才 setLogs，静止零开销）；一次追加 + 一次 `slice` 裁剪到 5000。`log://clear` 与手动清空均先清缓冲再清 state，保持时序语义。
- **key 改单调 id**（`useServer.ts` + `LogPanel.tsx`）：新增前端派生类型 `LogLine = ServerLogLine & { id }`，`logIdSeq` 单调递增（历史拉取与增量事件共用；IPC 契约 `ServerLogLine` 不变）。列表 key 由 `${ts}-${index}` 改为 `line.id`——满载 shift 后不再整列表重挂载。
- **尾部渲染窗口**（`LogPanel.tsx`）：默认只渲染尾部 800 行，顶部「↑ 加载更早日志」按钮按批扩窗（i18n 新键 `log.loadOlder` zh/en；样式 `.term-older`）。不引入虚拟滚动依赖，浏览器 overflow-anchor 保持视口锚定。
- **scroller 缓存**（`LogPanel.tsx`）：置底 effect 优先复用已绑定的滚动容器，仅缓存失效时重跑 `findScroller` 的 `getComputedStyle` 父链遍历。
- **取舍**：报告建议的「自动置底改 rAF 节流」未采纳——批量 flush 后置底频率已降至 5 次/秒量级，保持 `useLayoutEffect` 同步置底的原有竞态语义（绘制前贴底）更简单可靠。

### 5.3 轮询治理（对应 2.1 / 2.2）✅

- **锁外探测**（`lib.rs` `get_status`）：`probe_health` 不依赖状态、提前到拿锁之前执行；锁内仅做 `owned_alive` 计算（1.2 修复后 <1ms）。探测与拿锁之间状态可能被 start/stop 修改，`owned_alive` 基于拿锁后的最新值计算，无竞态。
- **setStatus 浅比较**（`useServer.ts`）：新增 `sameStatus`（六字段浅比较，均为原始值），静止时复用旧引用，React 跳过全树重渲染。
- **隐藏降频**（`useServer.ts` + `MetricsPanel.tsx`）：两个 1.5s 轮询均改为「可见 1.5s / 隐藏（托盘常驻）8s」，`visibilitychange` 切换 delay 重建定时器；`tauri://resume` 唤醒即查兜底不变。

以上均未触碰 AGENTS.md 架构约束与禁区（双层分层、默认值真源、PTY 启动方式、IPC 契约等保持不变）；无新增依赖。
