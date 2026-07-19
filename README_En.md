# Oh My Llama

[中文](README.md) | **English**

> Make launching and managing `llama-server` parameters effortless.

Oh My Llama is a desktop tool for centrally managing `llama-server` launch configurations, parameters, and logs. It supports multi-configuration switching, one-click command-line parsing, one-click parameter sharing, and real-time process control — so you can say goodbye to the pain of hand-assembling command lines.

---

![Oh My Llama Overview](public/overview.png)

## ✨ Highlights

### Multi-configuration switching

Switch between multiple configurations so you no longer have to dig through your notes for that pile of parameter presets — everything is managed in one place. Create, rename, delete, and save configurations with ease.

### One-click parameter import

Tired of other llama-server launchers presumptuously splitting every parameter into its own input box? Here you can paste all your parameters at once and let Oh My Llama parse them — known parameters are slotted into place, the launcher path is detected, and anything unrecognized is preserved as-is as a custom parameter.

### Configuration sharing

Oops, you've dialed in a fantastic set of parameters and want to share it with friends in the community right away. Oh My Llama happens to let you copy all launch parameters with a single click — a virtuous cycle. The copied command line is identical to the backend's launch logic, so the other person can just paste and run.

---

## 🚀 Quick Start

### Download

Head to [GitHub Releases](https://github.com/GDWhisper/oh-my-llama/releases) to download the latest installer.

---

## ⚙️ Configuration Storage

All configurations are persisted at:

```
%APPDATA%/OhMyLlama/configs.toml
```

Where `%APPDATA%` is typically:

```
C:\Users\<username>\AppData\Roaming
```

The configuration file uses the TOML format and contains the default configuration along with all named configurations.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Tauri 2](https://tauri.app/) |
| Frontend | React 19 + TypeScript + Vite |
| Backend | Rust |
| Config format | TOML |
| Process management | Native process management (with Job Object fallback) |

---

## 🤝 Contributing

Contributions of any kind are welcome. Please prefer raising requests or reporting issues through [Issues](https://github.com/GDWhisper/oh-my-llama/issues), and PRs are also welcome.

### Development Environment

**Requirements:**

- Node.js >= 18
- Rust >= 1.75 (installed via [rustup](https://rustup.rs/))
- Tauri CLI: `cargo install tauri-cli`

### Local Development

```bash
# Install dependencies
npm install

# Start the dev server (frontend port 6060)
npm run tauri dev
```

### Verification & Build

```bash
# Frontend type check + lint
npm run check:frontend

# Backend tests
cargo test --lib --manifest-path src-tauri/Cargo.toml

# Full check (frontend + backend)
npm run check

# Build
npm run tauri build
```

---

## 📄 License

[FSL-1.1-MIT](license.md)
