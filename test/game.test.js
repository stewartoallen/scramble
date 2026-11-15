import test from 'node:test';
import assert from 'node:assert/strict';
import { Dictionary, Dictionaries, extraLetters, signature } from '../server/dictionary.js';
import { Game, TilePool, TILE_COUNTS, SPEEDS } from '../server/game.js';
import { Lobby } from '../server/lobby.js';
import { TrainerBot } from '../server/bot.js';

const vocabulary = 'cat act tac cats scat cart dog god dogs good rat tar art star stare tears rates tea eat ate apple appeal peal pale leap red reed deer read catdog';
function fixture(options = {}) {
  let time = 10000;
  let seed = 123;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const events = [];
  const dictionary = new Dictionary(vocabulary.split(' ').join('\n'));
  const game = new Game({ name: 'Test game', dictionary, now: () => time, random,
    emit: event => events.push(event), ...options });
  const alice = { id: 'alice', name: 'Alice', lastAction: time };
  const bob = { id: 'bob', name: 'Bob', lastAction: time };
  game.addPlayer(alice);
  game.addPlayer(bob);
  return { game, alice, bob, events, setTime: value => { time = value; }, advance: ms => { time += ms; game.tick(time); } };
}

function stage(f, pool, ownership = []) {
  const { game } = f;
  for (const tile of game.pool.tiles) tile.state = 'bag';
  game.words = [];
  const mark = (letters, state) => {
    for (const letter of letters) {
      const tile = game.pool.tiles.find(t => t.state === 'bag' && t.letter === letter);
      assert.ok(tile, `Fixture exceeds tile distribution: ${letter}`);
      tile.state = state;
    }
  };
  for (const [owner, text, history = []] of ownership) {
    mark(text, 'owned');
    game.words.push({ id: `word-${game.words.length}`, text, ownerId: owner.id, history: new Set(history) });
  }
  mark(pool, 'pool');
  game.state = 'playing';
  game.startedAt = 10000;
  game.nextDealAt = 1000000;
  game.lastTake = -Infinity;
  game.deadline = null;
  game.endgame = false;
  for (const player of game.activePlayers) player.ready = true;
  conserved(game);
}

function conserved(game) {
  assert.equal(game.pool.tiles.length, 98);
  assert.ok(game.pool.letters.length <= 52);
  const boardLetters = game.words.map(w => w.text).join('');
  assert.equal(signature(boardLetters), signature(game.pool.tiles.filter(t => t.state === 'owned').map(t => t.letter).join('')));
  for (const p of game.players.values()) assert.ok(game.wordsFor(p).length <= 24);
}

function filler(reserved, count) {
  const letters = Object.entries(TILE_COUNTS).flatMap(([letter, n]) => Array(n).fill(letter));
  for (const letter of reserved) letters.splice(letters.indexOf(letter), 1);
  return Array.from({ length: count }, (_, i) => letters.slice(i * 3, i * 3 + 3).join(''));
}

test('letter signatures count occurrences and reject incomplete whole-word matches', () => {
  assert.equal(signature('apple'), signature('pepla'));
  assert.notEqual(signature('apple'), signature('appelx'));
  assert.equal(extraLetters('appeal', 'apple'), 'a');
  assert.equal(extraLetters('pale', 'apple'), null);
});

test('the four bundled vocabularies remain intact, with only malformed input excluded', () => {
  const dictionaries = new Dictionaries();
  assert.equal(dictionaries.get('default'), dictionaries.get('twl'));
  assert.equal(dictionaries.get('twl').words.size, 178590);
  assert.equal(dictionaries.get('sowpods').words.size, 267627);
  assert.equal(dictionaries.get('french').words.size, 378989);
  assert.equal(dictionaries.get('italian').words.size, 584977);
  assert.deepEqual(dictionaries.get('italian').skipped, ['acccu#']);
  assert.equal(dictionaries.get('french').noPlurals, false);
  assert.equal(dictionaries.get('uk english').noPlurals, true);
  assert.throws(() => dictionaries.get('unknown'));
});

