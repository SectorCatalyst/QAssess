import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

interface LoadOptions {
  baseUrl: string;
  slug: string;
  totalSessions: number;
  concurrency: number;
  warmupSessions: number;
  includeBootstrap: boolean;
  includeLead: boolean;
  includeComplete: boolean;
  completeAnswer: string;
  minSuccessRatePercent: number;
  maxSessionStartP95Ms: number;
  maxLeadP95Ms: number;
  maxCompleteP95Ms: number;
  assertThresholds: boolean;
  reportPath?: string;
}

interface StepStats {
  durationsMs: number[];
  ok: number;
  fail: number;
}

interface IterationResult {
  ok: boolean;
  questionId?: string;
}

type JsonRecord = Record<string, unknown>;

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number when set`);
  }
  return value;
}

function parseOptions(): LoadOptions {
  const baseUrl = (process.env.API_BASE_URL ?? 'http://127.0.0.1:4000').trim().replace(/\/+$/, '');
  const slug = (process.env.ASSESSMENT_SLUG ?? 'public-growth').trim();
  const totalSessions = readNumberEnv('LOAD_TOTAL_SESSIONS', 200);
  const concurrency = readNumberEnv('LOAD_CONCURRENCY', 20);
  const warmupSessions = readNumberEnv('LOAD_WARMUP_SESSIONS', 20);
  const includeBootstrap = readBoolEnv('LOAD_INCLUDE_BOOTSTRAP', true);
  const includeLead = readBoolEnv('LOAD_INCLUDE_LEAD', true);
  const includeComplete = readBoolEnv('LOAD_INCLUDE_COMPLETE', false);
  const completeAnswer = (process.env.LOAD_COMPLETE_ANSWER ?? 'advanced').trim();
  const minSuccessRatePercent = readNumberEnv('LOAD_MIN_SUCCESS_RATE_PERCENT', 98);
  const maxSessionStartP95Ms = readNumberEnv('LOAD_MAX_P95_SESSION_START_MS', 500);
  const maxLeadP95Ms = readNumberEnv('LOAD_MAX_P95_LEAD_MS', 700);
  const maxCompleteP95Ms = readNumberEnv('LOAD_MAX_P95_COMPLETE_MS', 900);
  const assertThresholds = readBoolEnv('LOAD_ASSERT_THRESHOLDS', false);
  const reportPath = process.env.LOAD_REPORT_PATH?.trim();

  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    throw new Error('API_BASE_URL must start with http:// or https://');
  }
  if (!slug) {
    throw new Error('ASSESSMENT_SLUG cannot be empty');
  }
  if (includeComplete && !completeAnswer) {
    throw new Error('LOAD_COMPLETE_ANSWER is required when LOAD_INCLUDE_COMPLETE=true');
  }

  const options: LoadOptions = {
    baseUrl,
    slug,
    totalSessions: Math.trunc(totalSessions),
    concurrency: Math.trunc(concurrency),
    warmupSessions: Math.trunc(warmupSessions),
    includeBootstrap,
    includeLead,
    includeComplete,
    completeAnswer,
    minSuccessRatePercent,
    maxSessionStartP95Ms,
    maxLeadP95Ms,
    maxCompleteP95Ms,
    assertThresholds
  };
  if (reportPath && reportPath.length > 0) {
    options.reportPath = reportPath;
  }
  return options;
}

function printHelp(): void {
  process.stdout.write(
    [
      'QAssess load baseline runner',
      '',
      'Usage:',
      '  npm run load:baseline',
      '',
      'Environment variables:',
      '  API_BASE_URL=http://127.0.0.1:4000      API base URL (default shown)',
      '  ASSESSMENT_SLUG=public-growth           Published assessment slug',
      '  LOAD_TOTAL_SESSIONS=200                 Number of session iterations',
      '  LOAD_CONCURRENCY=20                     Concurrent workers',
      '  LOAD_WARMUP_SESSIONS=20                 Warmup iterations (not counted)',
      '  LOAD_INCLUDE_BOOTSTRAP=true             Include bootstrap request each iteration',
      '  LOAD_INCLUDE_LEAD=true                  Include lead upsert each iteration',
      '  LOAD_INCLUDE_COMPLETE=false             Include response+complete steps',
      '  LOAD_COMPLETE_ANSWER=advanced           Answer payload for completion mode',
      '  LOAD_MIN_SUCCESS_RATE_PERCENT=98        Threshold for passing run',
      '  LOAD_MAX_P95_SESSION_START_MS=500       Threshold for passing run',
      '  LOAD_MAX_P95_LEAD_MS=700                Threshold for passing run',
      '  LOAD_MAX_P95_COMPLETE_MS=900            Threshold for passing run',
      '  LOAD_ASSERT_THRESHOLDS=false            Exit non-zero when thresholds fail',
      '  LOAD_REPORT_PATH=<path>                 Optional JSON report output path',
      '',
      'Notes:',
      '  - Prints summary metrics and writes a JSON report file under artifacts/ by default.'
    ].join('\n') + '\n'
  );
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function percentile(input: number[], p: number): number {
  if (input.length === 0) {
    return 0;
  }
  const sorted = [...input].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function average(input: number[]): number {
  if (input.length === 0) {
    return 0;
  }
  const total = input.reduce((sum, value) => sum + value, 0);
  return total / input.length;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

async function apiRequest(
  options: LoadOptions,
  input: {
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    expectedStatus: number;
  }
): Promise<unknown> {
  const init: RequestInit = {
    method: input.method,
    headers: {
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(input.headers ?? {})
    }
  };
  if (input.body !== undefined) {
    init.body = JSON.stringify(input.body);
  }

  const response = await fetch(`${options.baseUrl}${input.path}`, init);

  const parsed = await parseBody(response);
  if (response.status !== input.expectedStatus) {
    throw new Error(
      `Request failed: ${input.method} ${input.path} expected ${input.expectedStatus} got ${response.status}: ${JSON.stringify(parsed)}`
    );
  }
  return parsed;
}

function getOrCreateStepStats(store: Map<string, StepStats>, step: string): StepStats {
  const existing = store.get(step);
  if (existing) {
    return existing;
  }

  const created: StepStats = {
    durationsMs: [],
    ok: 0,
    fail: 0
  };
  store.set(step, created);
  return created;
}

async function timedStep(
  store: Map<string, StepStats>,
  step: string,
  fn: () => Promise<unknown>,
  collectMetrics: boolean
): Promise<unknown> {
  const start = performance.now();
  try {
    const value = await fn();
    if (collectMetrics) {
      const stats = getOrCreateStepStats(store, step);
      stats.ok += 1;
      stats.durationsMs.push(performance.now() - start);
    }
    return value;
  } catch (error) {
    if (collectMetrics) {
      const stats = getOrCreateStepStats(store, step);
      stats.fail += 1;
      stats.durationsMs.push(performance.now() - start);
    }
    throw error;
  }
}

async function runIteration(
  options: LoadOptions,
  store: Map<string, StepStats>,
  index: number,
  collectMetrics: boolean,
  fallbackQuestionId?: string
): Promise<IterationResult> {
  try {
    let questionId = fallbackQuestionId;

    if (options.includeBootstrap) {
      const bootstrapBody = asRecord(
        await timedStep(
          store,
          'bootstrap',
          () => apiRequest(options, { method: 'GET', path: `/v1/public/${options.slug}/bootstrap`, expectedStatus: 200 }),
          collectMetrics
        )
      );
      const firstQuestion = Array.isArray(bootstrapBody.questions) ? asRecord(bootstrapBody.questions[0]) : {};
      const discovered = asString(firstQuestion.id);
      if (discovered) {
        questionId = discovered;
      }
    }

    const sessionBody = asRecord(
      await timedStep(
        store,
        'session_start',
        () =>
          apiRequest(options, {
            method: 'POST',
            path: `/v1/public/${options.slug}/sessions`,
            expectedStatus: 201,
            body: {
              utm: {
                source: 'load-baseline'
              }
            }
          }),
        collectMetrics
      )
    );
    const sessionId = asString(sessionBody.id);
    if (!sessionId) {
      throw new Error('session_start returned no session id');
    }

    if (options.includeLead) {
      await timedStep(
        store,
        'lead_upsert',
        () =>
          apiRequest(options, {
            method: 'POST',
            path: `/v1/sessions/${sessionId}/lead`,
            expectedStatus: 200,
            headers: {
              'idempotency-key': `load-lead-${Date.now()}-${index}`
            },
            body: {
              email: `load-${index}-${Date.now()}@example.com`,
              consent: true
            }
          }),
        collectMetrics
      );
    }

    if (options.includeComplete) {
      if (!questionId) {
        throw new Error('Unable to resolve question id for complete flow');
      }
      await timedStep(
        store,
        'response_upsert',
        () =>
          apiRequest(options, {
            method: 'PUT',
            path: `/v1/sessions/${sessionId}/responses`,
            expectedStatus: 200,
            headers: {
              'idempotency-key': `load-response-${Date.now()}-${index}`
            },
            body: {
              questionId,
              answer: options.completeAnswer
            }
          }),
        collectMetrics
      );

      await timedStep(
        store,
        'session_complete',
        () =>
          apiRequest(options, {
            method: 'POST',
            path: `/v1/sessions/${sessionId}/complete`,
            expectedStatus: 200,
            headers: {
              'idempotency-key': `load-complete-${Date.now()}-${index}`
            },
            body: {}
          }),
        collectMetrics
      );
    }

    if (questionId) {
      return {
        ok: true,
        questionId
      };
    }
    return { ok: true };
  } catch {
    if (fallbackQuestionId) {
      return {
        ok: false,
        questionId: fallbackQuestionId
      };
    }
    return { ok: false };
  }
}

function summarizeStep(step: StepStats): {
  ok: number;
  fail: number;
  total: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
} {
  const total = step.ok + step.fail;
  return {
    ok: step.ok,
    fail: step.fail,
    total,
    avgMs: average(step.durationsMs),
    p50Ms: percentile(step.durationsMs, 50),
    p95Ms: percentile(step.durationsMs, 95),
    p99Ms: percentile(step.durationsMs, 99),
    maxMs: step.durationsMs.length > 0 ? Math.max(...step.durationsMs) : 0
  };
}

async function writeReport(reportPath: string, payload: unknown): Promise<void> {
  const absolute = path.isAbsolute(reportPath) ? reportPath : path.resolve(process.cwd(), reportPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, JSON.stringify(payload, null, 2), 'utf8');
  process.stdout.write(`Report written: ${absolute}\n`);
}

async function run(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const options = parseOptions();
  const reportPath =
    options.reportPath ??
    `artifacts/load-baseline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  process.stdout.write(
    `Load start: base=${options.baseUrl}, slug=${options.slug}, sessions=${options.totalSessions}, concurrency=${options.concurrency}\n`
  );

  const stats = new Map<string, StepStats>();
  let cachedQuestionId: string | undefined;

  for (let index = 0; index < options.warmupSessions; index += 1) {
    const result = await runIteration(options, stats, index, false, cachedQuestionId);
    if (result.questionId) {
      cachedQuestionId = result.questionId;
    }
  }
  process.stdout.write(`Warmup complete: ${options.warmupSessions} iterations\n`);

  let nextIndex = 0;
  let successfulIterations = 0;
  let failedIterations = 0;
  const startedAt = performance.now();

  const workers = Array.from({ length: options.concurrency }).map(async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.totalSessions) {
        return;
      }

      const result = await runIteration(options, stats, index, true, cachedQuestionId);
      if (result.questionId) {
        cachedQuestionId = result.questionId;
      }
      if (result.ok) {
        successfulIterations += 1;
      } else {
        failedIterations += 1;
      }
    }
  });

  await Promise.all(workers);
  const durationMs = performance.now() - startedAt;
  const totalIterations = successfulIterations + failedIterations;
  const successRate = totalIterations > 0 ? (successfulIterations / totalIterations) * 100 : 0;
  const sessionsPerSecond = durationMs > 0 ? (successfulIterations * 1000) / durationMs : 0;

  const stepSummary: Record<string, ReturnType<typeof summarizeStep>> = {};
  for (const [stepName, values] of stats.entries()) {
    stepSummary[stepName] = summarizeStep(values);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    options,
    outcome: {
      durationMs,
      totalIterations,
      successfulIterations,
      failedIterations,
      successRatePercent: successRate,
      sessionsPerSecond
    },
    stepSummary
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await writeReport(reportPath, report);

  const failures: string[] = [];
  if (successRate < options.minSuccessRatePercent) {
    failures.push(`success rate ${successRate.toFixed(2)}% < ${options.minSuccessRatePercent}%`);
  }

  const startP95 = stepSummary.session_start?.p95Ms ?? 0;
  if (startP95 > options.maxSessionStartP95Ms) {
    failures.push(`session_start p95 ${startP95.toFixed(2)}ms > ${options.maxSessionStartP95Ms}ms`);
  }

  if (options.includeLead) {
    const leadP95 = stepSummary.lead_upsert?.p95Ms ?? 0;
    if (leadP95 > options.maxLeadP95Ms) {
      failures.push(`lead_upsert p95 ${leadP95.toFixed(2)}ms > ${options.maxLeadP95Ms}ms`);
    }
  }

  if (options.includeComplete) {
    const completeP95 = stepSummary.session_complete?.p95Ms ?? 0;
    if (completeP95 > options.maxCompleteP95Ms) {
      failures.push(`session_complete p95 ${completeP95.toFixed(2)}ms > ${options.maxCompleteP95Ms}ms`);
    }
  }

  if (failures.length > 0) {
    process.stdout.write(`Threshold check: FAIL (${failures.join('; ')})\n`);
    if (options.assertThresholds) {
      process.exitCode = 1;
    }
  } else {
    process.stdout.write('Threshold check: PASS\n');
  }
}

run().catch((error) => {
  process.stderr.write(`Load baseline failed: ${String(error)}\n`);
  process.exitCode = 1;
});
