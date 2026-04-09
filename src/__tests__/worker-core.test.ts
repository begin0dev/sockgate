import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerCore } from '../shared-worker/worker-script';
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

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
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

const CONNECT_PAYLOAD = {
  url: 'ws://localhost',
  reconnectionDelay: 100,
  reconnectionDelayMax: 100,
  randomizationFactor: 0,
  reconnectionAttempts: Infinity,
};

/** 포트를 추가하고 CONNECT 메시지를 전달해 SocketManager를 생성·연결 */
function connectPort(core: WorkerCore, port: MockPort) {
  core.addPort(port as unknown as MessagePort);
  port.deliver({ type: WorkerMessageType.CONNECT, payload: CONNECT_PAYLOAD });
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
      const core = new WorkerCore();
      core.addPort(new MockPort() as unknown as MessagePort);
      expect(core.portCount).toBe(1);
    });

    it('여러 포트를 등록할 수 있다', () => {
      const core = new WorkerCore();
      core.addPort(new MockPort() as unknown as MessagePort);
      core.addPort(new MockPort() as unknown as MessagePort);
      expect(core.portCount).toBe(2);
    });

    it('removePort() 후 portCount가 감소한다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      core.addPort(port as unknown as MessagePort);
      core.removePort(port as unknown as MessagePort);
      expect(core.portCount).toBe(0);
    });

    it('마지막 포트 제거 시 소켓이 닫힌다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      connectPort(core, port);
      lastWs().simulateOpen();

      core.removePort(port as unknown as MessagePort);

      expect(lastWs().close).toHaveBeenCalled();
    });

    it('포트가 남아있으면 소켓을 닫지 않는다', () => {
      const core = new WorkerCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      connectPort(core, port1);
      core.addPort(port2 as unknown as MessagePort);
      lastWs().simulateOpen();

      core.removePort(port1 as unknown as MessagePort);

      expect(lastWs().close).not.toHaveBeenCalled();
      expect(core.portCount).toBe(1);
    });
  });

  describe('heartbeat', () => {
    it('첫 포트 추가 시 heartbeat가 시작된다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      core.addPort(port as unknown as MessagePort);

      vi.advanceTimersByTime(30_000);

      const pings = port.postMessage.mock.calls.filter(([msg]) => msg.type === WorkerMessageType.PING);
      expect(pings).toHaveLength(1);
    });

    it('30초마다 PING을 broadcast한다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      core.addPort(port as unknown as MessagePort);

      vi.advanceTimersByTime(90_000);

      const pings = port.postMessage.mock.calls.filter(([msg]) => msg.type === WorkerMessageType.PING);
      expect(pings).toHaveLength(3);
    });

    it('마지막 포트 제거 시 heartbeat가 멈춘다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      core.addPort(port as unknown as MessagePort);
      core.removePort(port as unknown as MessagePort);

      vi.advanceTimersByTime(90_000);

      const pings = port.postMessage.mock.calls.filter(([msg]) => msg.type === WorkerMessageType.PING);
      expect(pings).toHaveLength(0);
    });
  });

  describe('CONNECT 처리', () => {
    it('첫 CONNECT 시 WebSocket이 생성된다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      connectPort(core, port);
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('두 포트가 각각 CONNECT를 보내도 WebSocket은 하나만 생성된다', () => {
      const core = new WorkerCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      connectPort(core, port1);
      connectPort(core, port2);
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('CONNECT 시 현재 state가 STATE_CHANGE로 해당 포트에 전달된다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      connectPort(core, port);

      const stateMsg = port.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.STATE_CHANGE,
      )?.[0];
      expect(stateMsg).toBeDefined();
    });

    it('소켓이 이미 OPEN일 때 두 번째 포트 CONNECT 시 OPEN 이벤트를 즉시 전달한다', () => {
      const core = new WorkerCore();
      const port1 = new MockPort();
      connectPort(core, port1);
      lastWs().simulateOpen();

      const port2 = new MockPort();
      connectPort(core, port2);

      const openMsg = port2.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.OPEN,
      )?.[0];
      expect(openMsg).toBeDefined();
    });

    it('소켓이 OPEN일 때 두 번째 포트 CONNECT 시 connect()를 재호출하지 않는다', () => {
      const core = new WorkerCore();
      const port1 = new MockPort();
      connectPort(core, port1);
      lastWs().simulateOpen();

      const port2 = new MockPort();
      connectPort(core, port2);

      // WebSocket 추가 생성 없음
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  describe('broadcast', () => {
    it('소켓 open 시 모든 포트에 OPEN 메시지를 전달한다', () => {
      const core = new WorkerCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      connectPort(core, port1);
      core.addPort(port2 as unknown as MessagePort);
      port1.postMessage.mockClear();
      port2.postMessage.mockClear();

      lastWs().simulateOpen();

      expect(port1.postMessage).toHaveBeenCalledWith({ type: WorkerMessageType.OPEN });
      expect(port2.postMessage).toHaveBeenCalledWith({ type: WorkerMessageType.OPEN });
    });

    it('소켓 close 시 모든 포트에 CLOSE_EVENT 메시지를 전달한다', () => {
      const core = new WorkerCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      connectPort(core, port1);
      core.addPort(port2 as unknown as MessagePort);
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
      const core = new WorkerCore();
      const port = new MockPort();
      connectPort(core, port);
      lastWs().simulateOpen();
      port.postMessage.mockClear();

      lastWs().simulateMessage('hello');

      const messageCall = port.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.MESSAGE,
      )?.[0];
      expect(messageCall?.payload?.data).toBe('hello');
    });

    it('소켓 error 시 모든 포트에 ERROR 메시지를 전달한다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      connectPort(core, port);
      port.postMessage.mockClear();

      lastWs().simulateError();

      const errorCall = port.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.ERROR,
      )?.[0];
      expect(errorCall).toBeDefined();
    });

    it('stateChange 이벤트가 모든 포트에 STATE_CHANGE로 전달된다', () => {
      const core = new WorkerCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      connectPort(core, port1);
      core.addPort(port2 as unknown as MessagePort);
      port1.postMessage.mockClear();
      port2.postMessage.mockClear();

      lastWs().simulateOpen(); // CONNECTING→OPEN stateChange 발생

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
      const core = new WorkerCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      connectPort(core, port1);
      core.addPort(port2 as unknown as MessagePort);

      port1.postMessage.mockImplementation(() => {
        throw new Error('port closed');
      });

      lastWs().simulateOpen(); // broadcast 발생 → port1 에러 → 제거

      expect(core.portCount).toBe(1);
    });

    it('죽은 포트 제거 후 마지막 포트도 없으면 소켓이 닫힌다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      connectPort(core, port);
      lastWs().simulateOpen();

      port.postMessage.mockImplementation(() => {
        throw new Error('port closed');
      });

      lastWs().simulateOpen(); // broadcast → port 에러 → 제거 → 마지막 포트 없음

      expect(core.portCount).toBe(0);
      expect(lastWs().close).toHaveBeenCalled();
    });
  });

  describe('SEND 처리', () => {
    it('OPEN 상태에서 SEND 메시지를 받으면 ws.send()를 호출한다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      connectPort(core, port);
      lastWs().simulateOpen();

      port.deliver({ type: WorkerMessageType.SEND, payload: 'hello' });

      expect(lastWs().send).toHaveBeenCalledWith('hello');
    });

    it('OPEN이 아닌 상태에서 SEND는 해당 포트에 ERROR를 전달한다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      connectPort(core, port);
      port.postMessage.mockClear();

      port.deliver({ type: WorkerMessageType.SEND, payload: 'hello' });

      const errorCall = port.postMessage.mock.calls.find(
        ([msg]) => msg.type === WorkerMessageType.ERROR,
      )?.[0];
      expect(errorCall).toBeDefined();
    });
  });

  describe('CLOSE 처리', () => {
    it('CLOSE 메시지를 받으면 해당 포트가 제거된다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      core.addPort(port as unknown as MessagePort);

      port.deliver({ type: WorkerMessageType.CLOSE });

      expect(core.portCount).toBe(0);
    });

    it('마지막 포트 CLOSE 시 소켓이 닫힌다', () => {
      const core = new WorkerCore();
      const port = new MockPort();
      connectPort(core, port);
      lastWs().simulateOpen();

      port.deliver({ type: WorkerMessageType.CLOSE });

      expect(lastWs().close).toHaveBeenCalled();
    });

    it('포트가 남아있으면 CLOSE 후에도 소켓을 유지한다', () => {
      const core = new WorkerCore();
      const port1 = new MockPort();
      const port2 = new MockPort();
      connectPort(core, port1);
      core.addPort(port2 as unknown as MessagePort);
      lastWs().simulateOpen();

      port1.deliver({ type: WorkerMessageType.CLOSE });

      expect(lastWs().close).not.toHaveBeenCalled();
      expect(core.portCount).toBe(1);
    });
  });
});
