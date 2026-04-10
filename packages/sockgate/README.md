# sockgate

자동 재연결과 SharedWorker 기반 탭 간 연결 공유를 지원하는 가벼운 WebSocket 클라이언트.

## 특징

- **자동 재연결**: 지수 백오프 + 지터(jitter) 기반 재시도
- **SharedWorker 지원**: 여러 탭이 하나의 WebSocket 연결을 공유
- **토픽 구독**: 레퍼런스 카운팅 기반 subscribe / unsubscribe
- **하트비트**: 커스텀 ping/pong 로직을 콜백으로 주입
- **타입 세이프한 이벤트**: `open`, `close`, `message`, `error`, `stateChange`, `reconnecting`, `reconnectFailed`
- **의존성 없음**: 순수 TypeScript

## 설치

```bash
pnpm add @begin0dev/sockgate
```

## 사용법

### 기본 (SocketClient)

```ts
import { SocketClient, ConnectionState } from '@begin0dev/sockgate';

const client = new SocketClient({
  url: 'wss://example.com/ws',
  reconnect: {
    attempts: 10,       // 최대 재시도 횟수 (기본: Infinity)
    delay: 1000,        // 초기 재시도 지연 ms (기본: 1000)
    delayMax: 30000,    // 최대 재시도 지연 ms (기본: 30000)
    factor: 0.5,        // 지터 팩터 0~1 (기본: 0.5)
  },
});

client.on('open', () => console.log('connected'));
client.on('message', (e) => console.log('received:', e.data));
client.on('stateChange', ({ from, to }) => console.log(`${from} → ${to}`));
client.on('reconnecting', ({ attempt, delay }) => {
  console.log(`reconnect #${attempt} in ${delay}ms`);
});

client.connect();
client.send('hello');
// client.close();
```

### 토픽 구독

```ts
// 구독 시작 — subscribeData를 서버에 전송하고 unsubscribeData를 내부 저장
client.subscribe(
  'chat-room-1',
  JSON.stringify({ type: 'subscribe', room: 'chat-room-1' }),
  JSON.stringify({ type: 'unsubscribe', room: 'chat-room-1' }),
);

// 구독 해제 — 저장된 unsubscribeData를 서버에 전송
client.unsubscribe('chat-room-1');
```

### 하트비트 (Heartbeat)

```ts
const client = new SocketClient({
  url: 'wss://example.com/ws',
  heartbeat: (ctx) => {
    let pingId: string | null = null;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;

    const interval = setInterval(() => {
      const id = crypto.randomUUID();
      pingId = id;
      ctx.send(JSON.stringify({ type: 'ping', id }));
      pongTimer = setTimeout(() => ctx.reconnect(), 5_000);
    }, 10_000);

    const unsub = ctx.onMessage((event) => {
      const msg = JSON.parse(String(event.data));
      if (msg?.type === 'pong' && msg?.requestId === pingId) {
        clearTimeout(pongTimer!);
        pongTimer = null;
      }
    });

    return () => {
      clearInterval(interval);
      clearTimeout(pongTimer!);
      unsub();
    };
  },
});
```

### SharedWorker (탭 간 연결 공유)

SharedWorker를 사용하면 여러 탭이 하나의 WebSocket 연결을 공유합니다. 구현은 두 부분으로 나뉩니다.

#### 1. 워커 엔트리 파일 작성

`sockgate/worker`에서 `WorkerCore`를 가져와 SharedWorker 스크립트를 작성합니다.

```ts
// worker.ts (빌드 후 /worker.js 로 서빙)
import { WorkerCore } from '@begin0dev/sockgate/worker';
import type { SocketClientOptions } from '@begin0dev/sockgate/worker';

const options: SocketClientOptions = {
  url: 'wss://example.com/ws',
  reconnect: { attempts: 10 },
};

new WorkerCore(options);
```

#### 2. 메인 스레드에서 SharedWorkerClient 사용

```ts
import { SharedWorkerClient } from '@begin0dev/sockgate';

