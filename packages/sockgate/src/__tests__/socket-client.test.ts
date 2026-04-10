import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocketClient } from '../socket-client';

// ─── WebSocket Mock ───────────────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readyState = WebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((e: Partial<CloseEvent>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;

  send = vi.fn();
  close = vi.fn();

  addEventListener = vi.fn();
  removeEventListener = vi.fn();

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }

  simulateOpen() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }
}

function lastWs() {
  return MockWebSocket.instances.at(-1)!;
}

function createClient() {
  const client = new SocketClient({ url: 'ws://localhost' });
  client.connect();
  lastWs().simulateOpen();
  return client;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SocketClient.subscribe / unsubscribe', () => {
  it('subscribe() 호출 시 subscribeData를 서버에 전송한다', () => {
    const client = createClient();

    client.subscribe('chat', 'SUB chat', 'UNSUB chat');

    expect(lastWs().send).toHaveBeenCalledWith('SUB chat');
  });

  it('unsubscribe() 호출 시 저장된 unsubscribeData를 서버에 전송한다', () => {
    const client = createClient();
    client.subscribe('chat', 'SUB chat', 'UNSUB chat');
    lastWs().send.mockClear();

    client.unsubscribe('chat');

    expect(lastWs().send).toHaveBeenCalledWith('UNSUB chat');
  });

  it('subscribe()하지 않은 토픽을 unsubscribe()해도 에러가 발생하지 않는다', () => {
    const client = createClient();
    expect(() => client.unsubscribe('unknown')).not.toThrow();
  });

  it('unsubscribe() 후 같은 토픽을 다시 unsubscribe()해도 두 번 전송하지 않는다', () => {
    const client = createClient();
    client.subscribe('chat', 'SUB chat', 'UNSUB chat');
    client.unsubscribe('chat');
    lastWs().send.mockClear();

    client.unsubscribe('chat');

    expect(lastWs().send).not.toHaveBeenCalled();
  });

  it('여러 토픽을 독립적으로 구독/해제한다', () => {
    const client = createClient();
    client.subscribe('chat', 'SUB chat', 'UNSUB chat');
    client.subscribe('news', 'SUB news', 'UNSUB news');
    lastWs().send.mockClear();

    client.unsubscribe('chat');

    expect(lastWs().send).toHaveBeenCalledWith('UNSUB chat');
    expect(lastWs().send).not.toHaveBeenCalledWith('UNSUB news');
  });

  it('ISocketClient 타입으로도 subscribe/unsubscribe를 호출할 수 있다', () => {
    const client: import('../types').ISocketClient = createClient();

    expect(() => client.subscribe('chat', 'SUB', 'UNSUB')).not.toThrow();
    expect(() => client.unsubscribe('chat')).not.toThrow();
  });
});

describe('재연결 시 자동 재구독', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createReconnectClient() {
    const client = new SocketClient({
      url: 'ws://localhost',
      reconnect: { delay: 100, delayMax: 100, factor: 0 },
    });
    client.connect();
    lastWs().simulateOpen();
    return client;
  }

  function simulateReconnect() {
    lastWs().onclose?.({ code: 1006, reason: '', wasClean: false });
    vi.advanceTimersByTime(200);
    lastWs().simulateOpen();
  }

  it('재연결 시 모든 구독이 replay된다', () => {
    const client = createReconnectClient();
    client.subscribe('chat', 'SUB chat', 'UNSUB chat');
    client.subscribe('news', 'SUB news', 'UNSUB news');

    simulateReconnect();

    expect(lastWs().send).toHaveBeenCalledWith('SUB chat');
    expect(lastWs().send).toHaveBeenCalledWith('SUB news');
  });

  it('unsubscribe된 토픽은 replay되지 않는다', () => {
    const client = createReconnectClient();
    client.subscribe('chat', 'SUB chat', 'UNSUB chat');
    client.unsubscribe('chat');

    simulateReconnect();

    expect(lastWs().send).not.toHaveBeenCalledWith('SUB chat');
  });

  it('첫 open에서는 불필요한 전송이 없다', () => {
    const client = new SocketClient({
      url: 'ws://localhost',
      reconnect: { delay: 100, delayMax: 100, factor: 0 },
    });
    client.connect();
    lastWs().simulateOpen();

    expect(lastWs().send).not.toHaveBeenCalled();
  });

  it('여러 번 재연결 시 매번 replay된다', () => {
    const client = createReconnectClient();
    client.subscribe('chat', 'SUB chat', 'UNSUB chat');

    simulateReconnect();
    expect(lastWs().send).toHaveBeenCalledWith('SUB chat');

    simulateReconnect();
    expect(lastWs().send).toHaveBeenCalledWith('SUB chat');
  });

  it('재연결 사이에 추가된 구독도 포함된다', () => {
    const client = createReconnectClient();
    client.subscribe('chat', 'SUB chat', 'UNSUB chat');

    simulateReconnect();
    client.subscribe('news', 'SUB news', 'UNSUB news');

    simulateReconnect();

    expect(lastWs().send).toHaveBeenCalledWith('SUB chat');
    expect(lastWs().send).toHaveBeenCalledWith('SUB news');
  });
});
