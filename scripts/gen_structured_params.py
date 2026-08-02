#!/usr/bin/env python3
# 生成结构化高级参数注册表（Rust 源）与 i18n 标签（复用 preview.* 中文名）。
# 仅用于开发期产出数据，不参与运行时。
import re
import io

# (key, canonical_flag, is_bool) —— 取自 src/lib/parseArgs.ts 的 FLAG_INFO known 条目。
PARAMS = [
    ("threads_batch", "--threads-batch", False),
    ("cpu_strict", "--cpu-strict", False),
    ("prio", "--prio", False),
    ("parallel", "--parallel", False),
    ("keep", "--keep", False),
    ("swa_full", "--swa-full", True),
    ("kv_offload", "--kv-offload", False),
    ("no_kv_offload", "--no-kv-offload", True),
    ("repack", "--repack", True),
    ("no_repack", "--no-repack", True),
    ("cache_type_k", "--cache-type-k", False),
    ("cache_type_v", "--cache-type-v", False),
    ("rope_scaling", "--rope-scaling", False),
    ("rope_scale", "--rope-scale", False),
    ("rope_freq_base", "--rope-freq-base", False),
    ("rope_freq_scale", "--rope-freq-scale", False),
    ("yarn_orig_ctx", "--yarn-orig-ctx", False),
    ("yarn_ext_factor", "--yarn-ext-factor", False),
    ("yarn_attn_factor", "--yarn-attn-factor", False),
    ("yarn_beta_slow", "--yarn-beta-slow", False),
    ("yarn_beta_fast", "--yarn-beta-fast", False),
    ("mmproj", "--mmproj", False),
    ("mmproj_url", "--mmproj-url", False),
    ("image_min_tokens", "--image-min-tokens", False),
    ("image_max_tokens", "--image-max-tokens", False),
    ("rpc", "--rpc", False),
    ("numa", "--numa", False),
    ("device", "--device", False),
    ("override_tensor", "--override-tensor", False),
    ("cpu_moe", "--cpu-moe", True),
    ("n_cpu_moe", "--n-cpu-moe", False),
    ("split_mode", "--split-mode", False),
    ("tensor_split", "--tensor-split", False),
    ("main_gpu", "--main-gpu", False),
    ("fit", "--fit", False),
    ("fit_target", "--fit-target", False),
    ("fit_ctx", "--fit-ctx", False),
    ("override_kv", "--override-kv", False),
    ("op_offload", "--op-offload", True),
    ("no_op_offload", "--no-op-offload", True),
    ("log_disable", "--log-disable", True),
    ("log_file", "--log-file", False),
    ("log_colors", "--log-colors", False),
    ("verbosity", "--verbosity", False),
    ("log_prefix", "--log-prefix", True),
    ("no_log_prefix", "--no-log-prefix", True),
    ("log_timestamps", "--log-timestamps", True),
    ("no_log_timestamps", "--no-log-timestamps", True),
    ("control_vector", "--control-vector", False),
    ("control_vector_scaled", "--control-vector-scaled", False),
    ("control_vector_layer_range", "--control-vector-layer-range", False),
    ("check_tensors", "--check-tensors", True),
    ("samplers", "--samplers", False),
    ("sampler_seq", "--sampler-seq", False),
    ("seed", "--seed", False),
    ("ignore_eos", "--ignore-eos", True),
    ("top_k", "--top-k", False),
    ("top_p", "--top-p", False),
    ("min_p", "--min-p", False),
    ("top_nsigma", "--top-nsigma", False),
    ("xtc_probability", "--xtc-probability", False),
    ("xtc_threshold", "--xtc-threshold", False),
    ("typical", "--typical", False),
    ("repeat_last_n", "--repeat-last-n", False),
    ("repeat_penalty", "--repeat-penalty", False),
    ("presence_penalty", "--presence-penalty", False),
    ("frequency_penalty", "--frequency-penalty", False),
    ("dry_multiplier", "--dry-multiplier", False),
    ("dry_base", "--dry-base", False),
    ("dry_allowed_length", "--dry-allowed-length", False),
    ("dry_penalty_last_n", "--dry-penalty-last-n", False),
    ("dry_sequence_breaker", "--dry-sequence-breaker", False),
    ("adaptive_target", "--adaptive-target", False),
    ("adaptive_decay", "--adaptive-decay", False),
    ("dynatemp_range", "--dynatemp-range", False),
    ("dynatemp_exp", "--dynatemp-exp", False),
    ("mirostat", "--mirostat", False),
    ("mirostat_lr", "--mirostat-lr", False),
    ("mirostat_ent", "--mirostat-ent", False),
    ("logit_bias", "--logit-bias", False),
    ("grammar", "--grammar", False),
    ("grammar_file", "--grammar-file", False),
    ("json_schema", "--json-schema", False),
    ("json_schema_file", "--json-schema-file", False),
    ("backend_sampling", "--backend-sampling", True),
    ("server_base", "--server-base", False),
    ("lookup_cache_static", "--lookup-cache-static", False),
    ("lookup_cache_dynamic", "--lookup-cache-dynamic", False),
    ("ctx_checkpoints", "--ctx-checkpoints", False),
    ("checkpoint_min_step", "--checkpoint-min-step", False),
    ("cache_ram", "--cache-ram", False),
    ("cache_idle_slots", "--cache-idle-slots", True),
    ("no_cache_idle_slots", "--no-cache-idle-slots", True),
    ("context_shift", "--context-shift", True),
    ("no_context_shift", "--no-context-shift", True),
    ("pooling", "--pooling", False),
    ("attention", "--attention", False),
    ("warmup", "--warmup", True),
    ("no_warmup", "--no-warmup", True),
    ("reverse_prompt", "--reverse-prompt", False),
    ("special", "--special", True),
    ("spm_infill", "--spm-infill", True),
    ("cont_batching", "--cont-batching", True),
    ("no_cont_batching", "--no-cont-batching", True),
    ("lora", "--lora", False),
    ("lora_scaled", "--lora-scaled", False),
    ("alias", "--alias", False),
    ("tags", "--tags", False),
    ("api_key", "--api-key", False),
    ("api_key_file", "--api-key-file", False),
    ("ssl_key_file", "--ssl-key-file", False),
    ("ssl_cert_file", "--ssl-cert-file", False),
    ("api_prefix", "--api-prefix", False),
    ("path", "--path", False),
    ("ui_config", "--ui-config", False),
    ("ui_config_file", "--ui-config-file", False),
    ("ui_mcp_proxy", "--ui-mcp-proxy", True),
    ("no_ui_mcp_proxy", "--no-ui-mcp-proxy", True),
    ("tools", "--tools", False),
    ("agent", "--agent", True),
    ("no_agent", "--no-agent", True),
    ("ui", "--ui", True),
    ("no_ui", "--no-ui", True),
    ("embedding", "--embedding", True),
    ("rerank", "--rerank", True),
    ("reuse_port", "--reuse-port", True),
    ("timeout", "-to", False),
    ("sse_ping_interval", "--sse-ping-interval", False),
    ("threads_http", "--threads-http", False),
    ("cache_prompt", "--cache-prompt", True),
    ("no_cache_prompt", "--no-cache-prompt", True),
    ("cache_reuse", "--cache-reuse", False),
    ("metrics", "--metrics", True),
    ("props", "--props", True),
    ("slots", "--slots", True),
    ("no_slots", "--no-slots", True),
    ("slot_save_path", "--slot-save-path", False),
    ("media_path", "--media-path", False),
    ("models_dir", "--models-dir", False),
    ("models_preset", "--models-preset", False),
    ("models_max", "--models-max", False),
    ("models_autoload", "--models-autoload", True),
    ("no_models_autoload", "--no-models-autoload", True),
    ("jinja", "--jinja", True),
    ("no_jinja", "--no-jinja", True),
    ("reasoning_format", "--reasoning-format", False),
    ("reasoning", "--reasoning", False),
    ("reasoning_budget", "--reasoning-budget", False),
    ("reasoning_budget_message", "--reasoning-budget-message", False),
    ("reasoning_preserve", "--reasoning-preserve", True),
    ("no_reasoning_preserve", "--no-reasoning-preserve", True),
    ("chat_template", "--chat-template", False),
    ("chat_template_file", "--chat-template-file", False),
    ("chat_template_kwargs", "--chat-template-kwargs", False),
    ("skip_chat_parsing", "--skip-chat-parsing", True),
    ("no_skip_chat_parsing", "--no-skip-chat-parsing", True),
    ("prefill_assistant", "--prefill-assistant", True),
    ("no_prefill_assistant", "--no-prefill-assistant", True),
    ("slot_prompt_similarity", "--slot-prompt-similarity", False),
    ("sleep_idle_seconds", "--sleep-idle-seconds", False),
    ("log_prompts_dir", "--log-prompts-dir", False),
    ("offline", "--offline", True),
]

