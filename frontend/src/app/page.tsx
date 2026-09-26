'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useCallback, useState, type RefObject } from 'react';
import { createWebSocketManager, pathToCommand, WebSocketManager } from '@/lib/websocket';
import type { TerminalRef } from '@/components/Terminal';
import type { RoomViewHandle } from '@/room/RoomView';
import { resolveView, setActiveTerminalView, type TerminalView } from '@/lib/view-preference';

// xterm references browser globals (`self`) at module level — skip SSR.
const Terminal = dynamic(() => import('@/components/Terminal'), { ssr: false });
// The 3D room (three.js + the terminal on a monitor) only loads when chosen.
const RoomView = dynamic(() => import('@/room/RoomView'), { ssr: false });

// In the room the backend auto-types nothing ('' sentinel); the hands type
// the URL's command at the first prompt instead, the same string the
// backend would have typed.
function connectRoomSession(wsManager: WebSocketManager, pendingTypedCommand: RefObject<string | null>) {
  pendingTypedCommand.current = pathToCommand(window.location.pathname) ?? 'boot';
  wsManager.connect({ initCommand: '' });
}

export default function Home() {
  const wsManagerRef = useRef<WebSocketManager | null>(null);
  const terminalRef = useRef<TerminalRef | RoomViewHandle | null>(null);
  // Room view: the command the hands type once the first prompt shows.
  const pendingTypedCommandRef = useRef<string | null>(null);
  const [view, setView] = useState<TerminalView | null>(null);
  const connectedOnceRef = useRef(false);
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

    wsManager.onSessionEnd(() => {
      // Session ended (exit, idle timeout, dead container). Show the "session
      // ended" message briefly, then reset URL to / and reconnect. Resetting
      // the URL prevents a loop where the current path (e.g. /exit) is re-read
      // as the initCommand, which would immediately end the next session too.
      setTimeout(() => {
        if (typeof window !== 'undefined') {
          window.history.replaceState(null, '', '/');
        }
        const terminal = terminalRef.current;
        terminal?.clearTerminal();
        if (terminal && 'typeCommand' in terminal) connectRoomSession(wsManager, pendingTypedCommandRef);
        else wsManager.connect();
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

      const pending = pendingTypedCommandRef.current;
      const terminal = terminalRef.current;
      if (pending && terminal && 'typeCommand' in terminal && plain.includes('❯ ')) {
        pendingTypedCommandRef.current = null;
        setTimeout(() => terminal.typeCommand(pending), 450);
      }
    });

    // The room connects once its scene is on screen (RoomView's onReady) so
    // the boot intro plays on the monitor instead of behind the loading screen.
    const resolvedView = resolveView();
    setView(resolvedView);
    setActiveTerminalView(resolvedView);
    if (resolvedView === 'classic') {
      connectedOnceRef.current = true;
      wsManager.connect();
    }

    return () => {
      setActiveTerminalView(null);
      wsManager.disconnect();
    };
  }, []);

  const handleTerminalData = useCallback((data: string) => {
    wsManagerRef.current?.sendInput(data);
  }, []);

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    wsManagerRef.current?.resize(cols, rows);
  }, []);

  const connectOnce = useCallback(() => {
    if (connectedOnceRef.current) return;
    connectedOnceRef.current = true;
    wsManagerRef.current?.connect();
  }, []);

  const connectRoom = useCallback(() => {
    const wsManager = wsManagerRef.current;
    if (connectedOnceRef.current || !wsManager) return;
    connectedOnceRef.current = true;
    connectRoomSession(wsManager, pendingTypedCommandRef);
  }, []);

  const setRoomHandle = useCallback((handle: RoomViewHandle | null) => {
    terminalRef.current = handle;
  }, []);

  const handleRoomFail = useCallback(() => {
    setView('classic');
    setActiveTerminalView('classic');
    connectOnce();
  }, [connectOnce]);

  return (
    <div
      className="terminal-page w-full flex-1"
      style={{
        minHeight: 0,
        position: 'relative',
        overflowY: view === 'room' ? 'hidden' : 'auto',
        WebkitOverflowScrolling: 'touch',
        background: 'var(--color-bg)',
      }}
    >
      {view === 'classic' && (
        <Terminal
          ref={terminalRef}
          onData={handleTerminalData}
          onResize={handleTerminalResize}
        />
      )}
      {view === 'room' && (
        <RoomView
          ref={setRoomHandle}
          onData={handleTerminalData}
          onResize={handleTerminalResize}
          onReady={connectRoom}
          onFail={handleRoomFail}
        />
      )}
    </div>
  );
}
