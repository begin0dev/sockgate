/// <reference lib="webworker" />

import { WorkerCore } from 'sockgate/worker';
import {SocketClient} from "sockgate";

declare const self: SharedWorkerGlobalScope;

const core = new WorkerCore({
  socket: new SocketClient({
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
});

self.onconnect = (event: MessageEvent) => {
  core.addPort(event.ports[0]);
};
