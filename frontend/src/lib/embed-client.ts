import type { TerminalRef } from '@/components/Terminal';
import {
  initialEmbedState,
  RETRY_MS,
  transition,
  type EmbedEvent,
  type EmbedState,
} from './embed-machine';
import { parseTour, playTour, RESET, type Tour } from './embed-tour';
import { createWebSocketManager } from './websocket';

const TOUR_URL = '/x/tour.json';
const HINT = '\x1b[90mlive shell: try projects, about, blog\x1b[0m\r\n';
const STATIC_SCREEN = '\r\n  tim.waldin.net\r\n\r\n  click for a live shell\r\n';

export interface EmbedClient {
  gesture: () => void;
  input: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  destroy: () => void;
}

interface EmbedClientOptions {
  root: HTMLElement;
  terminal: Pick<TerminalRef, 'writeToTerminal' | 'setGrid' | 'focus'>;
  onChange: (state: EmbedState) => void;
}

export function createEmbedClient({ root, terminal, onChange }: EmbedClientOptions): EmbedClient {
  let state = initialEmbedState;
  let intersecting = true;
  let tour: Tour | null = null;
  let stopTour: (() => void) | null = null;
  let retryInterval: ReturnType<typeof setInterval> | undefined;
  let pendingInput: string[] = [];
  let destroyed = false;

  const isHidden = () => document.visibilityState === 'hidden' || !intersecting;
  const manager = createWebSocketManager({ kind: 'embed', isHidden });

  const showTour = () => {
    stopTour?.();
    stopTour = null;
    if (tour) {
      terminal.setGrid({ cols: tour.cols, rows: tour.rows });
      stopTour = playTour(tour, terminal.writeToTerminal);
    } else {
      terminal.setGrid(null);
      terminal.writeToTerminal(RESET + STATIC_SCREEN);
    }
  };

  const enter = (next: EmbedState, previous: EmbedState) => {
    if (previous.phase === 'busy') clearInterval(retryInterval);
    switch (next.phase) {
      case 'connecting':
        pendingInput = [];
        manager.connect();
        break;
      case 'live':
        stopTour?.();
        stopTour = null;
        terminal.writeToTerminal(RESET + HINT);
        terminal.setGrid(null);
        pendingInput.forEach(manager.sendInput);
        pendingInput = [];
        break;
      case 'busy':
        retryInterval = setInterval(() => dispatch({ type: 'retryTimer' }), RETRY_MS);
        break;
      case 'ended':
        if (previous.phase === 'live') showTour();
        break;
    }
  };

  const dispatch = (event: EmbedEvent) => {
    // destroy() disconnects, and Socket.IO reports that synchronously.
    if (destroyed) return;
    const previous = state;
    state = transition(previous, event);
    if (state === previous) return;
    if (state.phase !== previous.phase) enter(state, previous);
    onChange(state);
  };

  manager.onOutput((data) => {
    if (state.phase === 'connecting') dispatch({ type: 'connected' });
    if (state.phase === 'live') terminal.writeToTerminal(data);
  });
  manager.onSessionStatus(() => dispatch({ type: 'connected' }));
  manager.onDenied((reason) => {
    dispatch({ type: 'denied', reason });
    manager.disconnect();
  });
  manager.onDisconnect(() => dispatch({ type: 'disconnected' }));
  manager.onSessionEnd(() => dispatch({ type: 'disconnected' }));
  manager.onError(() => {
    manager.disconnect();
    dispatch({ type: 'disconnected' });
  });

  // Focus moved during keydown still receives that key's character, so a
  // session started from the keyboard keeps its first keystroke.
  const handleGesture = () => {
    dispatch({ type: 'gesture' });
    terminal.focus();
  };
  const handleVisibility = () => dispatch({ type: 'visibilityChanged', hidden: isHidden() });
  const observer = new IntersectionObserver((entries) => {
    intersecting = entries[entries.length - 1].isIntersecting;
    manager.reportVisibility();
    handleVisibility();
  });

  root.addEventListener('pointerdown', handleGesture, { capture: true });
  window.addEventListener('keydown', handleGesture, { capture: true });
  document.addEventListener('visibilitychange', handleVisibility);
  observer.observe(root);
  handleVisibility();

  fetch(TOUR_URL)
    .then((response) => (response.ok ? response.json() : null))
    .then(parseTour, () => null)
    .then((loaded) => {
      if (destroyed) return;
      tour = loaded;
      if (state.phase !== 'live') showTour();
    });

  return {
    gesture: handleGesture,
    input: (data) => {
      if (state.phase === 'live') manager.sendInput(data);
      else if (state.phase === 'connecting') pendingInput.push(data);
    },
    resize: manager.resize,
    destroy: () => {
      destroyed = true;
      stopTour?.();
      clearInterval(retryInterval);
      observer.disconnect();
      root.removeEventListener('pointerdown', handleGesture, { capture: true });
      window.removeEventListener('keydown', handleGesture, { capture: true });
      document.removeEventListener('visibilitychange', handleVisibility);
      manager.disconnect();
    },
  };
}
