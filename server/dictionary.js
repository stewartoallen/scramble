// Copyright Stewart Allen. GPL-2.0-or-later. See the original sources in src/.
import { readFileSync } from 'node:fs';

export const DICTIONARIES = Object.freeze({
  twl: { file: 'us-english-twl', label: 'US English', noPlurals: true },
  sowpods: { file: 'uk-english-sowpods', label: 'UK English', noPlurals: true },
  ods: { file: 'french-ods', label: 'French', noPlurals: false },
  zingarelli: { file: 'italian-zingarelli', label: 'Italian', noPlurals: false },
});

const aliases = {
  default: 'twl', 'us english': 'twl', 'uk english': 'sowpods',
  french: 'ods', italian: 'zingarelli',
};

export function letterCounts(word) {
  const counts = new Uint8Array(26);
  for (const letter of word) counts[letter.charCodeAt(0) - 97]++;
  return counts;
}

export function signature(word) {
  return letterCounts(word).join(',');
}

// Return the letters needed in addition to a whole existing word, or null if
// that word cannot be included. Counting occurrences avoids mutable tile marks.
export function extraLetters(target, existing) {
  const counts = letterCounts(target);
  for (const letter of existing) {
    const index = letter.charCodeAt(0) - 97;
    if (!counts[index]) return null;
    counts[index]--;
  }
  let extra = '';
  for (let i = 0; i < 26; i++) extra += String.fromCharCode(97 + i).repeat(counts[i]);
  return extra;
}

export class Dictionary {
  constructor(text, { label = 'US English', noPlurals = true } = {}) {
    this.label = label;
    this.noPlurals = noPlurals;
    this.words = new Set();
    this.skipped = [];
    for (const word of text.split(/\r?\n/)) {
      if (!word) continue;
      if (/^[a-z]{2,24}$/.test(word)) this.words.add(word);
      else this.skipped.push(word);
    }
    this.anagramIndex = null;
  }

  has(word) { return this.words.has(word); }

  prepareAnagrams() {
    if (this.anagramIndex) return;
    this.anagramIndex = new Map();
    for (const word of this.words) {
      const key = signature(word);
      const group = this.anagramIndex.get(key);
      if (group) group.push(word);
      else this.anagramIndex.set(key, [word]);
    }
  }

  anagrams(letters) {
    this.prepareAnagrams();
    return this.anagramIndex.get(signature(letters)) ?? [];
  }
}

export class Dictionaries {
  constructor() { this.loaded = new Map(); }

  get(name = 'default') {
    const lower = name.toLowerCase();
    const key = aliases[lower] ?? lower;
    const config = DICTIONARIES[key];
    if (!config) throw new Error(`Unknown dictionary: ${name}`);
    if (!this.loaded.has(key)) {
      const url = new URL(`../src/res/words/${config.file}`, import.meta.url);
      this.loaded.set(key, new Dictionary(readFileSync(url, 'utf8'), config));
    }
    return this.loaded.get(key);
  }
}
