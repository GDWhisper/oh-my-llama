import type { ParamSpec, ServerConfig } from '../types';
import type { AdvancedKey } from './advanced';
import type { MessageKey, Translator } from '../i18n/messages';

// 解析「一键传参」文本框里用户粘贴的 llama-server 命令行，产出可直接套用到
// 配置的补丁（已知 flag 映射到高级参数）+ 自定义参数（未知 flag 原样进入启动命令）。
// 这样用户粘贴的完整命令行，与真正启动时发出的命令行保持一致。

export interface ParsedArg {
  // '' 表示位置参数（无 flag）
  flag: string;
  kind: 'value' | 'bool' | 'model' | 'unknown' | 'positional' | 'exe' | 'ignore' | 'known';
  field?: keyof ServerConfig;
  key?: AdvancedKey;
  boolValue?: boolean;
  value: string | null;
  // 仅 'known' 类使用：指向 i18n 的友好预览文案键（如 'preview.top_p'），
  // 用于在「解析预览」中显示可读名而非裸 flag。
  labelKey?: MessageKey;
}

interface FlagInfo {
  kind: 'value' | 'bool' | 'model' | 'ignore' | 'known';
  key?: AdvancedKey;
  field?: keyof ServerConfig;
  boolValue?: boolean;
  // 'known' 类：i18n 友好预览文案键。
  labelKey?: MessageKey;
  // 'known' 类是否带取值（false = 纯布尔开关，不吞掉下一个 token）。
  takesValue?: boolean;
}

