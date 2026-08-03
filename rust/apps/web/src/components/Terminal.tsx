'use client';

import { useEffect, useRef, useState } from 'react';

export interface LogLine {
  text: string;
  cls?: 'ok' | 'warn' | 'err' | 'info' | '';
  ts?: string;
}

function timestamp() {
  return new Date().toISOString().slice(11, 19);
}

interface TerminalProps {
  title: string;
  lines: LogLine[];
  variant?: 'user' | 'node';
  live?: boolean;
  children?: React.ReactNode;
}

export function Terminal({ title, lines, variant = 'user', live, children }: TerminalProps) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  return (
    <div className="terminal">
      <div className={`terminal-header ${variant === 'node' ? 'terminal-header-node' : ''}`}>
        <span>[ {title} ]{live && ' ● LIVE'}</span>
        <div className="terminal-dots">
          <span className={`terminal-dot ${live ? 'active' : ''}`} />
          <span className="terminal-dot" />
          <span className="terminal-dot" />
        </div>
      </div>
      <div className="terminal-body">
        {lines.length > 0 && (
          <div className="terminal-log" ref={logRef}>
            {lines.map((line, i) => (
              <span key={i} className="terminal-log-line">
                <span className="ts">[{line.ts ?? timestamp()}]</span>{' '}
                <span className={line.cls ?? ''}>{line.text}</span>
              </span>
            ))}
            {live && <span className="terminal-log-line cursor-blink">&nbsp;</span>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function useTerminalLog(initial: LogLine[] = []) {
  const [lines, setLines] = useState<LogLine[]>(initial);
  const push = (text: string, cls: LogLine['cls'] = '') => {
    setLines((prev) => [...prev.slice(-80), { text, cls, ts: timestamp() }]);
  };
  return { lines, push, setLines };
}
