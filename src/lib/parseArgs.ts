import type { ServerConfig } from '../types';
import type { AdvancedKey } from './advanced';
import type { Translator } from '../i18n/messages';

// 解析「一键传参」文本框里用户粘贴的 llama-server 命令行，产出可直接套用到
// 配置的补丁（已知 flag 映射到高级参数）+ 自定义参数（未知 flag 原样进入启动命令）。
// 这样用户粘贴的完整命令行，与真正启动时发出的命令行保持一致。

export interface ParsedArg {
  // '' 表示位置参数（无 flag）
  flag: string;
  kind: 'value' | 'bool' | 'model' | 'unknown' | 'positional' | 'exe';
  field?: keyof ServerConfig;
  key?: AdvancedKey;
  boolValue?: boolean;
  value: string | null;
}

interface FlagInfo {
  kind: 'value' | 'bool' | 'model';
  key?: AdvancedKey;
  field: keyof ServerConfig;
  boolValue?: boolean;
}

// 已知 flag → 配置字段的映射。只列「带值」与「布尔」两类；
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
  // 供 UI 预览展示，确认前让用户核对
  rows: PreviewRow[];
}

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
export function buildPlan(args: ParsedArg[], t: Translator): ApplyPlan {
  const patch: Partial<ServerConfig> = {};
  const enableSet = new Set<AdvancedKey>();
  const extraArgs: string[] = [];
  const rows: PreviewRow[] = [];

  for (const arg of args) {
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

  return { patch, enable: [...enableSet], extraArgs, rows };
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
// 供「分享参数」复制到剪切板，他人粘贴即可复现同一启动。
const FLASH_NORMALIZE: Record<string, string> = { on: 'on', off: 'off', auto: 'auto' };

const quoteIfNeeded = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

export function configToCommand(config: ServerConfig): string {
  const enabled = new Set(config.enabled_advanced_params);
  const parts: string[] = [];
  parts.push('-m', quoteIfNeeded(config.model));
  parts.push('--host', config.host);
  parts.push('--port', String(config.port));
  parts.push('-c', String(config.ctx_size));
  parts.push('--timeout', '2400');
  if (enabled.has('n_predict')) parts.push('-n', String(config.n_predict));
  if (enabled.has('n_gpu_layers')) parts.push('-ngl', String(config.n_gpu_layers));
  if (enabled.has('threads')) parts.push('-t', String(config.threads));
  if (enabled.has('batch_size')) parts.push('-b', String(config.batch_size));
  if (enabled.has('temp')) parts.push('--temp', String(config.temp));
  if (enabled.has('flash_attn')) {
    const fv = FLASH_NORMALIZE[(config.flash_attn || 'auto').toLowerCase()] ?? 'auto';
    parts.push('--flash-attn', fv);
  }
  if (enabled.has('mmap')) parts.push(config.mmap ? '--mmap' : '--no-mmap');
  if (enabled.has('mlock') && config.mlock) parts.push('--mlock');
  // 自定义参数：原样追加（与启动一致），空字符串占位跳过。
  for (const arg of config.extra_args) {
    if (arg) parts.push(arg);
  }
  const exe = config.llama_server_path.trim() || 'llama-server.exe';
  return [exe, ...parts].join(' ');
}
