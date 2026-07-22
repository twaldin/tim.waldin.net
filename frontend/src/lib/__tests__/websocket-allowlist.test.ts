import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: false,
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

import { io } from 'socket.io-client';
import { createWebSocketManager } from '../websocket';

function connectFrom(pathname: string): void {
  vi.stubGlobal('window', {
    location: {
      pathname,
      protocol: 'https:',
      host: 'example.test',
    },
  });
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => 'test-session'),
    setItem: vi.fn(),
  });

  createWebSocketManager().connect();
}

function expectInitCommand(initCommand: string | undefined): void {
  expect(io).toHaveBeenLastCalledWith(
    'https://example.test',
    expect.objectContaining({
      auth: expect.objectContaining({ initCommand }),
    }),
  );
}

describe('URL command allowlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows a navigation command', () => {
    connectFrom('/about');
    expectInitCommand('about');
  });

  it('rejects command-prefix bypasses of the old denylist', () => {
    connectFrom('/command%20rm%20-rf%20%2F');
    expectInitCommand(undefined);
  });

  it('allows blog with a valid slug', () => {
    connectFrom('/blog/valid-slug');
    expectInitCommand('blog valid-slug');
  });

  it('rejects blog traversal outside the slug grammar', () => {
    connectFrom('/blog/../../etc');
    expectInitCommand(undefined);
  });
});
