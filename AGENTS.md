# AGENTS.md - rules for working on Adaptive Photo Frame

> **Name:** the project is **Adaptive Photo Frame** (package `adaptive-photo-frame`, by Pelaxa, licensed **AGPL-3.0-or-later**).

A photo wall (inspired by the photo frame on the first iPad) that shows an Immich shared album, or a folder of photos, on a TV or
tablet. A Node.js server loads one sandboxed **plugin** (a photo source), resizes and caches its images, and serves a small
vanilla-JavaScript page. Read `README.md` for what the app does and every setting; this file is about **how to work on it**.
Status and open items are in `.claude/HANDOFF.md`.

Follow these rules. They came from the project owner over a long design conversation; where one is marked *(owner rule)* it was
stated explicitly and must not be relaxed without asking.

## 1. How to work with the owner

- **Plan before big changes.** When asked to analyse or plan, do that and **wait for the go-ahead**. A question ("is it possible...",
  "what about...", "tell me how...") gets an answer, not a build. Build when told to.
- **Raise gaps one at a time**, security concerns first, and say plainly what is a recommendation. Do not bury a decision in a list.
- **Say what was not verified.** Report test results as they are, including failures. Never claim something was seen working in a
  browser or on a device when it was only unit-tested or run against a stand-in page.
- **Do not commit or push** unless asked. The owner commits.
  When asked to commit, end the message with a `Co-Authored-By:` trailer naming the assistant. The README has an **AI Use** section; keep it
  accurate if the way the project is built changes.
- **Stay inside the project folder** (the session scratchpad excepted) and **never change anything on the owner's Immich server** *(owner rule)*: only read (GET; the one approved exception is the `immich-library` search POST, see section 3)
  requests, no create/update/delete. The live Immich is real data.
- **Do not kill processes you did not start.** The owner often has their own server running (usually on port 3000). Test on other
  ports (for example 7395, 7396...) and stop only what you started, by PID. Never `pkill -f server.js`: it also matches VS Code's language
  servers (`languageserver.js`).
- **Keep secrets out of output.** `config.jsonc` holds the Immich share key. Do not echo it into replies or logs; redact it when
  quoting tool output. `config.jsonc` is gitignored and must stay that way.
- Be concise in replies; lead with what changed and what the owner must decide. Mention unrequested changes you made.

## 2. Code rules

- **Document everything** *(owner rule)*: every file starts with a header comment saying its purpose; every function has a doc
  comment with a description and typed `@param`/`@returns` (JSDoc); comment enough that a junior developer can follow the logic and
  the reasoning. Match the surrounding style (ES modules, 2-space indent, single quotes).
- **Constants** *(owner rule)*: ALL_CAPS is for global constants only, i.e. declared at the top level of a file, never inside a function or block. Tuning numbers (delays, fractions, limits, counts) are named,
  commented constants declared at the top level of their file, not numbers written into a function body. Anything declared inside a function is camelCase.
  **Constants come first in a file**, before the first function (after the imports); module state (`let`, maps, sets) follows them, then the functions, then any start-up code. A constant that can only be
  computed after start-up work (for example from the loaded settings) goes right after that work and still ahead of the functions; function declarations are hoisted, so they can be used above where they are written.
- **File names** *(owner rule)*: JavaScript files use camelCase starting with a lower-case letter (`guardedFetch.js`, `dockerSmokeTest.js`); a file that defines a class starts with a capital (PascalCase). Names that a
  tool or convention fixes (`Dockerfile`, `docker-compose.yml`, `package.json`, `config.example.jsonc`, `README.md`) are left as they are.
- **Indentation** is 2 spaces in every file type (JavaScript, CSS, HTML, YAML, JSONC); no tabs.
- A known limit of a shortcut gets a comment: `shortcut: <the limit>, <when to upgrade>`.
- **Fail loudly, not silently.** Configuration mistakes stop the server with a message naming the setting (and the line, for syntax
  errors). Unknown keys warn (to catch typos). Do not quietly ignore or fall back, except where a rule below says to.
- **Tests for new logic** (`node --test`, files in `test/`). Pure logic goes in small modules so it can be tested
  (`public/layout.js`, `public/sequence.js`). Always close sandboxed runtimes in tests (`rt.close()`), or the test run hangs.
