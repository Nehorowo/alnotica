/**
 * A mock Bot API at the HTTP level.
 *
 * Mocking grammY's handlers would test our wiring against itself. Mocking the
 * transport means the real grammY client, the real throttler and the real
 * auto-retry plugin all run — which is where the interesting bugs live.
 */
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
  readonly at: number;
}

export type Responder = (
  method: string,
  body: Record<string, unknown>,
) => { status?: number; payload: unknown } | null;

export class TelegramMock {
  private server: Server | null = null;
  private port = 0;
  readonly calls: RecordedCall[] = [];
  private responders: Responder[] = [];

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> = {};
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          body = {};
        }
        // Path shape: /bot<token>/<method>
        const method = (req.url ?? '').split('/').pop() ?? '';
        this.calls.push({ method, body, at: Date.now() });

        for (const responder of this.responders) {
          const custom = responder(method, body);
          if (custom) {
            res.writeHead(custom.status ?? 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(custom.payload));
            return;
          }
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: defaultResult(method, body) }));
      });
    });

    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server?.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }

  /** Responders are consulted in order; the first non-null answer wins. */
  respond(responder: Responder): void {
    this.responders.push(responder);
  }

  /** Fails the next `times` calls to `method` with a 429 and a retry_after. */
  floodWait(method: string, retryAfter: number, times = 1): void {
    let remaining = times;
    this.respond((m) => {
      if (m !== method || remaining <= 0) return null;
      remaining--;
      return {
        status: 429,
        payload: {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry later',
          parameters: { retry_after: retryAfter },
        },
      };
    });
  }

  /** Every call to `method` reports that the user blocked the bot. */
  blocked(method: string): void {
    this.respond((m) =>
      m === method
        ? {
            status: 403,
            payload: {
              ok: false,
              error_code: 403,
              description: 'Forbidden: bot was blocked by the user',
            },
          }
        : null,
    );
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  reset(): void {
    this.calls.length = 0;
    this.responders = [];
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }
}

function defaultResult(method: string, body: Record<string, unknown>): unknown {
  switch (method) {
    case 'getMe':
      return {
        id: 777_000,
        is_bot: true,
        first_name: 'Alnotica',
        username: 'AlnoticaTestBot',
        can_join_groups: true,
      };
    case 'sendMessage':
    case 'editMessageText':
      return {
        message_id: Math.floor(Math.random() * 1_000_000),
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(body.chat_id ?? 0), type: 'private' },
        text: body.text ?? '',
      };
    case 'answerCallbackQuery':
    case 'setWebhook':
    case 'deleteWebhook':
      return true;
    default:
      return true;
  }
}
