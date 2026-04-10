import { useMemo } from 'react';
import { SocketClient } from 'sockgate';
import { SocketProvider } from '../context/socket-context';
import { SocketScenario } from '../components/socket-scenario';

export function Socket() {
  const client = useMemo(
    () =>
      new SocketClient({
        url: 'ws://localhost:3001',
        reconnect: {
          attempts: 10,
          delay: 2_000,
          delayMax: 10_000,
          factor: 0.1,
        },
        heartbeat: (ctx) => {
          let pongTimeout: ReturnType<typeof setTimeout> | null = null;
          let nextPingTimer: ReturnType<typeof setTimeout> | null = null;
          let pingSentAt = 0;

          const sendPing = () => {
            pingSentAt = Date.now();
            ctx.send(JSON.stringify({ type: 'ping' }));
            pongTimeout = setTimeout(() => {
              pongTimeout = null;
              ctx.reconnect();
            }, 5_000);
          };

          const unsub = ctx.onMessage((event) => {
            try {
              const msg = JSON.parse(String(event.data));
              if (msg?.type !== 'pong') return;

              if (pongTimeout !== null) {
                clearTimeout(pongTimeout);
                pongTimeout = null;
              }

              const latency = Date.now() - pingSentAt;
              if (latency >= 2_000) {
                ctx.reconnect();
                return;
              }

              nextPingTimer = setTimeout(sendPing, 3_000);
            } catch {
              // non-JSON messages are ignored
            }
          });

          sendPing();

          return () => {
            if (pongTimeout !== null) clearTimeout(pongTimeout);
            if (nextPingTimer !== null) clearTimeout(nextPingTimer);
            unsub();
          };
        },
      }),
    [],
  );

  return (
    <SocketProvider client={client}>
      <SocketScenario
        title="1. Socket"
        description="채널별 구독/구독해지 및 연결 종료를 테스트하는 시나리오."
      />
    </SocketProvider>
  );
}
