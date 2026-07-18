import WebSocket from 'ws';

import type { PulseEvent } from '@/lib/pulse/types';

// Market data sources behind one interface, per the Phase 8 decision:
// crypto now (Coinbase, free/keyless/24-7), stocks later as another
// adapter, plus a synthetic source for local dev and load benchmarks.

export interface PulseSource {
  readonly name: string;
  /** Resolves once the source is connected and events are flowing. */
  start(symbols: string[], onEvent: (event: PulseEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

const COINBASE_WS_URL = 'wss://ws-feed.exchange.coinbase.com';

interface CoinbaseMatch {
  type: string;
  product_id?: string;
  price?: string;
  size?: string;
  time?: string;
}

// Public matches channel (executed trades), no API key. Sessions are
// minutes long, so failure handling is deliberately simple: one silent
// reconnect attempt, then stop emitting and let the session loop notice
// the event drought and end the session cleanly.
export class CoinbaseSource implements PulseSource {
  readonly name = 'coinbase';
  private socket: WebSocket | null = null;
  private stopping = false;
  private reconnected = false;

  async start(symbols: string[], onEvent: (event: PulseEvent) => void): Promise<void> {
    await this.connect(symbols, onEvent);
  }

  private connect(symbols: string[], onEvent: (event: PulseEvent) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(COINBASE_WS_URL);
      this.socket = socket;

      socket.on('open', () => {
        socket.send(
          JSON.stringify({ type: 'subscribe', product_ids: symbols, channels: ['matches'] }),
        );
        resolve();
      });

      socket.on('message', (raw: WebSocket.RawData) => {
        let message: CoinbaseMatch;
        try {
          message = JSON.parse(raw.toString()) as CoinbaseMatch;
        } catch {
          return;
        }
        if (message.type !== 'match' && message.type !== 'last_match') return;
        if (!message.product_id || !message.price || !message.time) return;
        const price = Number(message.price);
        const size = Number(message.size ?? 0);
        if (!Number.isFinite(price) || price <= 0) return;
        onEvent({
          symbol: message.product_id,
          price,
          size: Number.isFinite(size) && size >= 0 ? size : 0,
          exchangeTs: Date.parse(message.time),
          ingestTs: Date.now(),
        });
      });

      socket.on('error', (error: Error) => {
        reject(error); // no-op if already resolved
      });

      socket.on('close', () => {
        if (this.stopping || this.reconnected) return;
        this.reconnected = true;
        this.connect(symbols, onEvent).catch(() => {
          // Second failure: go quiet; the session loop ends on the drought.
        });
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.socket?.close();
    this.socket = null;
  }
}

// Deterministic-ish random walk per symbol at a configurable event rate.
// Local dev never depends on an internet feed, and the throughput
// benchmarks use this to push far past real market rates.
export class SyntheticSource implements PulseSource {
  readonly name = 'synthetic';
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly eventsPerSecond = 50) {}

  async start(symbols: string[], onEvent: (event: PulseEvent) => void): Promise<void> {
    const prices = new Map<string, number>(symbols.map((symbol, i) => [symbol, 1000 * (i + 1)]));
    const perTick = Math.max(1, Math.round(this.eventsPerSecond / 20));
    this.timer = setInterval(() => {
      for (let i = 0; i < perTick; i++) {
        const symbol = symbols[Math.floor(Math.random() * symbols.length)];
        const previous = prices.get(symbol) ?? 1000;
        const price = Math.max(0.01, previous * (1 + (Math.random() - 0.5) * 0.001));
        prices.set(symbol, price);
        const now = Date.now();
        onEvent({ symbol, price, size: Math.random(), exchangeTs: now - 5, ingestTs: now });
      }
    }, 50);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function selectSource(): PulseSource {
  const name = process.env.PULSE_SOURCE ?? 'coinbase';
  if (name === 'synthetic') {
    return new SyntheticSource(Number(process.env.PULSE_SYNTHETIC_RATE ?? 50));
  }
  if (name === 'coinbase') return new CoinbaseSource();
  throw new Error(`unknown PULSE_SOURCE ${name}`);
}