test('anagram index preserves dictionary order and repeated-letter multiplicity', () => {
  const dict = new Dictionary('cat\r\nact\r\ntac\r\ncat\r\napple\r\npepla\r\ninvalid#\r\n');
  assert.deepEqual(dict.anagrams('tca'), ['cat', 'act', 'tac']);
  assert.deepEqual(dict.anagrams('ppale'), ['apple', 'pepla']);
  assert.deepEqual(dict.anagrams('pale'), []);
  assert.equal(dict.has('tca'), false);
  assert.deepEqual(dict.skipped, ['invalid#']);
});

test('pot has precisely the original 98 tiles, enforces 52 visible, and redeals returns', () => {
  const pool = new TilePool();
  assert.equal(pool.remaining, 98);
  for (const [letter, count] of Object.entries(TILE_COUNTS)) assert.equal(pool.tiles.filter(t => t.letter === letter).length, count);
  for (let i = 0; i < 52; i++) assert.equal(pool.deal(), true);
  assert.equal(pool.deal(), false);
  assert.equal(pool.remaining, 46);
  const word = pool.letters.slice(0, 3);
  pool.take(word);
  assert.equal(pool.letters.length, 49);
  assert.equal(pool.deal(), true);
  pool.returnWord(word);
  assert.equal(pool.remaining, 48);
});

test('all active players must be ready; spectators do not block the three-second start', () => {
  const f = fixture();
  const c = { id: 'c', name: 'C' }, d = { id: 'd', name: 'D' }, e = { id: 'e', name: 'E' };
  for (const p of [c, d, e]) f.game.addPlayer(p);
  assert.equal(e.spectator, true);
  for (const p of [f.alice, f.bob, c]) f.game.setReady(p, true);
  assert.equal(f.game.state, 'waiting');
  f.game.setReady(d, true);
  assert.equal(f.game.state, 'countdown');
  assert.equal(f.game.take(f.alice, 'cat').ok, false);
  f.advance(2999);
  assert.equal(f.game.pool.letters.length, 0);
  f.advance(1);
  assert.equal(f.game.state, 'playing');
  assert.equal(f.game.pool.letters.length, 3);
  f.advance(3149);
  assert.equal(f.game.pool.letters.length, 3);
  f.advance(1);
  assert.equal(f.game.pool.letters.length, 4);
});

test('all four speeds preserve original deal, grace, and endgame timings', () => {
  assert.deepEqual(SPEEDS.map(s => [s.deal, s.grace, s.end]), [
    [4000, 3000, 40000], [3000, 2500, 30000], [2000, 2000, 20000], [1500, 1750, 15000],
  ]);
  for (let speed = 0; speed < 4; speed++) {
    const f = fixture({ speed });
    f.game.setReady(f.alice, true); f.game.setReady(f.bob, true);
    f.advance(3000);
    assert.equal(f.game.nextDealAt, 13000 + SPEEDS[speed].deal + 150);
  }
});

test('pot-first takes are case-insensitive and score tile count', () => {
  const f = fixture();
  stage(f, 'cat', [[f.bob, 'cat']]);
  assert.deepEqual(f.game.take(f.alice, ' CAT '), { ok: true });
  assert.equal(f.game.wordsFor(f.bob).length, 1);
  assert.equal(f.game.score(f.alice), 3);
  assert.equal(f.game.pool.letters, '');
  conserved(f.game);
});

test('steals consume repeated letters correctly and retain word identity/history', () => {
  const f = fixture();
  stage(f, 'a', [[f.bob, 'apple']]);
  const id = f.game.words[0].id;
  assert.equal(f.game.take(f.alice, 'appeal').ok, true);
  assert.equal(f.game.words[0].id, id);
  assert.equal(f.game.words[0].ownerId, f.alice.id);
  assert.ok(f.game.words[0].history.has('apple'));
  assert.equal(f.game.score(f.alice), 6);
  assert.equal(f.game.score(f.bob), 0);
  conserved(f.game);
});

