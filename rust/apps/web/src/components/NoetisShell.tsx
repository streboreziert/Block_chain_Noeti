'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  executeCommand,
  loadShellState,
  COMMAND_HINTS,
  type ShellLine,
  type ShellMode,
  type ShellState,
} from '../lib/shell';

interface NoetisShellProps {
  initialMode?: ShellMode;
  fullScreen?: boolean;
  compact?: boolean;
}

const BOOT_LINES: ShellLine[] = [
  { text: 'NOETIS INTERACTIVE SHELL v0.1.0', cls: 'ok' },
  { text: 'TYPE "help" FOR AVAILABLE COMMANDS', cls: 'info' },
  { text: 'TYPE "mode user" OR "mode node" TO SWITCH CONTEXT', cls: 'info' },
  { text: '' },
];

export function NoetisShell({ initialMode = 'user', fullScreen = false, compact = false }: NoetisShellProps) {
  const [lines, setLines] = useState<ShellLine[]>(BOOT_LINES);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [shellState, setShellState] = useState<ShellState>(() => loadShellState());
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setShellState((s) => ({ ...loadShellState(), mode: initialMode, apiUrl: s.apiUrl }));
  }, [initialMode]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, busy]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const appendLines = useCallback((newLines: ShellLine[]) => {
    if (newLines.length === 0) {
      setLines(BOOT_LINES);
      return;
    }
    setLines((prev) => [...prev.slice(-500), ...newLines]);
  }, []);

  const runCommand = useCallback(async (cmd: string) => {
    if (!cmd.trim() || busy) return;
    setBusy(true);
    setHistory((h) => [...h.filter((c) => c !== cmd), cmd]);
    setHistIdx(-1);
    setInput('');
    setSuggestions([]);

    const { lines: result, state } = await executeCommand(cmd, shellState);
    setShellState(state);
    appendLines(result);
    window.dispatchEvent(new Event('noetis-state-change'));
    setBusy(false);
  }, [busy, shellState, appendLines]);

  useEffect(() => {
    const handler = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      if (cmd) runCommand(cmd);
    };
    document.addEventListener('noetis-cmd', handler);
    return () => document.removeEventListener('noetis-cmd', handler);
  }, [runCommand]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      runCommand(input);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setInput(history[idx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === -1) return;
      const idx = histIdx + 1;
      if (idx >= history.length) { setHistIdx(-1); setInput(''); }
      else { setHistIdx(idx); setInput(history[idx]); }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const match = COMMAND_HINTS.filter((h) => h.startsWith(input.toLowerCase()));
      if (match.length === 1) setInput(match[0] + ' ');
      else setSuggestions(match.slice(0, 6));
    }
  }

  function handleInputChange(val: string) {
    setInput(val);
    if (val.length > 0) {
      setSuggestions(COMMAND_HINTS.filter((h) => h.startsWith(val.toLowerCase())).slice(0, 5));
    } else {
      setSuggestions([]);
    }
  }

  const isNode = shellState.mode === 'node';

  return (
    <div className={`noetis-shell ${fullScreen ? 'noetis-shell-full' : ''} ${compact ? 'noetis-shell-compact' : ''} ${isNode ? 'noetis-shell-node' : ''}`}>
      <div className={`terminal-header ${isNode ? 'terminal-header-node' : ''}`}>
        <span>[ NOETIS SHELL — {shellState.mode.toUpperCase()} MODE ]</span>
        <div className="terminal-dots">
          <span className={`terminal-dot ${busy ? 'warn' : 'active'}`} />
          <span className="terminal-dot" />
          <span className="terminal-dot" />
        </div>
      </div>

      <div className="shell-output" onClick={() => inputRef.current?.focus()}>
        {lines.map((line, i) => (
          <div key={i} className={`shell-line ${line.cls ?? ''}`}>
            {line.text || '\u00A0'}
          </div>
        ))}
        {busy && (
          <div className="shell-line info">
            <span className="cursor-blink">&nbsp;</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {suggestions.length > 0 && (
        <div className="shell-suggestions">
          {suggestions.map((s) => (
            <button key={s} type="button" className="shell-suggestion" onClick={() => { setInput(s + ' '); setSuggestions([]); inputRef.current?.focus(); }}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="shell-input-row">
        <span className={`shell-prompt ${isNode ? 'shell-prompt-node' : ''}`}>
          noetis@{shellState.mode}:~$
        </span>
        <input
          ref={inputRef}
          className="shell-input"
          value={input}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="type a command..."
        />
      </div>
    </div>
  );
}
