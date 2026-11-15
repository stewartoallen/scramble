# Scramble

A desktop browser rewrite of Stewart Allen's Java Scramble applet. The original
Java source, client JAR, dictionaries, instructions, and assets are preserved in
`src/`. The browser interface was reconstructed by inspecting `client.jar` with
`javap`, including its layout, colors, fonts, word slots, and keyboard behavior.

## Run

Requires Node.js 22 or newer.

```sh
npm ci
npm start
```

Open **http://localhost:3000**. The server listens on `0.0.0.0`; other players on
your network can open the server's address in their own browsers. `PORT` and
`HOST` override the defaults. You can override the port on the command line:

```sh
npm start -- --port 8080
# Or: npm start -- -p 8080
```

The command-line port takes precedence over `PORT`. Direct Node invocation also
supports `node server/index.js --port=8080`. Use `npm start -- --help` for usage.
`npm run dev -- --port 8080` works too and restarts the server on source changes.

Type a name and press Enter. Type a game name, select a level and speed, and press
Enter in the game-name field to create a game. Other players can click Join. All
players press Start; words and chat are also submitted with Enter. Instructions
are available below the game. Separate tabs can act as separate players.

This is a single Express process with a WebSocket connection for each browser.
The server owns the tile bag, word history, scores, readiness, and clocks. State
is held **only in memory**: restarting the server loses all names and games.
There are no accounts, database, or browser game saves. Disconnecting releases
the player's name and returns their words to the dealer. A reconnect goes to
the lobby and attempts to reclaim the name; it does not restore the prior seat.
If deployed behind a reverse proxy, forward WebSocket upgrades on `/ws` and
preserve the external Host header. Use one server process, without clustering.

The app retains the fixed **790 × 660** desktop game surface. The original
600 × 99 logo appears above it. It deliberately does not reflow for phones.

## Preserved rules

- Original 98-letter distribution, no blanks, four players, additional spectators.
- 52-letter pot and 24 words per player. Scores count collected letters.
- Three-letter minimum; one whole existing word may be rearranged or extended
  with pot letters. Combining two existing words is not implemented.
- Pot-only takes have priority over steals. Duplicate spellings made from
  separate tile sets remain independent words.
- Word history prevents cycling through anagrams. English plural steals and
  defenses are prohibited using the original S/history checks, rather than a
  new linguistic plural detector.
- Invalid dictionary words or unavailable board words lose the earliest shortest
  word. Lost tiles return to the hidden bag to be dealt again.
- Short or malformed input, attempted plurals, repeated historical forms, and
  word-limit rejections do not cost a word. Errors during the post-play grace
  period or true endgame are also forgiven.
- All active players must be ready. Stop is a vote; the game ends once all
  human players have stopped. Training bots do not prevent stopping.
- Three-second opening countdown, with three letters dealt at the start.
- A full pot starts a countdown even when the dealer still has hidden letters.
  This does not grant endgame protection. Successful plays reset the countdown
  and allow dealing to resume after the grace period.
- All eight original sounds are included as WAV files. Sound is off by default;
  use the lobby's speaker toggle or click Sound On during play to enable it.
  Both controls share the same setting.
- Idle waiting games warn after two minutes and close after three. An unready
  player is returned to the lobby after ten seconds of inactivity when other
  players want to start.

| Speed | Base deal interval | Grace after a play | End countdown |
| --- | --- | --- | --- |
| Slow | 4 s | 3 s | 40 s |
| Medium | 3 s | 2.5 s | 30 s |
| Fast | 2 s | 2 s | 20 s |
| Blitz | 1.5 s | 1.75 s | 15 s |

The deal interval also includes **50 ms per letter in the pot**. A successful
play delays the next deal until the grace period has elapsed. The original
Beginner / Normal / Expert selector remains visible; as in the Java server, it
labels a human-created game without introducing different human gameplay rules.

## Retained, hidden options

There are no new dictionary or bot controls in the browser. By default, only the
original default vocabulary (US TWL) is loaded, and no training rooms are shown.

For future use, the server retains all four dictionaries and aliases. These can
be selected for the entire server with `SCRAMBLE_DICTIONARY`:

| Value | Original file | Unique accepted entries |
| --- | --- | --- |
| `twl` (or `default`) | `us-english-twl` | 178,590 |
| `sowpods` | `uk-english-sowpods` | 267,627 |
| `ods` | `french-ods` | 378,989 |
| `zingarelli` | `italian-zingarelli` | 584,977 |

Aliases `us english`, `uk english`, `french`, and `italian` are also supported.
The old file named `default` is retained but unused, matching the Java server.
Dictionary files are unmodified. Duplicate lines are collapsed in memory. The
single malformed Italian entry, `acccu#`, is excluded from the runtime index.
Two-letter dictionary entries remain indexed but cannot be played.

`SCRAMBLE_TRAINING=1 npm start` explicitly enables the four original training
rooms. The trainer preserves its random short-word sampling, anagram/extension
strategy, delays, miss rates, reluctance to steal a player's only word, and
occasional immediate retakes. Its `help`, `/nicer`, `/harder`, `/spank me`, and
`/default` chat commands are retained. There is no browser toggle for enabling
training rooms. When enabled, they use the server's selected dictionary.

## Lookup changes and bug fixes

Word validation uses a `Set` instead of computing every anagram first. Anagram
queries use a lazily built map keyed by the 26 letter counts. The vocabulary and
file order of anagram results are preserved; the bots do not use a broader solver.

Intentional corrections to the original implementation:

- Steals prefer the **longest** eligible existing word, as the Java comment
  intended; equal-length matches retain their order.
- Plays validate completely before consuming tiles, including word-limit checks.
- Independent word IDs preserve ownership/history even with identical spellings.
- Remaining spectators automatically fill vacant player seats, oldest first.
- Every tied winner is reported, rather than only two players in a larger tie.
- Start countdowns reject early plays; expired countdowns cannot be extended by
  a command arriving before the timer callback.
- Readiness and dealer state reset between rounds; departed words cannot remain
  as ghost steal candidates. Bots cannot keep an abandoned human game running.
- The bot's random sampling cannot exhaust a scratch array and loop forever.
- Server inputs are bounded/validated, chat is rendered as text, and slow or
  dead WebSocket clients are disconnected.

## Checks

```sh
npm test
npm run test:browser
```

The Node tests exercise tile conservation, original vocabulary counts, word
history, steals/defenses, penalties, grace, timing, limits, spectators, ties,
training, idle cleanup, HTTP serving, and real multi-client WebSocket sessions.

The browser check uses Playwright with an installed Google Chrome on macOS.
Set `CHROME_PATH` to another installed Chromium executable when needed. It runs
two independent browser sessions, checks keyboard play, chat, sounds, desktop
layout, game restart, and reconnect, and saves screenshots in `test-results/`.
It uses an internal deterministic clock/board fixture, never a production API.

Converted audio is checked in, so FFmpeg is not needed to run the app. To
regenerate the WAV files from the preserved `.au` originals with FFmpeg installed:

```sh
npm run sounds
```

The original source headers specify GPL-2.0-or-later; this rewrite retains that
license and Stewart Allen's authorship.
