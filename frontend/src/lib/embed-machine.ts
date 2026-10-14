import type { DenialReason } from './websocket';

export type BusyReason = Exclude<DenialReason, 'unavailable'>;

export type EmbedPhase =
  | { phase: 'tour' }
  | { phase: 'connecting'; autoRetries: number }
  | { phase: 'live' }
  | { phase: 'busy'; reason: BusyReason; autoRetries: number }
  | { phase: 'ended' };

export type EmbedState = EmbedPhase & { hidden: boolean };

export type EmbedEvent =
  | { type: 'gesture' }
  | { type: 'connected' }
  | { type: 'denied'; reason: DenialReason }
  | { type: 'disconnected' }
  | { type: 'retryTimer' }
  | { type: 'visibilityChanged'; hidden: boolean };

export const MAX_AUTO_RETRIES = 10;
export const RETRY_MS = 30_000;

export const initialEmbedState: EmbedState = { phase: 'tour', hidden: false };

export function transition(state: EmbedState, event: EmbedEvent): EmbedState {
  const { hidden } = state;
  switch (event.type) {
    case 'visibilityChanged':
      return { ...state, hidden: event.hidden };
    case 'gesture':
      return state.phase === 'tour' || state.phase === 'busy' || state.phase === 'ended'
        ? { phase: 'connecting', autoRetries: 0, hidden }
        : state;
    case 'connected':
      return state.phase === 'connecting' ? { phase: 'live', hidden } : state;
    case 'denied':
      if (state.phase !== 'connecting') return state;
      return event.reason === 'unavailable'
        ? { phase: 'ended', hidden }
        : { phase: 'busy', reason: event.reason, autoRetries: state.autoRetries, hidden };
    case 'disconnected':
      return state.phase === 'connecting' || state.phase === 'live' ? { phase: 'ended', hidden } : state;
    case 'retryTimer':
      return state.phase === 'busy' && !hidden && state.autoRetries < MAX_AUTO_RETRIES
        ? { phase: 'connecting', autoRetries: state.autoRetries + 1, hidden }
        : state;
  }
}
