// Checks that git remotes become public https addresses with no credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRepoUrl } from '../lib/repoUrl.js';

test('ssh and https remotes become the same plain address', () => {
  assert.equal(publicRepoUrl('git@github.com:pelaxa/adaptive-photo-frame.git'), 'https://github.com/pelaxa/adaptive-photo-frame');
  assert.equal(publicRepoUrl('ssh://git@github.com/pelaxa/adaptive-photo-frame.git'), 'https://github.com/pelaxa/adaptive-photo-frame');
  assert.equal(publicRepoUrl('https://github.com/pelaxa/adaptive-photo-frame.git\n'), 'https://github.com/pelaxa/adaptive-photo-frame');
});

test('passwords and tokens never reach the address', () => {
  const url = publicRepoUrl('https://me:s3cret-token@github.com/pelaxa/adaptive-photo-frame.git?x=1');
  assert.equal(url, 'https://github.com/pelaxa/adaptive-photo-frame');
  assert.ok(!url.includes('s3cret'));
});

test('an empty or unknown remote gives an empty address', () => {
  assert.equal(publicRepoUrl(''), '');
  assert.equal(publicRepoUrl(undefined), '');
  assert.equal(publicRepoUrl('/local/path/repo'), '');
});
