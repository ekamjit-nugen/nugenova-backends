const path = require('path');

/**
 * pm2 process definition for the Nugenova API in production.
 *
 * Path-agnostic: `cwd` and the log paths resolve from THIS file's location, so
 * the repo can live anywhere (e.g. ~/nugenova-api alongside your other
 * projects) — no hard-coded /var/www. The app self-loads its secrets from `.env`
 * (via dotenv in src/main.ts), so no secrets live here.
 *
 * Start/reload from the repo dir:
 *   pm2 start ecosystem.config.js    /    pm2 reload nugenova-api
 *
 * Runs one fork on 127.0.0.1:4000; nginx (prod-api.nugenova.com) proxies to it.
 */
module.exports = {
  apps: [
    {
      name: 'nugenova-api',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '600M',
      // PORT comes from .env so each host can pick a free port without editing
      // this file. HOST stays loopback so only nginx can reach the app.
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
      },
      error_file: path.join(__dirname, 'logs', 'err.log'),
      out_file: path.join(__dirname, 'logs', 'out.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
