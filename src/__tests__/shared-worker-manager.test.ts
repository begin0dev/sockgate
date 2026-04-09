import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharedWorkerManager } from '../shared-worker/shared-worker-manager';
import { EventEmitter } from '../event-emitter';
import { ConnectionState, WorkerMessageType, type SocketEventMap, type WorkerMessage } from '../types';

// ─── Mock ─────────────────────────────────────────────────────────────────────

class MockPort {
  onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null = null;
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();

  deliver(msg: WorkerMessage) {
    this.onmessage?.(new MessageEvent('message', { data: msg }));
  }
}

class MockSharedWorker {
  static instances: MockSharedWorker[] = [];
  port: MockPort;

  constructor() {
    this.port = new MockPort();
    MockSharedWorker.instances.push(this);
  }
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function createManager(options: Record<string, unknown> = {}) {
  const emitter = new EventEmitter<SocketEventMap>();
  const manager = new SharedWorkerManager(
    {
      url: 'ws://localhost',
      sharedWorkerUrl: '/worker.js',
      autoReconnect: false,
      ...options,
    },
    emitter,
  );
  return { manager, emitter };
}

function lastWorker() {
  return MockSharedWorker.instances.at(-1)!;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  MockSharedWorker.instances = [];
  vi.stubGlobal('SharedWorker', MockSharedWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SharedWorkerManager', () => {
  describe('connect', () => {
    it('connect() 호출 시 SharedWorker가 생성된다', () => {
      const { manager } = createManager();
      manager.connect();
      expect(MockSharedWorker.instances).toHaveLength(1);
    });

    it('connect() 호출 시 포트에 CONNECT 메시지가 전달된다', () => {
      const { manager } = createManager();
      manager.connect();
      expect(lastWorker().port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: WorkerMessageType.CONNECT }),
      );
    });

    it('connect()가 이미 포트에 연결된 경우 SharedWorker를 재생성하지 않는다', () => {
      const { manager } = createManager();
      manager.connect(); // port 생성
      manager.connect(); // 동일 port 재사용
      expect(MockSharedWorker.instances).toHaveLength(1);
    });

    it('CLOSED 아닌 상태에서 connect() 호출은 무시된다', () => {
      const { manager } = createManager();
      manager.connect();
      const port = lastWorker().port;

      // STATE_CHANGE로 CONNECTING 상태로 전환
      port.deliver({
        type: WorkerMessageType.STATE_CHANGE,
        payload: { from: ConnectionState.CLOSED, to: ConnectionState.CONNECTING },
      });
      port.postMessage.mockClear();

      manager.connect(); // 무시돼야 함

      const connectCalls = port.postMessage.mock.calls.filter(
        ([msg]) => msg.type === WorkerMessageType.CONNECT,
      );
      expect(connectCalls).toHaveLength(0);
    });
  });

  describe('워커 메시지 처리', () => {
    it('OPEN 메시지 수신 시 OPEN 상태가 되고 open 이벤트가 emit된다', () => {
      const { manager, emitter } = createManager();
      const onOpen = vi.fn();
      emitter.on('open', onOpen);

      manager.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.OPEN });

      expect(manager.state).toBe(ConnectionState.OPEN);
      expect(onOpen).toHaveBeenCalledOnce();
    });

    it('CLOSE_EVENT 메시지 수신 시 CLOSED 상태가 되고 close 이벤트가 emit된다', () => {
      const { manager, emitter } = createManager();
      const onClose = vi.fn();
      emitter.on('close', onClose);

      manager.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.OPEN });
      lastWorker().port.deliver({
        type: WorkerMessageType.CLOSE_EVENT,
        payload: { code: 1006, reason: 'gone', wasClean: false },
      });

