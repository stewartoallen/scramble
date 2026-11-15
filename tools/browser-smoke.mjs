import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { createApp } from '../server/index.js';

let clock = Date.now();
const runtime = createApp({ now: () => clock });
let browser;
const errors = [];
const failedRequests = [];
try {
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const aliceContext = await browser.newContext({ viewport: { width: 1100, height: 940 } });
  const bobContext = await browser.newContext({ viewport: { width: 1100, height: 940 } });
  const alice = await aliceContext.newPage(), bob = await bobContext.newPage();
  for (const page of [alice, bob]) {
    await page.addInitScript(() => {
      window.audioPlayCount = 0;
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        window.audioPlayCount++;
        return play.call(this);
      };
    });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) failedRequests.push(response.url()); });
    await page.goto(base);
    await page.locator('#connection').waitFor({ state: 'hidden' });
  }
  mkdirSync('test-results', { recursive: true });
  assert.equal(await alice.locator('#applet').evaluate(e => e.clientWidth), 790);
  assert.equal(await alice.locator('#applet').evaluate(e => e.clientHeight), 660);
  assert.equal(await alice.locator('#games button').count(), 0);
  assert.equal(await alice.locator('#lobby-sound').getAttribute('aria-pressed'), 'false');
  const soundRow = await alice.locator('#lobby-sound').evaluate(button => {
    const row = document.querySelector('#create-form').getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    return rect.top >= row.top && rect.bottom <= row.bottom && rect.right <= row.right;
  });
  assert.equal(soundRow, true);
  // The lobby control must not submit the Create Game form, and its setting
  // carries into the game instead of resetting when the screens change.
  await bob.locator('#lobby-sound').click();
  assert.equal(await bob.locator('#lobby-sound').getAttribute('aria-label'), 'Turn sound off');
  assert.equal(await bob.locator('#sound').textContent(), 'Sound Off');
  assert.equal(runtime.lobby.games.size, 0);
  await alice.screenshot({ path: 'test-results/lobby.png', fullPage: true });
  await alice.locator('#name').fill('Alice');
  await alice.locator('#name').press('Enter');
  await alice.locator('#lobby-messages').getByText("Player 'Alice' enters the lobby", { exact: true }).waitFor();
  await alice.locator('#game-name').fill('Nostalgia');
  await alice.locator('#speed').selectOption('3');
  await alice.locator('#game-name').press('Enter', { delay: 100 });
  await alice.locator('#game').waitFor({ state: 'visible' });
  await alice.keyboard.press('Enter');
  const room = [...runtime.lobby.games.values()][0];
  assert.equal(room.state, 'waiting');
  assert.equal([...room.players.values()][0].ready, false);
  assert.equal(await alice.locator('#ready').textContent(), 'Start');
  assert.equal(await alice.locator('#sound').textContent(), 'Sound On');
  assert.equal(await alice.locator('#sound').getAttribute('aria-pressed'), 'false');
  // Creating/joining also commits a name without requiring a separate Enter.
  await bob.locator('#name').fill('Bob');
  await bob.getByRole('button', { name: 'Join Nostalgia', exact: true }).press('Enter', { delay: 100 });
  await bob.locator('#game').waitFor({ state: 'visible' });
  await bob.keyboard.press('Enter');
  assert.equal(room.state, 'waiting');
  assert.equal([...room.players.values()].every(player => !player.ready), true);
  assert.equal(await bob.locator('#sound').getAttribute('aria-pressed'), 'true');
  await bob.locator('#sound').click();
  assert.equal(await bob.locator('#lobby-sound').getAttribute('aria-pressed'), 'false');
  assert.equal(await bob.locator('#lobby-sound').getAttribute('aria-label'), 'Turn sound on');
  await bob.evaluate(() => { window.audioPlayCount = 0; });
  assert.equal(await alice.locator('.player-name').allTextContents().then(v => v.filter(Boolean).join(',')), 'Alice,Bob');
  await alice.locator('#ready').click();
  await bob.locator('#ready').click();
  await bob.locator('#play-status').filter({ hasText: '3 seconds' }).waitFor();
  clock += 3000;
  runtime.lobby.tick();
  await alice.waitForFunction(() => !document.querySelector('#word').disabled);
  assert.equal(await alice.locator('#word').evaluate(e => document.activeElement === e), true);
  // Stage a known legal board internally; production has no board override API.
  for (const tile of room.pool.tiles) tile.state = 'bag';
  for (const letter of 'cat') room.pool.tiles.find(t => t.state === 'bag' && t.letter === letter).state = 'pool';
  room.nextDealAt = clock + 60000;
  room.changed();
  await alice.locator('#word').fill('CAT');
  await alice.locator('#word').press('Enter');
  await alice.locator('.player-word').filter({ hasText: /^cat$/ }).waitFor();
  assert.equal(await alice.locator('.player-count').first().textContent(), '3');
  assert.equal(await bob.locator('.player-count').first().textContent(), '3');
  room.pool.tiles.find(t => t.state === 'bag' && t.letter === 's').state = 'pool';
  room.changed();
  await bob.locator('#word').fill('cats');
  await bob.locator('#word').press('Enter');
  await bob.locator('.message-error').filter({ hasText: 'plural' }).waitFor();
  assert.equal(room.words[0].text, 'cat');
  await bob.locator('#word').fill('scat');
  await bob.locator('#word').press('Enter');
  await alice.locator('.player-word').filter({ hasText: /^scat$/ }).waitFor();
  assert.deepEqual(await alice.locator('.player-count').allTextContents(), ['0', '4', '', '']);
  const chat = '<img src=x onerror=alert(1)> hello Alice';
  await bob.locator('#game-chat').fill(chat);
  await bob.locator('#game-chat').press('Enter');
  await alice.locator('#game-messages').getByText(`Bob : ${chat}`, { exact: true }).waitFor();
  assert.equal(await alice.locator('#game-messages img').count(), 0);
  assert.equal(await alice.evaluate(() => window.audioPlayCount), 0);
  assert.equal(await bob.evaluate(() => window.audioPlayCount), 0);
  await alice.locator('#sound').click();
  assert.equal(await alice.locator('#sound').textContent(), 'Sound Off');
  assert.equal(await alice.locator('#sound').getAttribute('aria-pressed'), 'true');
  assert.ok(await alice.evaluate(() => window.audioPlayCount) > 0);
  await alice.locator('#sound').click();
  assert.equal(await alice.locator('#sound').textContent(), 'Sound On');
  const bounds = await alice.locator('#applet').boundingBox();
  const layout = await alice.locator('#game').evaluate(element => ({ width: element.scrollWidth, height: element.scrollHeight }));
  assert.equal(layout.width, 790);
  assert.equal(layout.height, 660);
  assert.equal(bounds.width, 790);
  const slots = await alice.locator('.pot-slot').evaluateAll(elements => {
    const ys = new Set(elements.map(e => e.getBoundingClientRect().y));
    return { rows: ys.size, letters: elements.filter(e => !e.classList.contains('pot-separator')).length };
  });
  assert.deepEqual(slots, { rows: 3, letters: 52 });
  await alice.screenshot({ path: 'test-results/game.png', fullPage: true });
  await alice.locator('#help-open').click();
  assert.equal(await alice.locator('#help').evaluate(e => e.open), true);
  await alice.getByRole('button', { name: 'Close instructions' }).click();
  await alice.locator('#leave').click();
  await alice.locator('#lobby').waitFor({ state: 'visible' });
  assert.equal(await alice.locator('#lobby-sound').getAttribute('aria-pressed'), 'false');
  await bob.locator('#ready').click();
  await bob.locator('#play-status').filter({ hasText: 'Game over' }).waitFor();
  assert.equal(room.result.winners[0], [...room.players.values()][0].id);
  await bob.locator('#ready').click();
  await bob.locator('#play-status').filter({ hasText: '3 seconds' }).waitFor();
  assert.equal(await bob.locator('.player-word').filter({ hasText: /\S/ }).count(), 0);
  // A network failure disables play and reconnects to the lobby with the name.
  for (const ws of runtime.wss.clients) ws.terminate();
  await bob.locator('#connection').waitFor({ state: 'visible' });
  await bob.locator('#connection').waitFor({ state: 'hidden' });
  await bob.locator('#lobby').waitFor({ state: 'visible' });
  await bob.locator('#lobby-messages').getByText("Player 'Bob' enters the lobby", { exact: true }).last().waitFor();
  assert.equal(await bob.locator('#name').inputValue(), 'Bob');
  assert.deepEqual(errors, []);
  assert.deepEqual(failedRequests, []);
  console.log('Browser checks passed: desktop layout, Enter submission, two players, takes/steals, plural rules, chat escaping, sounds toggle, restart, help, reconnect; no browser errors.');
  console.log('Screenshots: test-results/lobby.png and test-results/game.png');
} finally {
  await browser?.close();
  await runtime.close();
}