// 已知 flag → 配置字段的映射。'value'/'bool'/'model' 三类映射到结构化配置；
// 'known' 类为「已识别但走自定义参数原样转发」的 llama-server flag（含常见采样/推理/服务参数），
// 在「解析预览」里显示友好文案、但仍原样进入 extra_args（不新增配置字段）。
// 不在表中的 flag 一律当作未知参数，原样进入 extra_args。
const FLAG_INFO: Record<string, FlagInfo> = {
  '-h': { kind: 'value', field: 'host' },
  '--host': { kind: 'value', field: 'host' },
  '-p': { kind: 'value', field: 'port' },
  '--port': { kind: 'value', field: 'port' },
  '-c': { kind: 'value', key: 'ctx_size', field: 'ctx_size' },
  '--ctx-size': { kind: 'value', key: 'ctx_size', field: 'ctx_size' },
  '-n': { kind: 'value', key: 'n_predict', field: 'n_predict' },
  '--n-predict': { kind: 'value', key: 'n_predict', field: 'n_predict' },
  '-ngl': { kind: 'value', key: 'n_gpu_layers', field: 'n_gpu_layers' },
  '--n-gpu-layers': { kind: 'value', key: 'n_gpu_layers', field: 'n_gpu_layers' },
  '-t': { kind: 'value', key: 'threads', field: 'threads' },
  '--threads': { kind: 'value', key: 'threads', field: 'threads' },
  '-b': { kind: 'value', key: 'batch_size', field: 'batch_size' },
  '--batch-size': { kind: 'value', key: 'batch_size', field: 'batch_size' },
  '--temp': { kind: 'value', key: 'temp', field: 'temp' },
  '--flash-attn': { kind: 'value', key: 'flash_attn', field: 'flash_attn' },
  '--mmap': { kind: 'bool', key: 'mmap', field: 'mmap', boolValue: true },
  '--no-mmap': { kind: 'bool', key: 'mmap', field: 'mmap', boolValue: false },
  '--mlock': { kind: 'bool', key: 'mlock', field: 'mlock', boolValue: true },
  '-m': { kind: 'model', field: 'model' },
  '--model': { kind: 'model', field: 'model' },
  // 启动器内部常量（由 build_server_args 自动追加）：识别但忽略，不进 patch / extra_args，
  // 且会吞掉其后的取值 token，避免回写时污染自定义参数。
  '--timeout': { kind: 'ignore' },

  // ── 已识别的 llama-server 参数（kind:'known'，友好预览 + 原样转发）────────
  // 通用（common）
  '-tb': { kind: 'known', labelKey: 'preview.threads_batch' },
  '--threads-batch': { kind: 'known', labelKey: 'preview.threads_batch' },
  '--cpu-strict': { kind: 'known', labelKey: 'preview.cpu_strict' },
  '--prio': { kind: 'known', labelKey: 'preview.prio' },
  '-np': { kind: 'known', labelKey: 'preview.parallel' },
  '--parallel': { kind: 'known', labelKey: 'preview.parallel' },
  '--keep': { kind: 'known', labelKey: 'preview.keep' },
  '--swa-full': { kind: 'known', labelKey: 'preview.swa_full', takesValue: false },
  '-kvo': { kind: 'known', labelKey: 'preview.kv_offload' },
  '--kv-offload': { kind: 'known', labelKey: 'preview.kv_offload' },
  '-nkvo': { kind: 'known', labelKey: 'preview.no_kv_offload', takesValue: false },
  '--no-kv-offload': { kind: 'known', labelKey: 'preview.no_kv_offload', takesValue: false },
  '--repack': { kind: 'known', labelKey: 'preview.repack', takesValue: false },
  '-nr': { kind: 'known', labelKey: 'preview.no_repack', takesValue: false },
  '--no-repack': { kind: 'known', labelKey: 'preview.no_repack', takesValue: false },
  '-ctk': { kind: 'known', labelKey: 'preview.cache_type_k' },
  '--cache-type-k': { kind: 'known', labelKey: 'preview.cache_type_k' },
  '-ctv': { kind: 'known', labelKey: 'preview.cache_type_v' },
  '--cache-type-v': { kind: 'known', labelKey: 'preview.cache_type_v' },
  '--rope-scaling': { kind: 'known', labelKey: 'preview.rope_scaling' },
  '--rope-scale': { kind: 'known', labelKey: 'preview.rope_scale' },
  '--rope-freq-base': { kind: 'known', labelKey: 'preview.rope_freq_base' },
  '--rope-freq-scale': { kind: 'known', labelKey: 'preview.rope_freq_scale' },
  '--yarn-orig-ctx': { kind: 'known', labelKey: 'preview.yarn_orig_ctx' },
  '--yarn-ext-factor': { kind: 'known', labelKey: 'preview.yarn_ext_factor' },
  '--yarn-attn-factor': { kind: 'known', labelKey: 'preview.yarn_attn_factor' },
  '--yarn-beta-slow': { kind: 'known', labelKey: 'preview.yarn_beta_slow' },
  '--yarn-beta-fast': { kind: 'known', labelKey: 'preview.yarn_beta_fast' },
  '-mm': { kind: 'known', labelKey: 'preview.mmproj' },
  '--mmproj': { kind: 'known', labelKey: 'preview.mmproj' },
  '-mmu': { kind: 'known', labelKey: 'preview.mmproj_url' },
  '--mmproj-url': { kind: 'known', labelKey: 'preview.mmproj_url' },
  '--image-min-tokens': { kind: 'known', labelKey: 'preview.image_min_tokens' },
  '--image-max-tokens': { kind: 'known', labelKey: 'preview.image_max_tokens' },
  '--rpc': { kind: 'known', labelKey: 'preview.rpc' },
  '--numa': { kind: 'known', labelKey: 'preview.numa' },
  '-dev': { kind: 'known', labelKey: 'preview.device' },
  '--device': { kind: 'known', labelKey: 'preview.device' },
  '-ot': { kind: 'known', labelKey: 'preview.override_tensor' },
  '--override-tensor': { kind: 'known', labelKey: 'preview.override_tensor' },
  '-cmoe': { kind: 'known', labelKey: 'preview.cpu_moe', takesValue: false },
  '--cpu-moe': { kind: 'known', labelKey: 'preview.cpu_moe', takesValue: false },
  '-ncmoe': { kind: 'known', labelKey: 'preview.n_cpu_moe' },
  '--n-cpu-moe': { kind: 'known', labelKey: 'preview.n_cpu_moe' },
  '-sm': { kind: 'known', labelKey: 'preview.split_mode' },
  '--split-mode': { kind: 'known', labelKey: 'preview.split_mode' },
  '-ts': { kind: 'known', labelKey: 'preview.tensor_split' },
  '--tensor-split': { kind: 'known', labelKey: 'preview.tensor_split' },
  '-mg': { kind: 'known', labelKey: 'preview.main_gpu' },
  '--main-gpu': { kind: 'known', labelKey: 'preview.main_gpu' },
  '-fit': { kind: 'known', labelKey: 'preview.fit' },
  '--fit': { kind: 'known', labelKey: 'preview.fit' },
  '-fitt': { kind: 'known', labelKey: 'preview.fit_target' },
  '--fit-target': { kind: 'known', labelKey: 'preview.fit_target' },
  '-fitc': { kind: 'known', labelKey: 'preview.fit_ctx' },
  '--fit-ctx': { kind: 'known', labelKey: 'preview.fit_ctx' },
  '--override-kv': { kind: 'known', labelKey: 'preview.override_kv' },
  '--op-offload': { kind: 'known', labelKey: 'preview.op_offload', takesValue: false },
  '--no-op-offload': { kind: 'known', labelKey: 'preview.no_op_offload', takesValue: false },
  '--log-disable': { kind: 'known', labelKey: 'preview.log_disable', takesValue: false },
  '--log-file': { kind: 'known', labelKey: 'preview.log_file' },
  '--log-colors': { kind: 'known', labelKey: 'preview.log_colors' },
  '-lv': { kind: 'known', labelKey: 'preview.verbosity' },
  '--verbosity': { kind: 'known', labelKey: 'preview.verbosity' },
  '--log-verbosity': { kind: 'known', labelKey: 'preview.verbosity' },
  '--log-prefix': { kind: 'known', labelKey: 'preview.log_prefix', takesValue: false },
  '--no-log-prefix': { kind: 'known', labelKey: 'preview.no_log_prefix', takesValue: false },
  '--log-timestamps': { kind: 'known', labelKey: 'preview.log_timestamps', takesValue: false },
  '--no-log-timestamps': {
    kind: 'known',
    labelKey: 'preview.no_log_timestamps',
    takesValue: false,
  },
  '--control-vector': { kind: 'known', labelKey: 'preview.control_vector' },
  '--control-vector-scaled': { kind: 'known', labelKey: 'preview.control_vector_scaled' },
  '--control-vector-layer-range': { kind: 'known', labelKey: 'preview.control_vector_layer_range' },
  '--check-tensors': { kind: 'known', labelKey: 'preview.check_tensors', takesValue: false },

  // 采样（sampling）
  '--samplers': { kind: 'known', labelKey: 'preview.samplers' },
  '--sampler-seq': { kind: 'known', labelKey: 'preview.sampler_seq' },
  '--sampling-seq': { kind: 'known', labelKey: 'preview.sampler_seq' },
  '-s': { kind: 'known', labelKey: 'preview.seed' },
  '--seed': { kind: 'known', labelKey: 'preview.seed' },
  '--ignore-eos': { kind: 'known', labelKey: 'preview.ignore_eos', takesValue: false },
  '--top-k': { kind: 'known', labelKey: 'preview.top_k' },
  '--top-p': { kind: 'known', labelKey: 'preview.top_p' },
  '--min-p': { kind: 'known', labelKey: 'preview.min_p' },
  '--top-nsigma': { kind: 'known', labelKey: 'preview.top_nsigma' },
  '--top-n-sigma': { kind: 'known', labelKey: 'preview.top_nsigma' },
  '--xtc-probability': { kind: 'known', labelKey: 'preview.xtc_probability' },
  '--xtc-threshold': { kind: 'known', labelKey: 'preview.xtc_threshold' },
  '--typical': { kind: 'known', labelKey: 'preview.typical' },
  '--typical-p': { kind: 'known', labelKey: 'preview.typical' },
  '--repeat-last-n': { kind: 'known', labelKey: 'preview.repeat_last_n' },
  '--repeat-penalty': { kind: 'known', labelKey: 'preview.repeat_penalty' },
  '--presence-penalty': { kind: 'known', labelKey: 'preview.presence_penalty' },
  '--frequency-penalty': { kind: 'known', labelKey: 'preview.frequency_penalty' },
  '--dry-multiplier': { kind: 'known', labelKey: 'preview.dry_multiplier' },
  '--dry-base': { kind: 'known', labelKey: 'preview.dry_base' },
  '--dry-allowed-length': { kind: 'known', labelKey: 'preview.dry_allowed_length' },
  '--dry-penalty-last-n': { kind: 'known', labelKey: 'preview.dry_penalty_last_n' },
  '--dry-sequence-breaker': { kind: 'known', labelKey: 'preview.dry_sequence_breaker' },
  '--adaptive-target': { kind: 'known', labelKey: 'preview.adaptive_target' },
  '--adaptive-decay': { kind: 'known', labelKey: 'preview.adaptive_decay' },
  '--dynatemp-range': { kind: 'known', labelKey: 'preview.dynatemp_range' },
  '--dynatemp-exp': { kind: 'known', labelKey: 'preview.dynatemp_exp' },
  '--mirostat': { kind: 'known', labelKey: 'preview.mirostat' },
  '--mirostat-lr': { kind: 'known', labelKey: 'preview.mirostat_lr' },
  '--mirostat-ent': { kind: 'known', labelKey: 'preview.mirostat_ent' },
  '-l': { kind: 'known', labelKey: 'preview.logit_bias' },
  '--logit-bias': { kind: 'known', labelKey: 'preview.logit_bias' },
  '--grammar': { kind: 'known', labelKey: 'preview.grammar' },
  '--grammar-file': { kind: 'known', labelKey: 'preview.grammar_file' },
  '-j': { kind: 'known', labelKey: 'preview.json_schema' },
  '--json-schema': { kind: 'known', labelKey: 'preview.json_schema' },
  '-jf': { kind: 'known', labelKey: 'preview.json_schema_file' },
  '--json-schema-file': { kind: 'known', labelKey: 'preview.json_schema_file' },
  '-bs': { kind: 'known', labelKey: 'preview.backend_sampling', takesValue: false },
  '--backend-sampling': { kind: 'known', labelKey: 'preview.backend_sampling', takesValue: false },

  // 服务专属（server-specific，剔除 speculative/download/finetune/perplexity/bench 等不适用的）
  '--server-base': { kind: 'known', labelKey: 'preview.server_base' },
  '-lcs': { kind: 'known', labelKey: 'preview.lookup_cache_static' },
  '--lookup-cache-static': { kind: 'known', labelKey: 'preview.lookup_cache_static' },
  '-lcd': { kind: 'known', labelKey: 'preview.lookup_cache_dynamic' },
  '--lookup-cache-dynamic': { kind: 'known', labelKey: 'preview.lookup_cache_dynamic' },
  '-ctxcp': { kind: 'known', labelKey: 'preview.ctx_checkpoints' },
  '--ctx-checkpoints': { kind: 'known', labelKey: 'preview.ctx_checkpoints' },
  '--swa-checkpoints': { kind: 'known', labelKey: 'preview.ctx_checkpoints' },
  '-cms': { kind: 'known', labelKey: 'preview.checkpoint_min_step' },
  '--checkpoint-min-step': { kind: 'known', labelKey: 'preview.checkpoint_min_step' },
  '-cram': { kind: 'known', labelKey: 'preview.cache_ram' },
  '--cache-ram': { kind: 'known', labelKey: 'preview.cache_ram' },
  '--cache-idle-slots': { kind: 'known', labelKey: 'preview.cache_idle_slots', takesValue: false },
  '--no-cache-idle-slots': {
    kind: 'known',
    labelKey: 'preview.no_cache_idle_slots',
    takesValue: false,
  },
  '--context-shift': { kind: 'known', labelKey: 'preview.context_shift', takesValue: false },
  '--no-context-shift': { kind: 'known', labelKey: 'preview.no_context_shift', takesValue: false },
  '--pooling': { kind: 'known', labelKey: 'preview.pooling' },
  '--attention': { kind: 'known', labelKey: 'preview.attention' },
  '--warmup': { kind: 'known', labelKey: 'preview.warmup', takesValue: false },
  '--no-warmup': { kind: 'known', labelKey: 'preview.no_warmup', takesValue: false },
  '-r': { kind: 'known', labelKey: 'preview.reverse_prompt' },
  '--reverse-prompt': { kind: 'known', labelKey: 'preview.reverse_prompt' },
  '-sp': { kind: 'known', labelKey: 'preview.special', takesValue: false },
  '--special': { kind: 'known', labelKey: 'preview.special', takesValue: false },
  '--spm-infill': { kind: 'known', labelKey: 'preview.spm_infill', takesValue: false },
  '-cb': { kind: 'known', labelKey: 'preview.cont_batching', takesValue: false },
  '--cont-batching': { kind: 'known', labelKey: 'preview.cont_batching', takesValue: false },
  '-nocb': { kind: 'known', labelKey: 'preview.no_cont_batching', takesValue: false },
  '--no-cont-batching': { kind: 'known', labelKey: 'preview.no_cont_batching', takesValue: false },
  '--lora': { kind: 'known', labelKey: 'preview.lora' },
  '--lora-scaled': { kind: 'known', labelKey: 'preview.lora_scaled' },
  '-a': { kind: 'known', labelKey: 'preview.alias' },
  '--alias': { kind: 'known', labelKey: 'preview.alias' },
  '--tags': { kind: 'known', labelKey: 'preview.tags' },
  '--api-key': { kind: 'known', labelKey: 'preview.api_key' },
  '--api-key-file': { kind: 'known', labelKey: 'preview.api_key_file' },
  '--ssl-key-file': { kind: 'known', labelKey: 'preview.ssl_key_file' },
  '--ssl-cert-file': { kind: 'known', labelKey: 'preview.ssl_cert_file' },
  '--api-prefix': { kind: 'known', labelKey: 'preview.api_prefix' },
  '--path': { kind: 'known', labelKey: 'preview.path' },
  '--ui-config': { kind: 'known', labelKey: 'preview.ui_config' },
  '--webui-config': { kind: 'known', labelKey: 'preview.ui_config' },
  '--ui-config-file': { kind: 'known', labelKey: 'preview.ui_config_file' },
  '--webui-config-file': { kind: 'known', labelKey: 'preview.ui_config_file' },
  '--ui-mcp-proxy': { kind: 'known', labelKey: 'preview.ui_mcp_proxy', takesValue: false },
  '--webui-mcp-proxy': { kind: 'known', labelKey: 'preview.ui_mcp_proxy', takesValue: false },
  '--no-ui-mcp-proxy': { kind: 'known', labelKey: 'preview.no_ui_mcp_proxy', takesValue: false },
  '--no-webui-mcp-proxy': { kind: 'known', labelKey: 'preview.no_ui_mcp_proxy', takesValue: false },
  '--tools': { kind: 'known', labelKey: 'preview.tools' },
  '-ag': { kind: 'known', labelKey: 'preview.agent', takesValue: false },
  '--agent': { kind: 'known', labelKey: 'preview.agent', takesValue: false },
  '-no-ag': { kind: 'known', labelKey: 'preview.no_agent', takesValue: false },
  '--no-agent': { kind: 'known', labelKey: 'preview.no_agent', takesValue: false },
  '--ui': { kind: 'known', labelKey: 'preview.ui', takesValue: false },
  '--webui': { kind: 'known', labelKey: 'preview.ui', takesValue: false },
  '--no-ui': { kind: 'known', labelKey: 'preview.no_ui', takesValue: false },
  '--no-webui': { kind: 'known', labelKey: 'preview.no_ui', takesValue: false },
  '--embedding': { kind: 'known', labelKey: 'preview.embedding', takesValue: false },
  '--embeddings': { kind: 'known', labelKey: 'preview.embedding', takesValue: false },
  '--rerank': { kind: 'known', labelKey: 'preview.rerank', takesValue: false },
  '--reranking': { kind: 'known', labelKey: 'preview.rerank', takesValue: false },
  '--reuse-port': { kind: 'known', labelKey: 'preview.reuse_port', takesValue: false },
  '-to': { kind: 'known', labelKey: 'preview.timeout' },
  '--sse-ping-interval': { kind: 'known', labelKey: 'preview.sse_ping_interval' },
  '--threads-http': { kind: 'known', labelKey: 'preview.threads_http' },
  '--cache-prompt': { kind: 'known', labelKey: 'preview.cache_prompt', takesValue: false },
  '--no-cache-prompt': { kind: 'known', labelKey: 'preview.no_cache_prompt', takesValue: false },
  '--cache-reuse': { kind: 'known', labelKey: 'preview.cache_reuse' },
  '--metrics': { kind: 'known', labelKey: 'preview.metrics', takesValue: false },
  '--props': { kind: 'known', labelKey: 'preview.props', takesValue: false },
  '--slots': { kind: 'known', labelKey: 'preview.slots', takesValue: false },
  '--no-slots': { kind: 'known', labelKey: 'preview.no_slots', takesValue: false },
  '--slot-save-path': { kind: 'known', labelKey: 'preview.slot_save_path' },
  '--media-path': { kind: 'known', labelKey: 'preview.media_path' },
  '--models-dir': { kind: 'known', labelKey: 'preview.models_dir' },
  '--models-preset': { kind: 'known', labelKey: 'preview.models_preset' },
  '--models-max': { kind: 'known', labelKey: 'preview.models_max' },
  '--models-autoload': { kind: 'known', labelKey: 'preview.models_autoload', takesValue: false },
  '--no-models-autoload': {
    kind: 'known',
    labelKey: 'preview.no_models_autoload',
    takesValue: false,
  },
  '--jinja': { kind: 'known', labelKey: 'preview.jinja', takesValue: false },
  '--no-jinja': { kind: 'known', labelKey: 'preview.no_jinja', takesValue: false },
  '--reasoning-format': { kind: 'known', labelKey: 'preview.reasoning_format' },
  '-rea': { kind: 'known', labelKey: 'preview.reasoning' },
  '--reasoning': { kind: 'known', labelKey: 'preview.reasoning' },
  '--reasoning-budget': { kind: 'known', labelKey: 'preview.reasoning_budget' },
  '--reasoning-budget-message': { kind: 'known', labelKey: 'preview.reasoning_budget_message' },
  '--reasoning-preserve': {
    kind: 'known',
    labelKey: 'preview.reasoning_preserve',
    takesValue: false,
  },
  '--no-reasoning-preserve': {
    kind: 'known',
    labelKey: 'preview.no_reasoning_preserve',
    takesValue: false,
  },
  '--chat-template': { kind: 'known', labelKey: 'preview.chat_template' },
  '--chat-template-file': { kind: 'known', labelKey: 'preview.chat_template_file' },
  '--chat-template-kwargs': { kind: 'known', labelKey: 'preview.chat_template_kwargs' },
  '--skip-chat-parsing': {
    kind: 'known',
    labelKey: 'preview.skip_chat_parsing',
    takesValue: false,
  },
  '--no-skip-chat-parsing': {
    kind: 'known',
    labelKey: 'preview.no_skip_chat_parsing',
    takesValue: false,
  },
  '--prefill-assistant': {
    kind: 'known',
    labelKey: 'preview.prefill_assistant',
    takesValue: false,
  },
  '--no-prefill-assistant': {
    kind: 'known',
    labelKey: 'preview.no_prefill_assistant',
    takesValue: false,
  },
  '-sps': { kind: 'known', labelKey: 'preview.slot_prompt_similarity' },
  '--slot-prompt-similarity': { kind: 'known', labelKey: 'preview.slot_prompt_similarity' },
  '--sleep-idle-seconds': { kind: 'known', labelKey: 'preview.sleep_idle_seconds' },
  '--log-prompts-dir': { kind: 'known', labelKey: 'preview.log_prompts_dir' },
  '--offline': { kind: 'known', labelKey: 'preview.offline', takesValue: false },
};

