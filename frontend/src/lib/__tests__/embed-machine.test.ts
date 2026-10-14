import { describe, expect, it } from 'vitest';
import { transition, type EmbedEvent, type EmbedState } from '../embed-machine';

const run = (state: EmbedState, ...events: EmbedEvent[]) => events.reduce(transition, state);

describe('embed state machine', () => {
  it('starts connecting on the first gesture over the tour', () => {
    expect(transition({ phase: 'tour', hidden: false }, { type: 'gesture' }))
      .toEqual({ phase: 'connecting', attempt: 0, hidden: false });
  });

  it('goes live once the connection delivers a session', () => {
    expect(transition({ phase: 'connecting', attempt: 0, hidden: false }, { type: 'connected' }))
      .toEqual({ phase: 'live', hidden: false });
  });

  it('shows busy with the denial reason and keeps the attempt count', () => {
    expect(transition({ phase: 'connecting', attempt: 3, hidden: false }, { type: 'denied', reason: 'ip-cap' }))
      .toEqual({ phase: 'busy', reason: 'ip-cap', attempt: 3, hidden: false });
  });

  it('treats an unavailable backend as an ended session', () => {
    expect(transition({ phase: 'connecting', attempt: 0, hidden: false }, { type: 'denied', reason: 'unavailable' }))
      .toEqual({ phase: 'ended', hidden: false });
  });

  it('stays busy when the server disconnects after denying', () => {
    expect(transition({ phase: 'busy', reason: 'capacity', attempt: 2, hidden: false }, { type: 'disconnected' }))
      .toEqual({ phase: 'busy', reason: 'capacity', attempt: 2, hidden: false });
  });

  it('auto-retries a visible busy embed with the next attempt number', () => {
    expect(transition({ phase: 'busy', reason: 'capacity', attempt: 3, hidden: false }, { type: 'retryTimer' }))
      .toEqual({ phase: 'connecting', attempt: 4, hidden: false });
  });

  it('does not auto-retry while hidden', () => {
    expect(transition({ phase: 'busy', reason: 'capacity', attempt: 3, hidden: true }, { type: 'retryTimer' }))
      .toEqual({ phase: 'busy', reason: 'capacity', attempt: 3, hidden: true });
  });

  it('stops auto-retrying at ten attempts', () => {
    expect(transition({ phase: 'busy', reason: 'capacity', attempt: 10, hidden: false }, { type: 'retryTimer' }))
      .toEqual({ phase: 'busy', reason: 'capacity', attempt: 10, hidden: false });
  });

  it('carries the attempt count through repeated denials until the cap', () => {
    const denied: EmbedEvent[] = [
      { type: 'denied', reason: 'capacity' },
      { type: 'disconnected' },
      { type: 'retryTimer' },
    ];
    const rounds = Array.from({ length: 12 }, () => denied).flat();
    expect(run({ phase: 'connecting', attempt: 0, hidden: false }, ...rounds))
      .toEqual({ phase: 'busy', reason: 'capacity', attempt: 10, hidden: false });
  });

  it('retries on a gesture from busy with a fresh attempt count', () => {
    expect(transition({ phase: 'busy', reason: 'ip-cap', attempt: 10, hidden: false }, { type: 'gesture' }))
      .toEqual({ phase: 'connecting', attempt: 0, hidden: false });
  });

  it('starts a new session on a gesture after the last one ended', () => {
    expect(transition({ phase: 'ended', hidden: false }, { type: 'gesture' }))
      .toEqual({ phase: 'connecting', attempt: 0, hidden: false });
  });

  it('ends a live session on disconnect', () => {
    expect(transition({ phase: 'live', hidden: false }, { type: 'disconnected' }))
      .toEqual({ phase: 'ended', hidden: false });
  });

  it('ends a connection attempt that drops before any session', () => {
    expect(transition({ phase: 'connecting', attempt: 0, hidden: false }, { type: 'disconnected' }))
      .toEqual({ phase: 'ended', hidden: false });
  });

  it('records visibility without changing the phase', () => {
    expect(transition({ phase: 'live', hidden: false }, { type: 'visibilityChanged', hidden: true }))
      .toEqual({ phase: 'live', hidden: true });
  });

  it('ignores events that do not apply to the current phase', () => {
    expect(run(
      { phase: 'tour', hidden: false },
      { type: 'connected' },
      { type: 'disconnected' },
      { type: 'retryTimer' },
      { type: 'denied', reason: 'capacity' },
    )).toEqual({ phase: 'tour', hidden: false });
    expect(run(
      { phase: 'live', hidden: false },
      { type: 'gesture' },
      { type: 'connected' },
      { type: 'retryTimer' },
      { type: 'denied', reason: 'capacity' },
    )).toEqual({ phase: 'live', hidden: false });
    expect(run({ phase: 'connecting', attempt: 2, hidden: false }, { type: 'gesture' }, { type: 'retryTimer' }))
      .toEqual({ phase: 'connecting', attempt: 2, hidden: false });
    expect(run({ phase: 'ended', hidden: false }, { type: 'disconnected' }, { type: 'retryTimer' }, { type: 'connected' }))
      .toEqual({ phase: 'ended', hidden: false });
  });
});
