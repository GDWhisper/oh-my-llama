# 托盘「阻止休眠」子菜单：关闭与时长同时带勾（2026-11-10）

## 问题现象

右键托盘 → 「阻止休眠」子菜单里，「关闭」和「永久」（或某一档时长）同时显示 ✓。
九项本应是互斥单选组：未开启只勾「关闭」，开启后只勾对应时长/自定义。

## 机制

子菜单用九个 `CheckMenuItem` 模拟单选，勾选态真源是 `settings.json` 的
`keep_awake_manual` + `keep_awake_duration_minutes`。有两个外部行为决定了这套模拟很脆弱：

- muda 在**派发菜单事件之前**就自行翻转被点项的原生勾选（`menu_selected` 里
  `item.set_checked(!item.checked)`）。所以点「永久」的瞬间，界面上必然短暂出现
  「关闭 + 永久」两个勾，必须靠事后的整体对齐把九项显式写回真源。
- Tauri 的 `CheckMenuItem::set_checked` 不是本地赋值：它把操作派发到主线程并同步等
  回执，返回 `Result`。任何一次派发失败都会让该项停在翻转后的状态。

也就是说：**只要有一次对齐漏跑、或部分项对齐失败，双勾就会留下来**。原来的实现有三处能造成这种漏跑：

1. **菜单重建与静态句柄竞态（主因）**。`build_tray_menu` 在构造菜单时就把九项句柄
   写进 `TRAY_KEEP_AWAKE_ITEMS`，`tray.set_menu(...)` 在之后。前端 `useEffect([t])` 在
   StrictMode 双挂载下会连发两次 `set_tray_labels`，而它是 async command、两次可能落在
   不同线程。若交叉成「A 建菜单 → B 建菜单 → B 挂上托盘 → A 挂上托盘」，静态里留存的是
   B 的句柄、托盘显示的却是 A 的菜单，之后所有对齐都打在一份看不见的孤儿菜单上。
   旧注释「StrictMode 双挂载重复 invoke 幂等无害」是错的。
2. **对齐只在部分分支跑**。成功路径依赖 `keep_awake::set_manual` 内部对齐，失败路径在
   `on_menu_event` 里补一次；一旦菜单 ID 解析失败，就既不 `set_manual` 也不对齐，
   muda 翻转出的第二个勾永久残留。
3. **错误被静默吞掉**。`let _ = item.set_checked(...)` 让主线程往返失败毫无痕迹，
   排查时看不到任何线索。

## 修复原则（`src-tauri/src/lib.rs`）

| 项 | 做法 |
|---|---|
| 重建原子性 | `TRAY_MENU_REBUILD` 锁包住「建菜单 → 挂上托盘 → 提交句柄」；setup 与 `set_tray_labels` 共用同一把锁 |
| 句柄提交时机 | `build_tray_menu` 改为返回 `(Menu, TrayMenuHandles)`，**只有 `set_menu` 成功后**才 `commit_tray_handles`；失败时静态仍是上一份可见菜单的句柄 |
| 点击后必对齐 | `on_menu_event` 收尾对全部 keep-awake 组 ID 无条件 `sync_tray_keep_awake_check()`，不再按成功/失败分支分别处理 |
| 失败可见 | `set_checked` 的 `Err` 打日志，不再 `let _ =` 吞掉（性能监控那一项同样处理） |
| ID 同源 | `keep_awake_item_id` / `keep_awake_minutes_from_id` 成对，避免生成模板与解析切片漂移 |

挂上新菜单后再刷一次勾选态，覆盖「构造 → 挂上」之间定时到期或设置面板改开关的窗口。

## 不变量

`keep_awake_active_key` 的结果必须命中 `KEEP_AWAKE_PRESETS` **恰好一项**：命中 0 项会
零勾，命中多项就是双勾。单测遍历 manual × 各类分钟数（含哨兵值与溢出值）验证这一点，
同时验证九项 ID 生成/解析往返与非法 ID 的兜底归类。

## 仍需人工确认的部分

原生托盘菜单的勾选由 Windows 绘制，单测覆盖不到视觉层。改完后应启动应用，右键托盘，
依次点「关闭 → 永久 → 30 分钟 → 关闭 → 自定义…」，每步重新打开菜单确认**恒有且仅有一个勾**。
