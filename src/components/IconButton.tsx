import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'title'
> {
  // 同时作为悬停提示（title）与无障碍名称（aria-label）使用。
  label: string;
  children: ReactNode;
}

/**
 * 公共图标按钮：白底灰边方盒（与设置齿轮按钮同款样式，见 App.css 的 .icon-btn），
 * 用于卡片/标题栏右上角的单个图标动作。图标通过 children 传入 SVG；
 * label 同时驱动 title 与 aria-label，避免散落的图标按钮各自写样式。
 */
export function IconButton({ label, children, ...rest }: IconButtonProps) {
  return (
    <button type="button" className="icon-btn" title={label} aria-label={label} {...rest}>
      {children}
    </button>
  );
}
