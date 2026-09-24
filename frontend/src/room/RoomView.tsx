'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import Terminal, { type TerminalRef, type TerminalScreenHandle, type TerminalScreenSpec } from '@/components/Terminal';
import type { RoomEngine } from './engine/engine';

interface RoomViewProps {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  // The scene is on screen: time to connect so the boot intro plays on the monitor.
  onReady: () => void;
  // WebGL or asset failure: the page falls back to the classic terminal.
  onFail: () => void;
}

export interface RoomViewHandle extends TerminalRef {
  // Type a shell command (plus Enter) with the on-screen hands.
  typeCommand: (command: string) => void;
}

// About 100 columns on the virtual monitor: font = width / 64.
const WIDTH_PER_FONT_PX = 64;
const SOUND_STORAGE_KEY = 'term-site:room-sound';

// The hidden terminal's CSS size sets the monitor texture resolution
// (xterm renders at devicePixelRatio): roughly the panel's on-screen size
// when zoomed in, clamped so small windows stay sharp and huge ones cheap.
function computeScreenSpec(): TerminalScreenSpec {
  const dpr = window.devicePixelRatio || 1;
  const devicePixels = Math.min(2560, Math.max(1600, window.innerWidth * 0.9 * dpr));
  const width = Math.round(devicePixels / dpr);
  return {
    width,
    height: Math.round((width * 9) / 16),
    fontSize: Math.round((width / WIDTH_PER_FONT_PX) * 10) / 10,
  };
}

const hudButton: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4,
  padding: '4px 9px',
  background: 'rgba(8,8,10,0.55)',
  color: 'rgba(235,230,220,0.72)',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  backdropFilter: 'blur(6px)',
};

const RoomView = forwardRef<RoomViewHandle, RoomViewProps>(({ onData, onResize, onReady, onFail }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const terminalRef = useRef<TerminalRef>(null);
  const engineRef = useRef<RoomEngine | null>(null);
  const handleRef = useRef<TerminalScreenHandle | null>(null);
  const [screenSpec, setScreenSpec] = useState<TerminalScreenSpec | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [sound, setSound] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const callbacks = useRef({ onReady, onFail, onData });
  callbacks.current = { onReady, onFail, onData };

  useImperativeHandle(ref, () => ({
    writeToTerminal: (data) => terminalRef.current?.writeToTerminal(data),
    clearTerminal: () => terminalRef.current?.clearTerminal(),
    fitTerminal: () => terminalRef.current?.fitTerminal(),
    // Ctrl-U first: whatever a resumed shell left on its line goes, so the
    // hands' command runs alone (prints nothing when the line is empty).
    typeCommand: (command) => {
      callbacks.current.onData('\x15');
      engineRef.current?.typeText(`${command}\r`, (data) => callbacks.current.onData(data));
    },
  }), []);

  useEffect(() => {
    setScreenSpec(computeScreenSpec());
    try {
      setSound(window.localStorage.getItem(SOUND_STORAGE_KEY) === 'on');
    } catch {
      // Storage blocked: sound stays off.
    }
    let timer: ReturnType<typeof setTimeout>;
    const onWindowResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setScreenSpec(computeScreenSpec()), 200);
    };
    window.addEventListener('resize', onWindowResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onWindowResize);
    };
  }, []);

  const handleScreenReady = useCallback((handle: TerminalScreenHandle | null) => {
    handleRef.current = handle;
    engineRef.current?.bindTerminal(handle);
    setTerminalReady(Boolean(handle));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !terminalReady) return;
    let disposed = false;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    import('./engine/engine')
      .then(({ createRoomEngine }) =>
        createRoomEngine({
          canvas,
          getTerminal: () => handleRef.current,
          reducedMotion,
          onProgress: (fraction) => {
            if (!disposed) setProgress(fraction);
          },
          onZoom: (zoom) => {
            if (!disposed) setZoomed(zoom >= 0.5);
          },
        }),
      )
      .then((engine) => {
        if (disposed) {
          engine.dispose();
          return;
        }
        engineRef.current = engine;
        setLoaded(true);
        callbacks.current.onReady();
      })
      .catch((error: unknown) => {
        console.error('Room view failed to start:', error);
        if (!disposed) callbacks.current.onFail();
      });
    return () => {
      disposed = true;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [terminalReady]);

  useEffect(() => {
    engineRef.current?.setSound(sound);
  }, [sound, loaded]);

  // HUD buttons must not take keyboard focus away from the terminal.
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();
  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    try {
      window.localStorage.setItem(SOUND_STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      // Not persisted; still applies now.
    }
  };
  const toggleZoom = () => {
    const next = !zoomed;
    setZoomed(next);
    engineRef.current?.setZoom(next ? 1 : 0);
  };

  return (
    <div className="room-view" style={{ position: 'absolute', inset: 0, background: '#020203' }}>
      {screenSpec && (
        <Terminal ref={terminalRef} onData={onData} onResize={onResize} screen={screenSpec} onScreenReady={handleScreenReady} />
      )}
      <canvas
        ref={canvasRef}
        aria-label="A desk in a dark room; the terminal is on the monitor"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 1, display: 'block' }}
      />
      {loaded && (
        <div style={{ position: 'absolute', right: 14, bottom: 12, zIndex: 3, display: 'flex', gap: 8 }}>
          <button type="button" style={hudButton} onMouseDown={keepFocus} onClick={toggleZoom} aria-pressed={zoomed}>
            {zoomed ? 'sit back' : 'lean in'}
          </button>
          <button type="button" style={hudButton} onMouseDown={keepFocus} onClick={toggleSound} aria-pressed={sound}>
            {sound ? 'sound on' : 'sound off'}
          </button>
        </div>
      )}
      <div
        aria-hidden={loaded}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#020203',
          color: 'var(--color-dim)',
          fontSize: 13,
          letterSpacing: '0.04em',
          opacity: loaded ? 0 : 1,
          transition: 'opacity 900ms ease',
          pointerEvents: loaded ? 'none' : 'auto',
        }}
      >
        entering the room… {Math.round(progress * 100)}%
      </div>
    </div>
  );
});

RoomView.displayName = 'RoomView';
export default RoomView;
