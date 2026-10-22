// One error-log entry as a text block. Shared by the extension (log download)
// and scripts/log-server.js (logs/error.log), so both files read the same.
// Entry shape: { at, level, scope, code?, message, stack?, details? }

export function formatLogEntry(entry) {
  const head = [
    entry.at,
    `[${String(entry.level || 'error').toUpperCase()}]`,
    `[${entry.scope || 'unknown'}]`,
    entry.code ? `${entry.code}:` : null,
    entry.message || '(no message)'
  ]
    .filter(Boolean)
    .join(' ');

  const lines = [head];
  if (entry.details !== undefined && entry.details !== null) {
    let details;
    try {
      details = JSON.stringify(entry.details);
    } catch {
      details = String(entry.details);
    }
    lines.push(`    details: ${details}`);
  }
  if (entry.stack) {
    // The first stack line repeats the message.
    for (const line of String(entry.stack).split('\n').slice(1)) lines.push(`    ${line.trim()}`);
  }
  return lines.join('\n');
}
