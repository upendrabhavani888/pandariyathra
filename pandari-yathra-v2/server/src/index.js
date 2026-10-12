import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, DATA_DIR } from './config.js';
import { db } from './db.js';
import { router as authRouter, prepareSetupCode } from './auth.js';
import { router as syncRouter } from './sync.js';
import { router as miscRouter } from './misc.js';
import { backupOnce } from './backup.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', authRouter);
app.use('/api', syncRouter);
app.use('/api', miscRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const page = path.join(config.webDir, 'index.html');
const sendApp = (req, res) => (fs.existsSync(page) ? res.sendFile(page) : res.status(503).type('text').send('The web app is not built yet (web/index.html is missing).'));
app.get(['/', '/index.html'], sendApp);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : err instanceof SyntaxError ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : status === 413 ? 'That is too large' : err.message, ...(err.must ? { must: true } : {}), ...(err.wait ? { wait: err.wait } : {}) });
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const server = app.listen(config.port, () => {
    console.log(`Pandari Yathra server on http://localhost:${config.port}`);
    console.log(config.anthropicKey ? 'Ticket reading: Claude (key kept on the server)' : 'Ticket reading: offline reader only (set ANTHROPIC_API_KEY for photos and robust PDF reading)');
    const code = prepareSetupCode();
    if (code) console.log(`\n  FIRST-TIME SETUP CODE: ${code}\n  Open the site, enter this code and create the Admin account.\n`);
  });
  const timer = setInterval(() => { if (new Date().getHours() >= 2) backupOnce().catch((e) => console.error('backup failed', e.message)); }, 3600000);
  timer.unref();
  backupOnce().catch(() => {});
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); });
}