test('same-length anagrams can be stolen/defended but cannot cycle through history', () => {
  const f = fixture();
  stage(f, '', [[f.bob, 'cat']]);
  assert.equal(f.game.take(f.alice, 'act').ok, true);
  assert.equal(f.game.take(f.alice, 'tac').ok, true);
  assert.equal(f.game.take(f.bob, 'cat').ok, false);
  assert.equal(f.game.take(f.alice, 'act').ok, false);
  assert.equal(f.game.words[0].text, 'tac');
  assert.equal(f.game.take(f.bob, 'tac').message, "'tac' already taken");
  conserved(f.game);
});

test('ambiguous steals choose the longest eligible word', () => {
  const f = fixture();
  stage(f, 'as', [[f.bob, 'rat'], [f.bob, 'star']]);
  assert.equal(f.game.take(f.alice, 'rates').ok, false); // Missing E remains a real error.
  stage(f, 'ae', [[f.bob, 'rat'], [f.bob, 'star']]);
  assert.equal(f.game.take(f.alice, 'stare').ok, true);
  assert.equal(f.game.wordsFor(f.bob)[0].text, 'rat');
  conserved(f.game);
});

test('English plural steals and plurals of historical forms are forgiven', () => {
  const f = fixture();
  stage(f, 's', [[f.bob, 'cat'], [f.alice, 'dog']]);
  assert.match(f.game.take(f.alice, 'cats').message, /plural/);
  assert.equal(f.game.score(f.alice), 3);
  stage(f, '', [[f.bob, 'scat', ['cat']], [f.alice, 'dog']]);
  assert.match(f.game.take(f.alice, 'cats').message, /plural/);
  conserved(f.game);
});

test('non-English dictionaries retain their original plural policy', () => {
  const f = fixture({ dictionary: new Dictionary('cat\ncats\n', { noPlurals: false }) });
  stage(f, 's', [[f.bob, 'cat']]);
  assert.equal(f.game.take(f.alice, 'cats').ok, true);
  conserved(f.game);
});

test('invalid dictionary words lose the earliest shortest word and return tiles to the bag', () => {
  const f = fixture();
  stage(f, 'a', [[f.alice, 'cat'], [f.alice, 'dog'], [f.alice, 'reed']]);
  const remaining = f.game.pool.remaining;
  assert.equal(f.game.take(f.alice, 'zzzz').ok, false);
  assert.deepEqual(f.game.wordsFor(f.alice).map(w => w.text), ['dog', 'reed']);
  assert.equal(f.game.pool.remaining, remaining + 3);
  assert.equal(f.game.pool.letters, 'a');
  conserved(f.game);
});

test('valid words unavailable on the board are penalized; partial words cannot be taken', () => {
  const f = fixture();
  stage(f, '', [[f.bob, 'apple'], [f.alice, 'dog']]);
  assert.match(f.game.take(f.alice, 'pale').message, /not on the board/);
  assert.equal(f.game.score(f.alice), 0);
  conserved(f.game);
});

test('two whole words cannot be combined', () => {
  const f = fixture();
  stage(f, '', [[f.bob, 'cat'], [f.bob, 'dog']]);
  assert.equal(f.game.take(f.alice, 'catdog').ok, false);
  assert.equal(f.game.wordsFor(f.bob).length, 2);
  conserved(f.game);
});

test('short, non-letter, oversized and spectator inputs cannot mutate the board', () => {
  const f = fixture();
  stage(f, 'cat', [[f.alice, 'dog']]);
  const before = f.game.snapshot();
  for (const word of ['ca', 'c@t', 'éat', 'a'.repeat(25), null, {}]) assert.equal(f.game.take(f.alice, word).ok, false);
  f.bob.spectator = true;
  assert.equal(f.game.take(f.bob, 'cat').ok, false);
  assert.deepEqual(f.game.snapshot(), { ...before, players: before.players.map(p => p.id === 'bob' ? { ...p, spectator: true } : p), spectators: 1 });
  conserved(f.game);
});

