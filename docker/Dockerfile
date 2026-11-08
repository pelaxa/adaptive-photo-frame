# syntax=docker/dockerfile:1
#
# Adaptive Photo Frame - container image. Build from the project root:  docker build -f docker/Dockerfile .
# (`npm run docker:build` does that and stamps the version and revision.)
#
# The base is the official Node image on Alpine Linux (small, so far fewer packages to patch), with a shell (sh) and npm: users can open a shell in the container (`docker exec -it <name> sh`) to add
# plugins to the mapped plugins folder and run `npm install --ignore-scripts` inside them. The app itself runs as the unprivileged
# user "node" (uid 1000), never as root, and the program files stay owned by root (read-only to the app).
#
# Folders (see the README): /app/builtin-plugins ships with the image (folder, immich-sharedAlbum, packages already installed);
# /app/plugins (user plugins) and /app/config (settings) are meant to be mapped to the host; /app/.cache holds resized images.
#
# The base image is a build argument so it can be pinned by digest or swapped:
#   docker build -f docker/Dockerfile --build-arg BASE_IMAGE=node:26-alpine@sha256:... .

ARG BASE_IMAGE=node:26-alpine
FROM ${BASE_IMAGE}

ARG APF_VERSION=dev
ARG APF_REVISION=unknown
ARG APF_CREATED=unknown
ARG APF_SOURCE=
# The version, revision, creation time and repository address are passed in by `npm run docker:build` and by the CI workflow.
LABEL org.opencontainers.image.title="Adaptive Photo Frame" \
      org.opencontainers.image.description="A photo wall for an Immich shared album or a folder of photos" \
      org.opencontainers.image.vendor="Pelaxa" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${APF_VERSION}" \
      org.opencontainers.image.revision="${APF_REVISION}" \
      org.opencontainers.image.created="${APF_CREATED}" \
      org.opencontainers.image.source="${APF_SOURCE}" \
      org.opencontainers.image.url="${APF_SOURCE}"

WORKDIR /app
ENV NODE_ENV=production \
    APF_CONFIG=/app/config/config.jsonc

# Pick up Alpine security fixes published since the base image was built (build time only; --no-cache keeps no package index in the image).
RUN apk upgrade --no-cache

# The npm that comes with the base image can lag behind and bundle packages with known vulnerabilities, so update it (as root, before USER).
# NPM_VERSION can pin a version for a reproducible build.
ARG NPM_VERSION=latest
RUN npm install -g npm@${NPM_VERSION} && npm cache clean --force

# App packages first (cached until package.json changes). The lock file is used when present; commit it for reproducible builds.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Each built-in plugin brings its own packages (it is sandboxed and cannot see the app's), installed now so the image is complete.
COPY builtin-plugins ./builtin-plugins
COPY scripts/installPlugins.js ./scripts/installPlugins.js
COPY lib ./lib
RUN node scripts/installPlugins.js

COPY LICENSE README.md server.js ./
COPY public ./public
COPY scripts ./scripts
COPY docker ./docker

# The commented examples (settings and styles) are kept here, outside /app/config (a mapped folder hides whatever the image has there). On first run the
# entrypoint copies them into the config folder.
COPY config/config.example.jsonc config/custom.example.css ./defaults/

# Writable places, owned by the unprivileged user: the (mapped) config and plugins folders and the image cache. Everything else is root's.
# builtin-plugins/folder/photos is the mount point for the user's photos (kept empty here, read-only when mounted).
RUN mkdir -p config plugins .cache builtin-plugins/folder/photos && chown node:node config plugins .cache

# Never root, by number (so orchestrators such as Kubernetes can verify it).
USER 1000:1000

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=6s --start-period=45s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.js"]

# Logs go to the console (stdout / stderr) only: nothing is written to a log file. See `docker logs`.
ENTRYPOINT ["node", "docker/dockerEntrypoint.js"]
