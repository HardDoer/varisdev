FROM node:lts AS build
WORKDIR /opt/varisdev

COPY package.json package-lock.json ./
COPY desktop/package.json desktop/package-lock.json ./desktop/
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm ci --prefix desktop --ignore-scripts --legacy-peer-deps --no-audit --no-fund

COPY . .
RUN npm run typecheck \
    && npm run desktop:build \
    && node --test test/web-install.test.ts test/release-web.test.ts test/production-build.test.ts \
    && npm run release:web -- /release

FROM alpine:3.24.2 AS release
COPY --from=build /release /release
