import { useMemo, useState } from 'react';
import { buildPlan, parseLlamaArgs, type ApplyPlan } from '../lib/parseArgs';
import { useI18n } from '../i18n';
import { Button } from './Button';

interface Props {
  // 覆盖：把套用计划整体替换进配置（与旧「确认添加」一致）；
  // 追加：仅把自定义参数接到现有自定义参数之后，已知字段仍套用。
  onOverwrite: (plan: ApplyPlan) => void;
  onAppend: (plan: ApplyPlan) => void;
  onClose: () => void;
}

// 「一键传参」面板：粘贴 llama-server 完整命令行，实时解析预览，
// 确认后把已知 flag 套用到对应高级参数、未知 flag 以自定义参数形式写入启动命令。
export function ParamPaste({ onOverwrite, onAppend, onClose }: Props) {
  const { t } = useI18n();
  const [text, setText] = useState('');

  // 实时把输入解析成套用计划，确认前即可核对「会变成什么」。预览文案随语言切换。
  const plan = useMemo(() => (text.trim() ? buildPlan(parseLlamaArgs(text), t) : null), [text, t]);

  return (
    <div className="panel param-paste">
      <div className="section-header">
        <h2>{t('paramPaste.title')}</h2>
        <button
          className="param-close"
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          ×
        </button>
      </div>
      <p className="param-desc">
        {t('paramPaste.descPre')}
        <code>llama-server.exe</code>
        {t('paramPaste.descPost')}
      </p>
      <textarea
        className="param-textarea"
        value={text}
        spellCheck={false}
        placeholder={t('paramPaste.placeholder')}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      {plan && plan.rows.length > 0 && (
        <div className="param-preview">
          <div className="param-preview-title">{t('paramPaste.previewTitle')}</div>
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
          {t('common.cancel')}
        </Button>
        <Button
          variant="secondary"
          type="button"
          disabled={!plan || plan.rows.length === 0}
          onClick={() => plan && onOverwrite(plan)}
        >
          {t('paramPaste.overwrite')}
        </Button>
        <Button
          variant="secondary"
          type="button"
          disabled={!plan || plan.rows.length === 0}
          onClick={() => plan && onAppend(plan)}
        >
          {t('paramPaste.append')}
        </Button>
      </div>
    </div>
  );
}
