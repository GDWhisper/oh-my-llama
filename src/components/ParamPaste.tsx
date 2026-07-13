import { useMemo, useState } from 'react';
import { buildPlan, parseLlamaArgs, type ApplyPlan } from '../lib/parseArgs';
import { Button } from './Button';

interface Props {
  // 确认后把套用计划交给上层（App）真正写入配置
  onConfirm: (plan: ApplyPlan) => void;
  onClose: () => void;
}

// 「一键传参」面板：粘贴 llama-server 完整命令行，实时解析预览，
// 确认后把已知 flag 套用到对应高级参数、未知 flag 以自定义参数形式写入启动命令。
export function ParamPaste({ onConfirm, onClose }: Props) {
  const [text, setText] = useState('');

  // 实时把输入解析成套用计划，确认前即可核对「会变成什么」。
  const plan = useMemo(() => (text.trim() ? buildPlan(parseLlamaArgs(text)) : null), [text]);

  return (
    <div className="panel param-paste">
      <div className="section-header">
        <h2>一键传参</h2>
        <button className="param-close" type="button" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      <p className="param-desc">
        粘贴 llama-server 的完整命令行（含或不含 <code>llama-server.exe</code> 均可）。
        确认后，支持的高级参数会直接套用，无法识别的参数以「自定义参数」形式一并写入启动命令，
        确保与真实启动时完全一致。
      </p>
      <textarea
        className="param-textarea"
        value={text}
        spellCheck={false}
        placeholder={
          '例如：\n' +
          'llama-server.exe -m C:/models/model.gguf --host 0.0.0.0 --port 9999 -c 8192 -ngl 99 --main-gpu 0 --alias demo'
        }
        onChange={(event) => setText(event.currentTarget.value)}
      />
      {plan && plan.rows.length > 0 && (
        <div className="param-preview">
          <div className="param-preview-title">解析预览（确认后将生效）</div>
          <ul className="param-preview-list">
            {plan.rows.map((row, index) => (
              <li key={index} className={row.custom ? 'custom' : ''}>
                {row.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="panel-actions">
        <Button variant="secondary" type="button" onClick={onClose}>
          取消
        </Button>
        <Button
          type="button"
          disabled={!plan || plan.rows.length === 0}
          onClick={() => plan && onConfirm(plan)}
        >
          确认添加
        </Button>
      </div>
    </div>
  );
}
