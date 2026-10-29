FROM node:lts AS build
WORKDIR /opt/varisdev

COPY package.json package-lock.json ./
COPY desktop/package.json desktop/package-lock.json ./desktop/
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm ci --prefix desktop --ignore-scripts --legacy-peer-deps --no-audit --no-fund

COPY . .
RUN timeout --kill-after=5s 120s npm run typecheck \
    && timeout --kill-after=5s 120s npm run desktop:build \
    && npm run test:installer \
    && npm run release:web -- /release

FROM alpine:3.24.2 AS release
COPY --from=build /release /release
