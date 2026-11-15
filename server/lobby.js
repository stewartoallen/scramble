import { randomUUID } from 'node:crypto';
import { Dictionaries } from './dictionary.js';
import { Game } from './game.js';
import { TrainerBot, TRAINING_ROOMS } from './bot.js';

export class Lobby {
  constructor({ dictionaries = new Dictionaries(), dictionary = 'default', training = false,
    now = Date.now, random = Math.random } = {}) {
    this.dictionaries = dictionaries;
    this.dictionary = dictionaries.get(dictionary);
    this.now = now;
    this.random = random;
    this.players = new Map();
    this.games = new Map();
    this.bots = new Map();
    this.messages = [];
    this.messageId = 0;
    this.lastSweep = now();
    if (training) {
      this.dictionary.prepareAnagrams();
      for (const room of TRAINING_ROOMS) {
        const game = this.createGame(room.name, room.level, room.level, true);
        const player = { id: randomUUID(), name: room.bot, bot: true, send() {}, lastAction: now() };
        this.players.set(player.id, player);
        game.addPlayer(player);
        this.bots.set(game.id, new TrainerBot(game, player, room.level, random));
      }
    }
  }

  record(messages, entry) {
    messages.push({ id: ++this.messageId, time: this.now(), ...entry });
    if (messages.length > 200) messages.shift();
  }

  connect(send) {
    const player = { id: randomUUID(), name: '', roomId: null, ready: false,
      spectator: false, bot: false, lastAction: this.now(), send };
    this.players.set(player.id, player);
    send({ type: 'welcome', playerId: player.id, serverTime: this.now() });
    this.sendLobby(player);
    this.broadcastLobby();
    return player;
  }

  disconnect(player) {
    if (!this.players.has(player.id)) return;
    if (player.roomId) this.leave(player, false);
    this.players.delete(player.id);
    if (player.name) this.lobbyMessage(`'${player.name}' leaves the lobby`, 'exit');
    this.broadcastLobby();
  }

  lobbyMessage(text, sound) {
    this.record(this.messages, { type: 'message', text });
    if (sound) for (const p of this.players.values()) if (!p.roomId) p.send({ type: 'sound', sound });
    this.broadcastLobby();
  }

  sendLobby(player) {
    player.send({ type: 'lobby', name: player.name, playerId: player.id,
      serverTime: this.now(), messages: this.messages,
      others: this.players.size - 1,
      names: [...this.players.values()].filter(p => p.id !== player.id && !p.roomId && p.name).map(p => p.name),
      games: [...this.games.values()].map(g => g.summary()) });
  }

  broadcastLobby() {
    for (const p of this.players.values()) if (!p.roomId && !p.bot) this.sendLobby(p);
  }

  sendRoom(game) {
    const state = { type: 'game', game: { ...game.snapshot(), messages: game.messages }, serverTime: this.now() };
    for (const player of game.players.values()) player.send(state);
  }

  createGame(name, level, speed, training = false) {
    const game = new Game({ name, level, speed, training, dictionary: this.dictionary,
      now: this.now, random: this.random, emit: event => this.roomEvent(game, event) });
    game.messages = [];
    this.games.set(game.id, game);
    return game;
  }

  roomEvent(game, event) {
    if (['message', 'chat', 'gameover'].includes(event.type)) this.record(game.messages, event);
    for (const player of game.players.values()) {
      if (event.type !== 'change') player.send({ type: 'event', event });
    }
    if (event.type === 'take') this.bots.get(game.id)?.onTake(event, this.now());
    if (['change', 'message', 'chat', 'gameover'].includes(event.type)) this.sendRoom(game);
    if (event.type === 'change') this.broadcastLobby();
  }

  leave(player, sendLobby = true) {
    const game = this.games.get(player.roomId);
    if (!game) { player.roomId = null; return; }
    game.removePlayer(player);
    if (!game.players.size && !game.training) this.games.delete(game.id);
    if (sendLobby) this.sendLobby(player);
    this.lobbyMessage(`'${player.name}' entered the lobby from the game '${game.name}'`);
  }

  error(player, text) { player.send({ type: 'error', text }); }