      expect(manager.state).toBe(ConnectionState.CLOSED);
      expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: 'gone', wasClean: false });
    });

    it('MESSAGE 메시지 수신 시 message 이벤트가 emit된다', () => {
      const { manager, emitter } = createManager();
      const onMessage = vi.fn();
      emitter.on('message', onMessage);

      manager.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.MESSAGE, payload: { data: 'hello' } });

      expect(onMessage).toHaveBeenCalledOnce();
      expect(onMessage.mock.calls[0][0].data).toBe('hello');
    });

    it('ERROR 메시지 수신 시 error 이벤트가 emit된다', () => {
      const { manager, emitter } = createManager();
      const onError = vi.fn();
      emitter.on('error', onError);

      manager.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.ERROR, payload: { type: 'error' } });

      expect(onError).toHaveBeenCalledOnce();
    });

    it('STATE_CHANGE 메시지 수신 시 state가 업데이트되고 stateChange 이벤트가 emit된다', () => {
      const { manager, emitter } = createManager();
      const changes: string[] = [];
      emitter.on('stateChange', ({ from, to }) => changes.push(`${from}→${to}`));

      manager.connect();
      lastWorker().port.deliver({
        type: WorkerMessageType.STATE_CHANGE,
        payload: { from: ConnectionState.CLOSED, to: ConnectionState.CONNECTING },
      });

      expect(manager.state).toBe(ConnectionState.CONNECTING);
      expect(changes).toContain('CLOSED→CONNECTING');
    });

    it('RECONNECTING 메시지 수신 시 reconnecting 이벤트가 emit된다', () => {
      const { manager, emitter } = createManager();
      const onReconnecting = vi.fn();
      emitter.on('reconnecting', onReconnecting);

      manager.connect();
      lastWorker().port.deliver({
        type: WorkerMessageType.RECONNECTING,
        payload: { attempt: 1, delay: 100 },
      });

      expect(onReconnecting).toHaveBeenCalledWith({ attempt: 1, delay: 100 });
    });

    it('RECONNECT_FAILED 메시지 수신 시 reconnectFailed 이벤트가 emit되고 CLOSED가 된다', () => {
      const { manager, emitter } = createManager();
      const onFailed = vi.fn();
      emitter.on('reconnectFailed', onFailed);

      manager.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.RECONNECT_FAILED });

      expect(onFailed).toHaveBeenCalledOnce();
      expect(manager.state).toBe(ConnectionState.CLOSED);
    });
  });

  describe('close', () => {
    it('close() 호출 시 포트에 CLOSE 메시지를 전송한다', () => {
      const { manager } = createManager();
      manager.connect();
      const port = lastWorker().port;

      manager.close();

      expect(port.postMessage).toHaveBeenCalledWith({ type: WorkerMessageType.CLOSE });
    });

    it('close() 호출 시 포트가 닫힌다', () => {
      const { manager } = createManager();
      manager.connect();
      const port = lastWorker().port;

      manager.close();

      expect(port.close).toHaveBeenCalled();
    });

    it('close() 호출 시 CLOSED 상태가 되고 stateChange 이벤트가 emit된다', () => {
      const { manager, emitter } = createManager();
      const changes: string[] = [];
      emitter.on('stateChange', ({ from, to }) => changes.push(`${from}→${to}`));

      manager.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.OPEN });
      manager.close();

      expect(manager.state).toBe(ConnectionState.CLOSED);
      expect(changes).toContain('OPEN→CLOSED');
    });

    it('CLOSING 상태에서 close()를 호출해도 CLOSED로 전달된다', () => {
      const { manager, emitter } = createManager();
      const onStateChange = vi.fn();
      emitter.on('stateChange', onStateChange);

      manager.connect();
      lastWorker().port.deliver({
        type: WorkerMessageType.STATE_CHANGE,
        payload: { from: ConnectionState.OPEN, to: ConnectionState.CLOSING },
      });
      onStateChange.mockClear();

      manager.close();

      expect(manager.state).toBe(ConnectionState.CLOSED);
      const lastCall = onStateChange.mock.calls.at(-1)?.[0];
      expect(lastCall?.to).toBe(ConnectionState.CLOSED);
    });

    it('이미 CLOSED 상태에서 close()를 호출하면 stateChange가 emit되지 않는다', () => {
      const { manager, emitter } = createManager();
      const onStateChange = vi.fn();
      emitter.on('stateChange', onStateChange);

      manager.connect();
      manager.close(); // CLOSED → CLOSED (포트 없음, noop)
      onStateChange.mockClear();

      manager.close(); // 이미 포트 없음

      expect(onStateChange).not.toHaveBeenCalled();
    });

    it('close() 후 connect() 호출 시 새 SharedWorker가 생성된다', () => {
      const { manager } = createManager();
      manager.connect();
      manager.close();

      manager.connect();

      expect(MockSharedWorker.instances).toHaveLength(2);
    });

    it('close() 후 connect() 호출 시 CONNECT 메시지가 전달된다', () => {
      const { manager } = createManager();
      manager.connect();
      manager.close();

      manager.connect();

      expect(lastWorker().port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: WorkerMessageType.CONNECT }),
      );
    });
  });

  describe('send', () => {
    it('OPEN 상태에서 send()가 포트에 SEND 메시지를 전달한다', () => {
      const { manager } = createManager();
      manager.connect();
      const port = lastWorker().port;
      port.deliver({ type: WorkerMessageType.OPEN });

      manager.send('hello');

      expect(port.postMessage).toHaveBeenCalledWith({
        type: WorkerMessageType.SEND,
        payload: 'hello',
      });
    });

    it('OPEN이 아닌 상태에서 send()는 에러를 throw한다', () => {
      const { manager } = createManager();
      manager.connect();

      expect(() => manager.send('hello')).toThrow();
    });
  });

  describe('autoReconnect 브라우저 이벤트', () => {
    it('autoReconnect=true이고 CLOSED 상태에서 visibilitychange 발생 시 재연결된다', () => {
      const { manager } = createManager({ autoReconnect: true });
      manager.connect();
      const port = lastWorker().port;
      port.deliver({ type: WorkerMessageType.RECONNECT_FAILED }); // state=CLOSED, intentional=false
      expect(manager.state).toBe(ConnectionState.CLOSED);

      const connectsBefore = port.postMessage.mock.calls.filter(
        ([msg]) => msg.type === WorkerMessageType.CONNECT,
      ).length;

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      const connectsAfter = port.postMessage.mock.calls.filter(
        ([msg]) => msg.type === WorkerMessageType.CONNECT,
      ).length;
      expect(connectsAfter).toBe(connectsBefore + 1);
    });

    it('autoReconnect=false면 브라우저 이벤트가 재연결을 트리거하지 않는다', () => {
      const { manager } = createManager({ autoReconnect: false });
      manager.connect();
      const port = lastWorker().port;
      port.deliver({ type: WorkerMessageType.RECONNECT_FAILED });

      const connectsBefore = port.postMessage.mock.calls.filter(
        ([msg]) => msg.type === WorkerMessageType.CONNECT,
      ).length;

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      const connectsAfter = port.postMessage.mock.calls.filter(
        ([msg]) => msg.type === WorkerMessageType.CONNECT,
      ).length;
      expect(connectsAfter).toBe(connectsBefore);
    });

    it('의도적 close() 후에는 visibilitychange가 재연결을 트리거하지 않는다', () => {
      const { manager } = createManager({ autoReconnect: true });
      manager.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.OPEN });
      manager.close(); // intentionalClose = true, 이벤트 언바인드

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      // 새 SharedWorker가 생기지 않아야 함
      expect(MockSharedWorker.instances).toHaveLength(1);
    });
  });
});
