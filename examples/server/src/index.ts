import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { randomDelay, mockTickerPayload, mockTradePayload } from './mock.js';

const PORT = 3001;
const wss = new WebSocketServer({ port: PORT });

let clientCount = 0;

interface InboundMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

interface SubscribePayload {
  channel: 'ticker' | 'trades';
  symbol: string;
}

function send(ws: WebSocket, type: string, payload: unknown, requestId?: string) {
  const envelope: Record<string, unknown> = {
    id: randomUUID(),
    type,
    payload,
    t: new Date().toISOString(),
  };
  if (requestId) envelope.requestId = requestId;
  ws.send(JSON.stringify(envelope));
}

function scheduleNext(fn: () => void): NodeJS.Timeout {
  return setTimeout(fn, randomDelay());
}

wss.on('connection', (ws: WebSocket) => {
  const clientId = ++clientCount;
  console.log(`[+] client #${clientId} connected (total: ${wss.clients.size})`);

  // subscriptionKey -> active timeout handle
  const subscriptions = new Map<string, NodeJS.Timeout>();

  function startSubscription(key: string, tick: () => void) {
    if (subscriptions.has(key)) return;
    const loop = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      tick();
      subscriptions.set(key, scheduleNext(loop));
    };
    subscriptions.set(key, scheduleNext(loop));
  }

  function stopSubscription(key: string) {
    const handle = subscriptions.get(key);
    if (handle !== undefined) {
      clearTimeout(handle);
      subscriptions.delete(key);
    }
  }

  ws.on('message', (data: Buffer | string) => {
    let msg: InboundMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, 'error', { code: 400, message: 'Invalid JSON' });
      return;
    }

    console.log(`[#${clientId}] type=${msg.type}`);

    switch (msg.type) {
      case 'ping':
        send(ws, 'pong', null, msg.id);
        break;

      case 'message':
        send(ws, 'message.ack', { clientId, data: msg.payload }, msg.id);
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            send(client, 'message.broadcast', { from: clientId, data: msg.payload });
          }
        });
        break;

      case 'subscribe': {
        const p = msg.payload as SubscribePayload;
        if (!p?.channel || !p?.symbol) {
          send(ws, 'error', { code: 400, message: 'subscribe requires payload.channel and payload.symbol' }, msg.id);
          break;
        }
        const key = `${p.channel}:${p.symbol}`;
        if (subscriptions.has(key)) {
          send(ws, 'subscribe.ack', { channel: p.channel, symbol: p.symbol, status: 'already_subscribed' }, msg.id);
          break;
        }
        if (p.channel === 'ticker') {
          startSubscription(key, () => send(ws, 'ticker', mockTickerPayload(p.symbol)));
        } else if (p.channel === 'trades') {
          startSubscription(key, () => send(ws, 'trade', mockTradePayload(p.symbol)));
        } else {
          send(ws, 'error', { code: 400, message: `Unknown channel: ${p.channel}` }, msg.id);
          break;
        }
        console.log(`[#${clientId}] subscribed ${key}`);
        send(ws, 'subscribe.ack', { channel: p.channel, symbol: p.symbol, status: 'subscribed' }, msg.id);
        break;
      }

      case 'unsubscribe': {
        const p = msg.payload as SubscribePayload;
        if (!p?.channel || !p?.symbol) {
          send(ws, 'error', { code: 400, message: 'unsubscribe requires payload.channel and payload.symbol' }, msg.id);
          break;
        }
        const key = `${p.channel}:${p.symbol}`;
        stopSubscription(key);
        console.log(`[#${clientId}] unsubscribed ${key}`);
        send(ws, 'unsubscribe.ack', { channel: p.channel, symbol: p.symbol, status: 'unsubscribed' }, msg.id);
        break;
      }

      default:
        send(ws, 'error', { code: 400, message: `Unknown type: ${msg.type}` }, msg.id);
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    subscriptions.forEach((handle) => clearTimeout(handle));
    subscriptions.clear();
    console.log(`[-] client #${clientId} disconnected (code: ${code}, reason: ${reason.toString() || '-'})`);
  });

  ws.on('error', (err: Error) => {
    console.error(`[!] client #${clientId} error:`, err.message);
  });

  send(ws, 'connected', { clientId });
});

console.log(`WebSocket server listening on ws://localhost:${PORT}`);