  handle(player, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return this.error(player, 'Invalid command');
    player.lastAction = this.now();
    const game = this.games.get(player.roomId);
    switch (data.type) {
      case 'name': {
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)) {
          return this.error(player, 'Choose a name of 1 to 24 characters');
        }
        if (/^trainer bot/i.test(name) || [...this.players.values()].some(p =>
          p.id !== player.id && p.name.toLowerCase() === name.toLowerCase())) {
          return this.error(player, `The name '${name}' is taken or reserved`);
        }
        const before = player.name;
        player.name = name;
        player.send({ type: 'named', name });
        if (game) { game.touch(); game.message(`${before} is now known as '${name}'`); game.changed(); }
        else if (before !== name) this.lobbyMessage(before
          ? `Player '${before}' is now known as '${name}'` : `Player '${name}' enters the lobby`, before ? undefined : 'enter');
        this.broadcastLobby();
        break;
      }
      case 'create': {
        if (!player.name) return this.error(player, 'You must pick a name before creating a game');
        if (game) return this.error(player, 'Leave your current game first');
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return this.error(player, 'Game name must contain 1 to 40 characters');
        if (this.games.size >= 100) return this.error(player, 'There are too many open games. Join an existing game.');
        if ([...this.games.values()].some(g => g.name.toLowerCase() === name.toLowerCase())) return this.error(player, 'Game name must be unique');
        if (!Number.isInteger(data.speed) || data.speed < 0 || data.speed > 3 ||
          !Number.isInteger(data.level) || data.level < 0 || data.level > 2) return this.error(player, 'Invalid game settings');
        const created = this.createGame(name, data.level, data.speed);
        created.addPlayer(player);
        this.lobbyMessage(`'${player.name}' joined the game '${name}'`);
        break;
      }
      case 'join': {
        if (!player.name) return this.error(player, 'You must pick a name before joining a game');
        if (game) return this.error(player, 'Leave your current game first');
        const target = this.games.get(data.gameId);
        if (!target) return this.error(player, 'That game is no longer available');
        if (target.players.size >= 100) return this.error(player, 'That game is full');
        target.addPlayer(player);
        this.lobbyMessage(`'${player.name}' joined the game '${target.name}'`);
        break;
      }
      case 'leave': if (game) this.leave(player); break;
      case 'ready': {
        if (!game) return this.error(player, 'Join a game first');
        if (game.state === 'waiting') {
          // Match the original waiting-room grace when somebody presses Start.
          for (const other of game.players.values()) other.lastAction = this.now();
        }
        const error = game.setReady(player, data.ready);
        if (error) this.error(player, error);
        break;
      }
      case 'take': {
        if (!game) return this.error(player, 'Join a game first');
        const result = game.take(player, data.word);
        if (!result.ok) this.error(player, result.message);
        break;
      }
      case 'chat': {
        if (!player.name) return this.error(player, 'You must pick a name before chatting');
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!text || text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) return this.error(player, 'Chat must contain 1 to 500 characters');
        if (game) {
          game.touch();
          // Preserve the original waiting-player kick chat command.
          if (text.toLowerCase().startsWith('kick ') && !player.spectator) {
            const target = [...game.players.values()].find(p => p.name === text.slice(5) && !p.ready && !p.bot);
            if (target && target.id !== player.id) {
              this.error(target, `${player.name} kicked you out of the game`);
              this.leave(target);
            }
          }
          game.emit({ type: 'chat', name: player.name, text });
          this.bots.get(game.id)?.chat(text);
        } else {
          this.record(this.messages, { type: 'chat', name: player.name, text });
          for (const p of this.players.values()) if (!p.roomId) p.send({ type: 'sound', sound: 'chat' });
          this.broadcastLobby();
        }
        break;
      }
      default: this.error(player, 'Unknown command');
    }
  }

  tick() {
    const time = this.now();
    for (const game of this.games.values()) game.tick(time);
    for (const bot of this.bots.values()) bot.tick(time);
    if (time - this.lastSweep < 1000) return;
    this.lastSweep = time;
    for (const game of this.games.values()) {
      if (game.state !== 'waiting' || game.training) continue;
      if (game.activePlayers.some(p => p.ready)) {
        for (const p of [...game.activePlayers]) {
          if (!p.ready && !p.bot && time - p.lastAction > 10000) {
            this.error(p, 'You were returned to the lobby because other players are ready to play');
            this.leave(p);
          }
        }
      }
      if (time - game.lastActivity > 180000) {
        for (const p of [...game.players.values()]) {
          this.error(p, 'The idle game has been terminated');
          this.leave(p);
        }
      } else if (time - game.lastActivity > 120000 && !game.idleWarned) {
        game.idleWarned = true;
        game.message('Game will terminate with no further activity');
      }
    }
  }
}
