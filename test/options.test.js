import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startupOptions } from '../server/options.js';

test('startup defaults and PORT/HOST environment variables are preserved', () => {
  assert.deepEqual(startupOptions([], {}), { port: 3000, host: '0.0.0.0' });
  assert.deepEqual(startupOptions([], { PORT: '4321', HOST: '127.0.0.1' }), { port: 4321, host: '127.0.0.1' });
});

test('long, short, and equals-form CLI ports override the environment', () => {
  for (const args of [['--port', '8080'], ['-p', '8080'], ['--port=8080']]) {
    assert.equal(startupOptions(args, { PORT: '4321' }).port, 8080);
  }
  assert.equal(startupOptions(['--port', '0'], { PORT: 'invalid' }).port, 0);
});

test('invalid ports, missing values, and unknown options fail with usage errors', () => {
  for (const value of ['-1', '65536', '1.5', '8080abc', '', ' ', '1e3', 'Infinity']) {
    assert.throws(() => startupOptions([`--port=${value}`], {}), /Port must be an integer/);
  }
  assert.throws(() => startupOptions(['--port'], {}));
  assert.throws(() => startupOptions(['--prot=8080'], {}));
  assert.throws(() => startupOptions([], { PORT: 'invalid' }), /Port must be an integer/);
  assert.deepEqual(startupOptions(['--help'], { PORT: 'invalid' }), { help: true });
});

test('CLI startup binds the requested port and ignores an invalid PORT environment value', async t => {
  const child = spawn(process.execPath, ['server/index.js', '--port', '0'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, PORT: 'invalid', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI startup timed out: ${errors}`)), 5000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Scramble: (http:\/\/localhost:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(`CLI exited ${code}: ${errors}`)); });
  });
  const health = await fetch(url.replace('localhost', '127.0.0.1') + '/api/health');
  assert.equal(health.status, 200);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
  assert.equal(errors, '');
});
