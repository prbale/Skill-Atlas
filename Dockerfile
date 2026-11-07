# ---------------------------------------------------------------
#  Skill Atlas 1.2.0 — Docker image  (image name: skill-atlas:1.2.0)
#  Build:  docker build -t skill-atlas:1.2.0 .
#  Production: use docker-compose.yml (Caddy + TLS). Local trial: docker-compose.dev.yml
#
#  Supply-chain tip: pin the base image by digest for repeatable builds:
#    docker pull node:22-alpine && docker inspect --format '{{index .RepoDigests 0}}' node:22-alpine
#    docker build --build-arg NODE_IMAGE=node:22-alpine@sha256:<digest> -t skill-atlas:1.2.0 .
# ---------------------------------------------------------------
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS dependencies
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Skill Atlas" \
      org.opencontainers.image.description="Mind-map web app for tracking the skills you are learning" \
      org.opencontainers.image.version="1.2.0"

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    UV_THREADPOOL_SIZE=8

WORKDIR /app
RUN apk add --no-cache libstdc++ && apk upgrade --no-cache
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json server.js database.js security.js ./
COPY scripts ./scripts
COPY public ./public

# Code is owned by root and read-only for the app user; only /data is writable.
RUN mkdir -p /data && chown node:node /data && chmod -R a-w /app
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server.js"]
