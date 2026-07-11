import type { ServerLogLine } from "../types";

interface Props {
  logs: ServerLogLine[];
  onClear: () => void;
}

export function LogPanel({ logs, onClear }: Props) {
  return (
    <div className="panel">
      <h2>日志</h2>
      <div className="log-list">
        {logs.length === 0 && <div className="empty">暂无日志</div>}
        {logs.map((line, index) => (
          <div className="log-line" key={`${line.ts}-${index}`}>
            <div>{line.ts}</div>
            <div className={`level ${line.level}`}>{line.level}</div>
            <div>{line.text}</div>
          </div>
        ))}
      </div>
      <div className="actions">
        <button className="secondary" onClick={onClear}>
          清空日志
        </button>
      </div>
    </div>
  );
}
