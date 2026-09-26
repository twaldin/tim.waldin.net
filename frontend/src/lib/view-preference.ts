// Which presentation the terminal page uses: the flat full-window terminal
// ("classic") or the 3D desk scene with the terminal on a monitor ("room").
// The choice persists per browser; `?view=room` / `?view=classic` sets it.

export type TerminalView = 'classic' | 'room';

export const DEFAULT_VIEW: TerminalView = 'classic';

const VIEW_STORAGE_KEY = 'term-site:view';
const VIEW_PARAM = 'view';
const ROOM_MIN_VIEWPORT_WIDTH = 900;

function isTerminalView(value: string | null): value is TerminalView {
  return value === 'classic' || value === 'room';
}

function readStoredView(): TerminalView | null {
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return isTerminalView(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function setViewPreference(view: TerminalView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Blocked storage only loses the preference, not the switch itself.
  }
}

// The room needs WebGL2 (three.js and the xterm WebGL renderer it samples),
// a precise pointer and a physical keyboard; phones and tablets keep the
// classic terminal and its on-screen-keyboard handling. The WebGL2 probe
// creates a context, so it runs once per page load.
let hasWebgl2: boolean | undefined;
export function roomSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.innerWidth < ROOM_MIN_VIEWPORT_WIDTH) return false;
  if (!window.matchMedia('(pointer: fine) and (hover: hover)').matches) return false;
  if (hasWebgl2 === undefined) {
    const probe = document.createElement('canvas').getContext('webgl2');
    probe?.getExtension('WEBGL_lose_context')?.loseContext();
    hasWebgl2 = probe !== null;
  }
  return hasWebgl2;
}

// A `?view=` parameter wins and is persisted, then the stored choice, then
// DEFAULT_VIEW. The parameter is removed from the address bar so the URL keeps
// mirroring only the terminal command.
export function resolveView(): TerminalView {
  const url = new URL(window.location.href);
  const requested = url.searchParams.get(VIEW_PARAM);
  if (isTerminalView(requested)) {
    setViewPreference(requested);
    url.searchParams.delete(VIEW_PARAM);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
  const view = (isTerminalView(requested) ? requested : readStoredView()) ?? DEFAULT_VIEW;
  return view === 'room' && !roomSupported() ? 'classic' : view;
}

// The mounted terminal page publishes the view it is showing (null when no
// terminal page is mounted) so the header can offer the switch.
type ActiveViewListener = (view: TerminalView | null) => void;
const activeViewListeners = new Set<ActiveViewListener>();
let activeView: TerminalView | null = null;

export function setActiveTerminalView(view: TerminalView | null): void {
  activeView = view;
  for (const listener of activeViewListeners) listener(view);
}

export function subscribeActiveTerminalView(listener: ActiveViewListener): () => void {
  activeViewListeners.add(listener);
  listener(activeView);
  return () => {
    activeViewListeners.delete(listener);
  };
}
