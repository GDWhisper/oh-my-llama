import { useEffect, useRef, useState } from 'react';
import type { ServerConfig } from '../types';
import { Button } from './Button';
import { NameDialog } from './NameDialog';
import { ConfirmDialog } from './ConfirmDialog';

type DialogMode = 'save-as-new' | 'create-empty' | 'rename';

interface Props {
  configs: Record<string, ServerConfig>;
  activeName: string;
  // 重命名弹窗对应的「原名」，供 NameDialog 预填。
  renameTarget: string;
  onSelect: (name: string) => void;
  onCreateEmpty: () => void;
  onParamPaste: () => void;
  onShare: () => void;
  onSaveAsNew: () => void;
  onSave: () => void;
  saving: boolean;
  onRename: (name: string) => void;
  onDelete: (name: string) => void;
  nameDialog: { open: boolean; mode: DialogMode };
  onNameConfirm: (name: string) => void;
  onNameCancel: () => void;
}

// 配置管理卡片：位于左侧栏顶部（必要参数上方），统一管理必要参数与高级参数。
// 通过自定义下拉框切换配置；默认配置为只读模板，保存时会提示生成新配置。
// 每个命名配置右侧带 ✎ 重命名图标（在 × 删除图标左侧），点击后弹窗输入新名称；
// 默认配置无 ✎ / ×（不可重命名、不可删除）。
export function ConfigManager({
  configs,
  activeName,
  renameTarget,
  onSelect,
  onCreateEmpty,
  onParamPaste,
  onShare,
  onSaveAsNew,
  onSave,
  saving,
  onRename,
  onDelete,
  nameDialog,
  onNameConfirm,
  onNameCancel,
}: Props) {
  const names = Object.keys(configs).sort();
  const [open, setOpen] = useState(false);
  // 当前正在请求删除的配置名；非 null 时展示删除确认弹窗。
  // 注意：删除弹窗打开时下拉框保持展开（open 不变）。
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 点击下拉框外部时收起列表（但删除弹窗打开时不处理，避免误关）。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const currentLabel = activeName === 'default' ? '默认配置' : activeName;

  const choose = (name: string) => {
    onSelect(name);
    setOpen(false);
  };

  const confirmDelete = () => {
    if (deleteTarget) {
      onDelete(deleteTarget);
    }
    setDeleteTarget(null);
    // 下拉框保持展开：不调用 setOpen(false)。
  };

  return (
    <div className="panel config-manager">
      <h2>配置管理</h2>
      <div className="fields">
        <div className="field">
          <label>选择配置</label>
          <div className={`select-box${open ? ' open' : ''}`} ref={boxRef}>
            <button
              type="button"
              className="select-trigger"
              onClick={() => setOpen((value) => !value)}
            >
              <span className="select-value">{currentLabel}</span>
              <span className="select-caret" aria-hidden>
                ▾
              </span>
            </button>
            {open && (
              <ul className="select-list">
                <li className="select-option">
                  <button
                    type="button"
                    className={`option-main${activeName === 'default' ? ' selected' : ''}`}
                    onClick={() => choose('default')}
                  >
                    默认配置
                  </button>
                </li>
                {names.map((name) => (
                  <li key={name} className="select-option">
                    <button
                      type="button"
                      className={`option-main${activeName === name ? ' selected' : ''}`}
                      onClick={() => choose(name)}
                    >
                      {name}
                    </button>
                    <button
                      type="button"
                      className="option-rename"
                      title={`重命名「${name}」`}
                      aria-label={`重命名配置 ${name}`}
                      onClick={() => onRename(name)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="option-delete"
                      title={`删除「${name}」`}
                      aria-label={`删除配置 ${name}`}
                      onClick={() => setDeleteTarget(name)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="config-actions">
          <Button variant="secondary" type="button" onClick={onCreateEmpty}>
            新增配置
          </Button>
          <Button variant="secondary" type="button" onClick={onParamPaste}>
            一键传参
          </Button>
          <Button variant="secondary" type="button" onClick={onShare}>
            分享参数
          </Button>
          <Button variant="secondary" type="button" onClick={onSaveAsNew}>
            保存为新配置
          </Button>
          <Button type="button" onClick={onSave} disabled={saving}>
            {saving ? '保存中...' : '保存配置'}
          </Button>
        </div>
      </div>

      <NameDialog
        open={nameDialog.open}
        mode={nameDialog.mode}
        defaultValue={nameDialog.mode === 'rename' ? renameTarget : undefined}
        onConfirm={onNameConfirm}
        onCancel={onNameCancel}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除配置"
        message={`确认永久删除配置「${deleteTarget ?? ''}」吗？此操作不可撤销，删除后该配置的所有参数都将丢失。`}
        confirmText="删除"
        cancelText="取消"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
