import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerCore } from '../shared-worker/worker-core';
import { SocketClient } from '../socket-client';
import { WorkerMessageType, type WorkerMessage } from '../types';

// ─── WebSocket Mock ───────────────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((e: Partial<CloseEvent>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSING;
  });

  private readonly _listeners: Record<string, Array<() => void>> = {};
  addEventListener(type: string, cb: () => void) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(cb);
  }
  removeEventListener(type: string, cb: () => void) {
    this._listeners[type] = (this._listeners[type] ?? []).filter((f) => f !== cb);
  }

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
    (this._listeners['open'] ?? []).forEach((cb) => cb());
  }

  simulateClose(code = 1000, reason = '', wasClean = true) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean });
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

// ─── MessagePort Mock ─────────────────────────────────────────────────────────

class MockPort {
  onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null = null;
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();

  deliver(msg: WorkerMessage) {
    this.onmessage?.(new MessageEvent('message', { data: msg }));
  }
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function lastWs() {
  return MockWebSocket.instances.at(-1)!;
}

function createCore() {
  const socket = new SocketClient({
    url: 'ws://localhost',
    reconnect: { delay: 100, delayMax: 100, factor: 0 },
  });
  return new WorkerCore({ socket });
}

/** 포트를 추가 (addPort 시 자동으로 연결 시작) */
function addPort(core: WorkerCore, port: MockPort) {
  core.addPort(port as unknown as MessagePort);
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkerCore', () => {
  describe('포트 관리', () => {
    it('addPort() 후 portCount가 증가한다', () => {
      const core = createCore();
      addPort(core, new MockPort());
      expect(core.portCount).toBe(1);
    });

    it('여러 포트를 등록할 수 있다', () => {
      const core = createCore();
      addPort(core, new MockPort());
      addPort(core, new MockPort());
      expect(core.portCount).toBe(2);
    });

    it('removePort() 후 portCount가 감소한다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      core.removePort(port as unknown as MessagePort);
      expect(core.portCount).toBe(0);
    });

    it('마지막 포트 제거 시 소켓이 닫힌다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      lastWs().simulateOpen();

      core.removePort(port as unknown as MessagePort);

      expect(lastWs().close).toHaveBeenCalled();
    });

    it('포트가 남아있으면 소켓을 닫지 않는다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      core.removePort(port1 as unknown as MessagePort);

      expect(lastWs().close).not.toHaveBeenCalled();
      expect(core.portCount).toBe(1);
    });
  });

  describe('keepalive (포트 생존 확인)', () => {
    it('첫 포트 추가 시 keepalive가 시작된다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);

      vi.advanceTimersByTime(30_000);

      const pings = port.postMessage.mock.calls.filter(
        ([msg]) => msg.type === WorkerMessageType.KEEPALIVE,
      );
      expect(pings).toHaveLength(1);
    });

    it('30초마다 KEEPALIVE를 broadcast한다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);

      vi.advanceTimersByTime(90_000);

      const pings = port.postMessage.mock.calls.filter(
        ([msg]) => msg.type === WorkerMessageType.KEEPALIVE,
      );
      expect(pings).toHaveLength(3);
    });

    it('마지막 포트 제거 시 keepalive가 멈춘다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      core.removePort(port as unknown as MessagePort);

      vi.advanceTimersByTime(90_000);

      const pings = port.postMessage.mock.calls.filter(
        ([msg]) => msg.type === WorkerMessageType.KEEPALIVE,
      );
      expect(pings).toHaveLength(0);
    });
  });

  describe('포트 추가 시 자동 연결', () => {
    it('첫 포트 추가 시 WebSocket이 생성된다', () => {
      const core = createCore();
      addPort(core, new MockPort());
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('두 번째 포트 추가 시 WebSocket은 하나만 유지된다', () => {
      const core = createCore();
      addPort(core, new MockPort());
      addPort(core, new MockPort());
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('두 번째 포트 추가 시 현재 state를 STATE_CHANGE로 전달한다', () => {
      const core = createCore();
      const port1 = new MockPort();
      addPort(core, port1);
      lastWs().simulateOpen();

      const port2 = new MockPort();
      addPort(core, port2);

      const stateMsg = port2.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.STATE_CHANGE,
      )?.[0];
      expect(stateMsg).toBeDefined();
    });

    it('소켓이 이미 OPEN일 때 두 번째 포트 추가 시 OPEN 이벤트를 즉시 전달한다', () => {
      const core = createCore();
      const port1 = new MockPort();
      addPort(core, port1);
      lastWs().simulateOpen();

      const port2 = new MockPort();
      addPort(core, port2);

      const openMsg = port2.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.OPEN,
      )?.[0];
      expect(openMsg).toBeDefined();
    });
  });

  describe('broadcast', () => {
    it('소켓 open 시 모든 포트에 OPEN 메시지를 전달한다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      port1.postMessage.mockClear();
      port2.postMessage.mockClear();

      lastWs().simulateOpen();

      expect(port1.postMessage).toHaveBeenCalledWith({ type: WorkerMessageType.OPEN });
      expect(port2.postMessage).toHaveBeenCalledWith({ type: WorkerMessageType.OPEN });
    });

    it('소켓 close 시 모든 포트에 CLOSE_EVENT 메시지를 전달한다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      lastWs().simulateClose(1006, 'gone', false);

      const expected = {
        type: WorkerMessageType.CLOSE_EVENT,
        payload: { code: 1006, reason: 'gone', wasClean: false },
      };
      expect(port1.postMessage).toHaveBeenCalledWith(expected);
      expect(port2.postMessage).toHaveBeenCalledWith(expected);
    });

    it('소켓 message 수신 시 모든 포트에 MESSAGE를 전달한다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      lastWs().simulateOpen();
      port.postMessage.mockClear();

      lastWs().simulateMessage('hello');

      const messageCall = port.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.MESSAGE,
      )?.[0];
      expect(messageCall?.payload?.data).toBe('hello');
    });

    it('소켓 error 시 모든 포트에 ERROR 메시지를 전달한다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      port.postMessage.mockClear();

      lastWs().simulateError();

      const errorCall = port.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.ERROR,
      )?.[0];
      expect(errorCall).toBeDefined();
    });

    it('stateChange 이벤트가 모든 포트에 STATE_CHANGE로 전달된다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      port1.postMessage.mockClear();
      port2.postMessage.mockClear();

      lastWs().simulateOpen();

      const stateMsg1 = port1.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.STATE_CHANGE,
      )?.[0];
      const stateMsg2 = port2.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.STATE_CHANGE,
      )?.[0];
      expect(stateMsg1).toBeDefined();
      expect(stateMsg2).toBeDefined();
    });

    it('postMessage가 throw하는 죽은 포트는 자동으로 제거된다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);

      port1.postMessage.mockImplementation(() => {
        throw new Error('port closed');
      });

      lastWs().simulateOpen();

      expect(core.portCount).toBe(1);
    });

    it('죽은 포트 제거 후 마지막 포트도 없으면 소켓이 닫힌다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      lastWs().simulateOpen();

      port.postMessage.mockImplementation(() => {
        throw new Error('port closed');
      });

      lastWs().simulateOpen();

      expect(core.portCount).toBe(0);
      expect(lastWs().close).toHaveBeenCalled();
    });
  });

  describe('SEND 처리', () => {
    it('OPEN 상태에서 SEND 메시지를 받으면 ws.send()를 호출한다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      lastWs().simulateOpen();

      port.deliver({ type: WorkerMessageType.SEND, payload: 'hello' });

      expect(lastWs().send).toHaveBeenCalledWith('hello');
    });

    it('OPEN이 아닌 상태에서 SEND는 해당 포트에 ERROR를 전달한다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      port.postMessage.mockClear();

      port.deliver({ type: WorkerMessageType.SEND, payload: 'hello' });

      const errorCall = port.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.ERROR,
      )?.[0];
      expect(errorCall).toBeDefined();
    });
  });

  describe('토픽 구독 레퍼런스 카운팅', () => {
    it('첫 번째 구독자일 때 서버에 subscribeData를 전송한다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      lastWs().simulateOpen();

      port.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });

      expect(lastWs().send).toHaveBeenCalledWith('SUB chat');
    });

    it('두 번째 구독자는 서버에 subscribeData를 전송하지 않는다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      port1.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });
      port2.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });

      expect(lastWs().send).toHaveBeenCalledTimes(1);
      expect(lastWs().send).toHaveBeenCalledWith('SUB chat');
    });

    it('topicSubscriberCount()가 구독자 수를 반환한다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      port1.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB', unsubscribeData: 'UNSUB' },
      });
      expect(core.topicSubscriberCount('chat')).toBe(1);

      port2.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB', unsubscribeData: 'UNSUB' },
      });
      expect(core.topicSubscriberCount('chat')).toBe(2);
    });

    it('마지막 구독자가 UNSUBSCRIBE하면 서버에 unsubscribeData를 전송한다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      lastWs().simulateOpen();

      port.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });
      lastWs().send.mockClear();

      port.deliver({ type: WorkerMessageType.UNSUBSCRIBE, payload: { topic: 'chat' } });

      expect(lastWs().send).toHaveBeenCalledWith('UNSUB chat');
    });

    it('구독자가 남아있으면 UNSUBSCRIBE 시 서버에 전송하지 않는다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      port1.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB', unsubscribeData: 'UNSUB' },
      });
      port2.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB', unsubscribeData: 'UNSUB' },
      });
      lastWs().send.mockClear();

      port1.deliver({ type: WorkerMessageType.UNSUBSCRIBE, payload: { topic: 'chat' } });

      expect(lastWs().send).not.toHaveBeenCalled();
      expect(core.topicSubscriberCount('chat')).toBe(1);
    });

    it('두 구독자 모두 UNSUBSCRIBE하면 서버에 한 번만 전송한다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      port1.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB', unsubscribeData: 'UNSUB' },
      });
      port2.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB', unsubscribeData: 'UNSUB' },
      });
      lastWs().send.mockClear();

      port1.deliver({ type: WorkerMessageType.UNSUBSCRIBE, payload: { topic: 'chat' } });
      port2.deliver({ type: WorkerMessageType.UNSUBSCRIBE, payload: { topic: 'chat' } });

      expect(lastWs().send).toHaveBeenCalledTimes(1);
      expect(lastWs().send).toHaveBeenCalledWith('UNSUB');
    });

    it('포트가 강제 제거(탭 닫힘)될 때 해당 토픽의 마지막 구독자라면 서버에 UNSUBSCRIBE를 전송한다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      // port1만 'private' 토픽 구독
      port1.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'private', subscribeData: 'SUB private', unsubscribeData: 'UNSUB private' },
      });
      lastWs().send.mockClear();

      // port1이 죽어서 강제 제거 (port2는 살아있음)
      core.removePort(port1 as unknown as MessagePort);

      expect(lastWs().send).toHaveBeenCalledWith('UNSUB private');
      expect(core.topicSubscriberCount('private')).toBe(0);
    });

    it('포트가 강제 제거될 때 다른 포트가 같은 토픽을 구독 중이면 서버에 전송하지 않는다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      port1.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB', unsubscribeData: 'UNSUB' },
      });
      port2.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB', unsubscribeData: 'UNSUB' },
      });
      lastWs().send.mockClear();

      core.removePort(port1 as unknown as MessagePort);

      expect(lastWs().send).not.toHaveBeenCalled();
      expect(core.topicSubscriberCount('chat')).toBe(1);
    });

    it('마지막 포트 제거 시 소켓이 닫히므로 UNSUBSCRIBE를 서버에 보내지 않는다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      lastWs().simulateOpen();

      port.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB', unsubscribeData: 'UNSUB' },
      });
      lastWs().send.mockClear();

      core.removePort(port as unknown as MessagePort);

      // socket.close()가 호출되었으므로 별도 UNSUBSCRIBE는 불필요
      expect(lastWs().send).not.toHaveBeenCalled();
      expect(lastWs().close).toHaveBeenCalled();
    });

    it('존재하지 않는 토픽에 UNSUBSCRIBE해도 에러가 발생하지 않는다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);

      expect(() => {
        port.deliver({ type: WorkerMessageType.UNSUBSCRIBE, payload: { topic: 'unknown' } });
      }).not.toThrow();
    });

    it('여러 토픽을 독립적으로 관리한다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      port1.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });
      port1.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'news', subscribeData: 'SUB news', unsubscribeData: 'UNSUB news' },
      });
      port2.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });
      lastWs().send.mockClear();

      // port1이 chat 해제 → port2가 남아있으므로 서버 전송 없음
      port1.deliver({ type: WorkerMessageType.UNSUBSCRIBE, payload: { topic: 'chat' } });
      expect(lastWs().send).not.toHaveBeenCalled();

      // port1이 news 해제 → 마지막 구독자이므로 서버에 전송
      port1.deliver({ type: WorkerMessageType.UNSUBSCRIBE, payload: { topic: 'news' } });
      expect(lastWs().send).toHaveBeenCalledWith('UNSUB news');
    });
  });

  describe('DETACH 처리', () => {
    it('DETACH 메시지를 받으면 해당 포트가 제거된다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);

      port.deliver({ type: WorkerMessageType.DETACH });

      expect(core.portCount).toBe(0);
    });

    it('마지막 포트 DETACH 시 소켓이 닫힌다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      lastWs().simulateOpen();

      port.deliver({ type: WorkerMessageType.DETACH });

      expect(lastWs().close).toHaveBeenCalled();
    });

    it('포트가 남아있으면 DETACH 후에도 소켓을 유지한다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      port1.deliver({ type: WorkerMessageType.DETACH });

      expect(lastWs().close).not.toHaveBeenCalled();
      expect(core.portCount).toBe(1);
    });
  });

  describe('재연결 시 자동 재구독', () => {
    function simulateReconnect() {
      lastWs().simulateClose(1006, '', false);
      vi.advanceTimersByTime(200);
      lastWs().simulateOpen();
    }

    it('재연결 시 모든 토픽이 재구독된다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      lastWs().simulateOpen();

      port.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });
      port.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'news', subscribeData: 'SUB news', unsubscribeData: 'UNSUB news' },
      });

      simulateReconnect();

      expect(lastWs().send).toHaveBeenCalledWith('SUB chat');
      expect(lastWs().send).toHaveBeenCalledWith('SUB news');
    });

    it('재구독이 OPEN broadcast보다 먼저 실행된다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      lastWs().simulateOpen();

      port.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });

      lastWs().simulateClose(1006, '', false);
      vi.advanceTimersByTime(200);
      const newWs = lastWs();
      newWs.send.mockClear();
      port.postMessage.mockClear();
      newWs.simulateOpen();

      const sendCallOrder = newWs.send.mock.invocationCallOrder[0];
      const openMsgIdx = port.postMessage.mock.calls.findIndex(
        ([msg]) => msg.type === WorkerMessageType.OPEN,
      );
      const openCallOrder = port.postMessage.mock.invocationCallOrder[openMsgIdx];
      expect(sendCallOrder).toBeLessThan(openCallOrder);
    });

    it('unsubscribe된 토픽은 재구독되지 않는다', () => {
      const core = createCore();
      const port = new MockPort();
      addPort(core, port);
      lastWs().simulateOpen();

      port.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });
      port.deliver({ type: WorkerMessageType.UNSUBSCRIBE, payload: { topic: 'chat' } });

      lastWs().simulateClose(1006, '', false);
      vi.advanceTimersByTime(200);
      lastWs().send.mockClear();
      lastWs().simulateOpen();

      expect(lastWs().send).not.toHaveBeenCalledWith('SUB chat');
    });

    it('같은 토픽의 다중 포트 구독은 한 번만 전송된다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      port1.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });
      port2.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });

      lastWs().simulateClose(1006, '', false);
      vi.advanceTimersByTime(200);
      lastWs().send.mockClear();
      lastWs().simulateOpen();

      const chatSends = lastWs().send.mock.calls.filter(([d]) => d === 'SUB chat');
      expect(chatSends).toHaveLength(1);
    });

    it('포트 제거 후 재연결 시 해당 포트의 토픽은 제외된다', () => {
      const core = createCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      addPort(core, port1);
      addPort(core, port2);
      lastWs().simulateOpen();

      port1.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'private', subscribeData: 'SUB private', unsubscribeData: 'UNSUB private' },
      });
      port2.deliver({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'public', subscribeData: 'SUB public', unsubscribeData: 'UNSUB public' },
      });
      core.removePort(port1 as unknown as MessagePort);

      lastWs().simulateClose(1006, '', false);
      vi.advanceTimersByTime(200);
      lastWs().send.mockClear();
      lastWs().simulateOpen();

      expect(lastWs().send).not.toHaveBeenCalledWith('SUB private');
      expect(lastWs().send).toHaveBeenCalledWith('SUB public');
    });
  });
});
