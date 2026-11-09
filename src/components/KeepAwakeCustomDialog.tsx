import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import { Button } from './Button';

// 与后端 keep_awake::MAX_MINUTES 对齐：自定义时长上限 24 小时。后端 set_manual 会再
// 校验一次，前端这里只为即时反馈，即便两处漂移也不会写入越界值。
const MAX_MINUTES = 24 * 60;

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 「阻止休眠」托盘子菜单的「自定义…」输入弹窗。托盘原生菜单没有输入框，故后端点击
 * 该项时唤起主窗并 emit `keep-awake://custom`，由 App 打开这里。确认后走与预设时长
 * 完全相同的 set_keep_awake_manual 命令，不另开一条生效路径。
 */
export function KeepAwakeCustomDialog({ open, onClose }: Props) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setValue('');
      setError('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const confirm = () => {
    const minutes = Number(value.trim());
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
      setError(t('keepAwake.customInvalid'));
      return;
    }
    setError('');
    invoke('set_keep_awake_manual', { enabled: true, minutes })
      .then(() => onClose())
      .catch((e) => setError(String(e)));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('keepAwake.customTitle')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">{t('keepAwake.customTitle')}</div>
        <div className="modal-body">{t('keepAwake.customHint')}</div>
        <input
          autoFocus
          type="number"
          min={1}
          max={MAX_MINUTES}
          className="name-input"
          placeholder={t('keepAwake.customPlaceholder')}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              confirm();
            }
          }}
        />
        {error && <div className="settings-proxy-err">{error}</div>}
        <div className="modal-actions">
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="button" onClick={confirm}>
            {t('common.ok')}
          </Button>
        </div>
      </div>
    </div>
  );
}
