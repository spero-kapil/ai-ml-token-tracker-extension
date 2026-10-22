// Local error-log receiver. The extension POSTs its error entries here and they
// are appended to logs/error.log in the project directory. No dependencies.
//
//   npm run logs            (listens on 127.0.0.1:47321, override with PORT)
import { createServer } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_SERVER_PORT } from '../src/lib/constants.js';
import { formatLogEntry } from '../src/lib/log-format.js';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = join(PROJECT_DIR, 'logs', 'error.log');
const PORT = Number(process.env.PORT) || LOG_SERVER_PORT;
const MAX_BODY_BYTES = 1024 * 1024;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleLog(req, res) {
  const { entries } = JSON.parse(await readBody(req));
  if (!Array.isArray(entries)) throw new Error('Expected { entries: [...] }');
  if (entries.length) {
    await appendFile(LOG_FILE, entries.map(formatLogEntry).join('\n') + '\n', 'utf8');
    for (const entry of entries) console.error(formatLogEntry(entry));
  }
  res.writeHead(204, CORS_HEADERS).end();
}

await mkdir(dirname(LOG_FILE), { recursive: true });

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, CORS_HEADERS).end();
  if (req.method !== 'POST' || req.url !== '/log') return res.writeHead(404, CORS_HEADERS).end();
  try {
    await handleLog(req, res);
  } catch (error) {
    console.error(`[log-server] ${error.message}`);
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'text/plain' }).end(error.message);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Writing extension errors to ${LOG_FILE}`);
  console.log(`Listening on http://127.0.0.1:${PORT}/log`);
});
