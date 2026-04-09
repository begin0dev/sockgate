# sockgate

자동 재연결과 SharedWorker 기반 탭 간 연결 공유를 지원하는 가벼운 WebSocket 클라이언트.

## 특징

- **자동 재연결**: 지수 백오프 + 지터(jitter) 기반 재시도
- **SharedWorker 지원**: 여러 탭이 하나의 WebSocket 연결을 공유 (미지원 환경에서는 일반 WebSocket으로 폴백)
- **타입 세이프한 이벤트**: `open`, `close`, `message`, `error`, `stateChange`, `reconnecting`, `reconnectFailed`
- **의존성 없음**: 순수 TypeScript

## 설치

```bash
pnpm add sockgate
```

## 사용법

### 기본

```ts
import { SocketClient, ConnectionState } from 'sockgate';

const client = new SocketClient({
  url: 'wss://example.com/ws',
  autoReconnect: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 30000,
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

### SharedWorker (탭 간 연결 공유)

```ts
const client = new SocketClient({
  url: 'wss://example.com/ws',
  useSharedWorker: true,
  sharedWorkerUrl: '/path/to/worker-script.js',
});

client.connect();
```

`SharedWorker`가 지원되지 않는 환경에서는 자동으로 일반 WebSocket으로 폴백됩니다.

## API

### `new SocketClient(options)`

| 옵션 | 타입 | 설명 |
|---|---|---|
| `url` | `string` | WebSocket URL (필수) |
| `protocols` | `string \| string[]` | 서브프로토콜 |
| `autoReconnect` | `boolean` | 자동 재연결 활성화 |
| `reconnectionAttempts` | `number` | 최대 재시도 횟수 |
| `reconnectionDelay` | `number` | 초기 재시도 지연 (ms) |
| `reconnectionDelayMax` | `number` | 최대 재시도 지연 (ms) |
| `randomizationFactor` | `number` | 지터 팩터 (0~1) |
| `useSharedWorker` | `boolean` | SharedWorker 사용 여부 |
| `sharedWorkerUrl` | `string` | 워커 스크립트 경로 |

### 메서드

- `connect()` — 연결 시작
- `send(data)` — 데이터 전송 (`string | ArrayBuffer | Blob | ArrayBufferView`)
- `close(code?, reason?)` — 연결 종료
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

## 개발

```bash
pnpm install
pnpm build    # tsc + worker 빌드
pnpm test     # vitest
pnpm lint     # oxlint
pnpm format   # prettier
```
