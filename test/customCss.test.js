// Checks reading the optional custom.css: the text when present, empty when missing, errors otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCustomCss } from '../lib/customCss.js';

test('returns the file text, or an empty string when there is no file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apf-css-'));
  await writeFile(join(dir, 'custom.css'), '.frame { border-color: red; }');
  assert.equal(await readCustomCss(join(dir, 'custom.css')), '.frame { border-color: red; }');
  assert.equal(await readCustomCss(join(dir, 'missing.css')), '');
});

test('other read problems are not hidden', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apf-css-'));
  await assert.rejects(readCustomCss(dir), /EISDIR/);
});
