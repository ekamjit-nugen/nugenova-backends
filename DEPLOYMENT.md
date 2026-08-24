# Deploying the Nugenova API — `prod-api.nugenova.com`

The API runs on the **E2E Networks box `164.52.202.240`** under **pm2**, behind
**nginx** with a Let's Encrypt certificate. Postgres is managed (Supabase), so
there is **no database on the box** — it only needs Node + pm2 + nginx + a `.env`.

Deploys are **automatic**: every push to `main` runs CI, and when CI passes the
`Deploy` workflow SSHes into the box and does `pull → npm ci → build → migrate →
pm2 reload`. You can also trigger it manually from the Actions tab.

```
GitHub push → CI (typecheck/unit/e2e) ──pass──▶ Deploy workflow ──SSH──▶ 164.52.202.240
                                                                          git reset --hard origin/main
                                                                          npm ci && npm run build
                                                                          npm run migration:run
                                                                          pm2 reload nugenova-api
nginx :443 (prod-api.nugenova.com) ──proxy──▶ 127.0.0.1:4000 (pm2)
```

Files that support this live in the repo: `ecosystem.config.js` (pm2),
`deploy/nginx/prod-api.nugenova.com.conf` (nginx), `deploy/env.production.example`
(env template), `.github/workflows/deploy.yml` (auto-deploy).

---

## 0. DNS (do this first)

Point an **A record** for `prod-api.nugenova.com` → `164.52.202.240`. Certbot
needs it resolving before it can issue the certificate. Verify:

```bash
dig +short prod-api.nugenova.com    # should print 164.52.202.240
```

---

## 1. One-time server setup

SSH in as a sudo user (`ssh user@164.52.202.240`). All commands run on the box.

### 1a. Node 20 + pm2 (via NodeSource so binaries are on the system PATH — the CI SSH shell needs that)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
node -v && pm2 -v
```

### 1b. nginx

```bash
sudo apt-get install -y nginx
```

### 1c. App directory + a read-only GitHub deploy key (so the box can `git pull`)

```bash
sudo mkdir -p /var/www/nugenova-api /var/log/nugenova-api
sudo chown -R $USER:$USER /var/www/nugenova-api /var/log/nugenova-api

# Generate a deploy key for pulling the private repo:
ssh-keygen -t ed25519 -f ~/.ssh/nugenova_deploy -N "" -C "nugenova-api-deploy"
cat ~/.ssh/nugenova_deploy.pub
```

Add that **public** key to the repo: GitHub → `cto-varun/nugenova-backend` →
**Settings → Deploy keys → Add deploy key** (read-only). Then tell SSH to use it
for GitHub and clone:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com-nugenova
  HostName github.com
  User git
  IdentityFile ~/.ssh/nugenova_deploy
  IdentitiesOnly yes
EOF

git clone git@github.com-nugenova:cto-varun/nugenova-backend.git /var/www/nugenova-api
cd /var/www/nugenova-api
```

### 1d. Production `.env` (you place this — CI never sees secrets)

```bash
cp deploy/env.production.example .env
nano .env      # fill in real values
```

Critical values: `DATABASE_URL` (Supabase), a strong `JWT_SECRET`
(`openssl rand -base64 48`), **`DEV_OTP_BYPASS=false`**, `CORS_ORIGINS` +
`FRONTEND_URL` = your production frontend, and the `ZEPTOMAIL_*` mail token.
`.env` is gitignored, so deploys never overwrite it.

### 1e. First build + migrate + start under pm2

```bash
npm ci
npm run build
npm run migration:run          # idempotent; safe to re-run
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd            # prints a command — run the sudo line it outputs
```

Check it's up: `pm2 status` and `curl http://127.0.0.1:4000/api/v1/health`.

### 1f. nginx site + HTTPS

```bash
sudo cp deploy/nginx/prod-api.nugenova.com.conf \
  /etc/nginx/sites-available/prod-api.nugenova.com
sudo ln -s /etc/nginx/sites-available/prod-api.nugenova.com \
  /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Issue + auto-renew the certificate (adds the :443 block + HTTP→HTTPS redirect):
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d prod-api.nugenova.com
```

### 1g. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'    # 80 + 443
sudo ufw enable
```

Port 4000 is **not** opened — the app binds to `127.0.0.1`, so only nginx reaches
it. (coturn's existing ports on this box are unaffected.)

**Verify end to end:**

```bash
curl https://prod-api.nugenova.com/api/v1/health
```

---

## 2. Wire up auto-deploy (GitHub Actions → SSH)

The `Deploy` workflow needs a key to SSH into the box. Generate a **separate**
keypair for CI (don't reuse the git deploy key):

```bash
# on the server (or anywhere):
ssh-keygen -t ed25519 -f nugenova_ci -N "" -C "github-actions-deploy"
# add the PUBLIC key to the box so CI can log in:
cat nugenova_ci.pub >> ~/.ssh/authorized_keys
```

Add these as **repository secrets** (GitHub → Settings → Secrets and variables →
Actions):

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | `164.52.202.240` |
| `DEPLOY_USER` | the SSH user that owns `/var/www/nugenova-api` |
| `DEPLOY_PORT` | `22` |
| `DEPLOY_SSH_KEY` | the **private** key (`cat nugenova_ci`) — the whole file |

Now every push to `main` deploys once CI is green. To deploy on demand (e.g. a
hotfix or after changing `.env`): Actions → **Deploy** → **Run workflow**.

---

## 3. Day-to-day

- **Watch a deploy:** GitHub → Actions → the latest **Deploy** run.
- **Logs:** `pm2 logs nugenova-api` (or `/var/log/nugenova-api/*.log`).
- **Status / restart:** `pm2 status`, `pm2 reload nugenova-api`.
- **Rollback:** on the box, `git reset --hard <good-sha> && npm ci && npm run
  build && pm2 reload nugenova-api` — or revert the commit on `main` and let the
  auto-deploy roll forward.
- **Renew cert:** automatic (certbot installs a systemd timer); test with
  `sudo certbot renew --dry-run`.

---

## 4. Notes & gotchas

- **`DEV_OTP_BYPASS=false` in prod** — otherwise `000000` logs anyone in. With it
  off, real OTP emails go out via ZeptoMail, so mail must be configured.
- **Migrations run on every deploy** and are idempotent (TypeORM skips ones
  already recorded). `npm ci` keeps devDependencies, which `migration:run` (ts-node)
  needs — don't switch to `--omit=dev`.
- **Same Supabase project** as dev means schema is already migrated; a separate
  prod Supabase project just gets migrated on first deploy.
- **`trust proxy` is set** in `main.ts`, so `req.ip` / signature-capture IPs and
  secure cookies are correct behind nginx.
- **Uploads:** nginx allows 30 MB (`client_max_body_size`) to cover the app's
  25 MB file cap. For real durability, set the `S3_*` env vars (otherwise files
  are stored in Postgres `bytea`).
- **Frontend** is a separate deploy (`cto-varun/nugenova-frontend`) — point its
  `NEXT_PUBLIC_API_URL` at `https://prod-api.nugenova.com/api/v1`.
