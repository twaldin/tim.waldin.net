'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useCallback } from 'react';
import { createWebSocketManager, WebSocketManager, type DenialReason } from '@/lib/websocket';
import type { TerminalRef } from '@/components/Terminal';

// xterm references browser globals (`self`) at module level — skip SSR.
const Terminal = dynamic(() => import('@/components/Terminal'), { ssr: false });

const DENIAL_MESSAGES: Record<DenialReason, string> = {
  capacity: 'Every shell is busy right now. Refresh in a minute to try again.',
  'ip-cap': 'Too many new shells from your network. Wait a minute, then refresh.',
  unavailable: 'The terminal is unavailable right now. Refresh to try again.',
};

export default function Home() {
  const wsManagerRef = useRef<WebSocketManager | null>(null);
  const terminalRef = useRef<TerminalRef | null>(null);
  // A denial can arrive before the Terminal chunk has mounted.
  const pendingNoticeRef = useRef<string | null>(null);
  const firstOutputSeenRef = useRef(false);
  const firstPromptSeenRef = useRef(false);
  const welcomeSeenRef = useRef(false);
  const readyPromptSeenRef = useRef(false);
  const promptCountRef = useRef(0);

  const stripAnsi = (s: string) =>
    s
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
      .replace(/\r/g, '');

  const mark = (name: string) => {
    if (typeof window === 'undefined') return;
    performance.mark(name);
    const w = window as Window & {
      __termTti?: {
        [key: string]: number;
      };
    };
    if (!w.__termTti) w.__termTti = {};
    w.__termTti[name] = performance.now();
  };

  useEffect(() => {
    mark('term:page-mounted');
    const wsManager = createWebSocketManager();
    wsManagerRef.current = wsManager;

    wsManager.onConnect(() => {
      mark('term:socket-connected');
    });


    wsManager.onDisconnect(() => {});

    wsManager.onError(() => {});

    wsManager.onDenied((reason) => {
      const notice = `\r\n${DENIAL_MESSAGES[reason]}\r\n`;
      if (terminalRef.current) terminalRef.current.writeToTerminal(notice);
      else pendingNoticeRef.current = notice;
    });

    wsManager.onSessionEnd(() => {
      // Session ended (exit, idle timeout, dead container). Show the "session
      // ended" message briefly, then reset URL to / and reconnect. Resetting
      // the URL prevents a loop where the current path (e.g. /exit) is re-read
      // as the initCommand, which would immediately end the next session too.
      setTimeout(() => {
        if (typeof window !== 'undefined') {
          window.history.replaceState(null, '', '/');
        }
        terminalRef.current?.clearTerminal();
        wsManager.connect();
      }, 1500);
    });

    wsManager.onTti((phase) => {
      if (phase === 'welcome-enter-sent' && !welcomeSeenRef.current) {
        welcomeSeenRef.current = true;
        mark('term:welcome-typed');
      }
    });

    wsManager.onOutput((data) => {
      if (!firstOutputSeenRef.current) {
        firstOutputSeenRef.current = true;
        mark('term:first-output');
      }

      const plain = stripAnsi(data);
      const promptMatches = plain.match(/❯ /g);
      if (promptMatches) {
        promptCountRef.current += promptMatches.length;
      }
      if (!firstPromptSeenRef.current && promptCountRef.current >= 1) {
        firstPromptSeenRef.current = true;
        mark('term:first-prompt');
      }
      if (!welcomeSeenRef.current && /welcome/i.test(plain)) {
        welcomeSeenRef.current = true;
        mark('term:welcome-typed');
      }
      if (!readyPromptSeenRef.current && promptCountRef.current >= 2) {
        readyPromptSeenRef.current = true;
        mark('term:ready-for-input');
      }

      if (terminalRef.current) {
        terminalRef.current.writeToTerminal(data);
      }
    });

    wsManager.connect();

    return () => {
      wsManager.disconnect();
    };
  }, []);



  const handleTerminalData = useCallback((data: string) => {
    wsManagerRef.current?.sendInput(data);
  }, []);

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    wsManagerRef.current?.resize(cols, rows);
  }, []);

  const attachTerminal = useCallback((terminal: TerminalRef | null) => {
    terminalRef.current = terminal;
    if (terminal && pendingNoticeRef.current) {
      terminal.writeToTerminal(pendingNoticeRef.current);
      pendingNoticeRef.current = null;
    }
  }, []);

  return (
    <div
      className="terminal-page w-full flex-1"
      style={{
        minHeight: 0,
        position: 'relative',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        background: 'var(--color-bg)',
      }}
    >
      <Terminal
        ref={attachTerminal}
        onData={handleTerminalData}
        onResize={handleTerminalResize}
      />
    </div>
  );
}
