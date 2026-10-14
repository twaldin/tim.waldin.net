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

const handshakeAuth = (call: number) => vi.mocked(io).mock.calls[call][1]?.auth;

describe('handshake session ids', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      location: { pathname: '/', protocol: 'https:', host: 'example.test' },
    });
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps one site session id across reconnects when storage throws', () => {
    const blocked = () => {
      throw new Error('SecurityError: storage is disabled');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });

    const manager = createWebSocketManager();
    manager.connect();
    manager.connect();

    expect(handshakeAuth(0)).toStrictEqual({ initCommand: 'boot', sessionId: '00000000-0000-4000-8000-000000000001' });
    expect(handshakeAuth(1)).toStrictEqual({ initCommand: 'boot', sessionId: '00000000-0000-4000-8000-000000000001' });
  });

  it('sends embed handshakes without an initCommand and a separate id per embed', () => {
    createWebSocketManager({ kind: 'embed' }).connect();
    createWebSocketManager({ kind: 'embed' }).connect();

    expect(handshakeAuth(0)).toStrictEqual({ kind: 'embed', sessionId: '00000000-0000-4000-8000-000000000001' });
    expect(handshakeAuth(1)).toStrictEqual({ kind: 'embed', sessionId: '00000000-0000-4000-8000-000000000002' });
  });
});
