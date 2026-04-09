/// <reference lib="webworker" />

import {
  ConnectionState,
  WorkerMessageType,
  type WorkerMessage,
  type WorkerConnectPayload,
  type SocketEventMap,
} from '../types';
import { EventEmitter } from '../event-emitter';
import { SocketManager } from '../socket-manager';

export class WorkerCore {
  static readonly #heartbeatIntervalMs = 30_000;

  readonly #ports: MessagePort[] = [];
  #manager: SocketManager | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  #bindEmitterToPorts(emitter: EventEmitter<SocketEventMap>): void {
    emitter.on('open', () => {
      this.#broadcast({ type: WorkerMessageType.OPEN });
    });

    emitter.on('close', (payload) => {
      this.#broadcast({ type: WorkerMessageType.CLOSE_EVENT, payload });
    });

    emitter.on('message', (event) => {
      this.#broadcast({ type: WorkerMessageType.MESSAGE, payload: { data: event.data } });
    });

    emitter.on('error', (event) => {
      this.#broadcast({ type: WorkerMessageType.ERROR, payload: { type: event.type ?? 'error' } });
    });

    emitter.on('stateChange', (payload) => {
      this.#broadcast({ type: WorkerMessageType.STATE_CHANGE, payload });
    });

    emitter.on('reconnecting', (payload) => {
      this.#broadcast({ type: WorkerMessageType.RECONNECTING, payload });
    });

    emitter.on('reconnectFailed', () => {
      this.#broadcast({ type: WorkerMessageType.RECONNECT_FAILED });
    });
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

  addPort(port: MessagePort): void {
    this.#ports.push(port);

    port.onmessage = (e: MessageEvent<WorkerMessage>) => {
      this.#handlePortMessage(port, e.data);
    };

    port.start();

    if (this.#ports.length === 1) {
      this.#startHeartbeat();
    }
  }

  removePort(port: MessagePort): void {
    const idx = this.#ports.indexOf(port);
    if (idx !== -1) this.#ports.splice(idx, 1);

    if (this.#ports.length === 0) {
      this.#stopHeartbeat();
      this.#manager?.close();
      this.#manager = null;
    }
  }

  #startHeartbeat(): void {
    this.#heartbeatTimer = setInterval(() => {
      this.#broadcast({ type: WorkerMessageType.PING });
    }, WorkerCore.#heartbeatIntervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #handlePortMessage(port: MessagePort, msg: WorkerMessage): void {
    switch (msg.type) {
      case WorkerMessageType.CONNECT: {
        const payload = msg.payload as WorkerConnectPayload | undefined;
        if (!payload) return;

        if (!this.#manager) {
          const emitter = new EventEmitter<SocketEventMap>();
          this.#bindEmitterToPorts(emitter);
          this.#manager = new SocketManager(
            {
              url: payload.url,
              protocols: payload.protocols,
              reconnectionAttempts: payload.reconnectionAttempts,
              reconnectionDelay: payload.reconnectionDelay,
              reconnectionDelayMax: payload.reconnectionDelayMax,
              randomizationFactor: payload.randomizationFactor,
              autoReconnect: false,
            },
            emitter,
          );
        }

        port.postMessage({
          type: WorkerMessageType.STATE_CHANGE,
          payload: { from: this.#manager.state, to: this.#manager.state },
        } satisfies WorkerMessage);

        if (this.#manager.state === ConnectionState.OPEN) {
          port.postMessage({ type: WorkerMessageType.OPEN } satisfies WorkerMessage);
          return;
        }

        this.#manager.connect();
        break;
      }

      case WorkerMessageType.SEND: {
        try {
          this.#manager?.send(msg.payload);
        } catch (err) {
          port.postMessage({
            type: WorkerMessageType.ERROR,
            payload: { type: (err as Error)?.message ?? 'send_failed' },
          } satisfies WorkerMessage);
        }
        break;
      }

      case WorkerMessageType.CLOSE: {
        this.removePort(port);
        break;
      }
    }
  }

  get state(): ConnectionState {
    return this.#manager?.state ?? ConnectionState.CLOSED;
  }

  get portCount(): number {
    return this.#ports.length;
  }
}

declare const self: SharedWorkerGlobalScope;

const core = new WorkerCore();

self.onconnect = (event: MessageEvent) => {
  core.addPort(event.ports[0]);
};
