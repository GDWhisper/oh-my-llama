import { useState } from 'react';
import type { ServerConfig } from '../types';
import { useI18n } from '../i18n';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { NameDialog } from './NameDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { TruncatedText } from './TruncatedText';
import { useDropdownSearch } from '../hooks/useDropdownSearch';

type DialogMode = 'save-as-new' | 'create-empty' | 'rename';

interface Props {
  configs: Record<string, ServerConfig>;
  activeName: string;
  // 当前 live 配置是否与已落盘基线不同（有未保存改动），用于标题旁「未保存」徽标。
  isDirty: boolean;
  // 重命名弹窗对应的「原名」，供 NameDialog 预填。
  renameTarget: string;
  onSelect: (name: string) => void;
  // 恢复为当前选中配置的已保存版本（丢弃未保存改动）。
  onRestoreConfig: () => void;
  onCreateEmpty: () => void;
  onShare: () => void;
  onSaveAsNew: () => void;
  onSave: () => void;
  saving: boolean;
  onRename: (name: string) => void;
  onDelete: (name: string) => void;
  nameDialog: { open: boolean; mode: DialogMode };
  // 命名弹窗「填入模型名称」候选（已去目录与 .gguf 后缀）；空串表示无候选、不显示按钮。
  nameDialogModelName: string;
  onNameConfirm: (name: string) => void;
  onNameCancel: () => void;
}

// 配置管理卡片：位于左侧栏顶部（必要参数上方），统一管理必要参数与高级参数。
// 通过可搜索的自定义下拉框切换配置（与「选择模型」同款，共用 useDropdownSearch）；
// 默认配置为只读模板，保存时会提示生成新配置。
// 每个命名配置右侧带 ✎ 重命名图标（在 × 删除图标左侧），点击后弹窗输入新名称；
// 默认配置无 ✎ / ×（不可重命名、不可删除）。
export function ConfigManager({
  configs,
  activeName,
  isDirty,
  renameTarget,
  onSelect,
  onRestoreConfig,
  onCreateEmpty,
  onShare,
  onSaveAsNew,
  onSave,
  saving,
  onRename,
  onDelete,
  nameDialog,
  nameDialogModelName,
  onNameConfirm,
  onNameCancel,
}: Props) {
  const { t } = useI18n();
  const names = Object.keys(configs).sort();
  const [open, setOpen] = useState(false);
  // 当前正在请求删除的配置名；非 null 时展示删除确认弹窗。
  // 注意：删除弹窗打开时下拉框保持展开（open 不变）。
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // 下拉条目：默认配置固定在最前（按展示文案参与搜索），其余按名称排序。
  const entries: { key: string; label: string }[] = [
    { key: 'default', label: t('config.default') },
    ...names.map((name) => ({ key: name, label: name })),
  ];

  const choose = (name: string) => {
    onSelect(name);
    setOpen(false);
  };

  // 与「选择模型」同款的可搜索下拉：搜索框、点击外部关闭、空间自适应展开方向、回车选中共用一套行为。
  const {
    query,
    setQuery,
    filtered,
    dropUp,
    boxRef,
    triggerRef,
    listRef,
    searchRef,
    onSearchKeyDown,
  } = useDropdownSearch({
    open,
    items: entries,
    getLabel: (entry) => entry.label,
    onClose: () => setOpen(false),
    onSelectFirst: (entry) => choose(entry.key),
  });

  const currentLabel = activeName === 'default' ? t('config.default') : activeName;

  const confirmDelete = () => {
    if (deleteTarget) {
      onDelete(deleteTarget);
    }
    setDeleteTarget(null);
    // 下拉框保持展开：不调用 setOpen(false)。
  };

  return (
    <div className="panel config-manager">
      <div className="panel-header">
        <div className="panel-header-left">
          <h2>{t('config.title')}</h2>
          {isDirty && (
            <span
              className="unsaved-icon"
              title={t('config.unsaved')}
              aria-label={t('config.unsaved')}
              role="img"
            >
              <svg
                viewBox="0 0 24 24"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </span>
          )}
        </div>
        <div className="panel-header-actions">
          <IconButton label={t('config.share')} onClick={onShare}>
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
          </IconButton>
        </div>
      </div>
      <div className="fields">
        <div className="field">
          <label>{t('config.select')}</label>
          <div className="select-with-restore">
            <div className={`select-box${open ? ' open' : ''}`} ref={boxRef}>
              <button
                type="button"
                className="select-trigger"
                ref={triggerRef}
                onClick={() => setOpen((value) => !value)}
              >
                <span className="select-value">
                  <TruncatedText text={currentLabel} />
                </span>
                <span className="select-caret" aria-hidden>
                  ▾
                </span>
              </button>
              {open && (
                <div ref={listRef} className={`select-list${dropUp ? ' drop-up' : ''}`}>
                  <div className="model-search">
                    <input
                      ref={searchRef}
                      type="text"
                      className="model-search-input"
                      placeholder={t('config.searchPlaceholder')}
                      value={query}
                      onChange={(event) => setQuery(event.currentTarget.value)}
                      onKeyDown={onSearchKeyDown}
                    />
                  </div>
                  {filtered.length === 0 ? (
                    <div className="model-search-empty">{t('config.noMatch')}</div>
                  ) : (
                    <ul className="model-options">
                      {filtered.map((entry) => (
                        <li key={entry.key} className="select-option">
                          <button
                            type="button"
                            className={`option-main${activeName === entry.key ? ' selected' : ''}`}
                            onClick={() => choose(entry.key)}
                          >
                            <TruncatedText text={entry.label} />
                          </button>
                          {entry.key !== 'default' && (
                            <>
                              <button
                                type="button"
                                className="option-rename"
                                title={t('config.renameTitle', { name: entry.key })}
                                aria-label={t('config.renameAria', { name: entry.key })}
                                onClick={() => onRename(entry.key)}
                              >
                                ✎
                              </button>
                              <button
                                type="button"
                                className="option-delete"
                                title={t('config.deleteTitle', { name: entry.key })}
                                aria-label={t('config.deleteAria', { name: entry.key })}
                                onClick={() => setDeleteTarget(entry.key)}
                              >
                                ×
                              </button>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <IconButton label={t('config.restore')} onClick={onRestoreConfig} disabled={!isDirty}>
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </IconButton>
          </div>
        </div>
        <div className="config-actions">
          <Button variant="secondary" type="button" onClick={onCreateEmpty}>
            {t('config.createNew')}
          </Button>
          <Button variant="secondary" type="button" onClick={onSaveAsNew}>
            {t('config.saveAsNew')}
          </Button>
          <Button type="button" onClick={onSave} disabled={saving}>
            {saving ? t('common.saving') : t('config.save')}
          </Button>
        </div>
      </div>

      <NameDialog
        open={nameDialog.open}
        mode={nameDialog.mode}
        defaultValue={nameDialog.mode === 'rename' ? renameTarget : undefined}
        modelSuggestion={nameDialogModelName}
        onConfirm={onNameConfirm}
        onCancel={onNameCancel}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('config.deleteDialogTitle')}
        message={t('config.deleteConfirm', { name: deleteTarget ?? '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