# key -> ('int'|'float'|'enum', default) ；未列出的取值类按 str、默认 ""。
TYPE = {
    "seed": "int", "top_k": "int", "min_p": "float", "top_p": "float",
    "top_nsigma": "float", "xtc_probability": "float", "xtc_threshold": "float",
    "typical": "float", "repeat_last_n": "int", "repeat_penalty": "float",
    "presence_penalty": "float", "frequency_penalty": "float", "dry_multiplier": "float",
    "dry_base": "float", "dry_allowed_length": "int", "dry_penalty_last_n": "int",
    "adaptive_target": "float", "adaptive_decay": "float", "dynatemp_range": "float",
    "dynatemp_exp": "float", "mirostat": "int", "mirostat_lr": "float", "mirostat_ent": "float",
    "threads_batch": "int", "parallel": "int", "keep": "int", "main_gpu": "int",
    "n_cpu_moe": "int", "threads_http": "int", "cache_ram": "int", "checkpoint_min_step": "int",
    "ctx_checkpoints": "int", "rope_freq_base": "float", "rope_freq_scale": "float",
    "yarn_orig_ctx": "int", "yarn_ext_factor": "float", "yarn_attn_factor": "float",
    "yarn_beta_slow": "float", "yarn_beta_fast": "float", "fit": "float", "fit_target": "float",
    "fit_ctx": "int", "image_min_tokens": "int", "image_max_tokens": "int",
    "reasoning_budget": "int", "sleep_idle_seconds": "int", "models_max": "int",
    "sse_ping_interval": "int", "timeout": "int", "slot_prompt_similarity": "float",
    "verbosity": "int", "lookup_cache_static": "int", "lookup_cache_dynamic": "int",
    "cache_reuse": "int", "prio": "int", "split_mode": "enum", "pooling": "enum",
    "attention": "enum",
}
ENUM_CHOICES = {
    "split_mode": ["none", "layer", "row"],
    "pooling": ["none", "mean", "cls"],
    "attention": ["none", "sdqa"],
}
# 合理的 llama.cpp 默认值（仅当用户启用却未改时用作初值）。
DEFAULTS = {
    "top_p": "0.95", "top_k": "40", "min_p": "0.05", "repeat_penalty": "1.1",
    "repeat_last_n": "64", "presence_penalty": "0", "frequency_penalty": "0",
    "seed": "-1", "mirostat": "0", "mirostat_ent": "5.0", "mirostat_lr": "0.1",
    "parallel": "1", "keep": "0", "threads_batch": "0", "main_gpu": "0",
    "threads_http": "0", "cache_ram": "0", "checkpoint_min_step": "0",
    "ctx_checkpoints": "0", "rope_freq_base": "0", "rope_freq_scale": "0",
    "yarn_orig_ctx": "0", "yarn_ext_factor": "0", "yarn_attn_factor": "0",
    "yarn_beta_slow": "0", "yarn_beta_fast": "0", "fit": "0", "fit_target": "0",
    "fit_ctx": "0", "image_min_tokens": "0", "image_max_tokens": "0",
    "reasoning_budget": "0", "sleep_idle_seconds": "0", "models_max": "0",
    "sse_ping_interval": "0", "timeout": "0", "verbosity": "0",
    "lookup_cache_static": "0", "lookup_cache_dynamic": "0", "cache_reuse": "0",
    "prio": "0", "slot_prompt_similarity": "0", "dry_base": "0", "dry_multiplier": "0",
    "dry_allowed_length": "0", "dry_penalty_last_n": "0", "adaptive_target": "0",
    "adaptive_decay": "0", "dynatemp_range": "0", "dynatemp_exp": "0",
    "xtc_probability": "0", "xtc_threshold": "0", "typical": "0", "top_nsigma": "0",
    "n_cpu_moe": "0",
}


