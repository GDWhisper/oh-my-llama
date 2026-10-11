import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { TaskbarMetrics } from './TaskbarMetrics';
import './widget.css';

// 任务栏小窗（widget.html）的独立入口：窗口由 Rust 侧 taskbar_widget 模块创建，
// 页面只负责绘制条带、轮询指标、把量出的尺寸上报回去（taskbar_widget_ready）。
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <TaskbarMetrics />
    </I18nProvider>
  </React.StrictMode>,
);
