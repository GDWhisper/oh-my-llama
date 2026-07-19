import { useEffect, useMemo, useRef, useState } from 'react';
import { buildPlan, configToCommand, parseLlamaArgs, type ApplyPlan } from '../lib/parseArgs';
import { useI18n } from '../i18n';
import { Button } from './Button';
import type { ServerConfig } from '../types';

interface Props {
  // 当前配置（来自后端默认值，无前端硬编码）：只读态据此实时派生启动命令。
  config: ServerConfig;
  // 当前配置名（'default' 或命名配置名）：用于侦测「切配置」，
  // 切走时强制退出编辑态并丢弃草稿，避免把旧配置文本误写进新配置（串台）。
  configName: string;
  // 配置重载纪元：每次从已落盘版本载入 config（切配置/恢复）时 +1。
  // 与 configName 配合——恢复同名配置时 configName 不变，靠它触发编辑态重置。
  configEpoch: number;
  // 编辑态实时回写：把解析后的套用计划整体覆盖进配置（与必要/高级参数实时同步）。
  onApply: (plan: ApplyPlan) => void;
  // 复原：回到进入编辑前快照的配置。
  onRestore: (config: ServerConfig) => void;
  // 复制成功/失败提示（复用 App 的 showToast，与配置管理分享同源）。
  showToast: (message: string) => void;
}

// 「原始参数」卡片：只读态展示由当前 config 实时派生的启动命令行（与必要/高级参数天然同步）；
// 点击【编辑】进入编辑态——textarea 预填当前命令，改动经防抖后实时回写配置，
// 必要/高级卡片随之即时更新；【复原】回到编辑前快照，【完成】退出并做最终归一化。
export function RawParams({
  config,
  configName,
  configEpoch,
  onApply,
  onRestore,
  showToast,
}: Props) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const preEditRef = useRef<ServerConfig | null>(null);
  const debounceRef = useRef<number | null>(null);

  // 只读态：由当前 config 实时派生（config 一变即重算，与必要/高级参数同步）。
  const cmd = useMemo(() => configToCommand(config), [config]);

  // 编辑态：实时解析预览（确认前即可核对会变成什么）。
  const plan = useMemo(
    () => (editing && text.trim() ? buildPlan(parseLlamaArgs(text), t) : null),
    [editing, text, t],
  );

  // 切配置（configName 变化，如用户在配置管理里选了别的配置）时，
  // 强制退出编辑态并丢弃本地草稿+清掉待触发防抖，避免把旧配置的编辑文本误写进新配置（串台）。
  // editing 用 ref 跟踪，避免把它列入依赖——否则进入编辑(editing→true)会立即触发重置。
  const editingRef = useRef(false);
  editingRef.current = editing;
  useEffect(() => {
    if (editingRef.current) {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      setEditing(false);
      setText('');
    }
  }, [configName, configEpoch]);

  const enterEdit = () => {
    preEditRef.current = config;
    setText(cmd);
    setEditing(true);
  };

  // 防抖回写：避免逐字触发 setConfig；空文本跳过，避免清空 extra_args。
  const applyDebounced = (value: string) => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    if (value.trim() === '') {
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      onApply(buildPlan(parseLlamaArgs(value), t));
    }, 300);
  };

  const onChange = (value: string) => {
    setText(value);
    applyDebounced(value);
  };

  // 退出编辑：清掉待处理防抖，用最终文本做一次覆盖归一化（清掉打字中途产生的脏 extra_args）。
  const exitEdit = () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (text.trim() !== '') {
      onApply(buildPlan(parseLlamaArgs(text), t));
    }
    setEditing(false);
    setText('');
  };

  const restore = () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (preEditRef.current) {
      onRestore(preEditRef.current);
    }
    setEditing(false);
    setText('');
  };

  // 复制当前启动命令到剪切板，并给出成功/失败提示（复用现有 i18n 文案）。
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(cmd);
        showToast(t('app.share.copied'));
        return;
      }
    } catch {
      // 落到下面的失败提示
    }
    showToast(t('app.share.copyFailed'));
  };

  // 卸载时清理未触发的防抖定时器，避免对已卸载组件回写。
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, []);

  if (!editing) {
    return (
      <div className="panel raw-params">
        <div className="section-header">
          <h2>{t('rawParams.title')}</h2>
          <div className="raw-actions">
            <Button variant="secondary" type="button" onClick={copy}>
              {t('rawParams.copy')}
            </Button>
            <Button variant="secondary" type="button" onClick={enterEdit}>
              {t('rawParams.edit')}
            </Button>
          </div>
        </div>
        <pre className="raw-box">
          <code>{cmd}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="panel raw-params editing">
      <div className="section-header">
        <h2>{t('rawParams.title')}</h2>
        <div className="raw-actions">
          <Button variant="secondary" type="button" onClick={restore}>
            {t('rawParams.restore')}
          </Button>
          <Button variant="primary" type="button" onClick={exitEdit}>
            {t('rawParams.done')}
          </Button>
        </div>
      </div>
      <textarea
        className="raw-box raw-box--edit"
        value={text}
        spellCheck={false}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {plan && plan.rows.length > 0 && (
        <div className="param-preview">
          <div className="param-preview-title">{t('rawParams.previewTitle')}</div>
          <ul className="param-preview-list">
            {plan.rows.map((row, index) => (
              <li key={index} className={row.custom ? 'custom' : ''}>
                {row.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
