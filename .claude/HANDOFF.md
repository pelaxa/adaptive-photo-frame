# Handoff - where the project stands

Written at the end of a long working session so anyone (a person or another agent) can pick the work up. The rules are in
`../AGENTS.md`; what the app does and every setting is in `../README.md`. This file is the **state**: what exists, what was and was not
verified, and what is open. Keep it short and update it when the state changes.

## How to resume

- **Same machine, same folder:** `claude --continue` (latest session) or `claude --resume` (pick one) from the project root restores the
  full conversation. Those transcripts are stored in the user's home folder (`~/.claude/projects/...`), **not** in this repository,
  so they cannot be shared by committing them.
- **Anyone else / another machine:** start a new session in the project root. `CLAUDE.md` loads `AGENTS.md`; then read this file and
  `README.md`. That is the whole context a fresh agent needs; the design decisions are recorded below.
- Run `npm install && npm run install-plugins`, copy `config/config.example.jsonc` to `config/config.jsonc`, then `npm test` (all pass) and
  `npm run check` to confirm the setup.

## Naming and licence

- Renamed to **Adaptive Photo Frame** (package `adaptive-photo-frame`). Folder and repository names are the owner's to change.
- Licensed **AGPL-3.0-or-later**: the official text is in `LICENSE`, the three `package.json` files carry the SPDX id, and the README has
  a "License" section ("Copyright (C) 2026 Pelaxa": confirm the legal holder and year). The Immich SDK used by the Immich plugin is
  AGPL-3.0, so the project is consistent; every other dependency is MIT, ISC, Apache-2.0 or LGPL (all compatible).
