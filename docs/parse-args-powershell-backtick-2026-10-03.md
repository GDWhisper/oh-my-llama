# 一键传参粘贴：PowerShell 反引号续接符与位置参数归位（2026-10-03）

## 问题现象

「原始参数」卡片粘贴多行 `llama-server` 命令点【完成】后，解析预览里刷屏
「位置参数 → `」，`extra_args` 里填满孤立反引号；更糟的是行尾反引号会粘在
前一个 flag 上被当成它的取值（如 `--no-mmproj` 存成 `["--no-mmproj", "`"]`）。
启动命令里因此被塞入无意义 token。

实样：配置 `kvmenV2-Qwen3.8-27B-GSQ-RCO-IQ3_S-MTP-Q4XS-Q3S`
（`%APPDATA%/OhMyLlama/configs.toml`）。

## 根因

PowerShell 的多行命令用**行尾反引号 `` ` ``** 表示换行续接（等价于 Unix shell 的 `\`）。
`src/lib/parseArgs.ts` 的 `tokenize` 只剥离 `\`，反引号独立成 token 后落入
`positional` 分支，被当作自定义参数原样透传。

两个独立缺陷叠加：

1. **续接符剥离不完整**：正则 `/\\+$/` 只认反斜杠。反引号不仅自身污染，还会被
   后续 flag 的「吞下一个非 flag token 当值」逻辑吃进参数值。
2. **位置模型未归位**：llama-server 的位置参数即模型路径（与 `-m` 等价），
   但此前一律按 `positional` 进 `extra_args`，导致 `model` 字段为空。

## 修复要点（`src/lib/parseArgs.ts`）

| 项 | 做法 |
|---|---|
| 续接符 | `LINE_CONTINUATION = /[\\`]+$/`，覆盖 `\`、`` ` `` 与二者混排（tokenize 末尾统一 map） |
| 位置模型 | 模型文件后缀 + 此前未出现过模型 → 归位 `kind:'model'`（填 `model`/推导 `model_dir`） |
| 双模型 | 已出现过模型后再来模型文件 → 降级 `positional`；`buildPlan` 给它 `field:model` 身份，与 `-m` 重复即标黄 |
| 后缀真源 | `MODEL_FILE_RE` 由 `isExeToken` 内联正则抽出，供「排除反斜杠紧贴 exe 名」与「位置模型归位」共用 |

## 容易漏掉的边界

- **Windows 路径尾巴贴反引号**（`F:\AI\x.gguf`` ` ``）：只剥反斜杠/反引号尾部，
  路径中段的 `\` 不受影响（续接符只在末尾匹配）。
- **目录形式位置参数**：llama.cpp 支持传目录，无模型后缀 → 仍是 `positional` 照发。
- **仅续接符无真参数**：`llama-server` + 三个反引号 → 只剩 `exe` 行，无污染。
- **`llama-server.exe` 前置识别**在续接符剥离**之前**执行（`isExeToken`），
  `llama-server.exe` 紧跟反引号时若先剥会变成 `llama-server`，行为不同——
  当前顺序（先识别启动器再 map 剥尾）恰好两者皆可命中，无需改动。

## 既有污染数据的处置

`applyPlan` 对 `extra_args` 是**整份重算**（非追加），所以存量配置重新粘贴一次
干净命令、点【完成】即可自动覆盖掉反引号残留，无需手工清理。
