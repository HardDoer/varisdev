FROM node:24-bookworm AS build
WORKDIR /opt/varisdev

# Release packaging does not need to download or launch Electron.
COPY package.json package-lock.json ./
COPY desktop/package.json desktop/package-lock.json ./desktop/
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm ci --prefix desktop --ignore-scripts --legacy-peer-deps --no-audit --no-fund

COPY . .
RUN npm run typecheck \
    && npm run desktop:build \
    && node --test test/web-install.test.ts test/release-web.test.ts \
    && npm run release:web -- /release

# The deployment job copies this release from the selected registry image.
FROM alpine:3.22 AS release
COPY --from=build /release /release
