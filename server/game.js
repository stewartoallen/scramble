// Ported from Scramble.java. Copyright Stewart Allen. GPL-2.0-or-later.
import { randomUUID } from 'node:crypto';
import { extraLetters } from './dictionary.js';

export const SPEEDS = Object.freeze([
  { label: 'Slow', deal: 4000, grace: 3000, end: 40000 },
  { label: 'Medium', deal: 3000, grace: 2500, end: 30000 },
  { label: 'Fast', deal: 2000, grace: 2000, end: 20000 },
  { label: 'Blitz', deal: 1500, grace: 1750, end: 15000 },
]);
export const LEVELS = Object.freeze(['Beginner', 'Normal', 'Expert']);
export const TILE_COUNTS = Object.freeze({
  a: 9, b: 2, c: 2, d: 4, e: 12, f: 2, g: 3, h: 2, i: 9,
  j: 1, k: 1, l: 4, m: 2, n: 6, o: 8, p: 2, q: 1, r: 6,
  s: 4, t: 6, u: 4, v: 2, w: 2, x: 1, y: 2, z: 1,
});

export class TilePool {
  constructor(random = Math.random) {
    this.random = random;
    this.tiles = Object.entries(TILE_COUNTS).flatMap(([letter, count]) =>
      Array.from({ length: count }, () => ({ letter, state: 'bag' })));
    this.scramble();
  }

  scramble() {
    // Preserve the applet's shuffle, including rearranging the visible pot.
    const count = 1500 + Math.floor(this.random() * 1500);
    for (let i = 0; i < count; i++) {
      const a = Math.floor(this.random() * this.tiles.length);
      const b = Math.floor(this.random() * this.tiles.length);
      [this.tiles[a], this.tiles[b]] = [this.tiles[b], this.tiles[a]];
    }
    this.tiles = [...this.tiles.filter(t => t.state === 'pool'),
      ...this.tiles.filter(t => t.state !== 'pool')];
  }

  get letters() { return this.tiles.filter(t => t.state === 'pool').map(t => t.letter).join(''); }
  get remaining() { return this.tiles.filter(t => t.state === 'bag').length; }

  deal() {
    if (this.letters.length >= 52) return false;
    const tile = this.tiles.find(t => t.state === 'bag');
    if (!tile) return false;
    tile.state = 'pool';
    return true;
  }

  canTake(letters) { return extraLetters(this.letters, letters) !== null; }

  take(letters) {
    if (!this.canTake(letters)) throw new Error('Tiles are not in the pot');
    for (const letter of letters) {
      this.tiles.find(t => t.state === 'pool' && t.letter === letter).state = 'owned';
    }
    if (letters.length) this.scramble();
  }

  returnWord(word) {
    for (const letter of word) {
      const tile = this.tiles.find(t => t.state === 'owned' && t.letter === letter);
      if (!tile) throw new Error(`Cannot return unowned tile: ${letter}`);
      tile.state = 'bag';
    }
    this.scramble();
  }
}

export class Game {
  constructor({ id = randomUUID(), name, speed = 1, level = 1, dictionary,
    random = Math.random, now = Date.now, emit = () => {}, training = false }) {
    if (!SPEEDS[speed] || !Number.isInteger(speed)) throw new Error('Invalid speed');
    if (!LEVELS[level] || !Number.isInteger(level)) throw new Error('Invalid level');
    this.id = id;
    this.name = name;
    this.speed = speed;
    this.level = level;
    this.dictionary = dictionary;
    this.random = random;
    this.now = now;
    this.emit = emit;
    this.training = training;
    this.players = new Map();
    this.words = [];
    this.pool = new TilePool(random);
    this.state = 'waiting';
    this.roundId = null;
    this.deadline = null;
    this.startedAt = null;
    this.lastTake = -Infinity;
    this.nextDealAt = Infinity;
    this.lastActivity = now();
    this.idleWarned = false;
    this.endgame = false;
    this.result = null;
  }

  get timing() { return SPEEDS[this.speed]; }
  get activePlayers() { return [...this.players.values()].filter(p => !p.spectator); }
  wordsFor(player) { return this.words.filter(w => w.ownerId === player.id); }
  score(player) { return this.wordsFor(player).reduce((sum, w) => sum + w.text.length, 0); }
  touch() { this.lastActivity = this.now(); this.idleWarned = false; }
  message(text) { this.emit({ type: 'message', text }); }
  changed() { this.emit({ type: 'change' }); }

  addPlayer(player) {
    player.spectator = this.activePlayers.length >= 4;
    player.ready = !player.spectator && this.state !== 'waiting';
    player.roomId = this.id;
    this.players.set(player.id, player);
    this.touch();
    this.emit({ type: 'join', playerId: player.id, name: player.name, spectator: player.spectator });
    this.message(`${player.name} joins${player.spectator ? ' as a spectator' : ' the game'}`);
    this.changed();
  }

