import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Lobby } from './lobby.js';
import { startupOptions, USAGE } from './options.js';

export function createApp(options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { etag: true }));
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const lobby = new Lobby(options);
  server.on('upgrade', (req, socket, head) => {
    // Browser connections must originate from this host; command clients may
    // omit Origin. No cross-origin cookie or identity trust is needed.
    let sameOrigin = true;
    try { if (req.headers.origin) sameOrigin = new URL(req.headers.origin).host === req.headers.host; }
    catch { sameOrigin = false; }
    if (req.url !== '/ws' || !sameOrigin) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    const player = lobby.connect(data => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return; }
      ws.send(JSON.stringify(data));
    });
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    let windowStart = Date.now(), commands = 0;
    ws.on('message', (raw, binary) => {
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); commands = 0; }
      if (++commands > 30) return lobby.error(player, 'Slow down a little');
      if (binary) return lobby.error(player, 'Commands must be JSON text');
      let data;
      try { data = JSON.parse(raw.toString()); }
      catch { return lobby.error(player, 'Invalid command'); }
      try { lobby.handle(player, data); }
      catch (error) {
        console.error('Command failed:', error);
        lobby.error(player, 'The command could not be completed');
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => lobby.disconnect(player));
  });
  const timer = setInterval(() => lobby.tick(), 50);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 15000);
  timer.unref();
  heartbeat.unref();
  const close = () => new Promise((resolveClose, reject) => {
    clearInterval(timer);
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => server.close(error => error ? reject(error) : resolveClose()));
  });
  return { app, server, wss, lobby, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = startupOptions(); }
  catch (error) { console.error(`${error.message}\n\n${USAGE}`); process.exit(1); }
  if (options.help) { console.log(USAGE); process.exit(0); }
  const { port, host } = options;
  const runtime = createApp({
    dictionary: process.env.SCRAMBLE_DICTIONARY ?? 'default',
    training: process.env.SCRAMBLE_TRAINING === '1',
  });
  runtime.server.listen(port, host, () => console.log(`Scramble: http://localhost:${runtime.server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => { await runtime.close(); process.exit(0); });
  }
}