test('grace-period errors are forgiven and dealing waits after a successful take', () => {
  const f = fixture();
  stage(f, 'cat', [[f.alice, 'dog']]);
  assert.equal(f.game.take(f.alice, 'cat').ok, true);
  assert.match(f.game.take(f.alice, 'zzzz').message, /too close/);
  assert.equal(f.game.wordsFor(f.alice).length, 2);
  f.game.nextDealAt = 10000;
  f.advance(2499);
  assert.equal(f.game.pool.letters.length, 0);
  f.advance(1);
  assert.equal(f.game.pool.letters.length, 1);
  assert.equal(f.game.take(f.alice, 'zzzz').ok, false);
  assert.equal(f.game.wordsFor(f.alice).length, 1);
  conserved(f.game);
});

test('24-word rejection never consumes pot tiles, while defense remains possible', () => {
  const f = fixture();
  const fill = filler('cats', 24);
  stage(f, 's', [[f.bob, 'cat'], ...fill.map(word => [f.alice, word])]);
  const before = f.game.pool.letters;
  // CAT -> SCAT is an extension, not the forbidden CAT -> CATS plural.
  assert.match(f.game.take(f.alice, 'scat').message, /word limit/);
  assert.equal(f.game.pool.letters, before);
  assert.equal(f.game.wordsFor(f.bob)[0].text, 'cat');
  conserved(f.game);
  stage(f, 's', [[f.alice, 'cat'], ...filler('cats', 23).map(word => [f.alice, word])]);
  assert.equal(f.game.take(f.alice, 'scat').ok, true);
  assert.equal(f.game.wordsFor(f.alice).length, 24);
  conserved(f.game);
});

test('24-word pot takes are rejected without losing or consuming words', () => {
  const f = fixture();
  stage(f, 'cat', filler('cat', 24).map(word => [f.alice, word]));
  const before = f.game.pool.letters;
  assert.equal(f.game.take(f.alice, 'cat').ok, false);
  assert.equal(f.game.pool.letters, before);
  assert.equal(f.game.wordsFor(f.alice).length, 24);
  conserved(f.game);
});

test('a full pot starts a countdown without granting endgame penalty protection', () => {
  const f = fixture();
  stage(f, '', [[f.alice, 'dog']]);
  while (f.game.pool.letters.length < 52) f.game.pool.deal();
  f.game.nextDealAt = 10000;
  f.advance(0);
  assert.equal(f.game.deadline, 40000);
  assert.equal(f.game.endgame, false);
  assert.equal(f.game.take(f.alice, 'zzzz').ok, false);
  assert.equal(f.game.wordsFor(f.alice).length, 0);
  conserved(f.game);
});

test('using a full pot cancels its countdown and resumes dealing after grace', () => {
  const f = fixture();
  stage(f, 'cat');
  while (f.game.pool.letters.length < 52) f.game.pool.deal();
  f.game.nextDealAt = 10000;
  f.advance(0);
  assert.equal(f.game.take(f.alice, 'cat').ok, true);
  assert.equal(f.game.deadline, null);
  assert.equal(f.game.pool.letters.length, 49);
  f.advance(2500);
  assert.equal(f.game.pool.letters.length, 50);
  conserved(f.game);
});

test('endgame protects errors, resets countdown after play, and expires on the server', () => {
  const f = fixture();
  const all = Object.entries(TILE_COUNTS).map(([l, n]) => l.repeat(n)).join('');
  // Keep CAT visible and give the other 95 letters to words of up to 24 letters.
  let rest = [...all];
  for (const c of 'cat') rest.splice(rest.indexOf(c), 1);
  const ownership = Array.from({ length: 4 }, (_, i) => [f.bob, rest.slice(i * 24, i * 24 + 24).join('')]);
  stage(f, 'cat', ownership);
  f.game.nextDealAt = 10000;
  f.advance(0);
  assert.equal(f.game.endgame, true);
  assert.match(f.game.take(f.bob, 'zzzz').message, /No loss in endgame/);
  assert.equal(f.game.score(f.bob), 95);
  f.advance(10000);
  assert.equal(f.game.take(f.alice, 'cat').ok, true);
  assert.equal(f.game.deadline, null);
  f.advance(2500);
  assert.equal(f.game.deadline, 52500);
  f.advance(30000);
  assert.equal(f.game.state, 'waiting');
  assert.deepEqual(f.game.result.winners, [f.bob.id]);
  assert.equal(f.alice.ready, false);
  conserved(f.game);
});

