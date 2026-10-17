// Cloudflare Worker entry. Serves the built client from ./dist and routes
// /ws/<CODE> to one Durable Object per room. The Durable Object runs the
// authoritative Room (src/server/room.ts) and its fixed-rate tick loop.

import { Room, type Conn } from '../src/server/room';
import { ROOM_CODE_RE } from '../src/shared/protocol';

interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true });
    }
    const match = url.pathname.match(/^\/ws\/([^/]+)$/);
    if (match) {
      const code = match[1].toUpperCase();
      if (!ROOM_CODE_RE.test(code)) return new Response('Bad room code', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

const TICK_MS = 1000 / 60;

export class RoomObject implements DurableObject {
  private room: Room | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = (url.pathname.split('/').pop() ?? '').toUpperCase();
    this.room ??= new Room(code);
    const room = this.room;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const conn: Conn = {
      send: (data) => server.send(data),
      close: (c, reason) => {
        try {
          server.close(c, reason);
        } catch {
          // Already closed.
        }
      },
    };
    const ok = room.connect(
      conn,
      {
        name: url.searchParams.get('name') ?? '',
        cid: url.searchParams.get('cid') ?? '',
        create: url.searchParams.get('create') === '1',
      },
      Date.now(),
    );
    if (ok) {
      server.addEventListener('message', (e) => room.message(conn, typeof e.data === 'string' ? e.data : '', Date.now()));
      const gone = () => room.disconnect(conn, Date.now());
      server.addEventListener('close', gone);
      server.addEventListener('error', gone);
      this.startLoop();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private startLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const room = this.room;
      if (!room) return;
      room.tick(Date.now());
      if (!room.alive) {
        clearInterval(this.timer!);
        this.timer = null;
        this.room = null;
      }
    }, TICK_MS);
  }
}
