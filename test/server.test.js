import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../server/index.js';
import { Dictionary } from '../server/dictionary.js';

async function setup(t, options = {}) {
  let time = 10000;
  const runtime = createApp({ now: () => time, ...options });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(() => runtime.close());
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  const url = origin.replace('http:', 'ws:') + '/ws';
  async function client(name) {
    const ws = new WebSocket(url);
    const messages = [];
    const pending = new Set();
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      for (const entry of pending) {
        if (entry.predicate(message)) { pending.delete(entry); clearTimeout(entry.timer); entry.resolve(message); }
      }
    });
    const wait = (predicate, since = 0) => {
      const found = messages.slice(since).find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const entry = { predicate, resolve, timer: setTimeout(() => { pending.delete(entry); reject(new Error('Timed out waiting for WebSocket response')); }, 2000) };
        pending.add(entry);
      });
    };
    await once(ws, 'open');
    const welcome = await wait(m => m.type === 'welcome');
    if (name) {
      ws.send(JSON.stringify({ type: 'name', name }));
      await wait(m => m.type === 'named');
    }
    return { ws, id: welcome.playerId, messages, wait,
      send(data) { const since = messages.length; ws.send(JSON.stringify(data)); return since; } };
  }
  return { ...runtime, origin, url, client, advance(ms) { time += ms; runtime.lobby.tick(); } };
}

