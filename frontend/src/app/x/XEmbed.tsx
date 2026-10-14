'use client';

import dynamic from 'next/dynamic';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import type { TerminalKey, TerminalRef } from '@/components/Terminal';
import { createEmbedClient, type EmbedClient } from '@/lib/embed-client';
import { initialEmbedState, type EmbedState } from '@/lib/embed-machine';

// xterm references browser globals (`self`) at module level — skip SSR.
const Terminal = dynamic(() => import('@/components/Terminal'), { ssr: false });

const EXTRA_KEYS: ReadonlyArray<readonly [label: string, key: TerminalKey | 'ctrl']> = [
  ['esc', 'escape'],
  ['tab', 'tab'],
  ['ctrl', 'ctrl'],
  ['←', 'left'],
  ['↑', 'up'],
  ['↓', 'down'],
  ['→', 'right'],
  ['⏎', 'enter'],
];

const KEY_STYLE: CSSProperties = {
  flex: '1 1 0',
  minWidth: 0,
  padding: '8px 0',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--color-fg)',
  font: 'inherit',
  fontSize: 14,
  touchAction: 'manipulation',
};

const ARMED_KEY_STYLE: CSSProperties = {
  ...KEY_STYLE,
  background: 'var(--color-green)',
  color: 'var(--color-bg)',
};

// mousedown is where a button takes focus, which would blur xterm and close
// the on-screen keyboard.
const keepTerminalFocus = (event: MouseEvent) => event.preventDefault();

function statusLine(state: EmbedState): string {
  switch (state.phase) {
    case 'tour':
      return '▶ tap or press any key for a live shell';
    case 'connecting':
      return 'connecting…';
    case 'live':
      return '● live shell';
    case 'busy':
      return state.reason === 'capacity'
        ? 'all shells are busy · press any key to retry'
        : 'too many shells from your network · press any key to retry';
    case 'ended':
      return 'session ended · press any key for a new shell';
  }
}

// Sticky ctrl turns the next typed character into its control code (c → ^C).
function withCtrl(data: string): string {
  const code = data.toUpperCase().charCodeAt(0);
  return data.length === 1 && code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data;
}

export default function XEmbed() {
  const rootRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<EmbedClient | null>(null);
  const ctrlArmedRef = useRef(false);
  // xterm loads in its own chunk; a tap or key before then still starts a shell.
  const earlyGestureRef = useRef(false);
  const markEarlyGesture = useCallback(() => { earlyGestureRef.current = true; }, []);
  const [terminal, setTerminal] = useState<TerminalRef | null>(null);
  const [state, setState] = useState<EmbedState>(initialEmbedState);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);

  useEffect(() => {
    setCoarsePointer(window.matchMedia('(pointer: coarse)').matches);
    window.addEventListener('keydown', markEarlyGesture, { capture: true, once: true });
    return () => window.removeEventListener('keydown', markEarlyGesture, { capture: true });
  }, [markEarlyGesture]);

  useEffect(() => {
    const root = rootRef.current;
    if (!terminal || !root) return;
    const client = createEmbedClient({ root, terminal, onChange: setState });
    clientRef.current = client;
    if (earlyGestureRef.current) client.gesture();
    return () => {
      clientRef.current = null;
      client.destroy();
    };
  }, [terminal]);

  const handleData = useCallback((data: string) => {
    let input = data;
    if (ctrlArmedRef.current) {
      ctrlArmedRef.current = false;
      setCtrlArmed(false);
      input = withCtrl(data);
    }
    clientRef.current?.input(input);
  }, []);

  const handleResize = useCallback((cols: number, rows: number) => {
    clientRef.current?.resize(cols, rows);
  }, []);

  const toggleCtrl = () => {
    ctrlArmedRef.current = !ctrlArmedRef.current;
    setCtrlArmed(ctrlArmedRef.current);
  };

  const idle = state.phase === 'live' || state.phase === 'connecting';

  return (
    <div
      ref={rootRef}
      onPointerDownCapture={markEarlyGesture}
      style={{
        flex: '1 1 auto',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg)',
      }}
    >
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
        <Terminal ref={setTerminal} embedded onData={handleData} onResize={handleResize} />
      </div>
      {coarsePointer && (
        <div
          role="toolbar"
          aria-label="Terminal keys"
          style={{ flexShrink: 0, display: 'flex', gap: 6, padding: '6px 14px 0' }}
        >
          {EXTRA_KEYS.map(([label, key]) => (
            <button
              key={key}
              type="button"
              tabIndex={-1}
              aria-pressed={key === 'ctrl' ? ctrlArmed : undefined}
              onMouseDown={keepTerminalFocus}
              onClick={key === 'ctrl' ? toggleCtrl : () => terminal?.pressKey(key)}
              style={key === 'ctrl' && ctrlArmed ? ARMED_KEY_STYLE : KEY_STYLE}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div
        role="status"
        style={{
          flexShrink: 0,
          padding: '4px 14px',
          color: idle ? 'var(--color-dim)' : 'var(--color-green)',
          fontSize: 12,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          cursor: idle ? 'default' : 'pointer',
        }}
      >
        {statusLine(state)}
      </div>
    </div>
  );
}