- **Licence** *(owner rule)*: the project is **AGPL-3.0-or-later** (`LICENSE`, `package.json`, README "License" section). Every dependency must be
  AGPL-compatible (MIT, ISC, BSD, Apache-2.0, LGPL-3.0, GPL-3.0 and AGPL-3.0 are fine; GPL-2.0-only, proprietary or "non-commercial"
  licenses are not). Check a package's license before adding it and update the README "Dependencies" paragraph. Never copy code from a
  project without a compatible license (the original Shifting Tiles repo has none, so none of it may be used). Selling commercial licenses
  would need every contributor's agreement: tell the owner before accepting outside code.
- **Dependencies:** none added without need. The server uses `@immich/sdk` only inside the Immich plugin, `sharp` only in the app's
  image service, `jsonc-parser` for config, `qrcode` for the QR code. Plugins keep their own packages (see 3).
- **README is part of every change** *(owner rule)*: list every setting with its default and range, document exceptions, and write it
  in the **third person** (no "we", "I", "you", "your").

## 3. Architecture rules

```
server.js              start-up, HTTP routes (GET only), no knowledge of any photo service
config/                the config folder (mapped to the host in Docker); docker/  every Docker file
lib/config.js          reads/validates config/config.jsonc (JSONC), picks the active plugin entry
lib/settings.js        typed setting specs (string, number, boolean, path, enum, color, object) for app and plugins
lib/plugins.js         finds/loads plugins, apiVersion adapters, contract checks, timeouts, album cache, restart on exit
lib/sandbox.js         runs a plugin in a restricted Node process; lib/sandboxChild.js is the code inside that process
lib/guardedFetch.js    GET-only fetch handed to plugins (advice, not enforcement)
lib/images.js          THE image service: download URL or take bytes, sniff format, resize with sharp, cache on disk
lib/logger.js          levelled logger; plugin lines are prefixed with the plugin's name
builtin-plugins/<id>/  the plugins shipped with the app: index.js + package.json + node_modules (folder/, immich-sharedAlbum/, immich-library/)
plugins/<id>/          plugins added by the user (empty in the repo; mapped to the host in Docker); same layout
public/                the page: app.js (rows, animations), layout.js and sequence.js (pure, tested), style.css, index.html
scripts/               pluginTool.js (npm run check / setup), installPlugins.js
test/                  unit tests
```

### Plugins and the sandbox
- **Every plugin runs in the sandbox, always** *(owner rule)*. Node's permission model: the process reads **only its own folder**,
  cannot write, run programs, start workers or load native addons, and starts with an **empty environment**. The network is open.
  There is **no `sandbox` setting**; its presence in config is an error. Nothing runs inside the server (no `providers/` folder).
