import { useEffect, useRef } from 'react';
import type { LogEntry } from '../hooks/use-socket';

const COLOR: Record<LogEntry['kind'], string> = {
  info: 'text-blue-400',
  send: 'text-green-400',
  recv: 'text-yellow-400',
  error: 'text-red-400',
  state: 'text-purple-400',
};

interface Props {
  logs: LogEntry[];
  onClear: () => void;
}

export function LogPanel({ logs, onClear }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="font-mono text-xs">
      <div className="flex justify-between items-center mb-1">
        <strong>Logs</strong>
        <button
          onClick={onClear}
          className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 cursor-pointer border-none text-gray-200"
        >
          clear
        </button>
      </div>
      <div className="bg-black rounded p-2 h-56 overflow-y-auto">
        {logs.map((l) => (
          <div key={l.ts + l.text} className={`leading-relaxed ${COLOR[l.kind]}`}>
            <span className="opacity-50">
              {new Date(l.ts).toLocaleTimeString('ko', { hour12: false })}{' '}
            </span>
            <span className="opacity-60 mr-1">[{l.kind}]</span>
            {l.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