def rust_ptype(is_bool, key):
    if is_bool:
        return "Bool"
    return {"int": "Int", "float": "Float", "enum": "Enum", "str": "Str"}[
        TYPE.get(key, "str")
    ]


def rust_default(is_bool, key):
    if is_bool:
        return "false"
    t = TYPE.get(key, "str")
    if t == "int":
        return DEFAULTS.get(key, "0")
    if t == "float":
        return DEFAULTS.get(key, "0.0")
    if t == "enum":
        return ENUM_CHOICES[key][0]
    return ""


def rust_entry(key, flag, is_bool):
    ptype = rust_ptype(is_bool, key)
    default = rust_default(is_bool, key)
    if ptype == "Enum":
        choices = ", ".join(f'"{c}".into()' for c in ENUM_CHOICES[key])
        choices_str = f"Some(vec![{choices}])"
    else:
        choices_str = "None"
    return (
        f'    ParamSpec {{ key: "{key}", flag: "{flag}", ptype: ParamType::{ptype}, '
        f'default: "{default}", min: None, max: None, choices: {choices_str}, '
        f'enabled_by_default: false }},'
    )


# ── 生成 Rust params.rs ──
rust_header = '''use serde::{Deserialize, Serialize};

// 结构化高级参数注册表：数据驱动，单一真源在 Rust（默认值 + 序列化规则均在此）。
// 前端通过 get_param_registry 命令拉取同一份元数据，通用渲染控件，无需为每个参数写硬编码 UI。
// 新增官方参数只需在此表加一行 + 在 src/i18n/messages.ts 补 advanced.structured.<key> 文案。

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ParamType {
    Int,
    Float,
    Bool,
    Str,
    Enum,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamSpec {
    pub key: String,
    pub flag: String,
    #[serde(rename = "type")]
    pub ptype: ParamType,
    pub default: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
    pub enabled_by_default: bool,
}

pub const PARAM_REGISTRY: &[ParamSpec] = &[
'''
rust_entries = "\n".join(rust_entry(k, f, b) for (k, f, b) in PARAMS)
rust_footer = """
];

// 供前端渲染用的注册表快照（含类型/默认值/候选项），与 PARAM_REGISTRY 同源。
#[tauri::command]
pub fn get_param_registry() -> Vec<ParamSpec> {
    PARAM_REGISTRY.to_vec()
}
"""
rust_src = rust_header + rust_entries + rust_footer

