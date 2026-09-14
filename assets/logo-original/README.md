# Logo 原风格备份

这是暖纸 UI 改造前、以及后续误改之前的**原始品牌图标快照**（取自 git HEAD）。

- 唯一真相源（改 logo 只改这里）：`src-tauri/app-icon.svg`
- 重新生成任务栏/托盘 PNG·ICO 与标题栏用 SVG：仓库根目录执行  
  `python scripts/gen_app_icons.py`
- 标题栏引用生成物：`public/oml-logo.svg`（25px = 母版 25 格 1:1）
- 本目录仅供对照/回滚，**不要**被构建脚本直接引用。
