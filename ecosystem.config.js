/**
 * pm2 process definition for the Nugenova API in production.
 *
 * The app self-loads its secrets from `.env` (via dotenv in src/main.ts), so this
 * file only sets NODE_ENV + the bind host — no secrets live here. Start/reload it
 * from the app directory:  `pm2 start ecosystem.config.js`  /  `pm2 reload nugenova-api`.
 *
 * Runs one fork on 127.0.0.1:4000; nginx (prod-api.nugenova.com) proxies to it.
 */
module.exports = {
  apps: [
    {
      name: 'nugenova-api',
      script: 'dist/main.js',
      cwd: '/var/www/nugenova-api',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '600M',
      // Bind to loopback so only nginx (same box) can reach the app.
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '4000',
      },
      error_file: '/var/log/nugenova-api/err.log',
      out_file: '/var/log/nugenova-api/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
