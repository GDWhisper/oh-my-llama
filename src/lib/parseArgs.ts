import type { ServerConfig } from '../types';
import type { AdvancedKey } from './advanced';

// 解析「一键传参」文本框里用户粘贴的 llama-server 命令行，产出可直接套用到
// 配置的补丁（已知 flag 映射到高级参数）+ 自定义参数（未知 flag 原样进入启动命令）。
// 这样用户粘贴的完整命令行，与真正启动时发出的命令行保持一致。

export interface ParsedArg {
  // '' 表示位置参数（无 flag）
  flag: string;
  kind: 'value' | 'bool' | 'model' | 'unknown' | 'positional';
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

export function parseLlamaArgs(input: string): ParsedArg[] {
  const tokens = tokenize(input);
  const out: ParsedArg[] = [];
  let firstToken = true;
  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    // 跳过开头的可执行文件名（如 llama-server.exe / 绝对路径），不把它当参数。
    if (firstToken && !tok.startsWith('-') && (/\.exe$/i.test(tok) || /llama-server/i.test(tok))) {
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
export function buildPlan(args: ParsedArg[]): ApplyPlan {
  const patch: Partial<ServerConfig> = {};
  const enableSet = new Set<AdvancedKey>();
  const extraArgs: string[] = [];
  const rows: PreviewRow[] = [];

  for (const arg of args) {
    if (arg.kind === 'model') {
      if (arg.value) {
        patch.model = arg.value;
        const idx = Math.max(arg.value.lastIndexOf('/'), arg.value.lastIndexOf('\\'));
        patch.model_dir = idx > 0 ? arg.value.slice(0, idx) : '';
        rows.push({ text: `模型路径 → ${arg.value}`, custom: false });
      }
      continue;
    }

    if (arg.kind === 'value') {
      const field = arg.field as keyof ServerConfig;
      switch (field) {
        case 'host':
          if (arg.value) {
            patch.host = arg.value;
            rows.push({ text: `监听地址 → ${arg.value}`, custom: false });
          }
          break;
        case 'port': {
          const n = toInt(arg.value);
          if (n != null) {
            patch.port = n;
            rows.push({ text: `监听端口 → ${n}`, custom: false });
          } else {
            rows.push({ text: `监听端口：数值无效，已忽略（${arg.value}）`, custom: false });
          }
          break;
        }
        case 'ctx_size': {
          const n = toInt(arg.value);
          if (n != null) {
            patch.ctx_size = n;
            enableSet.add('ctx_size');
            rows.push({ text: `上下文长度 → ${n}`, custom: false });
          } else {
            rows.push({ text: `上下文长度：数值无效，已忽略（${arg.value}）`, custom: false });
          }
          break;
        }
        case 'n_predict': {
          const raw = (arg.value ?? '').toLowerCase();
          const n = raw === 'unlimited' || raw === '-1' ? -1 : toInt(arg.value);
          if (n != null) {
            patch.n_predict = n;
            enableSet.add('n_predict');
            rows.push({ text: `最大生成数 → ${n === -1 ? 'unlimited' : n}`, custom: false });
          } else {
            rows.push({ text: `最大生成数：数值无效，已忽略（${arg.value}）`, custom: false });
          }
          break;
        }
        case 'n_gpu_layers': {
          const n = toInt(arg.value);
          if (n != null) {
            patch.n_gpu_layers = n;
            enableSet.add('n_gpu_layers');
            rows.push({ text: `GPU 层数 → ${n}`, custom: false });
          } else {
            rows.push({ text: `GPU 层数：数值无效，已忽略（${arg.value}）`, custom: false });
          }
          break;
        }
        case 'threads': {
          const n = toInt(arg.value);
          if (n != null) {
            patch.threads = n;
            enableSet.add('threads');
            rows.push({ text: `CPU 线程数 → ${n}`, custom: false });
          } else {
            rows.push({ text: `CPU 线程数：数值无效，已忽略（${arg.value}）`, custom: false });
          }
          break;
        }
        case 'batch_size': {
          const n = toInt(arg.value);
          if (n != null) {
            patch.batch_size = n;
            enableSet.add('batch_size');
            rows.push({ text: `批处理大小 → ${n}`, custom: false });
          } else {
            rows.push({ text: `批处理大小：数值无效，已忽略（${arg.value}）`, custom: false });
          }
          break;
        }
        case 'temp': {
          const n = toFloat(arg.value);
          if (n != null) {
            patch.temp = n;
            enableSet.add('temp');
            rows.push({ text: `温度 → ${n}`, custom: false });
          } else {
            rows.push({ text: `温度：数值无效，已忽略（${arg.value}）`, custom: false });
          }
          break;
        }
        case 'flash_attn': {
          const v = (arg.value ?? '').toLowerCase();
          const norm = v === 'on' ? 'on' : v === 'off' ? 'off' : 'auto';
          patch.flash_attn = norm;
          enableSet.add('flash_attn');
          rows.push({ text: `Flash Attention → ${norm}`, custom: false });
          break;
        }
      }
      continue;
    }

    if (arg.kind === 'bool') {
      const field = arg.field as keyof ServerConfig;
      if (field === 'mmap') {
        patch.mmap = !!arg.boolValue;
        enableSet.add('mmap');
        rows.push({ text: `mmap → ${arg.boolValue ? '开' : '关'}`, custom: false });
      } else if (field === 'mlock') {
        patch.mlock = !!arg.boolValue;
        enableSet.add('mlock');
        rows.push({ text: `mlock → ${arg.boolValue ? '开' : '关'}`, custom: false });
      }
      continue;
    }

    // 未知 flag 或位置参数：原样进入自定义参数（extra_args），启动命令里照发。
    if (arg.kind === 'unknown') {
      extraArgs.push(arg.flag);
      extraArgs.push(arg.value ?? '');
      rows.push({
        text: `自定义参数 → ${arg.value != null ? `${arg.flag} ${arg.value}` : arg.flag}`,
        custom: true,
      });
    } else if (arg.kind === 'positional' && arg.value) {
      extraArgs.push(arg.value);
      extraArgs.push('');
      rows.push({ text: `位置参数 → ${arg.value}`, custom: true });
    }
  }

  return { patch, enable: [...enableSet], extraArgs, rows };
}

// 把扁平的 extra_args（[flag, value, flag, value, ...]）还原成展示用的成组列表，
// 供高级参数卡片里渲染可移除的「自定义参数」片。
export function groupExtraArgs(extra: string[]): { text: string; start: number; count: number }[] {
  const groups: { text: string; start: number; count: number }[] = [];
  let i = 0;
  while (i < extra.length) {
    const flag = extra[i];
    const next = i + 1 < extra.length ? extra[i + 1] : '';
    const hasValue = next !== '';
    groups.push({
      text: hasValue ? `${flag} ${next}` : flag,
      start: i,
      count: hasValue ? 2 : 1,
    });
    i += hasValue ? 2 : 1;
  }
  return groups;
}
