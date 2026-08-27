本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

### 新增功能
- HuggingFace / 推测解码参数识别（一键传参）：粘贴含 HuggingFace 仓库（--hf / --hfd）或推测解码（--spec-draft 等）的命令行，一键传参现在能正确识别并归类，并剥离多行命令的行续接符，不再解析错位。

### 功能优化
- 性能卡片 GPU 单行显示：GPU 型号、显存、温度合并到同一行，窄栏可读性更好。

### Bug 修复
- 日志实时推送：改用伪终端（PTY）启动 llama-server，根治「原生日志直到进程退出才一次性涌出」的块缓冲问题；同时修复 ConPTY 生命周期导致的启动即崩溃，并消除 React StrictMode 双挂载下的日志双份。

> 详细改动参考 CHANGELOG
