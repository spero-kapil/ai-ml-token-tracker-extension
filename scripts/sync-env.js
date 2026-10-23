#!/usr/bin/env node
// Reads .env (or .env.example) and writes src/lib/env.js for the extension to import.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceName = existsSync(join(root, '.env')) ? '.env' : '.env.example';
const sourcePath = join(root, sourceName);

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = parseEnv(readFileSync(sourcePath, 'utf8'));
const defaultServerUrl = env.DEFAULT_SERVER_URL?.trim() || '127.0.0.1:3000';
const refreshPeriodMinutes = Number(env.REFRESH_PERIOD_MINUTES);

if (!Number.isFinite(refreshPeriodMinutes) || refreshPeriodMinutes < 1) {
  console.error('REFRESH_PERIOD_MINUTES must be a number of minutes >= 1.');
  process.exit(1);
}

const js = `// Generated from ${sourceName} by \`npm run env\`. Do not edit.
export const DEFAULT_SERVER_URL = ${JSON.stringify(defaultServerUrl)};
export const REFRESH_PERIOD_MINUTES = ${refreshPeriodMinutes};
`;

writeFileSync(join(root, 'src/lib/env.js'), js);
console.log(`Wrote src/lib/env.js from ${sourceName}`);