- Therefore **a plugin must bring its own `node_modules`** (it cannot see the app's). `npm run install-plugins` installs them with
  `--ignore-scripts` (a plugin's dependencies must not run code at install time).
- The sandbox limits **files, not the network**: a plugin can still POST anywhere and send out what it can see. Do not describe it as
  stronger than that. Node calls its permission model a safety net for mostly-trusted code. Third-party plugins are fully trusted code;
  the README warns about this and must keep doing so.
- Plugin ids are the folder/file name inside `builtin-plugins/` or `plugins/`: letters, digits, hyphens, **case-sensitive**. `<folder>/<id>/index.js` or
  `<folder>/<id>.js`; ambiguity (also the same id in both folders) is an error. In config, **the first entry with `enabled: true` wins**; later entries are ignored; if
  it fails to start the server retries (never falls through to the next entry).
- The plugin's `name` (chosen by the plugin author) prefixes every log line from it.
- **Contract `apiVersion: 1`** (adapters per version live in `lib/plugins.js`; additive optional changes do not bump the version):
  `name`, `settings` (typed specs; types include `list`), `init(settings, ctx)?` (throw if not ready; it is retried), `setup(ctx)?`
  (run by `npm run setup`), `getImages()` -> `{ title, images: [{ id, ratio, date?, city?, state?, country? }], order? }`, `getImage(id, {maxPixels})` ->
  `{ body }` **or** `{ url, headers? }`, `getUploadUrl()?` (async allowed, read once after init). `ctx` = `{ fetch, log, pluginDir, prompt }`.
  Ids are opaque unique text; `ratio` = displayed width / height (after EXIF rotation).
- **No upload feature in this app** *(owner rule)*: no upload route, no upload method in the contract. Only plugins that have a
  service with its own upload page return a URL from `getUploadUrl()`; that becomes the QR code. The folder plugin has none.
- Plugins read their photo service **read-only**. Built-in plugins use GET only, **with one owner-approved exception (2026-11-10)**: `immich-library` in `search` mode sends `POST /search/smart` (Immich offers
  smart search only as a POST; it changes nothing). That POST goes to that one path through one helper, and works only if the user listed the Immich host in `allowedPostHosts`. Documented API only: `immich-sharedAlbum` uses the
  documented `?key=` query parameter (the `x-immich-share-key` header works but is undocumented, so it is not used); `immich-library` sends its API key in the documented `x-api-key` header, never in a URL.
- **`allowedPostHosts` is the user's setting** *(owner rule)*: it is a list of host names on a plugin entry in `config/config.jsonc` (default none) and is handed to the plugin's `ctx.fetch` guard at `init`/`setup`. A plugin cannot declare its own (it is ignored with a warning).
- **`immich-library`** modes: `album`, `memory` (`daysBefore` 0-15, default 7, plus a fixed 2 days ahead, via `GET /memories?for=YYYY-MM-DD`: Immich keeps memories only about 2 days ahead) and `search`. It asks Immich **once per local day** (owner rule: no polling every minute).
- **Captions** *(owner decision)*: `display.caption` is an app option (template of `{date}`, `{year}`, `{city}`, `{state}`, `{country}`); plugins only supply the optional facts per image; a token a plugin does not provide is skipped with the text in front of it
  (`public/caption.js`). The element is `.frame-caption`.

### Images
- Plugins say *where* an image is; **the app** (`lib/images.js`) checks, resizes and caches it with `sharp`, so plugins need no image
  library. Accepted: **JPEG, PNG, WebP only**, sniffed by first bytes before any decoder runs (SVG etc. refused). Limits: 50 MB, 100
  megapixels, http(s) URLs only, download timeout, error messages never contain a URL's query string (keys live there).
- Sizes: 1440 px on `high-power`, 1080 otherwise. Cache: `.cache/images`, per plugin, reused for a day, never pruned (documented
  shortcut). In-flight requests for one image are shared.

### Folder plugin (`builtin-plugins/folder`)
- Photos live **inside the plugin's own folder** (`builtin-plugins/folder/photos`); `path` is relative to the plugin folder; absolute paths and
  `..` are refused (the sandbox could not read them anyway). Photo contents are gitignored.
- **Symbolic links are never followed, under any circumstance** *(owner rule)*: skipped when listing, root must not be a link, checked
  with `lstat` before reading, opened with `O_NOFOLLOW`. Requests never supply a path; ids are hashes.
- Photo shape from the header via `image-size` (pure JS, no native code); EXIF via `exifr`. No writes, no cache in the plugin.
- Hidden files and `node_modules` ignored; files changed in the last `minAgeSeconds` skipped (they may be copying); a file time in
  the future is *not* "young".

### `order` setting (both plugins) *(owner rule)*
- `order: { by, sort }`. `by` = `"random"` or an EXIF field name (any capitalisation); `sort` = `"desc"` (newest/largest first, the
  default) or `"asc"`. An unknown field name **logs a warning and falls back to random**. Missing values come last in either
  direction. Defaults: folder `DateTimeOriginal`, Immich `random`.
- The plugin answers `order: 'sequence'` (follow its list) or `'random'` in `getImages()`. In sequence mode the page cycles in **rounds**:
  every photo is shown before any repeats, and a photo added later joins the round in progress (`public/sequence.js`).

### Page and layout (`public/`)
- Two rows. A **column** is one full-height photo, or two stacked small photos (landscape only; portraits are never stacked). Column widths come from
  aspect ratios so photos are cropped as little as possible; **no blurred backgrounds** *(owner rule)*.
- Photo count between `minPhotos` and `maxPhotos`, but **the same photo is never on screen twice**: photos chosen but still loading are
  "reserved", and a small album lowers the maximum to (number of images - 2).
- **Panoramas** sometimes take a whole row (`panoramaChance`); that is the one allowed exception to `minPhotos`. Never both rows.
- **Rows are never left nearly empty** *(owner rule)*: an ordinary row's columns must fill at least `MIN_ROW_FILL` (0.75) of its width at natural size (`rowFill` in `public/layout.js`), because they are stretched
  to fill it. So never a lone stacked pair, `[pair][pair]` or one regular photo in a row: only a panorama may fill a row by itself. `planRow` redraws (up to 8 times) and `replaceColumn` rebuilds the row
  instead of making it emptier. Albums of 5 photos or fewer cannot satisfy it (best effort).
- **Animations** *(owner rules)*: exit and entrance are a matching pair moving the same way (new frame from below -> old one goes up);
  layering: leaving frame under the shifting neighbours, arriving frame over them; **no left/right squeeze-fold** (rotateY width
  collapse); accordion folds and page flips are allowed. Effects are random per change.
- **`display.hardware`**: `high-power` (every effect, neighbours glide by left/width), `standard` (default; slides only, transform-only
  movement), `low-power` (no animation at all; frames are just replaced). Keep the page working on all three.
- `display.burnInProtection` (default false, for OLED screens): the clock and the QR code move to other corners every hour (fixed interval, owner decision: not a setting), never staying put and never sharing a corner (`public/corners.js`).
- The clock and the QR code are corner boxes: corner and content come from `config.jsonc`, colours/fonts/sizes only from `custom.css` (no colour settings for the clock or the QR code; the defaults are in `public/style.css`). A new page element that can be restyled gets a class name listed in the README.
- Options an owner would want to change live in `config.jsonc` and reach the page via `/api/config`. Internal tuning constants (look-ahead of
  6, 16 candidate columns, animation timing fractions) stay in code, named and commented.

### Docker image *(owner rules)*
- **Never run as root**: the image sets `USER 1000:1000` (numeric; the base's `node` user). Nothing at start-up may need root
  (no `chown` at run time, no `apt`). Program files are root-owned and read-only to the app; only `/app/config`, `/app/plugins` and `/app/.cache` are writable.
- **Logs go to the console only**; never add file logging inside the container. (`docker logs` is the interface.)
- **The base is the official Node image on Alpine (`node:26-alpine`) with a shell and npm** *(owner decision)*, so users can add plugins and run `npm install --ignore-scripts`
  in them. Start-up logic is still Node (`docker/dockerEntrypoint.js`, `lib/firstRun.js`). Nothing private is baked in: `config/config.jsonc` and the user's photos are
  mounted (see `docker/Dockerfile.dockerignore`).
- **Folders in the image** *(owner decision)*: `builtin-plugins/` (folder, immich-sharedAlbum, packages installed at build time, read-only) ships with the app and is never
  mapped; `plugins/` (empty, user plugins) and `config/` are mapped to the host. A plugin id must be unique across both plugin folders. The folder plugin's photos
  are mounted at `/app/builtin-plugins/folder/photos` because the sandbox can read only the plugin's own folder.
- **First run** *(owner rule)*: the entrypoint creates `config.example.jsonc`, `config.jsonc`, `custom.example.css` and `custom.css` in an empty config folder from `/app/defaults/config.example.jsonc`, and
  **never overwrites an existing file** (the example in the folder is not refreshed after an upgrade).
- Keep the Dockerfile, `docker-compose.yml` and the README "Run with Docker" section in step with each other. Rebuild and re-run the container scenarios
  after any change to them (see HANDOFF for the list).

### GitHub Actions *(owner rules)*
- `.github/workflows/ci.yml` (tests) and `docker.yml`; `dependabot.yml`. `docker.yml` builds, smoke-tests and scans **each architecture natively** (amd64 on `ubuntu-24.04`, arm64 on
  `ubuntu-24.04-arm`, no QEMU; free for public repositories) *(owner decision)*. On a `v*.*.*` tag each architecture is pushed by digest, and a last job merges them into ONE multi-platform
  image (tags `1.2.3`, `1.2`, `latest`) and creates the release. Users never choose an architecture: they pull the plain tag. 32-bit ARM is out of scope *(owner decision)*.
- **Every third-party action is pinned to a full 40-character commit hash**, with the version in a trailing comment. Never use a tag or branch.
  When adding or bumping one, look up the commit of the exact release (`GET /repos/<owner>/<repo>/commits/<tag>`) and confirm the hash matches the tag.
  Prefer an official container or a few lines of shell over adding an action (the Trivy scan runs from its image, pinned by digest).
- **Least privilege**: `permissions: contents: read` at the top; widen only inside the job that needs it (`publish`: `packages: write`; `release`: `packages: write`, `contents: write`).
- Never paste `${{ github.event... }}`, `github.ref_name` or similar into a `run:` script; pass it through `env:`. Check workflow changes with `actionlint`
  (`docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest`).
- Image labels (`version`, `revision`, `created`, `source`, `url`, ...) are set in the Dockerfile from build args; `docker/dockerBuild.js` and the workflow pass them. The repository address is
  never typed in: it comes from the git remote (credentials stripped, `lib/repoUrl.js`) or from `github.repository`.
- `docker/dockerSmokeTest.js` is the executable definition of what the image must satisfy (non-root, shell and npm present, first run creates config without overwriting, no log files, hardened flags). Keep it,
  the Dockerfile, `docker-compose.yml` and the README in step; the workflow runs it on every build.
- These workflows have never run on GitHub from here. Say so until the owner reports a green run.

### Server
- GET only (405 otherwise); no CORS headers; photo ids validated against the current list before the plugin is asked; `X-Content-Type-Options: nosniff`.
- Default **port 3000**. `server.host` default `0.0.0.0`.
- It is for **private networks**: no login, no upload token. The QR code lets guests upload to Immich's own page; anything they upload
  shows on the wall within about a minute with no moderation. The README says so and must keep saying so.
- Configuration is **only `config/config.jsonc`** (JSON with comments, via `jsonc-parser`), plus an optional `config/custom.css` of style overrides that the page loads after its own
  styles (served at `/custom.css` from a fixed path next to the config file; never a request-supplied path). The page's built-in styles are not changed to suit one device: device quirks go in the user's `custom.css`; `config/config.example.jsonc` is the commented
  template and must stay in sync with the code. There is no `.env` any more.

## 4. Commands

```
npm install && npm run install-plugins   # app packages, then each plugin's own packages
cp config/config.example.jsonc config/config.jsonc   # then edit; config/config.jsonc is gitignored
npm start                                 # npm start -- --config other.jsonc  for another file
npm run dev                               # restarts on server.js changes
npm test                                  # node --test "test/*.test.js" (the sandbox tests start real child processes; a few start a local server)
npm run docker:test                       # starts the image hardened and checks it (non-root, no log files, health, shutdown...)
npm run docker:build                      # builds the Docker image (adaptive-photo-frame:latest); docker:build:multi = amd64 + arm64
npm run check                             # starts the active plugin and tests it against the contract + image service
npm run setup                             # runs the plugin's optional setup(ctx)
```
Node 26 is what everything was developed and tested on; the sandbox needs Node's `--permission` and `--allow-net` flags (the server
checks for them).

## 5. Verifying without a browser (what was done, and its limit)

There is no headless browser in this environment. The page logic was checked by running the real `public/app.js` in Node against a
small **stand-in page** (fake `document`, `Image`, `Element.animate`; real `fetch` to a real running server) and recording what it
did: duplicate photos on screen, panorama rows, the animations requested per hardware level, ordering and rounds. That proves the
logic, **not** the look, the timing or a real browser's behaviour. Say so when reporting. The throwaway harness scripts were not
kept; recreate them in the scratchpad if needed.

## 6. Gotchas that cost time before

- macOS: `sed -i` needs `''`; prefer Python or perl for multi-line edits. `/var` is a symlink to `/private/var`: the sandbox allow-list
  must use real paths (`lib/sandbox.js` does `realpath`).
- A plugin that fails to load must have its child process killed (it keeps the test run alive otherwise) - `loadSandboxed` does this.
- `Math.min(...bigArray)` throws on ~100k items; use `reduce`.
- Test fixtures for plugins need their own folder in a temp dir; the sandbox cannot read outside it.
- `npm run check` prints the plugin's upload URL, which for Immich contains the share key. Redact it when quoting.
- Renamed meanings: `display.hardware` once meant different things (`standard` was full animation, `low-power` was slides
  only). The current meanings are in section 3; the README documents the change.

- Docker: `docker diff <container>` is a good way to prove nothing but the intended files changed (it lists every changed file; pipe it to `head`).
  Starting Docker Desktop (`open -a Docker`) is needed before `docker build` works on the owner's Mac. The container's Node cannot be inspected with a
  shell; use `docker run --rm --entrypoint /nodejs/bin/node <image> -e "..."`.
- `package-lock.json` is hidden from git by the owner's *global* gitignore, so it is not tracked; the Dockerfile copes, but tell the owner builds are
  only reproducible if the lock files are committed (`git add -f`).

## 7. Terms the owner uses

"frame"/"tile" = a photo slot on the wall; "row" = one of the two strips; "round" = one pass through all photos in sequence mode;
"plugin" = a photo source in `builtin-plugins/` or `plugins/`; "share key" = the Immich shared-link key.