  removePlayer(player) {
    if (!this.players.has(player.id)) return;
    for (const word of this.wordsFor(player)) {
      this.pool.returnWord(word.text);
      this.words.splice(this.words.indexOf(word), 1);
    }
    this.players.delete(player.id);
    player.roomId = null;
    player.ready = false;
    player.spectator = false;
    this.touch();
    this.emit({ type: 'leave', playerId: player.id, name: player.name });
    this.message(`${player.name} left the game`);
    this.promoteSpectators();
    if (this.state !== 'waiting' && !this.activePlayers.some(p => !p.bot && p.ready)) {
      this.finish();
    } else if (this.state === 'waiting') this.checkReady();
    this.changed();
  }

  promoteSpectators() {
    for (const player of this.players.values()) {
      if (this.activePlayers.length >= 4) break;
      if (player.spectator) {
        player.spectator = false;
        player.ready = this.state !== 'waiting';
        this.message(`${player.name} is now a player`);
      }
    }
  }

  setReady(player, ready) {
    if (!this.players.has(player.id) || player.spectator) return 'You are a spectator. You cannot play!';
    if (typeof ready !== 'boolean') return 'Invalid ready state';
    if (player.ready === ready) return;
    player.ready = ready;
    this.touch();
    this.message(this.state === 'waiting'
      ? `${player.name} is ${ready ? '' : 'not '}ready to play`
      : `${player.name} ${ready ? 'will continue to play' : 'wishes to quit'}`);
    if (this.state === 'waiting') this.checkReady();
    else if (!this.activePlayers.some(p => p.ready && !p.bot)) {
      this.message('All players agree to quit');
      this.finish();
    }
    this.changed();
  }

  checkReady() {
    const players = this.activePlayers;
    if (this.state === 'waiting' && players.some(p => !p.bot) && players.every(p => p.ready)) {
      this.start();
    }
  }

  start() {
    this.words = [];
    this.pool = new TilePool(this.random);
    this.state = 'countdown';
    this.roundId = randomUUID();
    this.result = null;
    this.endgame = false;
    this.startedAt = null;
    this.lastTake = -Infinity;
    this.deadline = this.now() + 3000;
    this.nextDealAt = Infinity;
    this.touch();
    this.emit({ type: 'newgame' });
    this.message('All players are ready to play');
    this.message('The game will start in 3 seconds');
  }

  tick(time = this.now()) {
    if (this.state === 'countdown') {
      if (time < this.deadline) return;
      this.state = 'playing';
      this.startedAt = time;
      this.deadline = null;
      this.message('The game is now in play');
      this.pool.deal();
      this.pool.deal();
      this.nextDealAt = time;
    }
    if (this.state !== 'playing') return;
    if (this.deadline !== null && time >= this.deadline) {
      this.finish();
      return;
    }
    if (time < this.nextDealAt || time < this.lastTake + this.timing.grace) return;
    if (this.pool.deal()) {
      this.deadline = null;
      this.nextDealAt = time + this.timing.deal + this.pool.letters.length * 50;
    } else {
      if (!this.endgame && this.pool.remaining === 0) {
        this.endgame = true;
        this.message('No more tiles. Endgame begins now.');
      }
      if (this.deadline === null) {
        this.deadline = time + this.timing.end;
        this.message(`Game over in ${this.timing.end / 1000} seconds`);
      }
      this.nextDealAt = time + this.timing.deal + this.pool.letters.length * 50;
    }
    this.changed();
  }

  finish() {
    if (this.state === 'waiting') return;
    const scores = this.activePlayers.map(p => ({ id: p.id, name: p.name, score: this.score(p) }));
    const best = Math.max(0, ...scores.map(p => p.score));
    const winners = scores.filter(p => p.score === best);
    const names = winners.map(p => p.name).join(' and ');
    const text = winners.length > 1 ? `** And it's a tie between ${names}! **`
      : winners.length === 1 ? `*** And the winner is ${names}! ***` : 'Game over';
    this.result = { text, scores, winners: winners.map(p => p.id) };
    this.state = 'waiting';
    this.deadline = null;
    this.nextDealAt = Infinity;
    for (const player of this.players.values()) player.ready = false;
    this.touch();
    this.emit({ type: 'gameover', text });
    this.changed();
  }

