'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useCallback, useState } from 'react';
import { createWebSocketManager, WebSocketManager } from '@/lib/websocket';
import { terminalTheme } from '@/config/terminal-theme';
import AsciiContainerLoader from '@/components/AsciiContainerLoader';
import type { LoaderMode } from '@/lib/ascii-loader';

// xterm references browser globals (`self`) at module level — skip SSR.
const Terminal = dynamic(() => import('@/components/Terminal'), { ssr: false });

export default function Home() {
  const wsManagerRef = useRef<WebSocketManager | null>(null);
  const terminalRef = useRef<{ writeToTerminal: (data: string) => void; clearTerminal: () => void; fitTerminal: () => void } | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [containerReady, setContainerReady] = useState(false);
  const [loaderMode, setLoaderMode] = useState<LoaderMode | null>(null);
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

    wsManager.onSessionStatus((status) => {
      if (status.mode === 'resume') {
        setLoaderMode('resume');
      } else {
        setLoaderMode('cold');
      }
    });

    wsManager.onDisconnect(() => {});

    wsManager.onError(() => {});

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

      setContainerReady(true);
      if (terminalRef.current) {
        terminalRef.current.writeToTerminal(data);
      }
    });

    wsManager.connect();

    return () => {
      wsManager.disconnect();
    };
  }, []);

  // Auto-dismiss skeleton after 10s so it never permanently blocks the
  // terminal — if the WS is rate-limited or slow, xterm still shows.
  useEffect(() => {
    const t = setTimeout(() => setShowSkeleton(false), 10000);
    return () => clearTimeout(t);
  }, []);


  const handleTerminalData = useCallback((data: string) => {
    wsManagerRef.current?.sendInput(data);
  }, []);

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    wsManagerRef.current?.resize(cols, rows);
  }, []);

  const handleLoaderFinished = useCallback(() => {
    setShowSkeleton(false);
  }, []);

  return (
    <div className="terminal-page w-full flex-1 bg-black" style={{ minHeight: 0, position: 'relative', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      {showSkeleton && loaderMode && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: terminalTheme.background,
          fontFamily: 'JetBrains Mono, monospace',
          pointerEvents: 'none',
        }}>
          <AsciiContainerLoader
            mode={loaderMode}
            ready={containerReady}
            onFinished={handleLoaderFinished}
          />
        </div>
      )}
      <Terminal
        ref={terminalRef}
        onData={handleTerminalData}
        onResize={handleTerminalResize}
      />
    </div>
  );
}
