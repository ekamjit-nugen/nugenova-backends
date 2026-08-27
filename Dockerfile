# syntax=docker/dockerfile:1

# ── builder: compile native deps (bcrypt) + build the TypeScript ─────────────
# bookworm-slim (glibc) is used for BOTH stages so the compiled bcrypt addon is
# ABI-compatible in the runtime image. (Alpine/musl would need a separate build.)
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# bcrypt builds a native addon → needs python3 + a C/C++ toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── runtime: no build toolchain, just Node + the app ─────────────────────────
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Copy the fully-installed deps (includes the compiled bcrypt addon AND ts-node,
# which the TypeORM CLI needs to run the .ts migrations at deploy time), the
# build output, and the source (the migrations + data-source live in src/).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Drop privileges — run as the image's built-in unprivileged user.
USER node

# Documentation only; the real port comes from PORT in the .env (compose maps it).
EXPOSE 4000

CMD ["node", "dist/main"]
