import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocketManager } from '../socket-manager';
import { EventEmitter } from '../event-emitter';
import { ConnectionState, type SocketEventMap } from '../types';

// ─── WebSocket Mock ───────────────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState: number = WebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((e: Partial<CloseEvent>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = WebSocket.CLOSING;
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  simulateOpen() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }

  simulateClose(code = 1000, reason = '', wasClean = true) {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean });
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function createManager(
  options: {
    reconnectionAttempts?: number;
    reconnectionDelay?: number;
    autoReconnect?: boolean;
  } = {},
) {
  const emitter = new EventEmitter<SocketEventMap>();
  const manager = new SocketManager(
    {
      url: 'ws://localhost',
      reconnectionDelay: options.reconnectionDelay ?? 100,
      reconnectionDelayMax: 100,
      randomizationFactor: 0,
      reconnectionAttempts: options.reconnectionAttempts ?? Infinity,
      autoReconnect: options.autoReconnect ?? false,
    },
    emitter,
  );
  return { manager, emitter };
}

function lastWs() {
  return MockWebSocket.instances.at(-1)!;
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

describe('SocketManager', () => {
  describe('connect / 상태 전이', () => {
    it('connect() 호출 시 CONNECTING 상태가 된다', () => {
      const { manager } = createManager();
      manager.connect();
      expect(manager.state).toBe(ConnectionState.CONNECTING);
    });

    it('onopen 시 OPEN 상태가 된다', () => {
      const { manager } = createManager();
      manager.connect();
      lastWs().simulateOpen();
      expect(manager.state).toBe(ConnectionState.OPEN);
    });

    it('CONNECTING 중 connect() 재호출은 무시된다', () => {
      const { manager } = createManager();
      manager.connect();
      manager.connect();
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('OPEN 중 connect() 재호출은 무시된다', () => {
      const { manager } = createManager();
      manager.connect();
      lastWs().simulateOpen();
      manager.connect();
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('stateChange 이벤트가 순서대로 emit된다', () => {
      const { manager, emitter } = createManager();
      const changes: string[] = [];
      emitter.on('stateChange', ({ from, to }) => changes.push(`${from}→${to}`));

      manager.connect();
      lastWs().simulateOpen();

      expect(changes).toEqual(['CLOSED→CONNECTING', 'CONNECTING→OPEN']);
    });

    it('open 이벤트가 emit된다', () => {
      const { manager, emitter } = createManager();
      const onOpen = vi.fn();
      emitter.on('open', onOpen);
      manager.connect();
      lastWs().simulateOpen();
      expect(onOpen).toHaveBeenCalledOnce();
    });
  });

  describe('이벤트 emit', () => {
    it('error 이벤트가 emit된다', () => {
      const { manager, emitter } = createManager();
      const onError = vi.fn();
      emitter.on('error', onError);
      manager.connect();
      lastWs().simulateError();
      expect(onError).toHaveBeenCalledOnce();
    });

    it('message 이벤트가 데이터와 함께 emit된다', () => {
      const { manager, emitter } = createManager();
      const onMessage = vi.fn();
      emitter.on('message', onMessage);
      manager.connect();
      lastWs().simulateMessage('payload');
      expect(onMessage).toHaveBeenCalledOnce();
      expect(onMessage.mock.calls[0][0].data).toBe('payload');
    });

    it('close 이벤트가 code/reason/wasClean 페이로드와 함께 emit된다', () => {
      const { manager, emitter } = createManager();
      const onClose = vi.fn();
      emitter.on('close', onClose);
      manager.connect();
      lastWs().simulateOpen();
      lastWs().simulateClose(1006, 'gone', false);
      expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: 'gone', wasClean: false });
    });

    it('reconnecting 이벤트가 attempt/delay 페이로드와 함께 emit된다', () => {
      const { manager, emitter } = createManager();
      const onReconnecting = vi.fn();
      emitter.on('reconnecting', onReconnecting);

      manager.connect();
      lastWs().simulateOpen();
      lastWs().simulateClose(1006, '', false);

      expect(onReconnecting).toHaveBeenCalledWith({ attempt: 1, delay: 100 });
    });
  });

  describe('close', () => {
    it('close() 호출 후 onclose가 도착하면 CLOSED 상태가 된다', () => {
      const { manager } = createManager();
      manager.connect();
      lastWs().simulateOpen();

      manager.close();
      lastWs().simulateClose(1000, '', true);

      expect(manager.state).toBe(ConnectionState.CLOSED);
    });

    it('close() 호출 시 OPEN→CLOSING→CLOSED 상태 전이가 발생한다', () => {
      const { manager, emitter } = createManager();
      const changes: string[] = [];
      emitter.on('stateChange', ({ from, to }) => changes.push(`${from}→${to}`));

      manager.connect();
      lastWs().simulateOpen();
      manager.close();
      expect(manager.state).toBe(ConnectionState.CLOSING);

      lastWs().simulateClose(1000, '', true);
      expect(manager.state).toBe(ConnectionState.CLOSED);
      expect(changes).toEqual([
        'CLOSED→CONNECTING',
        'CONNECTING→OPEN',
        'OPEN→CLOSING',
        'CLOSING→CLOSED',
      ]);
    });

    it('close() 호출 후 onclose가 제때 오지 않으면 watchdog이 강제로 CLOSED로 만든다', () => {
      const { manager, emitter } = createManager();
      const onClose = vi.fn();
      emitter.on('close', onClose);

      manager.connect();
      lastWs().simulateOpen();
      manager.close(1000, 'bye');
      expect(manager.state).toBe(ConnectionState.CLOSING);

      // onclose를 의도적으로 발생시키지 않음 (네트워크 죽은 상황 시뮬레이션)
      vi.advanceTimersByTime(3000);

      expect(manager.state).toBe(ConnectionState.CLOSED);
      expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: 'bye', wasClean: false });
    });

    it('watchdog 발동 후 뒤늦게 onclose가 도착해도 중복 처리되지 않는다', () => {
      const { manager, emitter } = createManager();
      const onClose = vi.fn();
      emitter.on('close', onClose);

      manager.connect();
      lastWs().simulateOpen();
      const ws = lastWs();
      manager.close();
      vi.advanceTimersByTime(3000); // watchdog 발동
      expect(onClose).toHaveBeenCalledTimes(1);

      // 뒤늦게 실제 onclose가 도착 — 이미 핸들러가 null이므로 무시
      ws.onclose?.({ code: 1006, reason: '', wasClean: false });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('close() 호출 시 close 이벤트가 emit된다', () => {
      const { manager, emitter } = createManager();
      const onClose = vi.fn();
      emitter.on('close', onClose);

      manager.connect();
      lastWs().simulateOpen();
      manager.close(1000, 'bye');
      lastWs().simulateClose(1000, 'bye', true);

      expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: 'bye', wasClean: true });
    });

    it('close() 호출 시 ws.close()가 호출된다', () => {
      const { manager } = createManager();
      manager.connect();
      lastWs().simulateOpen();
      const ws = lastWs();

      manager.close(1000, 'bye');

      expect(ws.close).toHaveBeenCalledWith(1000, 'bye');
    });

    it('close() 후 서버 onclose가 도착해도 재연결하지 않는다', () => {
      const { manager, emitter } = createManager();
      const onReconnecting = vi.fn();
      emitter.on('reconnecting', onReconnecting);

      manager.connect();
      lastWs().simulateOpen();
      manager.close();
      lastWs().simulateClose(1000, '', true);

      vi.runAllTimers();
      expect(onReconnecting).not.toHaveBeenCalled();
    });

    it('close() 후 retry 타이머가 취소된다', () => {
      const { manager } = createManager();
      manager.connect();
      lastWs().simulateOpen();
      lastWs().simulateClose(1006, '', false); // retry 타이머 설정

      manager.close();
      const prevCount = MockWebSocket.instances.length;
      vi.runAllTimers();
      expect(MockWebSocket.instances.length).toBe(prevCount); // 새 연결 없음
    });

    it('CONNECTING 중 close() 호출 시 CLOSING이 되고 watchdog 발동 후 CLOSED가 된다', () => {
      const { manager, emitter } = createManager();
      const changes: string[] = [];
      emitter.on('stateChange', ({ from, to }) => changes.push(`${from}→${to}`));

      manager.connect();
      expect(manager.state).toBe(ConnectionState.CONNECTING);

      manager.close();
      expect(manager.state).toBe(ConnectionState.CLOSING);

      vi.advanceTimersByTime(3000);
      expect(manager.state).toBe(ConnectionState.CLOSED);
      expect(changes).toContain('CONNECTING→CLOSING');
      expect(changes).toContain('CLOSING→CLOSED');
    });

    it('close() 후 connect() 호출 시 재연결된다', () => {
      const { manager } = createManager();
      manager.connect();
      lastWs().simulateOpen();
      manager.close();
      lastWs().simulateClose(1000, '', true);

      expect(manager.state).toBe(ConnectionState.CLOSED);

      manager.connect();

      expect(manager.state).toBe(ConnectionState.CONNECTING);
      expect(MockWebSocket.instances).toHaveLength(2);
    });
  });

  describe('재연결', () => {
    it('비정상 종료 시 재연결을 시도한다', () => {
      const { manager, emitter } = createManager();
      const onReconnecting = vi.fn();
      emitter.on('reconnecting', onReconnecting);

      manager.connect();
      lastWs().simulateOpen();
      lastWs().simulateClose(1006, '', false);

      expect(onReconnecting).toHaveBeenCalledOnce();
    });

    it('재연결 타이머 경과 후 새 WebSocket을 생성한다', () => {
      const { manager } = createManager();
      manager.connect();
      lastWs().simulateOpen();
      lastWs().simulateClose(1006, '', false);

      vi.runAllTimers();
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    it('reconnectionAttempts 소진 시 reconnectFailed 이벤트를 emit하고 CLOSED가 된다', () => {
      const { manager, emitter } = createManager({ reconnectionAttempts: 2 });
      const onFailed = vi.fn();
      emitter.on('reconnectFailed', onFailed);

      manager.connect();
      lastWs().simulateOpen();

      for (let i = 0; i < 2; i++) {
        lastWs().simulateClose(1006, '', false);
        vi.runAllTimers();
      }
      lastWs().simulateClose(1006, '', false);

      expect(onFailed).toHaveBeenCalledOnce();
      expect(manager.state).toBe(ConnectionState.CLOSED);
    });

    it('재연결 성공 시 attempt가 초기화되어 delay가 처음부터 다시 시작된다', () => {
      const { manager, emitter } = createManager({ reconnectionDelay: 100 });
      const delays: number[] = [];
      emitter.on('reconnecting', ({ delay }) => delays.push(delay));

      manager.connect();
      lastWs().simulateOpen();
      lastWs().simulateClose(1006, '', false);
      vi.runAllTimers();
      lastWs().simulateOpen();
      lastWs().simulateClose(1006, '', false);

      expect(delays).toEqual([100, 100]);
    });
  });

  describe('send', () => {
    it('OPEN 상태에서 send()가 WebSocket에 전달된다', () => {
      const { manager } = createManager();
      manager.connect();
      lastWs().simulateOpen();
      manager.send('hello');
      expect(lastWs().send).toHaveBeenCalledWith('hello');
    });

    it('OPEN이 아닌 상태에서 send()는 에러를 throw한다', () => {
      const { manager } = createManager();
      manager.connect();
      expect(() => manager.send('hello')).toThrow();
    });
  });

  describe('autoReconnect 브라우저 이벤트', () => {
    it('visibilitychange로 탭이 활성화되면 CLOSED 상태에서 재연결한다', () => {
      const { manager } = createManager({ autoReconnect: true, reconnectionAttempts: 1 });
      manager.connect();
      lastWs().simulateOpen();

      lastWs().simulateClose(1006, '', false);
      vi.runAllTimers();
      lastWs().simulateClose(1006, '', false);
      expect(manager.state).toBe(ConnectionState.CLOSED);

      const prevCount = MockWebSocket.instances.length;
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(MockWebSocket.instances.length).toBe(prevCount + 1);
    });

    it('autoReconnect=false면 브라우저 이벤트가 재연결을 트리거하지 않는다', () => {
      const { manager } = createManager({ autoReconnect: false, reconnectionAttempts: 0 });
      manager.connect();
      lastWs().simulateOpen();
      lastWs().simulateClose(1006, '', false);
      expect(manager.state).toBe(ConnectionState.CLOSED);

      const prevCount = MockWebSocket.instances.length;
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(MockWebSocket.instances.length).toBe(prevCount);
    });

    it('retry 대기 중 visibilitychange 발생 시 타이머를 취소하고 즉시 재연결한다', () => {
      const { manager } = createManager({ autoReconnect: true });
      manager.connect();
      lastWs().simulateOpen();
      lastWs().simulateClose(1006, '', false); // retry 타이머 설정, state=CLOSED

      // 타이머 만료 전에 탭 활성화
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      // 타이머 없이도 즉시 새 연결
      expect(MockWebSocket.instances).toHaveLength(2);
      // 취소된 타이머가 만료돼도 추가 연결 없음
      vi.runAllTimers();
      expect(MockWebSocket.instances).toHaveLength(2);
    });
  });
});
