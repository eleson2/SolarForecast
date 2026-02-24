// PM2 ecosystem config — must be .cjs because the project uses ESM ("type": "module")
// Usage:
//   pm2 start ecosystem.config.cjs        # start
//   pm2 stop solar-forecast               # stop
//   pm2 restart solar-forecast            # restart
//   pm2 logs solar-forecast               # stream logs (Ctrl+C to exit)
//   pm2 logs solar-forecast --lines 200   # last 200 lines
//   pm2 save && pm2 startup               # survive reboots

module.exports = {
  apps: [
    {
      name: 'solar-forecast',
      script: 'scheduler.js',

      // Use system Node (ESM-compatible)
      interpreter: 'node',
      interpreter_args: '',

      // Restart policy
      restart_delay: 5000,       // wait 5s before restarting after a crash
      max_restarts: 10,          // stop retrying after 10 crashes in a row
      min_uptime: '30s',         // must stay up ≥30s to count as a successful start

      // Memory guard — Node can leak after many hours; restart if it grows too large
      max_memory_restart: '300M',

      // Log files (separate from logs/app.log written by logger.js)
      // PM2 captures all stdout/stderr here
      out_file:   'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,           // combine out + error into one stream for pm2 logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss',  // timestamp every PM2 log line

      // Environment
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
