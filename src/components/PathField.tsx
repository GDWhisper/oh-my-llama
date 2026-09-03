import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useI18n } from '../i18n';
import type { PathCandidate } from '../types';

interface DialogFilter {
  name: string;
  extensions: string[];
}

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  filters?: DialogFilter[];
  directory?: boolean;
  hint?: string;
  hintTone?: 'default' | 'error';
  // 传入即变成「输入 + 候选」组合框：候选由上层给（llama-server 路径 / 模型目录，
  // 两者共用后端同一套路径历史机制），点击回填。
  suggestions?: PathCandidate[];
  // 「从历史中忘掉」一条：仅对仍能被忘掉的路径显示 ×（被命名配置引用的条目不在此列）。
  onRemoveSuggestion?: (value: string) => void;
}

// Windows 路径大小写不敏感且 / 与 \ 常混用（手填 \ 、一键传参回填 /），判重必须走同一套
// 归一化（与后端 lib.rs::path_key 同构），否则候选里会出现「看着一样其实两行」。
function pathKey(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

// 按已输入内容做子串过滤，并排除与当前值指向同一文件的那条。
// 空输入不过滤：直接给出全部候选（后端已按「最近使用优先」排好序）。
function filterCandidates(suggestions: PathCandidate[], query: string): PathCandidate[] {
  const typed = pathKey(query);
  return suggestions.filter((item) => {
    const key = pathKey(item.path);
    return key !== typed && (typed === '' || key.includes(typed));
  });
}

// 通过 Tauri 官方 dialog 插件打开系统原生对话框，回填真实绝对路径。
// directory=true 时打开目录选择（用于模型目录）；否则打开文件选择。
// 前端只负责触发原生能力并把结果交回上层，不在此实现任何文件读写逻辑（严守分层）。
export function PathField({
  label,
  value,
  onChange,
  filters,
  directory,
  hint,
  hintTone,
  suggestions,
  onRemoveSuggestion,
}: Props) {
  const { t } = useI18n();
  const [showList, setShowList] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const candidates = suggestions ? filterCandidates(suggestions, value) : [];

  // 点击组件外部时收起候选列表（与模型下拉同一套交互）。
  useEffect(() => {
    if (!showList) return;
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) {
        setShowList(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showList]);

  const pick = async () => {
    const selected = directory
      ? await open({ directory: true })
      : await open({ multiple: false, filters });
    if (typeof selected === 'string') {
      onChange(selected);
    }
  };

  return (
    <div className="field">
      <label>{label}</label>
      <div className="field-path" ref={boxRef}>
        <input
          value={value}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            setShowList(true);
          }}
          onFocus={() => setShowList(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setShowList(false);
          }}
        />
        <button type="button" className="browse-btn" onClick={pick}>
          {t('common.browse')}
        </button>
        {showList && candidates.length > 0 && (
          <ul className="path-suggest">
            {candidates.map((item) => (
              <li key={item.path} className="path-suggest-item">
                <button
                  type="button"
                  className="path-suggest-text"
                  title={item.path}
                  onClick={() => {
                    onChange(item.path);
                    setShowList(false);
                  }}
                >
                  {item.path}
                </button>
                {onRemoveSuggestion && !item.used_by_config && (
                  <button
                    type="button"
                    className="path-suggest-remove"
                    title={t('common.forgetCandidate')}
                    aria-label={t('common.forgetCandidate')}
                    // 不阻止默认行为的话，输入框会先失焦、列表随即被「点外部」逻辑收起，
                    // 这次「移除」就永远点不到。
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onRemoveSuggestion(item.path)}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {hint && (
        <div className={`field-hint${hintTone === 'error' ? ' field-hint-error' : ''}`}>{hint}</div>
      )}
    </div>
  );
}