- The README has an **AI Use** section (Claude wrote most of the code under the owner's direction) placed before "License".
- Still open: the README says other arrangements "can be discussed with Pelaxa" but gives no contact; selling commercial licenses would
  need a contributor agreement (CLA) before accepting outside code; per-file licence headers (SPDX lines) were not added.
- If a credit to Herman Banken's original "Shifting Tiles" is added to the README, word it as inspiration ("shares no code with it"); his
  repo has no licence and none of his code is in this one.

## Open items (as of 2026-11-07)

1. ~~Rebuild and re-test the image~~ Done 2026-11-07: rebuilt (arm64, native), `npm run docker:test` passes all 20 checks, including `custom.css` and the labels.
2. **Try the TV fix through `custom.css`.** On Fully Kiosk Browser (Android TV stick) the black frame borders drew grey. Changing `.frame` to `border-color: transparent;
   background: #000;` in the browser inspector fixed the colours; the same snippet is in `config/custom.example.css` (commented out). Not yet tried via `custom.css` on the TV.
3. **Rotate the Immich share link.** `npm run check` printed the upload URL (with the share key) into a session transcript on 2026-11-04.
4. **Commit the lock files.** The owner's *global* gitignore (`~/.gitignore_global`, line 5, set by `core.excludesfile`) ignores every `package-lock.json`, so image builds are
   not reproducible. Either `git add -f` them (root + each `builtin-plugins/*/`) or add `!package-lock.json` to the project's `.gitignore` (a project rule beats the global one).
5. **Not started, optional:** pin the base image by digest (`--build-arg BASE_IMAGE=node:26-alpine@sha256:...`) and let Dependabot's `docker` ecosystem bump it; add `init: true`
   to `docker-compose.yml` (reaps child processes, tini-style); tidy anything stale below.
6. **Never verified:** a Linux host (bind-mount ownership for uid 1000), an amd64 or `buildx` multi-arch image on a real server, the Immich plugin *inside* the container
   (the smoke test uses the folder plugin), installing a user plugin with npm inside the container, Kubernetes, a Raspberry Pi.
7. **CI:** `.github/workflows` (`ci.yml`, `docker.yml`) and `dependabot.yml` have NEVER run on GitHub. `docker.yml` was rewritten on 2026-11-07 for native runners (amd64 + arm64, no QEMU),
   push-by-digest and a merge job that creates the multi-platform tags; the artifact actions it uses were pinned from the GitHub API, and `actionlint` passes (checked 2026-11-07). Watch the first run on GitHub. Things most likely to need a fix: merging the per-architecture
   images when provenance/SBOM attestations are on, the `index:` annotations from the metadata step, and the `ubuntu-24.04-arm` runner label. The repository must be public for the free arm64 runners.

## Clock (added 2026-11-07)

- `clock` section in `config.jsonc` (`lib/config.js` `CLOCK_SPECS`): enabled, position, showDate, showTime, dateFormat (full/long/medium/short/iso), timeFormat (auto/12h/24h), showSeconds, locale.
  Formatting is the browser's `Intl` (`public/clock.js`, unit-tested); the time is the device's own, no time zone option. Default: top-left, white on 50% black, rounded inner corner like the QR box.
  Colours and fonts are `custom.css` only (`.clock`, `.clock-date`, `.clock-time`, `--clock-background`, `--clock-color`, shared `--box-radius` and `--qr-size`). Same corner as the QR code: the clock moves beside it.
- QR styling moved to CSS on 2026-11-08 (owner request, for consistency with the clock): `qr.color` and `qr.background` are no longer settings (an old config gets one warning and they are ignored); `enabled`, `position` and `text` stay in `config.jsonc`.
  Defaults are in `public/style.css` (`.qrcode`: `color` white, `background` rgba(0,0,0,.35), `backdrop-filter: blur(12px)`); `custom.css` overrides them. The squares are drawn by CSS: the server's `/api/qr.svg` is plain black on transparent and `.qr-image` uses it as a `mask` over `currentColor`
  (needs mask support; `-webkit-mask` is included). NOT verified in a real browser, in particular the mask on the TV's WebView and that the code still scans. The owner's own `config/config.jsonc` still has the two old keys (harmless warning; delete them).
- Verified: unit tests (formats, 12/24h, seconds, locale, tick timing, config validation) and the server (`/api/config` carries `clock`; an all-hidden clock stops the server with a message).
  NOT verified: how it looks or behaves in a real browser (the DOM wiring in `app.js` and the CSS were never run in a browser), and the stacking next to the QR code.

## Burn-in protection (added 2026-11-08)

- `display.burnInProtection` (default false): every hour (fixed `BURN_IN_MOVE_MS` in `public/app.js`, currently 1 minute for testing, owner decision: not configurable) the clock and the QR code fade out, move to a different random corner and fade back in;
  never the same corner at once. Corner choice is `pickCorners()` in `public/corners.js` (unit-tested). Positions are not remembered across a page reload. NOT seen in a browser; the fade is the `.moving` rule in `style.css` (1 s, in step with `FADE_MS`).

## Row fill rule (added 2026-11-08)

- Owner rule: an ordinary row must never be a lone stacked pair, `[pair][pair]` or one regular photo (they get cropped like a panorama); only panoramas may fill a row alone. Implemented as
  `MIN_ROW_FILL = 0.75` and `rowFill()` in `public/layout.js` (unit-tested); `planRow` (public/app.js) redraws up to 8 times, `replaceColumn` rebuilds the whole row when its best swap would leave the row emptier than that.
- Checked with a scratch harness that runs the real `public/app.js` in Node against a stand-in page and a real server (not kept; see AGENTS.md section 5): on the owner's 132-photo Immich album rows never dropped below 0.75 even
  without the rule; with 6 and 8 photos the emptiest row was 0.61 and 0.56 without it and 0.8 with it. Albums of 5 photos or fewer cannot satisfy it (each row gets a budget of one photo). That is the likely source of the
  original report, but the owner's actual album size was not asked. Not seen in a real browser; animation of the "rebuild instead of swap" path is the same `showRow` as for panoramas.

## immich-library plugin, captions, allowedPostHosts (added 2026-11-10)

- `builtin-plugins/immich-library`: Immich read with an **API key** (`x-api-key` header, never in a URL). `mode` = `album` (albumIds / albumNames, via the timeline), `memory` (`daysBefore` 0-15, default 7, plus a fixed 2 days ahead: one
  `GET /memories?for=YYYY-MM-DD` per day) or `search` (`POST /search/smart` only, paged, `maxImages`, default 200; filters personIds, isFavorite, city, country). Immich is asked **once per local day** (`REFRESH_RETRY_MS` = 10 min back-off after a failure).
  Order helpers are copied from the shared-album plugin (a sandboxed plugin cannot import from a sibling): keep them in step.
- Why the memories API and the 2-day limit: probed on the owner's Immich 3.4.0 (2026-11-10, read-only GETs): `day`/`month` parameters (used by MMM-ImmichSlideShow) are **ignored** (the same 17 memories came back every time);
  `for=YYYY-MM-DD` works, but Immich held memories only from about 27 days back to 2 days ahead. MMM-ImmichSlideShow should send `for=YYYY-MM-DD` on Immich 3.x (to fix there later).
- **`allowedPostHosts` moved to config.jsonc**, per plugin entry (host names only), passed to the sandbox at `init`/`setup`; a plugin that still declares its own gets a warning and it is ignored. Default: none (GET only).
  Owner decision: the `search` POST is an explicit exception to "GET only on the live Immich" (it reads only). AGENTS.md records it.
- **`display.caption`** (template with `{date}`, `{year}`, `{city}`, `{state}`, `{country}`; a token the plugin does not provide is skipped with the text in front of it): `public/caption.js` (unit-tested), drawn by `public/app.js` as `.frame-caption`
  at the bottom-left of a frame. Plugins add optional `date`/`city`/`state`/`country` to each image (kept by `normalizeImages`). Provided by immich-library and immich-sharedAlbum (no state); the folder plugin provides none (open idea: its EXIF date).
- New setting type `list` (list of text) in `lib/settings.js`.
- Tests: 138 pass (some need local port binding, so they fail inside the Claude Code sandbox with `listen EPERM`; run outside it). Verified with a pretend Immich only. **NOT verified:** a live Immich (run `npm run check` with an API key in
  `config.jsonc`: albums, memories, search, ratio from EXIF orientation, the API key's permission names), smart search with machine learning on/off, how captions look in a browser (and that `position: relative` on `.frame` leaves the accordion folds unchanged),
  the Docker image with the new plugin. `npm run check` prints no upload URL for this plugin (it has none).

## Docker (built and tested on the owner's Mac, Apple silicon, Docker Desktop)

- `docker/` holds every Docker file: `Dockerfile`, `Dockerfile.dockerignore`, `docker-compose.yml`, `dockerBuild.js` (`npm run docker:build`, `docker:build:multi`),
  `dockerEntrypoint.js`, `healthcheck.js`, `dockerSmokeTest.js` (`npm run docker:test`). Build from the project root: `docker build -f docker/Dockerfile .`.
- Image: one stage on `node:26-alpine` (shell and npm included, owner decision), runs as uid 1000 (`node`). The Dockerfile updates npm (`NPM_VERSION`, default latest) and
  runs `apk upgrade` at build time. Built-in plugins ship in `/app/builtin-plugins` (packages installed at build); `/app/config` and `/app/plugins` are meant to be mapped
  to the host; photos for the folder plugin mount at `/app/builtin-plugins/folder/photos` (the sandbox can read only the plugin's own folder).
- First run (`lib/firstRun.js`, called by the entrypoint): creates `config.example.jsonc`, `config.jsonc`, `custom.example.css`, `custom.css` in the config folder, from
  `/app/defaults`. Existing files are never overwritten (owner rule).
- Verified with real containers (smoke test, 17 checks, 2026-11-05): non-root, shell and npm present, read-only root + all capabilities dropped + no-new-privileges, first run
  and restart, the app starts and serves resized photos (sharp works on Alpine/musl), health check, console-only logs and no other file changes, quick clean `docker stop`.
  Earlier, on the previous distroless image: Immich live in the container (132 photos), `--user 1000:1000` cache warning, missing config exits with a clear message.
- Trivy (same pinned scanner as CI; HIGH/CRITICAL, fixable only) is clean on the Alpine image. A full scan shows two MEDIUM, `glob` and `minimatch` bundled inside npm, which
  only a newer npm can fix (the weekly rebuild picks it up). Alternatives measured on 2026-11-05: Debian slim ~200 findings (52 HIGH), distroless 49 MEDIUM/LOW unfixed.
  No `.trivyignore` is needed; if a future finding has no fix, add one with a comment.
- Labels: the Dockerfile sets `version`, `revision`, `created`, `source`, `url` (plus title, description, vendor, licenses) from build args `APF_VERSION`, `APF_REVISION`, `APF_CREATED`, `APF_SOURCE`.
  `dockerBuild.js` takes the repository address from the git remote (this clone has no remote yet, so local images have an empty source/url until one is added). The smoke test checks them (source/url strictly only when `CI` is set).
- Custom styles: optional `config/custom.css` (template `config/custom.example.css`), served at `/custom.css` (`lib/customCss.js`) and loaded after `style.css`.
- Accordion seam lines: `accordionStrips()` in `public/layout.js` gives whole-pixel strips that overlap the next by 1px (`buildAccordion` in `public/app.js`). Unit-tested for the
  maths; the owner confirmed by eye on their device that the thin black lines are gone.

## What exists (all built and unit-tested)

- Plugin system with a file-access sandbox; plugins: `builtin-plugins/folder` and `builtin-plugins/immich-sharedAlbum` (both with their own packages).
- App-side image service (`sharp`): bytes or URL from the plugin, format check, resize, EXIF rotation, disk cache.
- Page: two rows of columns sized to photo shape; random slide/flip/accordion effects; panorama rows; no duplicate photos; sequence mode
  (rounds, new photos join the round); QR code to the plugin's upload page.
- `config.jsonc` (JSONC): server, display (three hardware levels), qr, clock, plugins. `order: { by, sort }` for both plugins.
- Git: the owner commits; `git status` shows anything uncommitted.

## Verified, and how

- 112 unit tests at 2026-11-08 (`npm test`; four of them start a local server, so they need permission to listen on a port): settings, config, first-run files, custom.css, plugin loading, sandbox behaviour (what it blocks and allows), image service, folder
  plugin (incl. symlink rules), Immich plugin against a pretend Immich, layout and sequence logic.
- Against the owner's **live Immich** (read-only GETs): album listing, image download via URL, ordering by `DateTimeOriginal`, `iso`,
  an invalid field name (warning + random).
- The real `public/app.js` against the real server using a **stand-in page in Node** (see AGENTS.md section 5): duplicates, panorama
  rows, the three hardware levels' animation calls, ordering rounds and new-photo timing.

## NOT verified

- **Anything in a real browser or on a real device:** how it looks, animation smoothness, memory. Fire TV, Roku, LG TV were
  discussed but never tried (Roku cannot run it: no web browser; LG needs a 2023+ webOS for the page's `top-level await`;
  Fire TV's Silk browser is untested). The page needs roughly Chromium 89+.
- Raspberry Pi, Windows (`O_NOFOLLOW`, `npm.cmd`), Node versions other than 26, the README's pm2/systemd/container hints.
- Behaviour with HEIC, GIF or video in a folder beyond "skipped and logged once".

## Open ideas and known limits (none are started)

- Older-browser support: bundle/transpile the three small page scripts (drop top-level `await`) so older TVs can run it.
- Very large albums: choosing photos costs about 17 ms (5,000 photos) to 144 ms (50,000) per tick on a fast computer; slower devices
  would hiccup. Could be cached/pre-sorted.
- Immich ordering by a field other than the date/city/country/coordinates costs one request per photo (limited to 8 s per refresh).
- The image cache is never pruned. The app decodes plugin-supplied images in the main process (a library flaw could in theory be
  reached by a hostile plugin). The sandbox restricts files only, not the network.
- The QR panel's blur (`backdrop-filter`) costs graphics work under moving photos on weak devices; a solid `qr.background` avoids it.
- The folder plugin cannot read photos outside its own folder (symlinks forbidden by design); a settings-driven read grant would be
  the way, if ever needed.
- Sequence mode follows the order loosely (look-ahead of 6 photos); strict order is `LOOK_AHEAD = 1` in `public/sequence.js`.
- `npm run check` prints the Immich upload URL including the share key.
- Possible next features (discussed 2026-11-08, nothing decided; plan with the owner before building):
  - Detect server restarts so open pages reload: `/api/config` reports a start id, the page re-checks it every so often and reloads when it
    changes or the server comes back. Also the natural signal for a live config reload (config is read once at start-up; only `custom.css` is live).
  - Synced clients: today each browser picks photos, layouts, effects and timing itself, so two screens differ. Idea: the server owns the
    state (it can run the pure `public/layout.js` and `public/sequence.js`) and pushes timed steps over server-sent events (a GET stream, no
    new dependency, preferred over WebSockets); clients preload, then animate at the server time. Open questions: SSE vs WebSockets, synced as
    the only mode or opt-in, acceptable drift (expect 50-200 ms), handling of clients that load late.