test('Express serves the complete page, original assets, health check, and no private sources', async t => {
  const rt = await setup(t);
  for (const path of ['/', '/app.js', '/style.css', '/assets/scramble.gif', '/assets/sound/woohoo.wav']) {
    const response = await fetch(rt.origin + path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
  }
  assert.deepEqual(await (await fetch(rt.origin + '/api/health')).json(), { ok: true });
  for (const path of ['/server/game.js', '/src/res/words/us-english-twl', '/.git/config', '/unknown']) {
    assert.equal((await fetch(rt.origin + path)).status, 404);
  }
});

test('real WebSocket clients create, join, start, chat, stop, and leave the same game', async t => {
  const rt = await setup(t);
  const alice = await rt.client('Alice');
  const bob = await rt.client('Bob');
  let since = alice.send({ type: 'create', name: 'Old school', level: 1, speed: 3 });
  const created = await alice.wait(m => m.type === 'game', since);
  const gameId = created.game.id;
  since = bob.send({ type: 'join', gameId });
  await bob.wait(m => m.type === 'game' && m.game.players.length === 2, since);
  alice.send({ type: 'ready', ready: true });
  since = bob.send({ type: 'ready', ready: true });
  await bob.wait(m => m.type === 'game' && m.game.state === 'countdown', since);
  rt.advance(3000);
  const playing = await alice.wait(m => m.type === 'game' && m.game.state === 'playing' && m.game.pool.length === 3);
  assert.equal(playing.game.pool.length, 3);
  since = alice.send({ type: 'chat', text: '<b>Hello Bob</b>' });
  const chat = await bob.wait(m => m.type === 'game' && m.game.messages.some(e => e.text === '<b>Hello Bob</b>'));
  assert.equal(chat.game.messages.at(-1).name, 'Alice');
  alice.send({ type: 'ready', ready: false });
  since = bob.send({ type: 'ready', ready: false });
  const finished = await bob.wait(m => m.type === 'game' && m.game.result, since);
  assert.equal(finished.game.state, 'waiting');
  assert.equal(finished.game.result.winners.length, 2);
  since = alice.send({ type: 'leave' });
  await alice.wait(m => m.type === 'lobby', since);
  since = bob.send({ type: 'leave' });
  await bob.wait(m => m.type === 'lobby' && m.games.length === 0, since);
  assert.equal(rt.lobby.games.size, 0);
});

test('case-insensitive names and room names are unique; malformed settings and commands are rejected', async t => {
  const rt = await setup(t);
  const alice = await rt.client('Alice');
  const anonymous = await rt.client();
  let since = anonymous.send({ type: 'name', name: 'aLiCe' });
  await anonymous.wait(m => m.type === 'error' && m.text.includes('taken'), since);
  since = anonymous.send({ type: 'create', name: 'Anonymous room', level: 1, speed: 1 });
  await anonymous.wait(m => m.type === 'error' && m.text.includes('pick a name'), since);
  since = alice.send({ type: 'create', name: 'Invalid', level: 1, speed: 99 });
  await alice.wait(m => m.type === 'error' && m.text.includes('settings'), since);
  assert.equal(rt.lobby.games.size, 0);
  since = alice.messages.length;
  alice.ws.send('{');
  await alice.wait(m => m.type === 'error' && m.text === 'Invalid command', since);
  since = alice.send({ type: 'unknown' });
  await alice.wait(m => m.type === 'error' && m.text === 'Unknown command', since);
  since = alice.send({ type: 'create', name: 'Room', level: 1, speed: 1 });
  await alice.wait(m => m.type === 'game', since);
  anonymous.send({ type: 'name', name: 'Bob' });
  since = anonymous.send({ type: 'create', name: 'rOOM', level: 1, speed: 1 });
  await anonymous.wait(m => m.type === 'error' && m.text.includes('unique'), since);
});

test('the fifth connection spectates, cannot take or start, and inherits a vacated seat', async t => {
  const rt = await setup(t);
  const clients = [];
  for (let i = 0; i < 5; i++) clients.push(await rt.client(`Player ${i}`));
  const first = clients[0];
  let since = first.send({ type: 'create', name: 'Full game', level: 1, speed: 1 });
  const { game: { id } } = await first.wait(m => m.type === 'game', since);
  for (const client of clients.slice(1)) {
    since = client.send({ type: 'join', gameId: id });
    await client.wait(m => m.type === 'game', since);
  }
  const spectator = clients[4];
  const room = rt.lobby.games.get(id);
  assert.equal(room.players.get(spectator.id).spectator, true);
  since = spectator.send({ type: 'ready', ready: true });
  await spectator.wait(m => m.type === 'error' && m.text.includes('spectator'), since);
  since = spectator.send({ type: 'take', word: 'cat' });
  await spectator.wait(m => m.type === 'error' && m.text.includes('spectator'), since);
  const marker = spectator.messages.length;
  first.send({ type: 'leave' });
  await spectator.wait(m => m.type === 'game' && !m.game.players.find(p => p.id === spectator.id).spectator, marker);
  assert.equal(room.activePlayers.length, 4);
});

test('concurrent claims award a tile set once; disconnects return words and release names', async t => {
  const rt = await setup(t);
  const alice = await rt.client('Alice'), bob = await rt.client('Bob');
  let since = alice.send({ type: 'create', name: 'Race', level: 1, speed: 1 });
  const { game: { id } } = await alice.wait(m => m.type === 'game', since);
  since = bob.send({ type: 'join', gameId: id });
  await bob.wait(m => m.type === 'game', since);
  const game = rt.lobby.games.get(id);
  game.state = 'playing';
  game.nextDealAt = Infinity;
  game.startedAt = 10000;
  for (const p of game.players.values()) p.ready = true;
  for (const c of 'cat') game.pool.tiles.find(t => t.state === 'bag' && t.letter === c).state = 'pool';
  alice.send({ type: 'take', word: 'cat' });
  since = bob.send({ type: 'take', word: 'cat' });
  await bob.wait(m => m.type === 'error' && m.text.includes('already taken'), since);
  assert.equal(game.words.length, 1);
  assert.equal(game.pool.letters.length, 0);
  alice.ws.close();
  await once(alice.ws, 'close');
  // A subsequent response fences the server's asynchronous close handling.
  since = bob.send({ type: 'chat', text: 'Still here' });
  await bob.wait(m => m.type === 'game' && m.game.messages.some(e => e.text === 'Still here'), since);
  assert.equal(game.words.length, 0);
  assert.equal(game.pool.remaining, 98);
  const replacement = await rt.client('Alice');
  assert.ok(replacement.id);
});

test('waiting players are removed after ten seconds when others are ready', async t => {
  const rt = await setup(t);
  const alice = await rt.client('Alice'), bob = await rt.client('Bob');
  let since = alice.send({ type: 'create', name: 'Waiting', level: 1, speed: 1 });
  const created = await alice.wait(m => m.type === 'game', since);
  since = bob.send({ type: 'join', gameId: created.game.id });
  await bob.wait(m => m.type === 'game', since);
  since = alice.send({ type: 'ready', ready: true });
  await alice.wait(m => m.type === 'game' && m.game.players.find(p => p.id === alice.id).ready, since);
  rt.advance(10001);
  await bob.wait(m => m.type === 'lobby');
  assert.equal(rt.lobby.games.get(created.game.id).state, 'countdown');
});

test('idle games warn at two minutes and expire after three; fresh servers have no persisted names or games', async t => {
  const rt = await setup(t);
  const alice = await rt.client('Alice');
  let since = alice.send({ type: 'create', name: 'Idle', level: 1, speed: 1 });
  await alice.wait(m => m.type === 'game', since);
  rt.advance(120001);
  await alice.wait(m => m.type === 'game' && m.game.messages.some(e => e.text.includes('will terminate')));
  rt.advance(60000);
  await alice.wait(m => m.type === 'lobby' && m.games.length === 0);
  const fresh = createApp();
  assert.equal(fresh.lobby.players.size, 0);
  assert.equal(fresh.lobby.games.size, 0);
  await new Promise(resolve => fresh.server.listen(0, '127.0.0.1', resolve));
  await fresh.close();
});

test('untrusted cross-origin WebSockets are rejected', async t => {
  const rt = await setup(t);
  const ws = new WebSocket(rt.url, { origin: 'https://unrelated.example' });
  ws.on('error', () => {});
  const [, response] = await once(ws, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  response.resume();
  ws.terminate();
});

test('training rooms stay operational through multiple starts and human departures', async t => {
  const dictionary = new Dictionary('cat\nact\ndog\ngod\n');
  const rt = await setup(t, { training: true, dictionaries: { get: () => dictionary } });
  const alice = await rt.client('Alice');
  const first = [...rt.lobby.games.values()][0];
  let since = alice.send({ type: 'join', gameId: first.id });
  await alice.wait(m => m.type === 'game', since);
  since = alice.send({ type: 'ready', ready: true });
  await alice.wait(m => m.type === 'game' && m.game.players.find(p => p.id === alice.id).ready, since);
  rt.advance(50);
  assert.equal(first.state, 'countdown');
  rt.advance(3000);
  assert.equal(first.state, 'playing');
  since = alice.send({ type: 'leave' });
  await alice.wait(m => m.type === 'lobby', since);
  assert.equal(first.state, 'waiting');
  assert.equal(first.players.size, 1);
  assert.equal(rt.lobby.games.size, 4);
});
