// SharedWorker 엔트리 컨텍스트 전용.
// 메인 스레드에서 import하지 말 것.
export { WorkerCore } from './shared-worker/worker-core';
export type { SocketClientOptions } from './types';
