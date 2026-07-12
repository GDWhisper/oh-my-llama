import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant =
  'primary' | 'secondary' | 'danger' | 'secondary-active' | 'secondary-danger';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  children: ReactNode;
}

/**
 * 公共按钮组件：收敛各面板里散落的 <button> 实例，保证颜色/字号/内边距/宽度一致。
 * - 宽度自适应内容（不拉伸、不固定宽）。
 * - variant 映射：primary=蓝色实心(默认/保存/启动)，secondary=白底灰边(取消/停止/预览/清空日志)，
 *   danger=红色实心(删除/清空参数/确认清空)，secondary-active=蓝色实心(添加中)，
 *   secondary-danger=红色实心(移除中)。
 */
export function Button({ variant = 'primary', children, ...rest }: ButtonProps) {
  return (
    <button className={`btn btn-${variant}`} {...rest}>
      {children}
    </button>
  );
}
