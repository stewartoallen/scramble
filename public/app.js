const $ = id => document.getElementById(id);
const levels = ['Beginner', 'Normal', 'Expert'];
const speeds = ['Slow', 'Medium', 'Fast', 'Blitz'];
let socket;
let playerId;
let confirmedName = '';
let game = null;
let lobby = null;
let serverOffset = 0;
let connected = false;
let soundOn = false;
let retry = 0;
let reconnectTimer;
let lastRoundId;
let lastRoomId;
let pendingNamedAction;
const rendered = { lobby: new Set(), game: new Set() };
const audio = new Map(['alert', 'beep', 'chat', 'doh', 'enter', 'exit', 'thirsty', 'woohoo']
  .map(name => [name, new Audio(`/assets/sound/${name}.wav`)]));
let audioEnabled = false;

// Unlock the original sound effects after the user switches sound on. Browser
// autoplay restrictions must not turn a failed sound into a failed game action.
function enableAudio() {
  if (!soundOn || audioEnabled) return;
  audioEnabled = true;
  const sample = audio.get('beep');
  sample.muted = true;
  const play = sample.play();
  play?.then(() => { sample.pause(); sample.currentTime = 0; sample.muted = false; })
    .catch(() => { sample.muted = false; audioEnabled = false; });
}
document.addEventListener('pointerdown', enableAudio);
document.addEventListener('keydown', enableAudio);

function playSound(name) {
  if (!soundOn || !audioEnabled || !audio.has(name)) return;
  const sound = audio.get(name).cloneNode();
  sound.play()?.catch(() => {});
}

function send(data) {
  if (!connected || socket.readyState !== WebSocket.OPEN) {
    localMessage('The connection is down. Please wait for the dealer to reconnect.');
    return false;
  }
  socket.send(JSON.stringify(data));
  return true;
}

function withName(action = () => {}) {
  const value = $('name').value.trim();
  if (!value) {
    localMessage('You must pick a name first');
    $('name').focus();
    return;
  }
  if (value === confirmedName) action();
  else {
    pendingNamedAction = action;
    send({ type: 'name', name: value });
  }
}

function appendMessage(target, entry, error = false) {
  const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
  const row = document.createElement('div');
  if (error) row.classList.add('message-error');
  if (entry.type === 'gameover') row.classList.add('message-gameover');
  row.textContent = entry.type === 'chat' ? `${entry.name} : ${entry.text}` : entry.text;
  target.append(row);
  while (target.children.length > 250) target.firstElementChild.remove();
  if (atBottom || error) target.scrollTop = target.scrollHeight;
}

function localMessage(text) {
  appendMessage($(game ? 'game-messages' : 'lobby-messages'), { text }, true);
  playSound('alert');
}

function renderMessages(mode, messages) {
  const target = $(`${mode}-messages`);
  for (const entry of messages) {
    if (rendered[mode].has(entry.id)) continue;
    rendered[mode].add(entry.id);
    appendMessage(target, entry);
  }
  // Bound bookkeeping along with the server's bounded message history.
  if (rendered[mode].size > 500) rendered[mode] = new Set(messages.map(m => m.id));
}

function setInputs() {
  for (const control of document.querySelectorAll('#lobby input, #lobby select')) control.disabled = !connected;
  const me = game?.players.find(p => p.id === playerId);
  $('ready').disabled = !connected || !me || me.spectator;
  $('leave').disabled = !connected;
  $('word').disabled = !connected || !me || me.spectator || game?.state !== 'playing';
  $('game-chat').disabled = !connected;
}

