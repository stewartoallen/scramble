import { mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/res/sound/', import.meta.url));
const destination = fileURLToPath(new URL('../public/assets/sound/', import.meta.url));
mkdirSync(destination, { recursive: true });
for (const file of readdirSync(source).filter(name => name.endsWith('.au'))) {
  const result = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', `${source}/${file}`, '-c:a', 'pcm_s16le', `${destination}/${file.replace(/\.au$/, '.wav')}`], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Could not convert ${file}`);
  console.log(`Converted ${file}`);
}
