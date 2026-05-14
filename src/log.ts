function makeRunId(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

const runId = makeRunId();
const LOG_FORMAT = (process.env.LOG_FORMAT ?? 'pretty').toLowerCase();

const COLOR: Record<string, string> = {
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

function redact(value: string): string {
  let out = value;
  for (const key of ['STERLING_EMAIL', 'STERLING_PASSWORD']) {
    const secret = process.env[key];
    if (secret && secret.length > 0) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

function shortenPath(v: string): string {
  // Trim long absolute paths to just the leaf: /app/screenshots/xx/01-foo.png -> 01-foo.png
  const m = v.match(/[^/]+\.(png|html)$/);
  return m ? m[0] : v;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') {
    return v.includes('/') && (v.endsWith('.png') || v.endsWith('.html')) ? shortenPath(v) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function emitPretty(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const lvl = level.toUpperCase().padEnd(5);
  const parts = Object.entries(fields)
    .filter(([k]) => k !== 'stack') // stack traces are noise on a single line
    .map(([k, v]) => `${COLOR.dim}${k}${COLOR.reset}=${formatValue(v)}`);
  const fieldsStr = parts.length ? ' ' + parts.join(' ') : '';
  const line = `${COLOR.dim}${ts}${COLOR.reset} ${COLOR[level]}${lvl}${COLOR.reset} ${event}${fieldsStr}`;
  process.stdout.write(redact(line) + '\n');
  if (typeof fields.stack === 'string') {
    process.stdout.write(redact(`${COLOR.dim}${fields.stack}${COLOR.reset}\n`));
  }
}

function emitJson(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    run_id: runId,
    level,
    event,
    ...fields,
  });
  process.stdout.write(redact(line) + '\n');
}

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>): void {
  if (LOG_FORMAT === 'json') emitJson(level, event, fields);
  else emitPretty(level, event, fields);
}

export const log = {
  info: (event: string, fields: Record<string, unknown> = {}) => emit('info', event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit('warn', event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => emit('error', event, fields),
  runId,
};