function timeString(startedAt) {
  if (startedAt === null) return 'WAITING';
  const seconds = Math.max(0, Math.floor((Date.now() + serverOffset - startedAt) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderGames() {
  const rows = document.createDocumentFragment();
  for (let i = 0; i < Math.max(10, lobby.games.length); i++) {
    const room = lobby.games[i];
    const row = document.createElement('tr');
    const values = room ? [room.name, `${room.players} / ${room.spectators}`, levels[room.level], speeds[room.speed],
      room.state === 'waiting' ? 'WAITING' : room.state === 'countdown' ? '00:00' : timeString(room.startedAt)] : ['', '', '', '', ''];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (value) cell.title = value;
      row.append(cell);
    }
    const cell = document.createElement('td');
    if (room) {
      const join = document.createElement('button');
      join.textContent = 'Join';
      join.type = 'button';
      join.disabled = !connected;
      join.setAttribute('aria-label', `Join ${room.name}`);
      join.addEventListener('click', () => withName(() => send({ type: 'join', gameId: room.id })));
      cell.append(join);
    }
    row.append(cell);
    rows.append(row);
  }
  $('games').replaceChildren(rows);
}

function showLobby(state) {
  const wasInGame = Boolean(game);
  game = null;
  lobby = state;
  $('lobby').hidden = false;
  $('game').hidden = true;
  renderGames();
  renderMessages('lobby', state.messages);
  $('play-status').textContent = confirmedName
    ? `${state.others} other player${state.others === 1 ? '' : 's'} online. ${state.names.length ? `In the lobby: ${state.names.join(', ')}` : 'No other players in the lobby.'}`
    : 'Type your name and press Enter. Enter also submits a new game, word, or chat.';
  document.title = 'S C R A M B L E';
  setInputs();
  if (wasInGame) $('game-name').focus();
}

// Match java.awt.GridLayout(3, 33): 105 alternating dot/letter labels
// resolve to three rows of 35 cells, with 52 letters and 53 separators.
const potSlots = [];
for (let i = 0; i < 105; i++) {
  const slot = document.createElement('span');
  slot.className = `pot-slot${i % 2 === 0 ? ' pot-separator' : ''}`;
  slot.textContent = i % 2 === 0 ? '.' : '';
  $('pot').append(slot);
  if (i % 2) potSlots.push(slot);
}

const playerSlots = [];
for (let i = 0; i < 4; i++) {
  const column = document.createElement('section');
  column.className = 'player';
  const name = document.createElement('div');
  name.className = 'player-name';
  const words = document.createElement('div');
  words.className = 'player-words';
  const cells = Array.from({ length: 24 }, () => {
    const cell = document.createElement('span');
    cell.className = 'player-word';
    words.append(cell);
    return cell;
  });
  const count = document.createElement('div');
  count.className = 'player-count';
  column.append(name, words, count);
  $('players').append(column);
  playerSlots.push({ column, name, cells, count, playerId: null });
}

function showGame(state) {
  const previousState = game?.state;
  const newRoom = state.id !== lastRoomId || !game;
  if (newRoom) {
    $('game-messages').replaceChildren();
    rendered.game.clear();
    lastRoundId = undefined;
    for (const slot of playerSlots) slot.playerId = null;
  }
  const newRound = state.roundId !== lastRoundId;
  game = state;
  lastRoomId = state.id;
  lastRoundId = state.roundId;
  $('lobby').hidden = true;
  $('game').hidden = false;
  for (let i = 0; i < potSlots.length; i++) potSlots[i].textContent = state.pool[i]?.toUpperCase() ?? '';
  // Keep columns stable when a player leaves or a spectator is promoted.
  const active = state.players.filter(p => !p.spectator);
  for (const slot of playerSlots) if (!active.some(p => p.id === slot.playerId)) slot.playerId = null;
  for (const player of active) {
    if (!playerSlots.some(s => s.playerId === player.id)) playerSlots.find(s => s.playerId === null).playerId = player.id;
  }
  for (const slot of playerSlots) {
    const player = active.find(p => p.id === slot.playerId);
    slot.column.setAttribute('aria-label', player ? `${player.name}: ${player.score} tiles` : 'Empty player seat');
    slot.name.textContent = player?.name ?? '';
    slot.name.title = player ? `${player.name}${player.ready ? ' — ready' : ''}` : '';
    slot.name.classList.toggle('is-ready', Boolean(player?.ready));
    slot.count.textContent = player ? String(player.score) : '';
    for (let i = 0; i < slot.cells.length; i++) {
      slot.cells[i].textContent = player?.words[i]?.text ?? '';
      slot.cells[i].title = player?.words[i]?.text ?? '';
    }
  }
  renderMessages('game', state.messages);
  const me = state.players.find(p => p.id === playerId);
  $('ready').textContent = me?.ready ? 'Stop' : 'Start';
  $('play-status').textContent = `${state.name} — ${me?.spectator ? 'You are a spectator.'
    : state.state === 'waiting' ? state.result ? 'Game over. Press Start to play again.' : 'Press Start when you are ready.'
      : state.state === 'countdown' ? 'The game will start in 3 seconds.'
        : state.endgame ? 'Endgame — no penalties for errors.' : 'Type a word and press Enter.'}`;
  document.title = `${state.name} — S C R A M B L E`;
  setInputs();
  updateClock();
  if (newRoom || newRound) $('word').value = '';
  if (state.state === 'playing' && (previousState !== 'playing' || newRoom) && !me?.spectator) $('word').focus();
  // Enter creates/joins a room. Keep that key (including repeats) away from
  // Start so entering the game cannot accidentally mark the player ready.
  else if (newRoom) $('game').focus({ preventScroll: true });
}

function updateClock() {
  const running = game?.deadline !== null && game?.deadline !== undefined;
  $('clock').classList.toggle('running', running);
  $('clock-value').textContent = running ? String(Math.max(0, Math.ceil((game.deadline - Date.now() - serverOffset) / 1000))) : '';
}

function onEvent(event) {
  if (event.type === 'join' && event.playerId !== playerId) playSound('enter');
  if (event.type === 'leave' && event.playerId !== playerId) playSound('exit');
  if (event.type === 'chat') playSound('chat');
  if (event.type === 'take' && event.playerId === playerId) playSound('woohoo');
  if (event.type === 'lose' && event.playerId === playerId && event.thiefId !== playerId) playSound('doh');
  if (event.type === 'gameover') playSound('thirsty');
}

function connect() {
  clearTimeout(reconnectTimer);
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket.addEventListener('open', () => {
    connected = true;
    retry = 0;
    $('connection').hidden = true;
    setInputs();
    const restoreName = confirmedName;
    confirmedName = '';
    if (restoreName) send({ type: 'name', name: restoreName });
  });
  socket.addEventListener('message', event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.serverTime) serverOffset = data.serverTime - Date.now();
    switch (data.type) {
      case 'welcome':
        playerId = data.playerId;
        rendered.lobby.clear();
        $('lobby-messages').replaceChildren();
        break;
      case 'named': {
        confirmedName = data.name;
        $('name').value = data.name;
        const action = pendingNamedAction;
        pendingNamedAction = undefined;
        action?.();
        break;
      }
      case 'lobby': showLobby(data); break;
      case 'game': showGame(data.game); break;
      case 'event': onEvent(data.event); break;
      case 'sound': playSound(data.sound); break;
      case 'error': pendingNamedAction = undefined; localMessage(data.text); break;
    }
  });
  socket.addEventListener('close', () => {
    if (connected) localMessage('Connection lost. You will return to the lobby after reconnecting.');
    connected = false;
    pendingNamedAction = undefined;
    $('connection').hidden = false;
    $('connection').textContent = 'Connection lost. Reconnecting to the dealer…';
    setInputs();
    reconnectTimer = setTimeout(connect, Math.min(10000, 1000 * 2 ** retry++));
  });
  socket.addEventListener('error', () => {});
}