with open("src-tauri/src/params.rs", "w", encoding="utf-8") as fh:
    fh.write(rust_src)
print(f"wrote src-tauri/src/params.rs ({len(PARAMS)} params)")


# ── 更新 i18n：在 zh / en 各插入 advanced.structured.<key> 区块（复用 preview.* 文案去 " → {value}"）──
def strip_label(s: str) -> str:
    return s.replace(" → {value}", "").strip()


def parse_preview(block: str) -> "dict[str, str]":
    out = {}
    for m in re.finditer(r"'preview\.([a-z_]+)':\s*'(.*?)',", block):
        out[m.group(1)] = m.group(2)
    return out


def build_block(preview: "dict[str, str]") -> str:
    lines = ["  // 结构化高级参数标签（由注册表渲染；文案复用 preview.* 去取值后缀）"]
    for (k, _f, _b) in PARAMS:
        if k not in preview:
            continue
        label = strip_label(preview[k]).replace("'", "\\'")
        if label == "":
            label = k
        lines.append(f"  'advanced.structured.{k}': '{label}',")
    return "\n".join(lines)


def insert_after_mlock(text: str, block: str) -> str:
    marker = "'advanced.label.mlock': 'mlock',"
    idx = text.find(marker)
    if idx == -1:
        raise RuntimeError("advanced.label.mlock marker not found")
    end = text.find("\n", idx)
    return text[: end + 1] + "\n" + block + "\n" + text[end + 1 :]


with open("src/i18n/messages.ts", "r", encoding="utf-8") as fh:
    content = fh.read()

if "advanced.structured." in content:
    print("i18n advanced.structured already present, skip")
else:
    en_idx = content.find("export const en")
    zh_part = content[:en_idx]
    en_part = content[en_idx:]
    zh_preview = parse_preview(zh_part)
    en_preview = parse_preview(en_part)
    zh_block = build_block(zh_preview)
    en_block = build_block(en_preview)
    new = insert_after_mlock(zh_part, zh_block)
    # re-find en marker in the en_part (already contains it)
    en_part2 = insert_after_mlock(en_part, en_block)
    content = new + en_part2
    with open("src/i18n/messages.ts", "w", encoding="utf-8") as fh:
        fh.write(content)
    print("updated src/i18n/messages.ts with advanced.structured labels")
