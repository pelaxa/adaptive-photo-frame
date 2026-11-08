/**
 * docker/dockerBuild.js - builds the Docker image (`npm run docker:build`).
 *
 * Tags it `adaptive-photo-frame:<version from package.json>` and `adaptive-photo-frame:latest`, and stamps the version, git revision,
 * creation time and repository address (from the git remote, without credentials) into the image labels. Anything after `--` is passed to `docker build`, for example:
 *   npm run docker:build -- --no-cache
 *   npm run docker:build -- --build-arg BASE_IMAGE=node:26-alpine@sha256:<digest>
 * `npm run docker:build:multi` builds for both amd64 and arm64 (Raspberry Pi, most NAS boxes and Apple chips) with buildx; add `--push`
 * after `--` with a registry-qualified name to publish (a multi-platform image cannot be loaded into the local Docker).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publicRepoUrl } from '../lib/repoUrl.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version, name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const multi = process.argv.includes('--multi');
const extra = process.argv.slice(2).filter(arg => arg !== '--multi');

const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
const revision = git.status === 0 ? git.stdout.trim() : 'unknown';

// The repository address for the image labels comes from the git remote (credentials removed); empty when there is no remote yet.
const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
const source = remote.status === 0 ? publicRepoUrl(remote.stdout) : '';

const args = [
  ...(multi ? ['buildx', 'build', '--platform', 'linux/amd64,linux/arm64'] : ['build']),
  '-t', `${name}:${version}`, '-t', `${name}:latest`,
  '--build-arg', `APF_VERSION=${version}`, '--build-arg', `APF_REVISION=${revision}`,
  '--build-arg', `APF_CREATED=${new Date().toISOString()}`, '--build-arg', `APF_SOURCE=${source}`,
  '-f', `${root}docker/Dockerfile`, ...extra, root
];
console.log(`docker ${args.join(' ')}\n`);
process.exit(spawnSync('docker', args, { stdio: 'inherit' }).status ?? 1);