// 引号感知的分词：双引号/单引号内的空格视为值的一部分；引号本身被剥离。
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// 判断某个非 flag token 是否为「llama-server 启动器」本体：
// - 以 .exe 结尾（Windows 最常见，含绝对路径如 F:\llama-turbo\llama-server.exe）；
// - 或裸名为 llama-server（类 Unix 无扩展名），但需排除形如 llama-server-model.gguf 的模型文件。
function isExeToken(tok: string): boolean {
  if (/\.exe$/i.test(tok)) return true;
  if (/llama-server/i.test(tok) && !/\.(gguf|bin|safetensors|pth|pt|ggml)$/i.test(tok)) return true;
  return false;
}

export function parseLlamaArgs(input: string): ParsedArg[] {
  const tokens = tokenize(input);
  const out: ParsedArg[] = [];
  let firstToken = true;
  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    // 开头的启动器路径（如 llama-server.exe / 绝对路径）：识别为启动器本体，
    // 捕获进 llama_server_path，而非当成未知参数丢弃。
    if (firstToken && !tok.startsWith('-') && isExeToken(tok)) {
      out.push({ flag: '', kind: 'exe', field: 'llama_server_path', value: tok });
      firstToken = false;
      continue;
    }
    firstToken = false;

    if (tok.startsWith('-')) {
      let value: string | null = null;
      // 支持 --flag=value 内联写法
      const eq = tok.indexOf('=');
      if (eq > 0) {
        value = tok.slice(eq + 1);
        tok = tok.slice(0, eq);
      }
      const info = FLAG_INFO[tok];
      if (info) {
        // 启动器内部常量（如 --timeout）：识别但忽略；仍需吞掉其后的取值 token
        // （--flag value 形式），否则会被误判为位置参数进入 extra_args。
        if (info.kind === 'ignore') {
          if (value === null && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
            i++;
          }
          out.push({ flag: tok, kind: 'ignore', value: null });
          continue;
        }
        if (info.kind === 'known') {
          // 已识别但走自定义参数的 flag：按 takesValue 决定是否吞掉下一个取值 token；
          // 纯布尔开关（takesValue:false）不吞值，避免误吃后续参数。
          const takesValue = info.takesValue ?? true;
          if (
            takesValue &&
            value === null &&
            i + 1 < tokens.length &&
            !tokens[i + 1].startsWith('-')
          ) {
            value = tokens[i + 1];
            i++;
          }
          out.push({
            flag: tok,
            kind: 'known',
            labelKey: info.labelKey,
            value: takesValue ? value : null,
          });
          continue;
        }
        if (info.kind === 'bool') {
          out.push({
            flag: tok,
            kind: 'bool',
            field: info.field,
            key: info.key,
            boolValue: info.boolValue,
            value: null,
          });
          continue;
        }
        // 内联没给值时，若下一个 token 不是 flag 则吞掉作为值
        if (value === null && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
          value = tokens[i + 1];
          i++;
        }
        out.push({ flag: tok, kind: info.kind, field: info.field, key: info.key, value });
      } else {
        if (value === null && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
          value = tokens[i + 1];
          i++;
        }
        out.push({ flag: tok, kind: 'unknown', value });
      }
    } else {
      out.push({ flag: '', kind: 'positional', value: tok });
    }
  }
  return out;
}

