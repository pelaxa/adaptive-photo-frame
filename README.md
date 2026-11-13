# Adaptive Photo Frame

A photo wall inspired by the photo frame on the first iPad. Photos fill two rows of frames sized to each picture's shape
(large frames, or two small ones stacked), and one frame at a time slides, flips or folds away like an accordion while a new one
arrives. The page is meant to be left open full screen on a TV, tablet or monitor.

> [!note]
> The inspiration for this tool came from a personal need to allow guests to see event photos while at the event and provide a way for them to upload their own photos (thus the QR code).  A simplistic version of this was originally created by a human, but this version is, as they say, 100% AI slop.  However, lots of thought has been put into app security and 3rd party plugin sandboxing. Users are advised to use at their own risk.

A small Node.js server reads the photos from a **plugin** (a photo source), serves the page, and passes the photos through.
The browser never talks to the photo service, so the service's address and keys stay on the server. Built-in plugins:

| Plugin id | Lives in | Photos come from |
|---|---|---|
| `folder` | `builtin-plugins/folder/` | a folder of image files inside the plugin's own folder (`builtin-plugins/folder/photos`) |
| `immich-sharedAlbum` | `builtin-plugins/immich-sharedAlbum/` | an [Immich](https://immich.app) shared album, read through its shared link |
| `immich-library` | `builtin-plugins/immich-library/` | an [Immich](https://immich.app) library, read with an API key: chosen albums, "on this day" memories, or a smart search ("dogs", "scenery") |

## Plugin Sandobx
Every plugin runs in a [file-access sandbox](#the-plugin-sandbox). The app itself checks, resizes and caches every image with
`sharp`, so plugins only have to say where an image is (see [Images](#images)).

Plugins for other services can be added by anyone (see [Writing a plugin](#writing-a-plugin)). The restriction is that plugin ids need to be unique so that they are loaded properly.  The built-in plugins that ship with the app are in `builtin-plugins/` and, like any outside plugin, carry their own packages and run under the same sandbox.

> [!important]
> **This is built for private servers.** There is no login, and anyone who can open the page can see the photos. Read
> [Security notes](#security-notes) before exposing it beyond a private network.

## Requirements

- Node.js 26 is the version this was developed and tested on (`node --version`). Plugins in `builtin-plugins/` and `plugins/` run in a sandbox that needs Node's
  permission flags (`--permission`, `--allow-net`); the server checks for them at start-up and refuses to start a sandboxed plugin on a Node
  that lacks them.
- Optional: Docker, to run it as a container (see [Run with Docker](#run-with-docker))
- For `immich-sharedAlbum`: an Immich server and an album with a **shared link** (Immich > album > Share)
- For `immich-library`: an Immich server and a read-only **API key** (Immich > Account Settings > API Keys); search mode also needs Immich's smart search (machine learning) switched on
- For `folder`: a folder of `.jpg`, `.jpeg`, `.png` or `.webp` files

## Deploy

1. Get the code and install the packages:
   ```
   git clone <this repository>
   cd <repository>
   npm install --omit=dev
   npm run install-plugins    # installs the packages each plugin in builtin-plugins/ and plugins/ needs (see below)
   ```
2. Create the settings file and edit it. The comments in the file explain every setting:
   ```
   cp config/config.example.jsonc config/config.jsonc
   ```
3. Optionally check that the photo source works, without starting the wall: `npm run check`
4. Start the server: `npm start`
5. Open `http://<computer-running-it>:3000` in a browser, ideally full screen (F11). The space bar swaps a frame immediately.

`npm run install-plugins` runs `npm install --omit=dev --ignore-scripts` inside every plugin folder that has a `package.json`
(running `npm install` inside a single plugin folder does the same for that plugin). A plugin in `builtin-plugins/` or `plugins/` can only use packages from its
own folder, so this step is required for `immich-sharedAlbum`, and for any plugin installed later. Package install scripts are switched
off on purpose: a plugin's dependencies must not be able to run code on the server during installation, outside the sandbox.

For a permanent display, the server can be kept running with a process manager (`pm2 start npm --name adaptive-photo-frame -- start`), a systemd
service, or a container whose command is `node server.js`. If the device may start before the network or a USB drive is ready, that
is fine: the page shows "Starting..." and the server retries (see `startupRetrySeconds`).

## Run with Docker

All Docker files live in the `docker/` folder: the `Dockerfile`, `docker-compose.yml` and the build, start-up, health-check and test scripts
(`npm run docker:build`). The container **never runs as root** (it runs as user id **1000**, `node`) and writes **no log files**: all output goes
to the console, so `docker logs` shows everything.

**Quick start**
```
npm run docker:build                                  # builds adaptive-photo-frame:latest (and a tag with the version)
mkdir -p config plugins                               # the folders that are mapped to the host
docker compose -f docker/docker-compose.yml up -d     # edit the photos mount first, see below
docker compose -f docker/docker-compose.yml logs -f   # the logs; the first start creates config/config.jsonc
```
Edit `config/config.jsonc` (the comments explain every setting) and restart: `docker compose -f docker/docker-compose.yml restart`.

Without Compose:
```
docker run -d --name photo-frame -p 3000:3000 \
  -v "$PWD/config:/app/config" -v "$PWD/plugins:/app/plugins" -v cache:/app/.cache \
  -v /path/to/photos:/app/builtin-plugins/folder/photos:ro \
  adaptive-photo-frame:latest
```
Then open `http://<host>:3000`. The published port must match `server.port` in `config.jsonc` (3000 by default). Nothing is configured through
environment variables except `APF_CONFIG` (the path of the config file inside the container, default `/app/config/config.jsonc`).

**Choosing the right image.** Published releases are one **multi-platform image**, so there is nothing to choose: pull the plain tag and Docker picks the build that matches the machine.
```
docker pull ghcr.io/pelaxa/adaptive-photo-frame:1.2.3        # pelaxa/adaptive-photo-frame is this project's address on GitHub
```
| Tag | Meaning |
|---|---|
| `1.2.3` | exactly that release |
| `1.2` | the latest `1.2.x` release |
| `latest` | the newest release |

| Platform | For |
|---|---|
| `linux/amd64` | Intel and AMD computers, most servers, many NAS boxes |
| `linux/arm64` | Apple Silicon Macs, Raspberry Pi 3, 4 and 5 **with a 64-bit operating system**, Graviton servers, many ARM NAS boxes |

32-bit ARM (for example the 32-bit Raspberry Pi OS, or a Pi 2 or Zero) and Windows containers are **not** supported. On a Pi, `uname -m` printing `aarch64` means 64-bit (use the image), `armv7l` means 32-bit (not supported).
- See what a tag contains: `docker buildx imagetools inspect ghcr.io/pelaxa/adaptive-photo-frame:1.2.3` lists the platforms. After pulling, `docker image inspect <image> --format '{{.Architecture}}'` shows which one was chosen.
- Force one (for example to test the other architecture under emulation): `docker pull --platform linux/arm64 <image>`, or `--platform` on `docker run`.
- Each image carries standard labels: `docker image inspect <image> --format '{{json .Config.Labels}}'` shows `version`, `revision` (the git commit), `created`, `source` and `url` (the repository), `licenses`, `title` and `description`.
- Building it yourself: `npm run docker:build` builds for the machine's own architecture and stamps the same labels (the repository address comes from the git remote, with any credentials removed). `npm run docker:build:multi` builds both architectures, but a multi-platform image cannot be loaded into an ordinary local Docker, so it needs `-- --push` with a registry-qualified name.

**What is in the image, and what gets mounted**

| Inside the container | What it is | Mount |
|---|---|---|
| `/app/builtin-plugins` | The plugins that ship with the app: `folder`, `immich-sharedAlbum` and `immich-library`, with their packages already installed. | Not mounted (part of the image, read-only). |
| `/app/builtin-plugins/folder/photos` | The photos shown by the `folder` plugin. | A host folder of photos, read-only (`:ro`). Only for the `folder` plugin. The plugin cannot follow symbolic links, so mount the real folder. It has to be at this path: the sandboxed plugin can read only its own folder. |
| `/app/config` | The settings folder. It holds the Immich share key, so keep it private. | A host folder. Required for any real use. |
| `/app/plugins` | Plugins added by the user (empty in the image). | A host folder. Optional. |
| `/app/.cache` | The resized-image cache. | A named volume (optional; it can be lost, but a volume avoids downloading and resizing everything again after an upgrade). |

**First run: the config folder.** When `/app/config` lacks `config.example.jsonc`, `config.jsonc`, `custom.example.css` or `custom.css` (an empty host folder, say), the start-up
creates the missing ones: the commented examples, and a copy of each as `config.jsonc` and `custom.css` so the app starts and there is something to edit. **Files that already exist
are never overwritten**, not even the example, so after an upgrade the example in the folder can be older than the program. The current one is
always in the image (`docker run --rm --entrypoint cat adaptive-photo-frame /app/defaults/config.example.jsonc` (and `custom.example.css`)) and in the repository (`config/config.example.jsonc`).
The default `config.jsonc` uses the `folder` plugin; mount photos as above, or change the plugin entry.

**Adding a plugin.** The image has a shell and npm for this. Put the plugin's folder in the host `plugins` folder, then install its packages inside the
container (`photo-frame` is the container's name; use the name from `docker ps`):
```
docker exec -it photo-frame sh -c "cd /app/plugins/<plugin-folder> && npm install --omit=dev --ignore-scripts"
```
Then add the plugin to `plugins` in `config.jsonc` and restart the container (`docker restart photo-frame`) so that it loads. The installed `node_modules` live in the
mapped `plugins` folder, so they survive restarts and upgrades. Install scripts stay switched off on purpose: a plugin's dependencies must not run code during installation,
outside the sandbox. Running `npm install --omit=dev --ignore-scripts` in the plugin's folder on the host also works for plugins that need only plain JavaScript packages; packages with
compiled parts or per-platform variants would be built for the host, not the container (Alpine Linux), and would not load, so installing inside the container is the safe way. A plugin id must be unique across `builtin-plugins` and `plugins` (the same id in both is an error, so a user plugin cannot
silently replace a built-in one: give a modified copy a new id).

**Permissions: the container does not run as root.** It runs as user id **1000**. Program files are owned by root and read-only to it; only
`/app/config`, `/app/plugins` and `/app/.cache` are writable.
- A bind-mounted host folder must be writable by the container's user. On Linux, either `chown -R 1000:1000 ./config ./plugins` or start the container as
  the folder's owner with `--user "$(id -u):$(id -g)"` (Compose: `user: "1000:1000"`). Docker Desktop on macOS and Windows maps ownership
  automatically (checked on macOS).
- If the config folder cannot be written and `config.jsonc` is missing, the container stops at start-up with a message saying so. If only the cache cannot
  be written (a different `--user`, say), photos still show; one warning is logged and each photo is fetched and resized every time it is requested.

**Logs.** The app prints to the console only (set the amount with `server.logLevel`); the container writes no log file. Docker itself stores the
console output on the host, so limit its size: the Compose file sets `max-size` and `max-file` (for `docker run`: `--log-opt max-size=10m --log-opt max-file=3`).

**Health and stopping.** The image has a health check (`docker ps` shows `healthy` once the photo source is ready; a plugin that is still starting or
failing shows as unhealthy after a grace period of 45 seconds). The server handles `docker stop` cleanly (stops within a fraction of a second).

**Hardening that works.** The Compose file also runs the container with a read-only root filesystem (config, plugins and cache are mounts), all Linux
capabilities dropped and `no-new-privileges`. All three were tested together with the app, including both plugins.

**The base image.** `node:26-alpine` (Node 26 on Alpine Linux), the official Node image with a shell (`sh`) and npm. Alpine has far fewer packages than Debian, so far fewer known vulnerabilities to patch (a full scan of the stock Debian image listed about 200 findings, 52 of them HIGH; the patched Alpine image has 2, both MEDIUM). It is a build argument: pin it with
`npm run docker:build -- --build-arg BASE_IMAGE=node:26-alpine@sha256:<digest>`, or use another image that has Node 26 and npm.
- **Keep it patched.** Rebuild regularly (`npm run docker:build -- --pull`) so new base-image fixes are picked up, and scan the image (for example `docker scout cves
  adaptive-photo-frame` or `trivy image adaptive-photo-frame`). The base tags move, so a build today and a build next month are not identical.
  The Dockerfile updates npm and the Alpine packages at build time (`--build-arg NPM_VERSION=<version>` pins npm), because the versions bundled in the base image can
  carry known vulnerabilities; the CI scan (HIGH and CRITICAL with a fix available) was clean with this. The two MEDIUM findings left are `glob` and `minimatch` bundled inside npm itself, which only a newer npm release can fix.
- **Reproducible installs.** The build uses `npm ci` when `package-lock.json` is present and falls back to `npm install` when it is not. Commit
  the lock files (the root one and the one in each plugin folder) so builds install exactly what was tested.

**Testing the image.** `npm run docker:test` (or `npm run docker:test -- some/image:tag`) starts the image exactly as it is meant to be deployed (read-only root,
all capabilities dropped, no-new-privileges, mounted config, plugins and photos) with a few generated photos, and checks that it is configured to run as a non-root
user and really does, that it has a shell and npm, that it carries the version, revision, creation-time and repository labels, that the first run fills an empty config folder and a restart does not overwrite it, that it starts,
lists and serves photos, passes its health check, writes only to the console (no log file) and stops cleanly on `docker stop`. It removes everything it created
and exits with an error if any check fails.

## Settings: `config.jsonc`

All settings live in `config/config.jsonc`, which is JSON that allows `//` comments and trailing commas. `config/config.example.jsonc` holds the same
list with explanations. The server must be restarted after any change. `npm start -- --config other.jsonc` uses a different file.

Out-of-range numbers are raised or lowered to the nearest allowed value (with a warning in the log). Wrong types and missing required
settings stop the server with a message naming the setting; syntax errors name the line and column. Unknown settings are ignored with
a warning, which catches typos. `config.jsonc` holds the photo service's key, so it is gitignored and should be kept private.

### `server`

| Setting | Default | What it does |
|---|---|---|
| `host` | `"0.0.0.0"` | Network address to listen on. `"127.0.0.1"` = this computer only. |
| `port` | `3000` | Port the page is served on (1-65535). If the port is already in use, the server says so and stops. |
| `pluginTimeoutSeconds` | `15` | Longest any plugin call may take before it counts as failed. Applies to every plugin (1-300). |
| `startupRetrySeconds` | `10` | Delay between attempts to start a plugin that failed to start (1-3600). |
| `logLevel` | `"info"` | `"error"`, `"warn"`, `"info"` or `"debug"`. Plugin lines are prefixed with the plugin's name. |

### `display`

| Setting | Default | What it does |
|---|---|---|
| `tileSeconds` | `5` | Seconds between photo changes; one frame is replaced each time (1-3600). |
| `refreshSeconds` | `60` | Seconds between re-reading the photo source for new or deleted images (5-86400). **Images added to the source (uploaded to Immich, or copied into a folder) appear on the wall within about this time**, plus up to 30 seconds of server-side caching. |
| `minPhotos` | `8` | Fewest photos on screen at once, across both rows. Stacked pairs of small photos are used to reach it. Cannot exceed `maxPhotos` (1-40). The one exception is a [panorama row](#panoramas), which holds a single photo. |
| `maxPhotos` | `12` | Most photos on screen at once. Lower means bigger photos (2-40). |
| `panoramaChance` | `0.2` | Chance that a row change turns one row into a single [panorama](#panoramas) across its whole width, if the album has one wide enough: `0` never, `1` every time (0-1). |
| `stackChance` | `0.3` | Chance that a new frame is two small stacked photos rather than one large photo, both for a new row and when one frame is replaced (the neighbours then shrink or stretch to suit, within the row-fill limit): `0` never, `1` always. Portraits are never stacked (0-1). |
| `hardware` | `"standard"` | How much animation to use, and how big the photos are; see [Hardware levels](#hardware-levels). `"high-power"`, `"standard"` or `"low-power"`. |
| `animationSeconds` | `1` | Length of each slide/fold (0.2-5). Not used on `"low-power"`. |
| `accordionStrips` | `4` | Folds in an accordion animation (2-8). Only used on `"high-power"`. |
| `caption` | `""` (none) | One line of text on each photo, built from what the photo source knows about it. The template mixes plain text with the tokens `{date}` (the day the photo was taken, long form, in the language of `clock.locale` or the browser's), `{year}`, `{city}`, `{state}` and `{country}`: `"{city}, {year}"` shows "Paris, 2021". **A token the photo source does not provide is skipped together with the text in front of it**: the same template shows "2021" for a photo with no city, and nothing at all if no token has a value. Keep templates to values joined by simple separators such as `", "` or `" - "`. `immich-library` and `immich-sharedAlbum` provide the date and place (the shared-album timeline has no state); the `folder` plugin provides none, so no caption shows with it. The caption sits at the bottom-left of each photo; see [Custom styles](#custom-styles-customcss) to restyle or hide it. |
| `burnInProtection` | `false` | For OLED screens, whose static bright pixels can burn in. When `true`, the clock and the QR code move to a different corner **every hour** (the interval is fixed): each one always goes to a corner it was not in, and they are never in the same corner at the same time. They fade out, move and fade back in (a one-second fade). `clock.position` and `qr.position` are where they start; if both name the same corner, they are separated at once. Only boxes that are showing move (the QR code appears only when the plugin has an upload address). The positions are not remembered: a page reload, which only happens while there are no photos, starts again from the configured corners. Photos change all the time and need no protection. |

#### Custom styles: `custom.css`

`custom.css` sits in the same folder as `config.jsonc` (the `config` folder, which is the mapped folder in Docker). The page loads it **after** its own styles, so a rule in it wins. It is optional: without it the page looks as shipped. Reload the page to see a change (no restart). `config/custom.example.css` is the commented template, with ready-made snippets to switch on; in Docker the first start creates both files (see [Run with Docker](#run-with-docker)), and existing files are never overwritten.

The class names meant for overriding are `.gallery` (the whole wall), `.row`, `.column`, `.frame` (a photo and its border), `.frame-caption` (the line of text from `display.caption`, at the bottom-left of a photo), `.message` (text such as "no photos"), `.starting` (the "Starting..." picture: a tiny wall of two rows of boxes, `.starting-box`, where boxes slide out and new ones slide in; they stand still on `"low-power"` hardware or when the device asks for reduced motion), `.clock` (with `.clock-date` and `.clock-time` inside it) and `.qrcode` (with its caption `p`). Other classes are internal and may change between versions. The file is served to anyone who can open the page, so it must not hold anything private, and the page's layout and timing (JavaScript) cannot be changed from it.

**Clock and QR code.** Both are corner boxes. Their corner and content are set in `config.jsonc` (`clock.position`, `qr.position`, `qr.text`, ...); their look is set here, and the defaults live in the app's own `style.css`. Because `custom.css` loads last, a normal rule wins:
```css
.clock { background: rgba(20, 40, 90, .7); color: #ffd966; font-family: Georgia, serif; }   /* clock colours and font */
.clock-time { font-size: 6vh; }                                                              /* bigger time */
.qrcode { color: #000; background: #fff; backdrop-filter: none; }                            /* black code on solid white, no blur */
:root { --box-radius: 14px; --qr-size: 14vh; }                                               /* rounded corner and QR size, for both boxes */
```
- **`.qrcode`**: `color` paints both the squares and the caption, `background` is the panel behind them (default: black at 35% opacity), and the frosted-glass effect is `backdrop-filter` (default `blur(12px)`; set it to `none` for a flat panel, which is also lighter on weak devices). Keep strong contrast between `color` and `background`, or phones cannot scan the code; white on a dark panel is an inverted code that most current phone cameras read, and if scanning fails, use a dark `color` on a light `background`.
- **`.frame-caption`**: the photo captions. Hide them with `.frame-caption { display: none; }`, or restyle: `.frame-caption { font-size: 2.4vh; }`.
- **Variables** can be used instead of properties: `--clock-background`, `--clock-color`, `--qr-background`, `--qr-color`, `--caption-background`, `--caption-color`, plus `--box-radius` and `--qr-size` for both boxes.

Example: some Android TV browsers (for example Fully Kiosk Browser on a streaming stick) draw the black border between photos paler than it should be. This fixes it by letting the frame's background show through a transparent border:
```css
.frame { border-color: transparent; background: #000; }
```

#### Hardware levels

`display.hardware` trades looks for work, on the device that shows the page:

| Level | For | Animations | Photo size |
|---|---|---|---|
| `"high-power"` | a computer or recent tablet | every effect: slides, page flips, accordion folds; neighbouring frames glide smoothly by animating their position and width | up to 1440 px |
| `"standard"` (default) | most TVs, TV sticks, Raspberry Pis | slides only (no 3D); neighbouring frames glide with a transform alone | up to 1080 px |
| `"low-power"` | the weakest devices, or anything that still stutters | **none**: a frame is simply replaced by the new one, and the other frames jump into their new places | up to 1080 px |

Before this setting had three levels, `"standard"` meant what is now `"high-power"` and `"low-power"` meant what is now `"standard"`.

#### `order` setting

The `immich-sharedAlbum`, `immich-library` and `folder` plugins have an `order` setting, an object with two fields:

```jsonc
"order": { "by": "DateTimeOriginal", "sort": "desc" }
```

- **`by`**: `"random"`, or an EXIF field name in any capitalisation. The default is `"random"` for the two Immich plugins and
  `"DateTimeOriginal"` (the date taken) for `folder`.
  - `"random"`: photos are chosen at random, longest-ago first (see below).
  - An EXIF field: photos are listed by that field's value and shown in that order, round after round. Photos with no value for the field come
    last, in either direction, except that for the date fields (`DateTimeOriginal`, `CreateDate`, `ModifyDate`) a `folder` photo without one
    is placed by its file modified time.
  - Anything else (a name that is not an EXIF field) is **logged as a warning** and the order is random.
- **`sort`**: `"desc"` (the default) lists the largest / **newest** value first; `"asc"` lists the smallest / **oldest** first. It has no effect
  on `"random"`. With `"desc"` on a date, the newest photos come first in every round.

Either field may be left out (`"order": { "by": "iso" }` is `desc`); an `order` that is not an object, or a `sort` that is neither
`"asc"` nor `"desc"`, stops the server with a message.

The `folder` plugin accepts any of the several hundred standard EXIF tag names (for example `DateTimeOriginal`, `CreateDate`, `ISO`, `FNumber`,
`FocalLength`, `Make`, `Model`, `LensModel`), read from the file itself. The Immich plugin accepts the fields Immich keeps for a photo:
`city`, `country`, `dateTimeOriginal`, `description`, `exifImageHeight`, `exifImageWidth`, `exposureTime`, `fNumber`, `fileSizeInByte`,
`focalLength`, `iso`, `latitude`, `lensModel`, `longitude`, `make`, `model`, `modifyDate`, `orientation`, `projectionType`, `rating`, `state`
and `timeZone`. In Immich, `dateTimeOriginal` is Immich's own capture date, and `city`, `country`, `latitude` and `longitude` come with the album
listing, so ordering by those costs nothing extra. Any other Immich field needs one request per photo; these are made a few at a time, remembered,
and limited to 8 seconds per refresh, so a large album fills in over a few refreshes (photos not yet looked up come last meanwhile).

#### Which photos are shown

How photos are chosen depends on what the plugin's `getImages()` answers. A plugin that answers `order: 'random'` (or says nothing) gets the
random mode; one that answers `order: 'sequence'` gets the in-order mode. For the built-in plugins that follows from their [`order` setting](#order-setting).

- **Random mode.** Each new frame is chosen at random from the photos shown **longest ago**, so every photo comes round before any repeats,
  and photos added to the source (never shown) are first in line.
- **Sequence mode.** The plugin lists its images in the order they should be shown (newest first, for the built-in plugins), and the wall cycles
  through them in rounds. **Every photo is shown once before any photo is shown a second time**, and **a photo added to the source joins the
  round in progress**, wherever it falls in the order (even if it is older than everything already shown), so it appears before the cycle comes
  round again and is not then repeated to make up for earlier rounds. A newly added photo that is also the newest is among the very next shown. The order is followed loosely: the next frame is chosen among the next six
  photos still waiting, so a frame of the right shape can be picked for the space available. A panorama row (below) is the one thing that can
  show a photo out of turn; it still counts as that photo's showing for the round.

In both modes a photo that is on screen, or about to appear, is never chosen, so the same photo is never showing twice at once. A new photo
is noticed on the next refresh: `display.refreshSeconds` plus up to 30 seconds of server-side caching.

A small album limits the wall: replacements are chosen while the old photos are still showing, and may be a stacked pair, so the album
needs two spare images beyond those on screen. The wall therefore shows at most **the number of images minus two**, if that is lower
than `maxPhotos` (and `minPhotos` is lowered to match). An album of 11 images shows at most 9 photos at once. Fewer than three images
cannot avoid repeats.

### `qr`

How the QR code looks (the colour of its squares and caption, the background, the frosted-glass blur) is not a setting: it is styled in [`custom.css`](#custom-styles-customCss), with the defaults in `public/style.css`. (`qr.color` and `qr.background` were settings in earlier versions; an old `config.jsonc` that still has them gets a warning at start-up and they are ignored.)

The QR code is shown only if `enabled` is true **and** the active plugin provides an upload address. The Immich plugin does (the
shared-link page); the `folder` plugin never does. See [Why the QR code allows uploads](#why-the-qr-code-allows-uploads).

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `true` | Show the QR code at all. |
| `position` | `"bottom-left"` | `"bottom-left"`, `"bottom-right"`, `"top-left"` or `"top-right"`. The box touches the two screen edges of that corner; only the corner facing the middle of the screen is rounded. |
| `text` | `"Scan to upload"` | Caption above the code. `""` = none. Cut off after 60 characters. |

### `clock`

A box with the date and time of the device that shows the page (a TV's own clock, for a TV), in one corner. It does not depend on the server's time zone. Colours, fonts and sizes are **not** settings: they are changed in [`custom.css`](#custom-styles-customCss).

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `true` | Show the clock at all. |
| `position` | `"top-left"` | `"top-left"`, `"top-right"`, `"bottom-left"` or `"bottom-right"`. Like the QR code, the box touches the two screen edges of that corner and only the corner facing the middle of the screen is rounded. If the QR code is in the same corner, the clock sits next to it (above it in a bottom corner, below it in a top corner). |
| `showDate` | `true` | Show the date. |
| `showTime` | `true` | Show the time. With both `showDate` and `showTime` false and the clock enabled, the server stops with a message (set `enabled` to false instead). |
| `dateFormat` | `"full"` | `"full"` (Saturday, November 7, 2026), `"long"` (November 7, 2026), `"medium"` (Nov 7, 2026), `"short"` (11/7/26) or `"iso"` (2026-11-07). Except for `"iso"`, the words and their order follow `locale`. |
| `timeFormat` | `"auto"` | `"auto"` (the usual clock for the locale), `"12h"` (9:05 PM) or `"24h"` (21:05). |
| `showSeconds` | `false` | Include seconds in the time. |
| `locale` | `""` | A language tag such as `"en-US"`, `"de-DE"` or `"fr"`. Empty means the browser's own language. A malformed tag stops the server with a message; a well-formed tag the browser does not know falls back to its default language. |

Default look: white text on a black background at 50% opacity, top-left corner. Limits: the format is chosen from the styles above, not written as a pattern (for example `DD/MM/YYYY`), and the clock shows the device's time zone; neither is configurable.

### `plugins`

A list of photo sources. **Only one is used: the first entry with `"enabled": true`; entries after it are ignored.** (`enabled`
defaults to true.) Several set-ups can be kept in the file and switched by changing which entry is first or enabled. If no entry is
enabled, the server stops with a message. If the chosen plugin fails to start, the server shows the error and retries; it does not
fall through to the next entry.

```jsonc
"plugins": [
  { "id": "immich-sharedAlbum", "enabled": true,  "settings": { "url": "https://photos.example.com", "albumId": "...", "shareKey": "..." } },
  { "id": "folder",             "enabled": false, "settings": { "path": "photos" } }
]
```

`id` is the plugin's folder (or file) name, written exactly (ids are case-sensitive and may contain letters, digits and hyphens):
`<folder>/<id>/index.js` or `<folder>/<id>.js`, where `<folder>` is `builtin-plugins` (shipped with the app) or `plugins` (added by the user). If an id exists in more than one of these places, the server refuses to start rather than guess.

Every plugin always runs in the [file-access sandbox](#the-plugin-sandbox). There is no setting to turn that off, and a `sandbox` line in
an entry stops the server with a message, so nobody can believe a plugin is unsandboxed.

Each entry may also carry `allowedPostHosts`, a list of host names (`["photos.example.com"]`: the name only, with no `https://`, port or path). It is **the user's list of
the only hosts that plugin's `ctx.fetch` may send non-GET requests (POST and the like) to**. The default is none, so a plugin can read but not POST. A plugin cannot add to the list
itself: one that still declares `allowedPostHosts` in its own code gets a warning and the declaration is ignored. `immich-library` needs its Immich host here for `search` mode only
(Immich offers its smart search only as a POST, which still changes nothing). Like the rest of `ctx.fetch`, this is a safety net, not enforcement: see [the plugin sandbox](#the-plugin-sandbox).

#### `immich-sharedAlbum` settings

| Setting | Required | What it does |
|---|---|---|
| `url` | yes | Address of the Immich server, with no trailing slash and no `/api`. |
| `albumId` | yes | The album's id: the last part of its web address in Immich (`.../albums/<id>`). |
| `shareKey` | yes | The key of the album's shared link: the part after `/share/`. |
| `order` | no, default `{ "by": "random", "sort": "desc" }` | How photos are ordered: see [the `order` setting](#order-setting). |

The album is read through the shared link, and the shared-link page is the address the QR code points to. With `order.by` set to a date field and `sort` `"desc"`,
the first photos shown in every round are the newest. The plugin keeps its own
packages (the Immich SDK) in `builtin-plugins/immich-sharedAlbum/node_modules`, installed by `npm run install-plugins`.

#### `immich-library` settings

Photos from an Immich library, read with an **API key** (Account Settings > API Keys in Immich). It has three modes, chosen with `mode`. Unlike a share key, an API key can read
the whole library, so **create it with read-only permissions only**: `asset.read`, `album.read`, `memory.read` and `timeline.read` (and `person.read` if `personIds` is used). The
plugin never changes anything in Immich. The key is sent in a request header, never in an address. (These permission names come from the Immich SDK this plugin uses; if Immich
reports "forbidden" for a mode, add the permission it names.) This plugin gives no upload address, so there is no QR code with it.

| Setting | Required | What it does |
|---|---|---|
| `url` | yes | Address of the Immich server, with no trailing slash and no `/api`. |
| `apiKey` | yes | The API key. Keep `config.jsonc` private. |
| `mode` | yes | `"album"`, `"memory"` or `"search"` (below). |
| `maxImages` | no, `0` | Most photos to use (0-100000). `0` means all, except in `search` mode, where it means 200. Extra photos are dropped at random, or from the end when `order` is set. |
| `order` | no, `{ "by": "random", "sort": "desc" }` | How photos are ordered: see [the `order` setting](#order-setting). **`search` mode ignores `order`** (with a warning if it is set): photos stay in Immich's own ranking, best match first, as in its search box. Memory results carry their EXIF details, so any field works at no extra cost. For albums, the timeline fields (`dateTimeOriginal`, `city`, `country`, `latitude`, `longitude`) are free and any other field costs one request per photo (spread over a few refreshes). |
| `albumIds` | `album` mode | List of album ids (the last part of an album's web address in Immich). Used instead of `albumNames` when both are set (with a warning). |
| `albumNames` | `album` mode | List of album names, spelled exactly (capitals count). Albums the user owns and albums shared with the user are both found. A name that matches nothing stops the start with a message. |
| `daysBefore` | no, `7` | `memory` mode: how many days back from today to include (0-15). |
| `query` | `search` mode | What to look for, in words: `"dogs"`, `"mountain sunset"`, `"birthday cake"`. |
| `personIds` | no, none | `search` mode: only photos of these people (list of person ids). |
| `isFavorite` | no, `false` | `search` mode: only photos marked as favourites. |
| `city`, `country` | no, none | `search` mode: only photos taken in this city or country. |

Settings that belong to another mode are ignored with a warning.

- **`album`**: every photo in the listed albums, without duplicates. Videos are skipped.
- **`memory`**: Immich's "on this day" memories, which are photos taken on a date in earlier years. The plugin asks Immich for each day from `daysBefore` days ago up to **2 days
  ahead of today** (one request per day), so `daysBefore: 7` shows photos from the same date in earlier years for the last week, today and the next two days. **The 2 days ahead are fixed: Immich
  keeps its memories only about two days ahead, so asking for more finds nothing.** For the same reason the number of days back is limited to 15. A day with no photos from earlier years has no
  memory, so a gap in the dates is normal.
- **`search`**: Immich's smart search, which finds photos by meaning (it needs Immich's machine-learning feature switched on). Results stay in Immich's order of relevance, best match first (`order` is ignored); the wall follows that order loosely, round after round.
  **It sends a POST request to Immich (`/search/smart` only), so the Immich host must be listed in `allowedPostHosts` on the plugin's entry in `config.jsonc`.** Without it, the plugin stops at start-up and says so.

**Immich is asked once a day.** The plugin keeps its list and asks Immich again only on the first request after the date changes (or after a restart); the page's `refreshSeconds` does not make it ask more often. A photo added to Immich therefore appears
the next day or after a restart. If a refresh fails, the old list stays in use and Immich is left alone for 10 minutes. The date is the one in the plugin's time zone, which in Docker is UTC unless the host's `/etc/localtime` is mounted. The photos themselves are downloaded when they are first shown and cached
for a day by the app. The plugin keeps its own packages (the Immich SDK) in `builtin-plugins/immich-library/node_modules`, installed by `npm run install-plugins`.

Example (search mode):

```jsonc
{
  "id": "immich-library",
  "enabled": true,
  "allowedPostHosts": ["photos.example.com"],
  "settings": { "url": "https://photos.example.com", "apiKey": "your-api-key", "mode": "search", "query": "dogs", "maxImages": 300 }
}
```

#### `folder` settings

| Setting | Default | What it does |
|---|---|---|
| `path` | `"photos"` | The folder of photos, **relative to the plugin's own folder**: `"photos"` means `builtin-plugins/folder/photos`. Absolute paths and `..` are refused, and it must not be a symbolic link, because the sandboxed plugin can read only its own folder. |
| `recursive` | `true` | Also include photos in sub-folders. |
| `title` | folder name | Window title. |
| `order` | `{ "by": "DateTimeOriginal", "sort": "desc" }` | How photos are ordered: see [the `order` setting](#order-setting). The default is newest first by the date taken. |
| `minAgeSeconds` | `10` | Ignore files changed more recently than this, so a photo that is still being copied in is not read half-finished (0-3600). |

How it works:
- **Order.** By default photos are shown **newest first** by the date they were **taken**: the EXIF `DateTimeOriginal` (or `CreateDate`) in
  the file. A file without one is placed by its **file modified time**, and ties (files copied together share one time) by their path.
  The `order` setting changes this, including the direction (see [the `order` setting](#order-setting)). Photos exported or edited by some tools have their EXIF data
  removed, and a copy that did not keep the original modified time sorts by when it was copied; `cp -p`, `rsync -t` and most file managers keep
  the original time. A file time in the future is accepted, not mistaken for a file still being copied.
- **There is no upload feature.** Photos are added by any outside means (copying files, a network share, a sync tool). The folder is
  re-read on every refresh (`display.refreshSeconds`), so new files appear within about a minute, and removed files disappear.
- **Symbolic links are never followed, under any circumstance.** Links to files and links to folders inside the photo folder are skipped
  (and logged once), and the configured folder itself must not be a link. Each file is checked again just before it is read, and opened
  with `O_NOFOLLOW` when served, where the operating system supports that flag. One limit: links in the *parent* parts of the configured
  path (for example `/var` pointing to `/private/var` on a Mac) are resolved by the operating system itself and cannot be avoided.
- The plugin hands the app the original file; the app resizes and caches it (see [Images](#images)). The plugin cannot write files, so it
  keeps no cache of its own, and it learns each photo's shape from the file header with the pure-JavaScript `image-size` package, because
  native modules such as `sharp` cannot load in the sandbox.
- Photos have to be **copied into** `builtin-plugins/folder/photos`. A symbolic link to a folder elsewhere does not work, by design.
  The contents of that folder are not committed to git (`.gitignore`).
- Files starting with `.`, other file types (HEIC, GIF, videos...), and files that are not readable images are skipped and logged once.
- A photo keeps its identity across restarts, as long as the file is unchanged.


## Images

The app, not the plugin, handles every image, in one place and with `sharp` (`lib/images.js`). A plugin's `getImage()` answers with either
the image's bytes or a web address for the app to download (see [Writing a plugin](#writing-a-plugin)). Then the app:

1. downloads the address if there is one (http or https only, 15 seconds by default, at most 50 MB, no cookies; error messages never show
   the address's query string);
2. checks the first bytes: only **JPEG, PNG and WebP** are accepted. SVG and everything else is refused before any decoder runs;
3. resizes to fit 1440 pixels on the longest side (1080 unless `display.hardware` is `"high-power"`) and bakes in the EXIF rotation. An image that
   is already small enough and upright is passed through untouched, with no quality loss; anything else is re-encoded as JPEG (quality 85);
4. keeps the result in `.cache/images/`. Each image is fetched and resized once, not once per viewer, and viewers asking for the same
   image at the same moment share one fetch. A cached image is reused for a day and then fetched again.

The cache is never pruned. Deleting `.cache/images` at any time reclaims the space; the images are simply fetched again. Images over
100 million pixels are refused.

## Security notes

- **No login.** Anyone who can reach the server's address can view the wall and its photos. The server itself never accepts uploads
  and never changes anything. It should stay on a private network, or sit behind something that adds a login.
- **The shared link is not completely hidden.** The browser never sees the Immich address or key, but the QR code encodes the
  shared-link address, so anyone who can scan the screen can open that link. That is the purpose of the QR code. It can be turned off
  (`qr.enabled`) when the link should stay private.
- **HTTPS belongs in front of it.** The server speaks plain HTTP. Anything beyond a private network should go through a reverse proxy
  that adds HTTPS (for example Caddy or nginx), with `server.host` set to `"127.0.0.1"` so only the proxy can reach the server.
- **No cross-origin access.** The server sends no CORS headers, so other web sites cannot read its responses from a visitor's browser.
- **No upload token.** Uploads happen on the photo service, not on this server, and the target is private servers. The shared link is
  the only secret involved. See the next section.
- **Third-party plugins are fully trusted code.** See [Third-party plugins](#third-party-plugins-read-this-first).

### Why the QR code allows uploads

The QR code exists on purpose. At a party or event, guests scan it, land on the Immich shared-link page, and add their own photos to
the album. Within about a minute (`display.refreshSeconds`) those photos appear on the wall, which turns it into a living wall of the
event's photos.

The downside is built in. Anyone who has the link can upload, and nothing is approved before it is shown. A bad actor, or an
unlucky mistake, can put an inappropriate photo on the screen until it is deleted in Immich (it leaves the wall on the next
refresh). Options for hosts who want less risk: switch the QR code off and add photos only through trusted routes, create the shared
link without upload permission, or keep an eye on the album during the event. This server does not moderate anything.

## Third-party plugins: read this first

**A plugin is code that runs on the server. Plugins should only be installed from people who are trusted, and read first.**

### The plugin sandbox

Plugins in `builtin-plugins/` and `plugins/` always run in a separate Node process started with Node's permission system. That process:

- **can** read its own plugin folder (its code and its own `node_modules`), and use the network freely;
- **cannot** read any other file (so not `config.jsonc` with its keys, not the app's `node_modules`, not the photos folder), cannot write files,
  cannot run programs, cannot start worker threads or load native addons, and starts with an empty environment;
- talks to the server only through messages (the plugin contract), and is stopped if a call takes longer than `server.pluginTimeoutSeconds`.
  A plugin process that crashes or hangs is restarted from scratch.

Because the plugin cannot see the app's packages, **a plugin has to bring its own packages**, installed inside its own folder.

What the sandbox does **not** do:

- **It does not restrict the network.** A plugin can contact any address, including other devices on the local network, and can send out
  everything it can see: its own settings (including its token) and the images it fetches.
- **It does not enforce read-only access.** The `ctx.fetch` given to a plugin blocks anything but GET unless the user listed the host in
  the plugin entry's `allowedPostHosts` in `config.jsonc`, but that is a safety net against accidents, not a rule: a plugin can use Node's `http` module, another library, or the
  global `fetch` and send POST, PUT or DELETE requests anywhere.
- **It is not a hardened sandbox.** Node describes its permission system as a safety net for code that is mostly trusted, not as protection
  against code written to escape it. Anything that must be isolated from a hostile plugin should also run in a container or under a
  separate operating-system user.
- **The app decodes the images a plugin supplies.** `sharp` (libvips) runs inside the server, not in the sandbox. Only JPEG, PNG and WebP
  are decoded, with a pixel limit, but a flaw in an image library could in principle be reached by a hostile plugin sending a crafted
  image. This is another reason to install only plugins that are trusted.
- **A `{ url }` answer makes the server download from that address**, so a hostile plugin could point it at other devices on the local
  network. The sandbox gives a plugin full network access anyway, so this adds little, but it is how the request would come from the server.

Other rules:
- Installing a plugin means putting its folder in `plugins/` (`builtin-plugins/` is for the plugins shipped with the app) (or unzipping it there manually), and then running `npm run install-plugins`.
  Nothing is downloaded or unzipped automatically. With the Docker image, the packages are installed inside the container (see "Adding a plugin" under "Run with Docker").
- A plugin's `apiVersion` must match what this server supports. A mismatch is refused with a message.

## Develop

```
git clone <this repository>
cd <repository>
npm install
npm run install-plugins                  # packages for the plugins in builtin-plugins/ and plugins/
cp config/config.example.jsonc config/config.jsonc     # then fill in a plugin
npm run dev                              # restarts the server when server.js changes
npm test                                 # unit tests
npm run check                            # starts the active plugin and tests it against the plugin contract
```

Files in `public/` are served as they are (there is no build step), so a browser reload picks up changes.

| Path | Role |
|---|---|
| `server.js` | Start-up and HTTP routes. Knows nothing about any particular photo service. |
| `lib/config.js` | Reads and validates `config.jsonc`; picks the active plugin entry. |
| `lib/settings.js` | Validates settings (app and plugin) against a list of typed specs. |
| `lib/plugins.js` | Finds and loads plugins, checks `apiVersion` and the contract, starts them, adds timeouts and caching. |
| `lib/guardedFetch.js` | The read-only `fetch` given to plugins. |
| `lib/logger.js` | The logger; plugins get one prefixed with their name. |
| `lib/sandbox.js`, `lib/sandboxChild.js` | Start a plugin in a restricted Node process and call it through messages. |
| `lib/images.js` | The image service: download, check, resize and cache. |
| `builtin-plugins/` | The plugins shipped with the app (`folder/`, `immich-sharedAlbum/`, `immich-library/`), each with its own `package.json` and `node_modules`. |
| `plugins/` | Plugins added by the user (empty in the repository), laid out the same way. Always sandboxed. |
| `scripts/pluginTool.js` | `npm run check` and `npm run setup`. |
| `scripts/installPlugins.js` | `npm run install-plugins`. |
| `public/` | The page: `app.js` (rows, photos, animations), `layout.js` (layout maths, unit tested), `sequence.js` (choosing photos in order, unit tested), `style.css`. |

Every file starts with a header comment and every function is documented, which makes those the best place to start reading.

The server's HTTP routes (all GET): `/api/config`, `/api/images`, `/api/image/:id`, `/api/qr.svg`, and static files from `public/`.

## Writing a plugin

A plugin is an ES module whose default export is an object. 

>[!Tip]
> To help users find plugins easier, name the plugin starting with APF (e.g. APF-Dropbox-Photos).

The usual layout is a folder:

```
plugins/APF-my-photos/
  index.js          the plugin
  package.json      { "type": "module", "dependencies": { ... } }
  node_modules/     created by `npm install` in this folder (or `npm run install-plugins`)
```

A plugin with no dependencies can also be a single file, `plugins/AFP-my-photos.js`. Then `{ "id": "AFP-my-photos", "settings": { ... } }` is added
to `plugins` in `config.jsonc`. Because the plugin runs in the [sandbox](#the-plugin-sandbox), it can use Node's built-in modules and the packages in
its own `node_modules`, but nothing from the app. Its `ctx.log` lines appear in the server log prefixed with its `name`, and it can read
only its own folder. Packages that make their own HTTP calls work as they are; packages with native parts (compiled addons) do not work at all.
The contract (`apiVersion: 1`):

```js
export default {
  apiVersion: 1,                      // required. The server refuses versions it does not know.
  name: 'My Photos',                  // required. Prefixes every log line from this plugin.
  settings: [                         // required (use [] for none). What config.jsonc may contain for the plugin.
    { key: 'token', type: 'string', required: true, secret: true, description: 'API token' },
    { key: 'count', type: 'number', default: 50, min: 1, max: 500, description: 'How many photos' }
  ],                                  // types: string, number, boolean, path, enum (values: [...]), color, list (a list of
                                      // text values) and object (a group: { key: 'order', type: 'object', fields: [ ...settings... ] },
                                      // each field with its own default)

  async init(settings, ctx) {},       // optional. Runs at every start. Connect, check the key, and THROW if not ready:
                                      // the server logs it, shows "Starting..." and retries every startupRetrySeconds.
  async setup(ctx) {},                // optional. Run by hand with `npm run setup`; see below.

  async getImages() {                 // required. Lists the available images (not videos). ratio = width / height as DISPLAYED
    return {                          // (after any rotation). Ids are unique text chosen by the plugin.
      title: 'My album',
      images: [{ id: 'any-unique-text', ratio: 1.5 }],   // optional per image: date (ISO text whose first ten characters are
                                      // the day it was taken), city, state, country: used by display.caption, skipped if absent
      order: 'sequence'               // optional. 'sequence' = show them in the order listed, round after round, every image
    };                                // once before any repeats. 'random' (the default) = at random, longest-ago first.
                                      // (A plugin may offer its own `order` setting, as the built-in ones do, to choose this.)
  },
  async getImage(id, { maxPixels }) { // required. Says where ONE image from the list is. Either the bytes:
    return { body: Buffer.from(/* ... */) };
    // or a web address for the app to download, with optional request headers (an API key, say):
    // return { url: 'https://photos.example.com/img/' + id, headers: { 'x-api-key': settings.token } };
  },                                  // The app checks, resizes (to about maxPixels) and caches the result.
  getUploadUrl() {                    // optional (may be async). The address of the service's OWN upload page; the QR code
    return null;                      // points there. Read once, right after init succeeds. Omitted, or null: no QR code.
  }
};
```

`ctx` is `{ fetch, log, pluginDir, prompt }`. `ctx.fetch` is a GET-only fetch to use for requests (advice, not enforcement: see the sandbox
section). A plugin that must POST (a search API, say) cannot allow that itself: the user adds the service's host to `allowedPostHosts` on the plugin's entry in `config.jsonc`,
and the README of such a plugin should say so, `ctx.log.info/warn/debug/error(...)` writes messages prefixed with the plugin's `name`, `pluginDir` is the plugin's own folder (the
one place it can read), and `prompt` is for the setup step. `settings` arrive already validated, typed and
defaulted, so a plugin should not read the config file or the environment itself. The server enforces these rules:

- Every call has a time limit (`server.pluginTimeoutSeconds`); a call that hangs counts as failed.
- `getImage()` answers `{ body }` (JPEG, PNG or WebP bytes, at most 50 MB) or `{ url, headers? }` (an http or https address). Where a service documents it, a key is better sent in
  `headers` than in the address, which can end up in a proxy's access log. The app never logs or shows an address's query string, so a
  key in the query (as Immich's documented `key` parameter does) stays out of the app's own logs. Plugins need no image library: the app does
  the resizing, so `maxPixels` is only a hint that lets a service send a smaller picture.
- Image ids are opaque text chosen by the plugin (at least one character, unique). Keys and tokens do not belong in them.
- The server only asks for images whose ids appeared in the last `getImages()` result.
- Entries with a bad `id` or `ratio`, and duplicate ids, are dropped with a warning. An `order` other than `'sequence'` or `'random'` is ignored with a warning.
- If `getImages()` fails after a good result, the previous list keeps being shown.
- Changes that only add optional things do not need a new `apiVersion`. Breaking changes do, and older versions keep working through
  an adapter in `lib/plugins.js`.

### `npm run check`

Tests the active plugin against the contract without starting the wall: starts it with the settings from `config.jsonc`, then calls
`init`, `getImages`, `getImage` on the first image and `getUploadUrl`, and reports what is wrong. Intended for plugin authors while
writing a plugin, and for anyone checking that new settings work.

### `npm run setup`

Runs the active plugin's optional `setup(ctx)` function, then exits. It is meant for one-off, interactive preparation that does not
belong in `init`, which must run unattended at every start. Typical uses: asking for a username and password and exchanging them for
a long-lived token, listing the albums an account has so one can be chosen, or testing an API key and printing the values to paste
into `config.jsonc`. In `setup`, `ctx` also has `ctx.prompt('question')`, which asks on the terminal and returns the typed answer.
Nothing is written to `config.jsonc` automatically; the plugin prints what to paste. A plugin without `setup` just prints a message.
The two plugins that ship with this app have no setup step, because they only need values that are already in the settings.

## Troubleshooting

- **"failed to load ... Cannot find package"**: the plugin's packages are not installed. `npm run install-plugins` (or `npm install` inside the
  plugin's folder) fixes it. In Docker, run `docker exec -it <container> sh -c "cd /app/plugins/<plugin-folder> && npm install --omit=dev --ignore-scripts"` and restart the
  container. A sandboxed plugin cannot use the app's own packages.
- **"this version of Node cannot sandbox plugins"**: the Node version lacks the permission flags. A newer Node is needed (26 is tested).
- **A photo is missing and the log says it is "not a readable image" or "not a JPEG, PNG or WebP"**: only those three types are shown.
  Other types (HEIC, GIF, SVG, video) are skipped.
- **The page says "Starting..."**: the plugin has not started yet. The log shows `could not start: ...` lines (`logLevel` `"debug"`
  adds detail). For `folder`, the folder may be missing, not mounted yet, or a symbolic link. For `immich-sharedAlbum`, `url`,
  `albumId` and `shareKey` need checking.
- **"Cannot start: ..." and the server exits**: a configuration mistake. The message names the setting or the line.
- **Port already in use**: another copy is running. It has to be stopped, or `server.port` changed.
- **No QR code**: the active plugin has no upload address (`folder` never has one), or `qr.enabled` is false.
- **A photo in the folder does not show**: it may be too new (`minAgeSeconds`), hidden, a symbolic link, an unsupported type, or
  unreadable. The log says which.

## AI Use

This project was built with an AI coding assistant. Most of the code, the automated tests and the documentation (including this README) were
written by **Claude**, a large language model from [Anthropic](https://www.anthropic.com), mainly Claude Sonnet 5.5, working through
[Claude Code](https://claude.com/claude-code) under the direction of the project owner.

The owner set the goals, made the design, security and licensing decisions, reviewed the results, and ran the software against a real
Immich server. The assistant produced the implementation, wrote the tests that accompany it, and proposed and compared options for the
owner to decide. The conventions it followed are written down in [`AGENTS.md`](AGENTS.md) (loaded by Claude Code through `CLAUDE.md`), so
other AI assistants and contributors can follow the same rules; [`.claude/HANDOFF.md`](.claude/HANDOFF.md) records the current status and
what has and has not been verified.

As with any software, and especially a program that can run third-party plugins, the code is open for inspection and is best read
before it is trusted with anything sensitive. Problems found in AI-written parts are treated like any other bug.

## License

Adaptive Photo Frame is free software, licensed under the **GNU Affero General Public License, version 3 or (at the user's option) any later
version** (`AGPL-3.0-or-later`). The full text is in [`LICENSE`](LICENSE). In plain terms (this summary is not the license):

- **Anyone may use, study, modify and share it**, including for commercial purposes, for example to run a photo wall at a business.
- **Using it unmodified, or modifying it for one's own use, asks nothing further.** That covers a home display, a family album and a wall
  at one's own event.
- **Sharing a copy, modified or not,** means passing on the same license and the source code, and marking any changes.
- **Running a modified version for other people over a network** (for example, as a hosted service) means offering those users the complete
  source of the modified version. This network clause is what separates the AGPL from the ordinary GPL.
- **It cannot be re-licensed under terms that take these rights away**, so a closed-source product built on this code is not permitted.


**Plugins.** Plugins run as separate programs and talk to the app only through the documented plugin contract. The two that ship in this
repository (`builtin-plugins/folder`, `builtin-plugins/immich-sharedAlbum`, `builtin-plugins/immich-library`) are covered by the same license. A plugin written by someone else is that
author's work and carries the license its author chooses.

**Dependencies.** The app depends on `sharp` (Apache-2.0, with its LGPL-3.0-or-later image library), `jsonc-parser`, `qrcode`, `image-size`
and `exifr` (all MIT), and the Immich plugin on `@immich/sdk` (AGPL-3.0). All are compatible with the AGPL. These packages are installed
by `npm`, not included in this repository, and keep their own licenses.

## Trademarks

iPad and Apple Silicon are trademarks of Apple Inc. This project is independent. It is not affiliated with, authorized, sponsored or endorsed by Apple Inc., and the mention of the photo frame on the first iPad only says where the idea came from. Other product and company names in this documentation, such as Immich, Docker, Raspberry Pi, Android, Chrome and Fully Kiosk Browser, belong to their owners and are used only to say what the project works with; their use does not imply any endorsement.