$('name-form').addEventListener('submit', event => { event.preventDefault(); withName(); });
$('create-form').addEventListener('submit', event => {
  event.preventDefault();
  withName(() => send({ type: 'create', name: $('game-name').value, level: Number($('level').value), speed: Number($('speed').value) }));
});
for (const mode of ['lobby', 'game']) {
  $(`${mode}-chat-form`).addEventListener('submit', event => {
    event.preventDefault();
    const input = $(`${mode}-chat`);
    if (!input.value.trim()) return;
    const submit = () => { if (send({ type: 'chat', text: input.value })) input.value = ''; };
    if (mode === 'game') submit(); else withName(submit);
  });
}
$('word-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('word');
  if (input.value.trim() && send({ type: 'take', word: input.value })) input.value = '';
});
$('ready').addEventListener('click', () => {
  const me = game?.players.find(p => p.id === playerId);
  if (me) send({ type: 'ready', ready: !me.ready });
});
$('leave').addEventListener('click', () => send({ type: 'leave' }));
function toggleSound() {
  soundOn = !soundOn;
  $('sound').textContent = soundOn ? 'Sound Off' : 'Sound On';
  $('sound').setAttribute('aria-pressed', String(soundOn));
  $('lobby-sound').setAttribute('aria-pressed', String(soundOn));
  const label = soundOn ? 'Turn sound off' : 'Turn sound on';
  $('lobby-sound').setAttribute('aria-label', label);
  $('lobby-sound').title = label;
  if (soundOn) enableAudio();
  if (!soundOn) for (const sound of audio.values()) sound.pause();
}
$('sound').addEventListener('click', toggleSound);
$('lobby-sound').addEventListener('click', toggleSound);
$('help-open').addEventListener('click', () => $('help').showModal());
setInterval(updateClock, 100);
setInputs();
connect();
