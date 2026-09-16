# Deploying the Nugenova API with Docker — `prod-api.nugenova.com`

The API now runs as a **Docker container** on the E2E Networks box
(`164.52.202.240`). Postgres is managed (Supabase) → **no database container**.
Public HTTPS is still terminated by **host nginx + Let's Encrypt (certbot)**,
which proxies to the container on `127.0.0.1:4100`.

```
DNS A record prod-api.nugenova.com → 164.52.202.240
        │
   nginx :443  ──proxy──▶  127.0.0.1:4100  (docker container "nugenova-api")
                                   │
                            Supabase Postgres (external, via DATABASE_URL)
```

Auto-deploy: push/merge to `main` → **CI** (`ci.yml`) runs (typecheck, npm audit,
unit, e2e) → on green, **Deploy** (`deploy.yml`) SSHes in and runs
`git reset --hard origin/main && docker compose build && docker compose run --rm
api npm run migration:run && docker compose up -d`.

Repo files that support this: `Dockerfile`, `.dockerignore`, `docker-compose.yml`,
`deploy/nginx/prod-api.nugenova.com.conf`, `deploy/env.production.example`.

---

## 0. DNS (do this first)

Point an **A record** for `prod-api.nugenova.com` → `164.52.202.240`, then:

```bash
dig +short prod-api.nugenova.com   # should print 164.52.202.240
```

## 1. One-time server setup (the box was wiped — start clean)

SSH into the box, then:

### 1a. Docker Engine + compose plugin

```bash
# Official convenience script (Ubuntu/Debian):
curl -fsSL https://get.docker.com | sudo sh
sudo docker --version && sudo docker compose version   # both should print
# (optional) run docker as your login user without sudo:
sudo usermod -aG docker "$USER" && newgrp docker
```

### 1b. nginx + certbot (host, for TLS)

```bash
sudo apt-get update && sudo apt-get install -y nginx certbot python3-certbot-nginx
```

### 1c. A read-only GitHub deploy key (so the box can `git pull`)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/nugenova_deploy -N "" -C "prod-api deploy key"
cat ~/.ssh/nugenova_deploy.pub
# → add this PUBLIC key to the nugenova-backend repo:
#   GitHub → repo → Settings → Deploy keys → Add deploy key (read-only, no write).
cat >> ~/.ssh/config <<'EOF'
Host github.com-nugenova
  HostName github.com
  User git
  IdentityFile ~/.ssh/nugenova_deploy
  IdentitiesOnly yes
EOF
```

### 1d. Clone the repo

```bash
git clone git@github.com-nugenova:cto-varun/nugenova-backend.git ~/nugenova-api
cd ~/nugenova-api
git checkout main
```

### 1e. Production `.env` (you place this — CI never sees secrets)

```bash
cp deploy/env.production.example .env
nano .env   # fill DATABASE_URL (Supabase session pooler), JWT_SECRET, PORT=4100, etc.
chmod 600 .env
```

> The container reads this file via `env_file: .env` in `docker-compose.yml`.
> Keep `PORT=4100` so it matches the nginx proxy target.

### 1f. First build + migrate + start

```bash
cd ~/nugenova-api
docker compose build
docker compose run --rm api npm run migration:run     # apply the schema
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:4100/api/v1/health          # expect a 200/JSON
```

### 1g. nginx site + HTTPS

```bash
sudo cp deploy/nginx/prod-api.nugenova.com.conf \
  /etc/nginx/sites-available/prod-api.nugenova.com
sudo ln -sf /etc/nginx/sites-available/prod-api.nugenova.com \
  /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# Issue + auto-renew the cert (adds the :443 block + HTTP→HTTPS redirect):
sudo certbot --nginx -d prod-api.nugenova.com
```

### 1h. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # 80 + 443
sudo ufw enable
```

Verify from your laptop: `curl -fsS https://prod-api.nugenova.com/api/v1/health`.

## 2. Wire up auto-deploy (GitHub Actions → SSH)

The deploy job **skips cleanly** until the secrets exist, so nothing breaks
before you configure it. Create a key CI uses to log in as your deploy user:

```bash
# on the box (or anywhere):
ssh-keygen -t ed25519 -f ~/.ssh/ci_deploy -N "" -C "github-actions deploy"
# authorize it for SSH login:
cat ~/.ssh/ci_deploy.pub >> ~/.ssh/authorized_keys
# copy the PRIVATE key for the GitHub secret:
cat ~/.ssh/ci_deploy
```

In **GitHub → nugenova-backend → Settings → Secrets and variables → Actions**,
add repository secrets:

| Secret            | Value                                             |
| ----------------- | ------------------------------------------------- |
| `DEPLOY_HOST`     | `164.52.202.240`                                  |
| `DEPLOY_USER`     | your ssh login user on the box (e.g. `root`)      |
| `DEPLOY_SSH_KEY`  | the **private** `ci_deploy` key (full contents)   |
| `DEPLOY_PORT`     | `22`                                              |
| `DEPLOY_PATH`     | `/root/nugenova-api` (or `$HOME/nugenova-api`)    |

Now every green push to `main` deploys automatically. You can also trigger it
manually: **Actions → Deploy → Run workflow**.

## 3. Day-to-day

```bash
cd ~/nugenova-api
docker compose ps                       # status + health
docker compose logs -f --tail=100 api   # live logs
docker compose restart api              # restart
docker compose up -d --build            # manual redeploy from local checkout
git log -1 --oneline                    # what's currently deployed
```

**Rollback:** `git reset --hard <good-sha> && docker compose up -d --build`
(re-run migrations only if the rollback changes the schema).

## 4. Notes & gotchas

- **Migrations also run on every container start.** The image's entrypoint
  (`docker-entrypoint.sh`) applies pending migrations before the API process starts and
  **refuses to start** if they fail (exit 1), so the schema can never lag the code — even
  on a manual `docker compose up -d --build` that skips the deploy job. It retries a few
  times (`MIGRATION_RETRIES`, default 5) for a database that is still waking up, and
  `RUN_MIGRATIONS=false` skips it for a one-off container. With nothing pending it costs
  a couple of seconds; the compose health check allows 90s at start for this.
- **`DB_SSL=false`** (or `?sslmode=disable` in the URL) turns off TLS for a self-hosted /
  containerised Postgres; Supabase and any other remote database keep SSL by default.
- **Migrations run as a one-off container before the swap** — a failed migration
  fails the deploy and the currently-running container keeps serving.
- **The image carries `ts-node` + `src/`** on purpose: the TypeORM CLI runs the
  `.ts` migrations (`typeorm-ts-node-commonjs -d src/bootstrap/database/data-source.ts`).
- **bcrypt** is a native addon → the image builds it with `python3 make g++` in a
  builder stage; both stages use `node:20-bookworm-slim` (glibc) so the compiled
  addon is ABI-compatible.
- **Only loopback is published** (`127.0.0.1:4100`), so the container is never
  directly exposed — nginx is the sole public door.
- Postgres is Supabase; there is nothing to back up on the box except `.env`.
