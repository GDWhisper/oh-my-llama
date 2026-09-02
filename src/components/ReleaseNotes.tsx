import type { ReactNode } from 'react';

// Release notes 排版：正文来自 GitHub Release body，按 `.dev_docs/release-note-template.md`
// 只会用到 Markdown 的一个子集（标题 / 无序列表 / 引用 / 段落 + 行内加粗）。
// 因此逐行解析成文本节点渲染，不引入 markdown 库，也不用 dangerouslySetInnerHTML。

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'paragraph'; text: string };

function parse(md: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', text: heading[1] });
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      const item = line.replace(/^[-*+]\s+/, '');
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === 'list') prev.items.push(item);
      else blocks.push({ kind: 'list', items: [item] });
      continue;
    }
    if (line.startsWith('>')) {
      blocks.push({ kind: 'quote', text: line.replace(/^>+\s*/, '') });
      continue;
    }
    blocks.push({ kind: 'paragraph', text: line });
  }
  return blocks;
}

// 行内只处理 **加粗**；反引号、链接等直接按原样文本展示。
function inline(text: string): ReactNode[] {
  return text
    .split(/\*\*(.+?)\*\*/g)
    .map((seg, i) => (i % 2 === 1 ? <strong key={i}>{seg}</strong> : seg));
}

export function ReleaseNotes({ body }: { body: string }) {
  return (
    <div className="release-notes">
      {parse(body.trim()).map((block, i) => {
        switch (block.kind) {
          case 'heading':
            return (
              <div className="rn-heading" key={i}>
                {inline(block.text)}
              </div>
            );
          case 'list':
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </ul>
            );
          case 'quote':
            return <blockquote key={i}>{inline(block.text)}</blockquote>;
          default:
            return <p key={i}>{inline(block.text)}</p>;
        }
      })}
    </div>
  );
}
