// The original trainer's search strategy and tuning, backed by the new index.
export const TRAINING_ROOMS = Object.freeze([
  { name: 'Beginner Training 1', bot: 'Trainer Bot 1', level: 0 },
  { name: 'Beginner Training 2', bot: 'Trainer Bot 2', level: 0 },
  { name: 'Intermediate Training', bot: 'Trainer Bot 3', level: 1 },
  { name: 'Advanced Training', bot: 'Trainer Bot 4', level: 2 },
]);

export class TrainerBot {
  constructor(game, player, level = 0, random = Math.random) {
    this.game = game;
    this.player = player;
    this.level = level;
    this.random = random;
    this.nextGuess = 0;
    this.lastThrow = 0;
    this.lastPool = '';
    this.roundId = null;
    this.retakes = [];
    this.reset();
  }

  reset() {
    const settings = [
      { miss: .85, max: 7500, min: 1000, weight: 100, throwWait: 2000, throwMin: 1500, maxLength: 5, minPool: 5 },
      { miss: .80, max: 7000, min: 1000, weight: 150, throwWait: 1500, throwMin: 1000, maxLength: 6, minPool: 5 },
      { miss: .75, max: 6000, min: 1000, weight: 200, throwWait: 1000, throwMin: 1000, maxLength: 7, minPool: 4 },
    ];
    this.tuning = { ...settings[this.level] };
  }

  choose(words) { return words[Math.floor(this.random() * words.length)]; }
  submit(word) { if (word) this.game.take(this.player, word); }

  onTake(event, now) {
    if (this.random() < .10 * this.level) {
      this.retakes.push({ word: event.word, at: now + 500 + this.random() * 1000 });
    }
  }

  chat(input) {
    const command = input.toLowerCase().replace(/^\//, '');
    const t = this.tuning;
    let reply;
    switch (command) {
      case 'help':
        reply = "Tune my behavior with '/nicer', '/harder', '/spank me' or '/default'. Nicer and harder are cumulative.";
        break;
      case 'nicer':
        t.max = Math.min(10000, t.max + 500); t.min = Math.min(5000, t.min + 100);
        t.weight = Math.min(500, t.weight + 25); t.miss = Math.min(1, t.miss + .05); t.maxLength = 5;
        reply = "ok, I'll play nicer";
        break;
      case 'harder':
        t.max = Math.max(3000, t.max - 500); t.min = Math.max(1000, t.min - 100);
        t.weight = Math.max(50, t.weight - 25); t.miss = Math.max(.25, t.miss - .05); t.maxLength = 6;
        reply = 'there ya go!';
        break;
      case 'spank me':
        Object.assign(t, { max: 3000, min: 1000, weight: 50, miss: .25, maxLength: 8 });
        reply = 'hang on to your shorts';
        break;
      case 'default': this.reset(); reply = 'using default settings'; break;
    }
    if (reply) this.game.emit({ type: 'chat', name: this.player.name, text: reply });
  }

  tick(now) {
    const game = this.game;
    if (this.roundId !== game.roundId) {
      this.roundId = game.roundId;
      this.retakes = [];
      this.reset();
      this.nextGuess = now + this.tuning.max;
    }
    if (game.state === 'waiting') {
      const humans = game.activePlayers.filter(p => !p.bot);
      if (humans.length && humans.every(p => p.ready) && !this.player.ready) {
        game.setReady(this.player, true);
      }
      return;
    }
    if (game.state !== 'playing') return;
    if (game.pool.letters !== this.lastPool) {
      this.lastPool = game.pool.letters;
      this.lastThrow = now;
    }
    const due = this.retakes.filter(r => r.at <= now);
    this.retakes = this.retakes.filter(r => r.at > now);
    for (const retake of due) {
      const anagrams = game.dictionary.anagrams(retake.word);
      if (anagrams.length > 1) this.submit(this.choose(anagrams));
      else this.extend(retake.word);
    }
    if (now < this.nextGuess) return;
    if (now - this.lastThrow < this.tuning.throwMin) {
      this.nextGuess = now + this.tuning.throwWait;
      return;
    }
    this.lookForWords();
    const t = this.tuning;
    const reduction = Math.min(t.max - t.min, (game.pool.letters.length + game.words.length) * t.weight);
    this.nextGuess = now + t.max - reduction;
  }

  extend(word) {
    for (const letter of this.game.pool.letters) {
      if (this.random() < this.tuning.miss) continue;
      const words = this.game.dictionary.anagrams(word + letter);
      if (words.length) { this.submit(this.choose(words)); return true; }
    }
    return false;
  }

  lookForWords() {
    const pool = this.game.pool.letters;
    if (pool.length >= this.tuning.minPool) {
      const length = 3 + (this.random() > .75 ? 1 : 0);
      for (let attempt = 0; attempt < Math.floor(pool.length / 4); attempt++) {
        // Each attempt has its own draw. The Java bot could exhaust its scratch
        // array and loop forever when trying multiple unsuccessful guesses.
        const available = [...pool];
        let letters = '';
        for (let i = 0; i < length; i++) letters += available.splice(Math.floor(this.random() * available.length), 1)[0];
        const words = this.game.dictionary.anagrams(letters);
        if (words.length) { this.submit(this.choose(words)); return; }
      }
    }
    for (const player of this.game.activePlayers) {
      if (this.random() < this.tuning.miss) continue;
      const words = this.game.wordsFor(player);
      if (words.length <= 1) continue; // The trainers spare a player's only word.
      const word = this.choose(words).text;
      if (this.random() > .5) {
        this.submit(this.choose(this.game.dictionary.anagrams(word)));
        return;
      }
      if (word.length < this.tuning.maxLength && this.extend(word)) return;
    }
  }
}
