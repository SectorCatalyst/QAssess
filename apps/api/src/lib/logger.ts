type LogLevel = 'INFO' | 'WARN' | 'ERROR';

const LOG_SERVICE = (process.env.LOG_SERVICE_NAME ?? 'qassess-api').trim();
const LOG_SINK_URL = process.env.LOG_SINK_URL?.trim();
const LOG_SINK_TOKEN = process.env.LOG_SINK_TOKEN?.trim();
const LOG_SINK_TIMEOUT_MS = Number(process.env.LOG_SINK_TIMEOUT_MS ?? 2000);

let lastSinkErrorAt = 0;

function sinkEnabled(): boolean {
  return typeof LOG_SINK_URL === 'string' && LOG_SINK_URL.length > 0;
}

function maybeWarnSink(message: string): void {
  const now = Date.now();
  if (now - lastSinkErrorAt < 30_000) {
    return;
  }
  lastSinkErrorAt = now;
  process.stderr.write(`${message}\n`);
}

async function writeToSink(payload: Record<string, unknown>): Promise<void> {
  if (!sinkEnabled() || !LOG_SINK_URL) {
    return;
  }

  const controller = new AbortController();
  const timeoutMs = Number.isFinite(LOG_SINK_TIMEOUT_MS) && LOG_SINK_TIMEOUT_MS > 0 ? Math.trunc(LOG_SINK_TIMEOUT_MS) : 2000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    };
    if (typeof LOG_SINK_TOKEN === 'string' && LOG_SINK_TOKEN.length > 0) {
      headers.authorization = `Bearer ${LOG_SINK_TOKEN}`;
    }

    const response = await fetch(LOG_SINK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      maybeWarnSink(`logger sink error: HTTP ${response.status}`);
    }
  } catch (error) {
    maybeWarnSink(`logger sink error: ${String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    service: LOG_SERVICE,
    pid: process.pid,
    ...meta
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);

  if (sinkEnabled()) {
    void writeToSink(payload);
  }
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>): void => write('INFO', message, meta),
  warn: (message: string, meta?: Record<string, unknown>): void => write('WARN', message, meta),
  error: (message: string, meta?: Record<string, unknown>): void => write('ERROR', message, meta)
};
