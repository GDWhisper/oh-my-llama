#!/usr/bin/env node
/**
 * 门禁：拦下「选择器里伪类/伪元素被冒号后的空格拆开」的写法（例：`.icon-btn: hover`）。
 *
 * 为什么值得单开一条检查：这种选择器语法非法，浏览器 / WebView2 会**静默丢弃整条规则**——
 * 不报错、Console 干净、元素只是"少了个样式"，因此 tsc / eslint / prettier 全查不出来。
 * 2026-09-16 实测 App.css 里积了 29 条（其中 21 条 hover 从未生效），修完后补上本检查防复发。
 *
 * 判定：选择器位置出现「冒号 + 空白 + 名字」，同时覆盖 `.a: hover`、`.a: disabled`、
 * `.column: :-webkit-scrollbar-thumb`（冒号紧挨冒号）三类写法。
 *
 * 实现不引入任何依赖：按 `{` `}` `;` 切出「选择器片段」——声明与属性值天然落不进片段，
 * 故不会把 `background: red` 里的冒号误判；注释先等长替换成空白，保证行号仍是原文件行号；
 * 片段里的引号串（如 `[title="a: b"]`）同样等长清空，避免内容里的 `: ` 误报。
 *
 * 用法：node scripts/check-css-selectors.mjs [扫描根目录，默认 src]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] ?? 'src';
const PATTERN = /:\s+(:?[A-Za-z-]+)/g;

function collectCss(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...collectCss(path));
    else if (name.endsWith('.css')) found.push(path);
  }
  return found;
}

// 注释等长替换为空白：既不移位、也不让注释里的 `: ` 参与匹配。
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));

const blankQuotes = (text) =>
  text.replace(/"[^"]*"|'[^']*'/g, (quoted) => ' '.repeat(quoted.length));

function findViolations(text) {
  const src = stripComments(text);
  const hits = [];
  let prelude = '';
  let start = 0;

  const inspect = () => {
    const raw = prelude;
    const trimmed = raw.trim();
    // @media / @supports 等 at-rule 的前导不是选择器（其条件里合法地带 `: `）。
    if (!trimmed || trimmed.startsWith('@')) return;
    const safe = blankQuotes(raw);
    PATTERN.lastIndex = 0;
    for (let m = PATTERN.exec(safe); m; m = PATTERN.exec(safe)) {
      const at = m.index;
      const lineStart = raw.lastIndexOf('\n', at) + 1;
      const lineEnd = raw.indexOf('\n', at);
      hits.push({
        line: src.slice(0, start + at).split('\n').length,
        snippet: raw.slice(lineStart, lineEnd === -1 ? raw.length : lineEnd).trim(),
      });
    }
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    // 只在 `{` 处检查：此刻累积的才是选择器。`;` / `}` 只清空累积——
    // 若在 `;` 处也检查，会把上一条声明（`background: red`）当成选择器误报。
    if (ch === '{') {
      inspect();
      prelude = '';
      start = i + 1;
    } else if (ch === '}' || ch === ';') {
      prelude = '';
      start = i + 1;
    } else {
      prelude += ch;
    }
  }
  return hits;
}

let total = 0;
const files = collectCss(ROOT);
for (const file of files) {
  for (const hit of findViolations(readFileSync(file, 'utf8'))) {
    total += 1;
    console.error(
      `[FAIL] ${file}:${hit.line} 选择器写成「冒号 + 空格 + 名字」，整条规则会被浏览器静默丢弃：${hit.snippet}`,
    );
  }
}

if (total > 0) {
  console.error(
    `\n选择器语法检查未通过：${total} 处。修法：删掉冒号后的空格（如 ": hover" -> ":hover"）。`,
  );
  process.exit(1);
}
console.log(`[OK] 选择器语法检查通过（${files.length} 个 CSS 文件）`);
