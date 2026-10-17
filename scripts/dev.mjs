// Starts the Durable Object backend (wrangler dev on :8787) and the Vite client (:5173) together.
// Stop both with Ctrl+C.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';

// wrangler needs the assets directory to exist, even when Vite serves the client.
if (!existsSync('dist')) mkdirSync('dist');

const procs = [
  spawn('npx', ['wrangler', 'dev', '--port', '8787'], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
];

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