  reject(player, reason, penalize = false) {
    let text = reason;
    if (penalize && this.endgame) text += '. No loss in endgame.';
    else if (penalize && this.now() - this.lastTake < this.timing.grace) {
      text += ", but it's too close to the last play so I'll forget it";
    } else if (penalize) {
      const shortest = this.wordsFor(player).reduce((a, b) => !a || b.text.length < a.text.length ? b : a, null);
      if (shortest) {
        this.words.splice(this.words.indexOf(shortest), 1);
        this.pool.returnWord(shortest.text);
        this.emit({ type: 'lose', playerId: player.id, word: shortest.text });
        this.message(`${player.name} loses '${shortest.text}' because ${reason}`);
        this.changed();
      }
    }
    return { ok: false, message: text };
  }

  take(player, input) {
    if (!this.players.has(player.id) || player.spectator) return this.reject(player, 'You are a spectator. You cannot play!');
    // An overdue countdown cannot be extended by a command arriving before the
    // next interval callback. All play decisions use the server clock.
    this.tick(this.now());
    if (this.state !== 'playing') return this.reject(player, 'Whoa there, speedy! The game is not yet in play.');
    if (typeof input !== 'string' || input.length > 24) return this.reject(player, 'Words must contain 3 to 24 letters');
    const word = input.trim().toLowerCase();
    this.touch();
    if (word.length < 3) return this.reject(player, 'Words must be at least three letters');
    if (!/^[a-z]+$/.test(word)) return this.reject(player, 'Words may only contain letters A–Z');
    if (!this.dictionary.has(word)) return this.reject(player, `'${word}' is not a word`, true);

    const atLimit = this.wordsFor(player).length >= 24;
    let saved = '';
    // Preserve pot-first precedence, even when a steal of the same spelling is
    // also possible. A new word may duplicate one made from a different tile set.
    if (this.pool.canTake(word)) {
      if (!atLimit) {
        this.pool.take(word);
        this.words.push({ id: randomUUID(), text: word, ownerId: player.id, history: new Set() });
        this.accept(player, word, 'take');
        this.message(`${player.name} took '${word}'`);
        return { ok: true };
      }
      saved = "You've reached your word limit";
    }

    // The original comparator contradicted its comment. Prefer the longest
    // eligible whole word, and keep insertion order for equal lengths.
    const candidates = this.words.filter(w => w.text.length <= word.length)
      .sort((a, b) => b.text.length - a.text.length);
    for (const old of candidates) {
      const extra = extraLetters(word, old.text);
      if (extra === null) continue;
      if (this.dictionary.noPlurals && (word === `${old.text}s` ||
        [...old.history].some(previous => word === `${previous}s`))) {
        saved = 'You cannot steal/defend by making a plural';
        continue;
      }
      if (old.text === word || old.history.has(word)) {
        saved = old.text === word ? `'${word}' already taken`
          : `Can't steal '${old.text}' with '${word}' because it's been used`;
        continue;
      }
      if (!this.pool.canTake(extra)) continue;
      const owner = this.players.get(old.ownerId);
      if (owner.id !== player.id && atLimit) {
        saved = "You've reached your word limit";
        continue;
      }
      // Validation completes before mutating anything: word-limit rejections
      // must never consume tiles. Word identity also survives steals/history.
      this.pool.take(extra);
      const before = old.text;
      old.history.add(before);
      old.text = word;
      old.ownerId = player.id;
      // The applet removes then appends transformed words in a player's list.
      this.words.splice(this.words.indexOf(old), 1);
      this.words.push(old);
      this.emit({ type: 'lose', playerId: owner.id, word: before, thiefId: player.id });
      this.accept(player, word, owner.id === player.id ? 'defend' : 'steal');
      this.message(owner.id === player.id
        ? `${player.name} defended '${before}' with '${word}'`
        : `${player.name} stole '${before}' from ${owner.name} with '${word}'`);
      return { ok: true };
    }
    return this.reject(player, saved || `'${word}' is not on the board`, !saved);
  }

  accept(player, word, action) {
    this.lastTake = this.now();
    // A play wakes the dealer when the pot is full or the bag is empty, while
    // retaining the original post-play pause before any further dealing.
    if (this.deadline !== null) this.nextDealAt = this.lastTake + this.timing.grace;
    else this.nextDealAt = Math.max(this.nextDealAt, this.lastTake + this.timing.grace);
    this.deadline = null;
    this.emit({ type: 'take', playerId: player.id, word, action });
    this.changed();
  }

  summary() {
    return {
      id: this.id, name: this.name, level: this.level, speed: this.speed,
      players: this.activePlayers.length, spectators: this.players.size - this.activePlayers.length,
      state: this.state, startedAt: this.startedAt,
    };
  }

  snapshot() {
    return {
      ...this.summary(), roundId: this.roundId, pool: this.pool.letters,
      endgame: this.endgame, deadline: this.deadline, result: this.result,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, spectator: p.spectator, ready: p.ready,
        score: this.score(p), words: this.wordsFor(p).map(w => ({ id: w.id, text: w.text })),
      })),
    };
  }
}
