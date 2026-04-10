/// <reference lib="webworker" />

import {
  ConnectionState,
  WorkerMessageType,
  type ISocketClient,
  type SubscribeData,
  type WorkerMessage,
} from '../types';

interface TopicEntry {
  ports: Set<MessagePort>;
  subscribeData: SubscribeData;
  unsubscribeData: SubscribeData;
}

export class WorkerCore {
  static readonly #keepaliveIntervalMs = 30_000;

  readonly #socket: ISocketClient;
  readonly #ports: MessagePort[] = [];
  readonly #subscriptions: Map<string, TopicEntry> = new Map();
  #keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { socket: ISocketClient }) {
    this.#socket = options.socket;
    this.#bindSocketEvents();
  }

  addPort(port: MessagePort): void {
    this.#ports.push(port);

    port.onmessage = (e: MessageEvent<WorkerMessage>) => {
      this.#handlePortMessage(port, e.data);
    };
    port.start();

    if (this.#ports.length === 1) {
      this.#startKeepalive();
      this.#socket.connect();
    } else {
      this.#syncState(port);
    }
  }

  removePort(port: MessagePort): void {
    const idx = this.#ports.indexOf(port);
    if (idx !== -1) this.#ports.splice(idx, 1);

    // 해당 포트가 구독 중이던 토픽들을 정리한다.
    // 포트가 남아있는 경우, 구독자가 없어진 토픽은 서버에 UNSUBSCRIBE를 전송한다.
    for (const [topic, entry] of this.#subscriptions) {
      if (!entry.ports.has(port)) continue;
      entry.ports.delete(port);
      if (entry.ports.size === 0) {
        this.#subscriptions.delete(topic);
        if (this.#ports.length > 0) {
          try {
            this.#socket.send(entry.unsubscribeData);
          } catch {
            // noop — socket may be closing
          }
        }
      }
    }

    if (this.#ports.length === 0) {
      this.#stopKeepalive();
      this.#socket.close();
    }
  }

  get state(): ConnectionState {
    return this.#socket.state;
  }

  get portCount(): number {
    return this.#ports.length;
  }

  topicSubscriberCount(topic: string): number {
    return this.#subscriptions.get(topic)?.ports.size ?? 0;
  }

  #bindSocketEvents(): void {
    this.#socket.on('open', () => {
      this.#resubscribeAll();
      this.#broadcast({ type: WorkerMessageType.OPEN });
    });

    this.#socket.on('close', (payload) =>
      this.#broadcast({ type: WorkerMessageType.CLOSE_EVENT, payload }),
    );

    this.#socket.on('message', (event) =>
      this.#broadcast({ type: WorkerMessageType.MESSAGE, payload: { data: event.data } }),
    );

    this.#socket.on('error', (event) =>
      this.#broadcast({
        type: WorkerMessageType.ERROR,
        payload: { type: (event as Event).type ?? 'error' },
      }),
    );

    this.#socket.on('stateChange', (payload) =>
      this.#broadcast({ type: WorkerMessageType.STATE_CHANGE, payload }),
    );

    this.#socket.on('reconnecting', (payload) =>
      this.#broadcast({ type: WorkerMessageType.RECONNECTING, payload }),
    );

    this.#socket.on('reconnectFailed', () =>
      this.#broadcast({ type: WorkerMessageType.RECONNECT_FAILED }),
    );
  }

  #syncState(port: MessagePort): void {
    const currentState = this.#socket.state;

    port.postMessage({
      type: WorkerMessageType.STATE_CHANGE,
      payload: { from: ConnectionState.CLOSED, to: currentState },
    } satisfies WorkerMessage);

    if (currentState === ConnectionState.OPEN) {
      port.postMessage({ type: WorkerMessageType.OPEN } satisfies WorkerMessage);
    }
  }

  #broadcast(message: WorkerMessage): void {
    const dead: MessagePort[] = [];
    for (const port of this.#ports) {
      try {
        port.postMessage(message);
      } catch {
        dead.push(port);
      }
    }
    for (const p of dead) this.removePort(p);
  }

  #handlePortMessage(port: MessagePort, msg: WorkerMessage): void {
    switch (msg.type) {
      case WorkerMessageType.SEND: {
        try {
          this.#socket.send(msg.payload);
        } catch (err) {
          port.postMessage({
            type: WorkerMessageType.ERROR,
            payload: { type: (err as Error)?.message ?? 'send_failed' },
          } satisfies WorkerMessage);
        }
        break;
      }

      case WorkerMessageType.DETACH: {
        this.removePort(port);
        break;
      }

      case WorkerMessageType.SUBSCRIBE: {
        const { topic, subscribeData, unsubscribeData } = msg.payload;
        if (!this.#subscriptions.has(topic)) {
          this.#subscriptions.set(topic, { ports: new Set(), subscribeData, unsubscribeData });
        }
        const entry = this.#subscriptions.get(topic)!;
        const isFirst = entry.ports.size === 0;
        entry.ports.add(port);
        if (isFirst) {
          try {
            this.#socket.send(subscribeData);
          } catch (err) {
            port.postMessage({
              type: WorkerMessageType.ERROR,
              payload: { type: (err as Error)?.message ?? 'subscribe_failed' },
            } satisfies WorkerMessage);
          }
        }
        break;
      }

      case WorkerMessageType.UNSUBSCRIBE: {
        const { topic } = msg.payload;
        const entry = this.#subscriptions.get(topic);
        if (!entry) break;
        entry.ports.delete(port);
        if (entry.ports.size === 0) {
          this.#subscriptions.delete(topic);
          try {
            this.#socket.send(entry.unsubscribeData);
          } catch {
            // noop
          }
        }
        break;
      }
    }
  }

  #resubscribeAll(): void {
    for (const entry of this.#subscriptions.values()) {
      try {
        this.#socket.send(entry.subscribeData);
      } catch {
        // noop — socket may not be fully ready
      }
    }
  }

  #startKeepalive(): void {
    this.#keepaliveTimer = setInterval(() => {
      this.#broadcast({ type: WorkerMessageType.KEEPALIVE });
    }, WorkerCore.#keepaliveIntervalMs);
  }

  #stopKeepalive(): void {
    if (this.#keepaliveTimer !== null) {
      clearInterval(this.#keepaliveTimer);
      this.#keepaliveTimer = null;
    }
  }
}
