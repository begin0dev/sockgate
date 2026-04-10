import { useEffect, useState } from 'react';
import { ConnectionState } from 'sockgate';
import { useSocketClient } from '../context/socket-context';

export interface LogEntry {
  ts: number;
  kind: 'info' | 'send' | 'recv' | 'error' | 'state';
  text: string;
}

export function useSocket() {
  const client = useSocketClient();
  const [state, setState] = useState<ConnectionState>(ConnectionState.CLOSED);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const addLog = (kind: LogEntry['kind'], text: string) => {
    setLogs((prev) => [...prev.slice(-199), { ts: Date.now(), kind, text }]);
  };

  useEffect(() => {
    const offState = client.on('stateChange', ({ from, to }) => {
      setState(to);
      addLog('state', `${from} → ${to}`);
    });
    const offOpen = client.on('open', () => addLog('info', 'connected'));
    const offClose = client.on('close', ({ code, reason }) =>
      addLog('info', `closed (code=${code} reason=${reason || '-'})`),
    );
    const offMessage = client.on('message', (e) => addLog('recv', String(e.data)));
    const offError = client.on('error', () => addLog('error', 'error event'));
    const offReconnecting = client.on('reconnecting', ({ attempt, delay }) =>
      addLog('info', `reconnecting #${attempt} in ${delay}ms…`),
    );
    const offReconnectFailed = client.on('reconnectFailed', () =>
      addLog('error', 'reconnect failed — giving up'),
    );

    return () => {
      offState();
      offOpen();
      offClose();
      offMessage();
      offError();
      offReconnecting();
      offReconnectFailed();
    };
  }, [client]);

  const send = (data: string) => {
    client.send(data);
    addLog('send', data);
  };

  const subscribe = (topic: string, subscribeData: string, unsubscribeData: string) => {
    client.subscribe(topic, subscribeData, unsubscribeData);
    addLog('send', subscribeData);
  };

  const unsubscribe = (topic: string) => {
    client.unsubscribe(topic);
    addLog('send', `unsubscribe: ${topic}`);
  };

  const connect = () => {
    client.connect();
  };

  const close = () => {
    client.close();
  };

  const clearLogs = () => setLogs([]);

  return { state, logs, send, subscribe, unsubscribe, connect, close, clearLogs };
}
