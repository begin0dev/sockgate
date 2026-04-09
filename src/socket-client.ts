import { ConnectionState, type IManager, type SocketClientOptions, type SocketEventMap } from './types';
import { EventEmitter } from './event-emitter';
import { SocketManager } from './socket-manager';
import { SharedWorkerManager } from './shared-worker/shared-worker-manager';

export class SocketClient {
  readonly #emitter: EventEmitter<SocketEventMap>;
  readonly #manager: IManager;

  constructor(options: SocketClientOptions) {
    this.#emitter = new EventEmitter<SocketEventMap>();
    this.#manager = SocketClient.#createManager(options, this.#emitter);
  }

  static #createManager(
    options: SocketClientOptions,
    emitter: EventEmitter<SocketEventMap>,
  ): IManager {
    if (options.useSharedWorker) {
      if (!options.sharedWorkerUrl) {
        throw new Error('useSharedWorker가 true이면 sharedWorkerUrl을 지정해야 합니다.');
      }
      if (typeof SharedWorker === 'undefined') {
        return new SocketManager(options, emitter);
      }
      return new SharedWorkerManager(options, emitter);
    }
    return new SocketManager(options, emitter);
  }

  connect(): void {
    this.#manager.connect();
  }

  close(code?: number, reason?: string): void {
    this.#manager.close(code, reason);
  }

  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void {
    this.#manager.send(data);
  }

  on<K extends keyof SocketEventMap>(
    event: K,
    listener: (data: SocketEventMap[K]) => void,
  ): () => void {
    return this.#emitter.on(event, listener);
  }

  off<K extends keyof SocketEventMap>(
    event: K,
    listener: (data: SocketEventMap[K]) => void,
  ): void {
    this.#emitter.off(event, listener);
  }

  get state(): ConnectionState {
    return this.#manager.state;
  }
}
