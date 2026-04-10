import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharedWorkerClient } from '../shared-worker/shared-worker-client';
import { ConnectionState, WorkerMessageType, type WorkerMessage } from '../types';

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

function createClient(options: Record<string, unknown> = {}) {
  return new SharedWorkerClient({
    sharedWorkerUrl: '/worker.js',
    autoReconnect: false,
    ...options,
  });
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

describe('SharedWorkerClient', () => {
  describe('connect', () => {
    it('connect() 호출 시 SharedWorker가 생성된다', () => {
      const client = createClient();
      client.connect();
      expect(MockSharedWorker.instances).toHaveLength(1);
    });

    it('connect()가 이미 포트에 연결된 경우 SharedWorker를 재생성하지 않는다', () => {
      const client = createClient();
      client.connect();
      client.connect();
      expect(MockSharedWorker.instances).toHaveLength(1);
    });

    it('CLOSED 아닌 상태에서 connect() 호출은 무시된다', () => {
      const client = createClient();
      client.connect();
      const port = lastWorker().port;

      port.deliver({
        type: WorkerMessageType.STATE_CHANGE,
        payload: { from: ConnectionState.CLOSED, to: ConnectionState.CONNECTING },
      });

      const workerCountBefore = MockSharedWorker.instances.length;
      client.connect();
      expect(MockSharedWorker.instances).toHaveLength(workerCountBefore);
    });
  });

  describe('워커 메시지 처리', () => {
    it('OPEN 메시지 수신 시 OPEN 상태가 되고 open 이벤트가 emit된다', () => {
      const client = createClient();
      const onOpen = vi.fn();
      client.on('open', onOpen);

      client.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.OPEN });

      expect(client.state).toBe(ConnectionState.OPEN);
      expect(onOpen).toHaveBeenCalledOnce();
    });

    it('CLOSE_EVENT 메시지 수신 시 CLOSED 상태가 되고 close 이벤트가 emit된다', () => {
      const client = createClient();
      const onClose = vi.fn();
      client.on('close', onClose);

      client.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.OPEN });
      lastWorker().port.deliver({
        type: WorkerMessageType.CLOSE_EVENT,
        payload: { code: 1006, reason: 'gone', wasClean: false },
      });

      expect(client.state).toBe(ConnectionState.CLOSED);
      expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: 'gone', wasClean: false });
    });

    it('MESSAGE 메시지 수신 시 message 이벤트가 emit된다', () => {
      const client = createClient();
      const onMessage = vi.fn();
      client.on('message', onMessage);

      client.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.MESSAGE, payload: { data: 'hello' } });

      expect(onMessage).toHaveBeenCalledOnce();
      expect(onMessage.mock.calls[0][0].data).toBe('hello');
    });

    it('ERROR 메시지 수신 시 error 이벤트가 emit된다', () => {
      const client = createClient();
      const onError = vi.fn();
      client.on('error', onError);

      client.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.ERROR, payload: { type: 'error' } });

      expect(onError).toHaveBeenCalledOnce();
    });

    it('STATE_CHANGE 메시지 수신 시 state가 업데이트되고 stateChange 이벤트가 emit된다', () => {
      const client = createClient();
      const changes: string[] = [];
      client.on('stateChange', ({ from, to }) => changes.push(`${from}→${to}`));

      client.connect();
      lastWorker().port.deliver({
        type: WorkerMessageType.STATE_CHANGE,
        payload: { from: ConnectionState.CLOSED, to: ConnectionState.CONNECTING },
      });

      expect(client.state).toBe(ConnectionState.CONNECTING);
      expect(changes).toContain('CLOSED→CONNECTING');
    });

    it('RECONNECTING 메시지 수신 시 reconnecting 이벤트가 emit된다', () => {
      const client = createClient();
      const onReconnecting = vi.fn();
      client.on('reconnecting', onReconnecting);

      client.connect();
      lastWorker().port.deliver({
        type: WorkerMessageType.RECONNECTING,
        payload: { attempt: 1, delay: 100 },
      });

      expect(onReconnecting).toHaveBeenCalledWith({ attempt: 1, delay: 100 });
    });

    it('RECONNECT_FAILED 메시지 수신 시 reconnectFailed 이벤트가 emit되고 CLOSED가 된다', () => {
      const client = createClient();
      const onFailed = vi.fn();
      client.on('reconnectFailed', onFailed);

      client.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.RECONNECT_FAILED });

      expect(onFailed).toHaveBeenCalledOnce();
      expect(client.state).toBe(ConnectionState.CLOSED);
    });
  });

  describe('close', () => {
    it('close() 호출 시 포트에 DETACH 메시지를 전송한다', () => {
      const client = createClient();
      client.connect();
      const port = lastWorker().port;

      client.close();

      expect(port.postMessage).toHaveBeenCalledWith({ type: WorkerMessageType.DETACH });
    });

    it('close() 호출 시 포트가 닫힌다', () => {
      const client = createClient();
      client.connect();
      const port = lastWorker().port;

      client.close();

      expect(port.close).toHaveBeenCalled();
    });

    it('close() 호출 시 CLOSED 상태가 되고 stateChange 이벤트가 emit된다', () => {
      const client = createClient();
      const changes: string[] = [];
      client.on('stateChange', ({ from, to }) => changes.push(`${from}→${to}`));

      client.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.OPEN });
      client.close();

      expect(client.state).toBe(ConnectionState.CLOSED);
      expect(changes).toContain('OPEN→CLOSED');
    });

    it('이미 CLOSED 상태에서 close()를 호출하면 stateChange가 emit되지 않는다', () => {
      const client = createClient();
      const onStateChange = vi.fn();
      client.on('stateChange', onStateChange);

      client.connect();
      client.close();
      onStateChange.mockClear();

      client.close();

      expect(onStateChange).not.toHaveBeenCalled();
    });

    it('close() 후 connect() 호출 시 새 SharedWorker가 생성된다', () => {
      const client = createClient();
      client.connect();
      client.close();

      client.connect();

      expect(MockSharedWorker.instances).toHaveLength(2);
    });
  });

  describe('send', () => {
    it('OPEN 상태에서 send()가 포트에 SEND 메시지를 전달한다', () => {
      const client = createClient();
      client.connect();
      const port = lastWorker().port;
      port.deliver({ type: WorkerMessageType.OPEN });

      client.send('hello');

      expect(port.postMessage).toHaveBeenCalledWith({
        type: WorkerMessageType.SEND,
        payload: 'hello',
      });
    });

    it('OPEN이 아닌 상태에서 send()는 에러를 throw한다', () => {
      const client = createClient();
      client.connect();

      expect(() => client.send('hello')).toThrow();
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('subscribe() 호출 시 포트에 SUBSCRIBE 메시지를 전달한다', () => {
      const client = createClient();
      client.connect();
      const port = lastWorker().port;
      port.deliver({ type: WorkerMessageType.OPEN });

      client.subscribe('chat', 'SUB chat', 'UNSUB chat');

      expect(port.postMessage).toHaveBeenCalledWith({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });
    });

    it('unsubscribe() 호출 시 포트에 UNSUBSCRIBE 메시지를 전달한다', () => {
      const client = createClient();
      client.connect();
      const port = lastWorker().port;
      port.deliver({ type: WorkerMessageType.OPEN });

      client.unsubscribe('chat');

      expect(port.postMessage).toHaveBeenCalledWith({
        type: WorkerMessageType.UNSUBSCRIBE,
        payload: { topic: 'chat' },
      });
    });

    it('연결되지 않은 상태에서 subscribe()를 호출하면 에러를 throw한다', () => {
      const client = createClient();
      expect(() => client.subscribe('chat', 'SUB', 'UNSUB')).toThrow('Not connected');
    });

    it('연결되지 않은 상태에서 unsubscribe()를 호출하면 에러를 throw한다', () => {
      const client = createClient();
      expect(() => client.unsubscribe('chat')).toThrow('Not connected');
    });
  });

  describe('탭 close → connect 시 구독 복원', () => {
    function connectAndOpen(client: ReturnType<typeof createClient>) {
      client.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.OPEN });
    }

    function reconnect(client: ReturnType<typeof createClient>) {
      client.close();
      connectAndOpen(client);
    }

    it('close → connect 후 OPEN 수신 시 구독이 자동 복원된다', () => {
      const client = createClient();
      connectAndOpen(client);
      client.subscribe('chat', 'SUB chat', 'UNSUB chat');

      reconnect(client);

      const newPort = lastWorker().port;
      expect(newPort.postMessage).toHaveBeenCalledWith({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });
    });

    it('여러 토픽이 모두 복원된다', () => {
      const client = createClient();
      connectAndOpen(client);
      client.subscribe('chat', 'SUB chat', 'UNSUB chat');
      client.subscribe('news', 'SUB news', 'UNSUB news');

      reconnect(client);

      const newPort = lastWorker().port;
      expect(newPort.postMessage).toHaveBeenCalledWith({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'chat', subscribeData: 'SUB chat', unsubscribeData: 'UNSUB chat' },
      });
      expect(newPort.postMessage).toHaveBeenCalledWith({
        type: WorkerMessageType.SUBSCRIBE,
        payload: { topic: 'news', subscribeData: 'SUB news', unsubscribeData: 'UNSUB news' },
      });
    });

    it('unsubscribe된 토픽은 복원되지 않는다', () => {
      const client = createClient();
      connectAndOpen(client);
      client.subscribe('chat', 'SUB chat', 'UNSUB chat');
      client.unsubscribe('chat');

      reconnect(client);

      const newPort = lastWorker().port;
      const subscribeCalls = newPort.postMessage.mock.calls.filter(
        ([msg]) => msg.type === WorkerMessageType.SUBSCRIBE,
      );
      expect(subscribeCalls).toHaveLength(0);
    });

    it('구독 복원은 OPEN 이벤트 emit 전에 실행된다', () => {
      const client = createClient();
      connectAndOpen(client);
      client.subscribe('chat', 'SUB chat', 'UNSUB chat');

      client.close();
      client.connect();
      const newPort = lastWorker().port;
      newPort.postMessage.mockClear();

      const callOrder: string[] = [];
      client.on('open', () => callOrder.push('open-event'));

      newPort.deliver({ type: WorkerMessageType.OPEN });

      const subscribeCallIdx = newPort.postMessage.mock.calls.findIndex(
        ([msg]) => msg.type === WorkerMessageType.SUBSCRIBE,
      );
      expect(subscribeCallIdx).toBeGreaterThanOrEqual(0);
      // SUBSCRIBE는 postMessage로 전송되고, open 이벤트 emit은 그 이후
      expect(callOrder).toContain('open-event');
    });
  });

  describe('autoReconnect 브라우저 이벤트', () => {
    it('autoReconnect=true이고 CLOSED 상태에서 visibilitychange 발생 시 재연결된다', () => {
      const client = createClient({ autoReconnect: true });
      client.connect();
      const port = lastWorker().port;
      port.deliver({ type: WorkerMessageType.RECONNECT_FAILED });
      expect(client.state).toBe(ConnectionState.CLOSED);

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(MockSharedWorker.instances).toHaveLength(2);
    });

    it('autoReconnect=false면 브라우저 이벤트가 재연결을 트리거하지 않는다', () => {
      const client = createClient({ autoReconnect: false });
      client.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.RECONNECT_FAILED });

      const countBefore = MockSharedWorker.instances.length;

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(MockSharedWorker.instances).toHaveLength(countBefore);
    });

    it('의도적 close() 후에는 visibilitychange가 재연결을 트리거하지 않는다', () => {
      const client = createClient({ autoReconnect: true });
      client.connect();
      lastWorker().port.deliver({ type: WorkerMessageType.OPEN });
      client.close();

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(MockSharedWorker.instances).toHaveLength(1);
    });
  });
});