export interface PreviewRow {
  text: string;
  custom: boolean; // 是否走自定义参数（extra_args）
}

export interface ApplyPlan {
  // 直接套用到 config 的补丁（已知 flag）
  patch: Partial<ServerConfig>;
  // 需要启用的高级参数键
  enable: AdvancedKey[];
  // 扁平存储的自定义参数：[flag, value?, flag, value?, ...]，无值时用 '' 占位
  extraArgs: string[];
  // 命中注册表的官方参数：键 → 字符串值（类型由注册表声明，写入时统一存字符串）
  structured: Record<string, string>;
  // 需要启用（显示为独立卡片）的结构化参数键，保持出现顺序
  enableStructured: string[];
  // 供 UI 预览展示，确认前让用户核对
  rows: PreviewRow[];
}

// 'preview.top_p' → 'top_p'：FLAG_INFO 里 known 项的 labelKey 后缀即注册表主键，
// 因此无需给 160+ 条识别项各补一个 key 字段（同一事实只维护一处，避免双份表漂移）。
const PREVIEW_PREFIX = 'preview.';
const structuredKeyOf = (labelKey?: MessageKey): string | undefined =>
  labelKey && labelKey.startsWith(PREVIEW_PREFIX)
    ? labelKey.slice(PREVIEW_PREFIX.length)
    : undefined;