const client = new SharedWorkerClient({
  sharedWorkerFactory: () => new SharedWorker('/worker.js', { type: 'module' }),
  autoReconnect: true, // 탭 포커스/온라인 복귀 시 포트 재부착 (기본: true)
});

client.on('open', () => console.log('connected'));
client.on('message', (e) => console.log('received:', e.data));

client.connect();

// 토픽 구독 (레퍼런스 카운팅: 첫 탭만 서버에 전송)
client.subscribe(
  'chat-room-1',
  JSON.stringify({ type: 'subscribe', room: 'chat-room-1' }),
  JSON.stringify({ type: 'unsubscribe', room: 'chat-room-1' }),
);
```

## API

### `new SocketClient(options)`

| 옵션 | 타입 | 설명 |
|---|---|---|
| `url` | `string` | WebSocket URL (필수) |
| `protocols` | `string \| string[]` | 서브프로토콜 |
| `reconnect.attempts` | `number` | 최대 재시도 횟수 (기본: Infinity) |
| `reconnect.delay` | `number` | 초기 재시도 지연 ms (기본: 1000) |
| `reconnect.delayMax` | `number` | 최대 재시도 지연 ms (기본: 30000) |
| `reconnect.factor` | `number` | 지터 팩터 0~1 (기본: 0.5) |
| `heartbeat` | `HeartbeatFn` | 소켓 오픈 시 호출되는 하트비트 콜백 |

### `new SharedWorkerClient(options)`

| 옵션 | 타입 | 설명 |
|---|---|---|
| `sharedWorkerUrl` | `string` | 워커 스크립트 경로 |
| `sharedWorkerFactory` | `() => SharedWorker` | 커스텀 SharedWorker 생성 함수 |
| `autoReconnect` | `boolean` | 탭 포커스/온라인 시 자동 재연결 (기본: true) |

### 공통 메서드 (`ISocketClient`)

- `connect()` — 연결 시작
- `send(data)` — 데이터 전송 (`string | ArrayBuffer | Blob | ArrayBufferView`)
- `close(code?, reason?)` — 연결 종료
- `subscribe(topic, subscribeData, unsubscribeData)` — 토픽 구독
- `unsubscribe(topic)` — 토픽 구독 해제
- `on(event, listener)` — 리스너 등록 (해제 함수 반환)
- `off(event, listener)` — 리스너 해제
- `state` — 현재 `ConnectionState` (`CONNECTING | OPEN | CLOSING | CLOSED`)

### 이벤트

| 이벤트 | 페이로드 |
|---|---|
| `open` | `undefined` |
| `close` | `{ code, reason, wasClean }` |
| `message` | `MessageEvent` |
| `error` | `Event` |
| `stateChange` | `{ from, to }` |
| `reconnecting` | `{ attempt, delay }` |
| `reconnectFailed` | `undefined` |

### HeartbeatFn

소켓이 열릴 때 호출되며, cleanup 함수를 반환하면 소켓이 닫힐 때 자동 호출됩니다.

```ts
type HeartbeatFn = (ctx: HeartbeatContext) => (() => void) | void;

interface HeartbeatContext {
  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void;
  onMessage(handler: (event: MessageEvent) => void): () => void;
  reconnect(): void; // 현재 연결을 끊고 재연결
}
```

## 내보내기

```ts
// 메인 엔트리
import { SocketClient, SharedWorkerClient, ConnectionState } from '@begin0dev/sockgate';
import type { SocketClientOptions, SharedWorkerClientOptions, ISocketClient, SocketEventMap, SubscribeData } from '@begin0dev/sockgate';

// SharedWorker 엔트리 (워커 스크립트 전용)
import { WorkerCore } from '@begin0dev/sockgate/worker';
import type { SocketClientOptions } from '@begin0dev/sockgate/worker';
```

## 개발

```bash
pnpm install
pnpm build    # esm + cjs + worker 빌드
pnpm test     # vitest
pnpm lint     # oxlint
pnpm format   # prettier
```
