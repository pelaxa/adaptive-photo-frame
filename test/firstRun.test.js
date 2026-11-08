// Checks the first-run creation of config files: created when missing, never overwritten.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureConfigFiles } from '../lib/firstRun.js';

/** Makes a defaults folder holding the two example files. */
async function defaults() {
  const dir = await mkdtemp(join(tmpdir(), 'apf-first-'));
  await writeFile(join(dir, 'config.example.jsonc'), '// example\n');
  await writeFile(join(dir, 'custom.example.css'), '/* css */\n');
  return dir;
}

test('an empty config folder gets the examples and the working files', async () => {
  const dir = await defaults();
  const config = join(dir, 'config');
  assert.deepEqual(await ensureConfigFiles(config, dir), ['config.example.jsonc', 'config.jsonc', 'custom.example.css', 'custom.css']);
  assert.equal(await readFile(join(config, 'config.jsonc'), 'utf8'), '// example\n');
  assert.equal(await readFile(join(config, 'custom.css'), 'utf8'), '/* css */\n');
});

test('existing files are never overwritten', async () => {
  const source = await defaults();
  const dir = join(source, 'config'); await mkdir(dir);
  await writeFile(join(dir, 'config.jsonc'), 'mine');
  await writeFile(join(dir, 'config.example.jsonc'), 'old example');
  await writeFile(join(dir, 'custom.css'), 'my css');
  assert.deepEqual(await ensureConfigFiles(dir, source), ['custom.example.css']);
  assert.equal(await readFile(join(dir, 'custom.css'), 'utf8'), 'my css');
  assert.equal(await readFile(join(dir, 'config.jsonc'), 'utf8'), 'mine');
  assert.equal(await readFile(join(dir, 'config.example.jsonc'), 'utf8'), 'old example');
});
