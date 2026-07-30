import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Tiny .env loader — avoids adding a dotenv dependency for four variables. */
function loadEnvFile(): void {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

export const config = {
  callServiceUrl: process.env.CALL_SERVICE_URL ?? 'http://localhost:4000',
  callServiceWsUrl: process.env.CALL_SERVICE_WS_URL ?? process.env.CALL_SERVICE_URL ?? 'http://localhost:4000',
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-to-a-long-random-secret',
  jwtAlgorithm: (process.env.JWT_ALGORITHM ?? 'HS256') as 'HS256',
  internalApiKey: (process.env.INTERNAL_API_KEYS ?? 'change-me-internal-key').split(',')[0].trim(),
  browserAppPort: Number(process.env.BROWSER_APP_PORT ?? 8899),
};

export const browserAppUrl = `http://localhost:${config.browserAppPort}`;