const TRUTHY = new Set(['true', '1', 'on', 'yes']);

// 按注册表声明把「参数键 + 用户值」还原成命令行片段。
// 必须与 Rust 侧 params::ParamSpec::to_args 保持同一语义：
// bool 只在真值时输出裸 flag，其余类型空值视为未设置。改动其一务必同步另一侧。
export function structuredToArgs(spec: ParamSpec, raw: string | undefined): string[] {
  const value = (raw ?? '').trim();
  if (spec.type === 'bool') {
    return TRUTHY.has(value.toLowerCase()) ? [spec.flag] : [];
  }
  return value === '' ? [] : [spec.flag, value];
}

// 解析出的原始 token → 注册表声明下的存储值（bool 型的裸 flag 记为 'true'）。
const structuredValueOf = (spec: ParamSpec, raw: string | null): string => {
  if (spec.type === 'bool') {
    const v = (raw ?? '').trim().toLowerCase();
    // 裸 flag（无取值）即表示开启；显式给了 0/false 时尊重用户意图。
    return v === '' ? 'true' : TRUTHY.has(v) ? 'true' : 'false';
  }
  return (raw ?? '').trim();
};

const toInt = (v: string | null): number | null => {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const toFloat = (v: string | null): number | null => {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// 把解析出的参数整理成「套用计划」：已知 flag 落入对应字段并启用高级键；
// 未知 / 位置参数原样进 extra_args；rows 供确认前的预览。
// 预览行文案走 i18n：调用方传入 t（翻译函数），本函数只负责组织数据与拼装 key。
export function buildPlan(args: ParsedArg[], t: Translator, registry: ParamSpec[]): ApplyPlan {
  const patch: Partial<ServerConfig> = {};
  const enableSet = new Set<AdvancedKey>();
  const extraArgs: string[] = [];
  const structured: Record<string, string> = {};
  const enableStructuredSet = new Set<string>();
  const rows: PreviewRow[] = [];
  const specByKey = new Map(registry.map((spec) => [spec.key, spec]));

  for (const arg of args) {
    // 启动器内部常量：识别时已忽略，回写不会污染配置，直接跳过。
    if (arg.kind === 'ignore') continue;
    if (arg.kind === 'exe') {
      if (arg.value) {
        patch.llama_server_path = arg.value;
        rows.push({ text: t('preview.serverPath', { value: arg.value }), custom: false });
      }
      continue;
    }

    if (arg.kind === 'model') {
      if (arg.value) {
        patch.model = arg.value;
        const idx = Math.max(arg.value.lastIndexOf('/'), arg.value.lastIndexOf('\\'));
        patch.model_dir = idx > 0 ? arg.value.slice(0, idx) : '';
        rows.push({ text: t('preview.model', { value: arg.value }), custom: false });
      }
      continue;
    }

    if (arg.kind === 'value') {
      const field = arg.field as keyof ServerConfig;
      switch (field) {
        case 'host':
          if (arg.value) {
            patch.host = arg.value;
            rows.push({ text: t('preview.host', { value: arg.value }), custom: false });
          }
          break;
        case 'port': {
          const n = toInt(arg.value);
          if (n != null) {
            patch.port = n;
            rows.push({ text: t('preview.port', { value: n }), custom: false });
          } else {
            rows.push({
              text: t('preview.portInvalid', { value: arg.value ?? '' }),
              custom: false,
            });
          }
          break;
        }
        case 'ctx_size': {
          const n = toInt(arg.value);
          if (n != null) {
            patch.ctx_size = n;
            enableSet.add('ctx_size');
            rows.push({ text: t('preview.ctx', { value: n }), custom: false });
          } else {
            rows.push({ text: t('preview.ctxInvalid', { value: arg.value ?? '' }), custom: false });
          }
          break;
        }
        case 'n_predict': {
          const raw = (arg.value ?? '').toLowerCase();
          const n = raw === 'unlimited' || raw === '-1' ? -1 : toInt(arg.value);
          if (n != null) {
            patch.n_predict = n;
            enableSet.add('n_predict');
            rows.push({
              text: t('preview.predict', { value: n === -1 ? 'unlimited' : n }),
              custom: false,
            });
          } else {
            rows.push({
              text: t('preview.predictInvalid', { value: arg.value ?? '' }),
              custom: false,
            });
          }
          break;
        }
        case 'n_gpu_layers': {
          const n = toInt(arg.value);
          if (n != null) {
            patch.n_gpu_layers = n;
            enableSet.add('n_gpu_layers');
            rows.push({ text: t('preview.gpu', { value: n }), custom: false });
          } else {
            rows.push({ text: t('preview.gpuInvalid', { value: arg.value ?? '' }), custom: false });
          }
          break;
        }
        case 'threads': {
          const n = toInt(arg.value);
          if (n != null) {
            patch.threads = n;
            enableSet.add('threads');
            rows.push({ text: t('preview.threads', { value: n }), custom: false });
          } else {
            rows.push({
              text: t('preview.threadsInvalid', { value: arg.value ?? '' }),
              custom: false,
            });
          }
          break;
        }
        case 'batch_size': {
          const n = toInt(arg.value);
          if (n != null) {
            patch.batch_size = n;
            enableSet.add('batch_size');
            rows.push({ text: t('preview.batch', { value: n }), custom: false });
          } else {
            rows.push({
              text: t('preview.batchInvalid', { value: arg.value ?? '' }),
              custom: false,
            });
          }
          break;
        }
        case 'temp': {
          const n = toFloat(arg.value);
          if (n != null) {
            patch.temp = n;
            enableSet.add('temp');
            rows.push({ text: t('preview.temp', { value: n }), custom: false });
          } else {
            rows.push({
              text: t('preview.tempInvalid', { value: arg.value ?? '' }),
              custom: false,
            });
          }
          break;
        }
        case 'flash_attn': {
          const v = (arg.value ?? '').toLowerCase();
          const norm = v === 'on' ? 'on' : v === 'off' ? 'off' : 'auto';
          patch.flash_attn = norm;
          enableSet.add('flash_attn');
          rows.push({ text: t('preview.flash', { value: norm }), custom: false });
          break;
        }
      }
      continue;
    }

    if (arg.kind === 'bool') {
      const field = arg.field as keyof ServerConfig;
      const state = arg.boolValue ? t('preview.on') : t('preview.off');
      if (field === 'mmap') {
        patch.mmap = !!arg.boolValue;
        enableSet.add('mmap');
        rows.push({ text: t('preview.mmap', { value: state }), custom: false });
      } else if (field === 'mlock') {
        patch.mlock = !!arg.boolValue;
        enableSet.add('mlock');
        rows.push({ text: t('preview.mlock', { value: state }), custom: false });
      }
      continue;
    }

    // 已识别参数（kind:'known'）：命中注册表 → 升级为结构化高级参数，
    // 以独立卡片呈现（可编辑值、可临时禁用、可删除），并按声明序列化。
    // 未命中（如新版 llama.cpp 刚加的 flag）→ 退回自定义参数原样透传，保证不丢参数。
    if (arg.kind === 'known') {
      const spec = specByKey.get(structuredKeyOf(arg.labelKey) ?? '');
      if (spec) {
        structured[spec.key] = structuredValueOf(spec, arg.value);
        enableStructuredSet.add(spec.key);
        rows.push({
          text: t((arg.labelKey ?? 'preview.custom') as MessageKey, { value: arg.value ?? '' }),
          custom: false,
        });
        continue;
      }
      extraArgs.push(arg.flag);
      extraArgs.push(arg.value ?? '');
      rows.push({
        text: t((arg.labelKey ?? 'preview.custom') as MessageKey, { value: arg.value ?? '' }),
        custom: true,
      });
      continue;
    }

    // 未知 flag 或位置参数：原样进入自定义参数（extra_args），启动命令里照发。
    if (arg.kind === 'unknown') {
      extraArgs.push(arg.flag);
      extraArgs.push(arg.value ?? '');
      rows.push({
        text: t('preview.custom', {
          value: arg.value != null ? `${arg.flag} ${arg.value}` : arg.flag,
        }),
        custom: true,
      });
    } else if (arg.kind === 'positional' && arg.value) {
      extraArgs.push(arg.value);
      extraArgs.push('');
      rows.push({ text: t('preview.positional', { value: arg.value }), custom: true });
    }
  }

  return {
    patch,
    enable: [...enableSet],
    extraArgs,
    structured,
    enableStructured: [...enableStructuredSet],
    rows,
  };
}

// 把扁平的 extra_args（[flag, value, flag, value, ...]）还原成展示用的成组列表，
// 供高级参数卡片里渲染可编辑 / 可移除的「自定义参数」片。
// 存储恒为「成对」：每条自定义参数占两个槽位（flag + value，value 为 '' 表示纯 flag），
// 因此严格按步长 2 遍历——这与 buildPlan 的写入和 removeExtraArg 的按 2 删除保持一致，
// 避免纯 flag（value=''）时错位产生空行。
export function groupExtraArgs(
  extra: string[],
): { text: string; flag: string; value: string; start: number }[] {
  const groups: { text: string; flag: string; value: string; start: number }[] = [];
  for (let i = 0; i + 1 < extra.length; i += 2) {
    const flag = extra[i];
    const value = extra[i + 1];
    groups.push({
      text: value !== '' ? `${flag} ${value}` : flag,
      flag,
      value,
      start: i,
    });
  }
  return groups;
}

// 把用户在「自定义参数」输入框里编辑的一整行文本，拆回扁平存储所需的 [flag, value] 对。
// 与解析粘贴命令一致的引号感知分词：首个 token 作 flag，其余 token 合并作 value（无则 ''）。
export function splitExtraArg(text: string): [string, string] {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return ['', ''];
  }
  const [flag, ...rest] = tokens;
  return [flag, rest.join(' ')];
}

// 把一份配置序列化为与后端 build_server_args 完全一致的 llama-server 启动命令行
// （基础参数 + 各项已启用高级参数，未知/自定义参数原样追加），
// 供「分享配置」复制到剪切板，他人粘贴即可复现同一启动。
const FLASH_NORMALIZE: Record<string, string> = { on: 'on', off: 'off', auto: 'auto' };

const quoteIfNeeded = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

export function configToCommand(config: ServerConfig, registry: ParamSpec[]): string {
  const enabled = new Set(config.enabled_advanced_params);
  const disabled = new Set(config.disabled_advanced_params);
  // 仅当「已启用且未临时禁用」时才拼入：与后端 build_server_args 保持一致。
  const active = (key: string) => enabled.has(key) && !disabled.has(key);
  const parts: string[] = [];
  parts.push('-m', quoteIfNeeded(config.model));
  parts.push('--host', config.host);
  parts.push('--port', String(config.port));
  parts.push('-c', String(config.ctx_size));
  parts.push('--timeout', '2400');
  if (active('n_predict')) parts.push('-n', String(config.n_predict));
  if (active('n_gpu_layers')) parts.push('-ngl', String(config.n_gpu_layers));
  if (active('threads')) parts.push('-t', String(config.threads));
  if (active('batch_size')) parts.push('-b', String(config.batch_size));
  if (active('temp')) parts.push('--temp', String(config.temp));
  if (active('flash_attn')) {
    const fv = FLASH_NORMALIZE[(config.flash_attn || 'auto').toLowerCase()] ?? 'auto';
    parts.push('--flash-attn', fv);
  }
  if (active('mmap')) parts.push(config.mmap ? '--mmap' : '--no-mmap');
  if (active('mlock') && config.mlock) parts.push('--mlock');
  // 结构化高级参数：顺序与后端 build_server_args 一致（按启用顺序遍历、跳过禁用与未知键）。
  const specByKey = new Map(registry.map((spec) => [spec.key, spec]));
  const structuredDisabled = new Set(config.disabled_structured_params);
  for (const key of config.enabled_structured_params) {
    if (structuredDisabled.has(key)) continue;
    const spec = specByKey.get(key);
    if (!spec) continue;
    for (const part of structuredToArgs(spec, config.structured_params[key] ?? spec.default)) {
      parts.push(quoteIfNeeded(part));
    }
  }
  // 自定义参数：仅追加「启用」列表（disabled_extra_args 不拼入），空字符串占位跳过。
  for (const arg of config.extra_args) {
    if (arg) parts.push(arg);
  }
  const exe = config.llama_server_path.trim() || 'llama-server.exe';
  return [exe, ...parts].join(' ');
}