test('a word at or beyond countdown expiry cannot reset the clock', () => {
  const f = fixture();
  stage(f, 'cat');
  f.game.deadline = 11000;
  f.setTime(11000);
  assert.equal(f.game.take(f.alice, 'cat').ok, false);
  assert.equal(f.game.state, 'waiting');
  assert.equal(f.game.score(f.alice), 0);
});

test('leaving returns owned tiles even in endgame and promotes the oldest spectator', () => {
  const f = fixture();
  const c = { id: 'c', name: 'C' }, d = { id: 'd', name: 'D' }, e = { id: 'e', name: 'E' };
  for (const p of [c, d, e]) f.game.addPlayer(p);
  stage(f, 'a', [[f.alice, 'dog']]);
  f.game.endgame = true;
  f.game.removePlayer(f.alice);
  assert.equal(f.game.words.length, 0);
  assert.equal(e.spectator, false);
  assert.equal(e.ready, true);
  assert.equal(f.game.activePlayers.length, 4);
  conserved(f.game);
});

test('all-human Stop ends a game, handles ties across every player, and allows a fresh round', () => {
  const f = fixture();
  const third = { id: 'third', name: 'Third' };
  f.game.addPlayer(third);
  stage(f, '', [[f.alice, 'cat'], [f.bob, 'dog'], [third, 'rat']]);
  f.game.setReady(f.alice, false);
  assert.equal(f.game.state, 'playing');
  f.game.setReady(f.bob, false);
  assert.equal(f.game.state, 'playing');
  f.game.setReady(third, false);
  assert.equal(f.game.state, 'waiting');
  assert.equal(f.game.result.winners.length, 3);
  for (const player of f.game.activePlayers) f.game.setReady(player, true);
  assert.equal(f.game.state, 'countdown');
  assert.equal(f.game.words.length, 0);
  assert.equal(f.game.pool.remaining, 98);
  conserved(f.game);
});

test('equal-spelling words retain independent identities when one is stolen or lost', () => {
  const f = fixture();
  stage(f, '', [[f.alice, 'cat'], [f.bob, 'cat']]);
  assert.equal(f.game.take(f.bob, 'act').ok, true);
  f.setTime(20000);
  f.game.take(f.bob, 'zzzz');
  assert.equal(f.game.words.length, 1);
  assert.equal(f.game.words[0].text, 'act');
  conserved(f.game);
});

test('training and alternate dictionaries have no default lobby exposure', () => {
  const lobby = new Lobby();
  assert.equal(lobby.games.size, 0);
  assert.equal(lobby.bots.size, 0);
  assert.equal(lobby.dictionaries.loaded.size, 1);
  assert.equal(lobby.dictionary.words.size, 178590);
});

test('preserved training rooms can be enabled and prepare the anagram index once', () => {
  const dictionary = new Dictionary(vocabulary.split(' ').join('\n'));
  const lobby = new Lobby({ training: true, dictionaries: { get: () => dictionary } });
  assert.equal(lobby.games.size, 4);
  assert.equal(lobby.bots.size, 4);
  assert.ok(dictionary.anagramIndex);
  const human = lobby.connect(() => {});
  lobby.handle(human, { type: 'name', name: 'Human' });
  const first = [...lobby.games.values()][0];
  lobby.handle(human, { type: 'join', gameId: first.id });
  lobby.handle(human, { type: 'ready', ready: true });
  lobby.tick();
  assert.equal(first.state, 'countdown');
});

test('bot tuning retains old values and accepts the original chat commands', () => {
  const f = fixture();
  const bot = new TrainerBot(f.game, f.bob, 2);
  assert.equal(bot.tuning.max, 6000);
  bot.chat('/nicer');
  assert.equal(bot.tuning.max, 6500);
  bot.chat('/harder');
  assert.equal(bot.tuning.max, 6000);
  bot.chat('/spank me');
  assert.equal(bot.tuning.maxLength, 8);
  bot.chat('/default');
  assert.equal(bot.tuning.maxLength, 7);
  assert.equal(bot.tuning.miss, .75);
});
