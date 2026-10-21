# kodakool-server — collaboration server (REST + Yjs rooms + node:sqlite)
FROM node:22-slim

# pnpm comes from the root package.json's packageManager field
RUN corepack enable

WORKDIR /app

# workspace manifests first: dependency install caches well
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY server/package.json server/
RUN pnpm install --filter kodakool-server --prod --frozen-lockfile

COPY server/ server/

# node:sqlite + type stripping flags live in the start script itself
EXPOSE 8787
CMD ["pnpm", "--dir", "server", "start"]
