import { setTimeout as sleep } from 'node:timers/promises';

interface SmokeOptions {
  baseUrl: string;
  tenantSlug: string;
  email: string;
  password: string;
  slugPrefix: string;
  requirePdfCompleted: boolean;
  pdfTimeoutSeconds: number;
  pdfPollIntervalMs: number;
  webhookTargetUrl?: string;
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

function parseOptions(): SmokeOptions {
  const baseUrl = (process.env.API_BASE_URL ?? 'http://127.0.0.1:4000').trim().replace(/\/+$/, '');
  const tenantSlug = (process.env.SMOKE_TENANT_SLUG ?? 'acme').trim();
  const email = (process.env.SMOKE_EMAIL ?? 'owner@acme.example').trim();
  const password = process.env.SMOKE_PASSWORD ?? 'ChangeMe123!';
  const slugPrefix = (process.env.SMOKE_SLUG_PREFIX ?? 'smoke').trim();
  const requirePdfCompleted = readBoolEnv('SMOKE_REQUIRE_PDF_COMPLETED', false);
  const pdfTimeoutSeconds = readNumberEnv('SMOKE_PDF_TIMEOUT_SECONDS', 90);
  const pdfPollIntervalMs = readNumberEnv('SMOKE_PDF_POLL_INTERVAL_MS', 2000);
  const webhookTargetUrl = process.env.SMOKE_WEBHOOK_TARGET_URL?.trim();

  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    throw new Error('API_BASE_URL must start with http:// or https://');
  }
  if (!tenantSlug) {
    throw new Error('SMOKE_TENANT_SLUG cannot be empty');
  }
  if (!email || !password) {
    throw new Error('SMOKE_EMAIL and SMOKE_PASSWORD are required');
  }
  if (!slugPrefix) {
    throw new Error('SMOKE_SLUG_PREFIX cannot be empty');
  }

  const options: SmokeOptions = {
    baseUrl,
    tenantSlug,
    email,
    password,
    slugPrefix,
    requirePdfCompleted,
    pdfTimeoutSeconds,
    pdfPollIntervalMs
  };
  if (webhookTargetUrl && webhookTargetUrl.length > 0) {
    options.webhookTargetUrl = webhookTargetUrl;
  }
  return options;
}

function printHelp(): void {
  process.stdout.write(
    [
      'QAssess staging smoke runner',
      '',
      'Usage:',
      '  npm run smoke:staging',
      '',
      'Environment variables:',
      '  API_BASE_URL=http://127.0.0.1:4000      API base URL (default shown)',
      '  SMOKE_TENANT_SLUG=acme                  Login tenant slug',
      '  SMOKE_EMAIL=owner@acme.example          Login email',
      '  SMOKE_PASSWORD=ChangeMe123!             Login password',
      '  SMOKE_SLUG_PREFIX=smoke                 Prefix for created assessment slug',
      '  SMOKE_REQUIRE_PDF_COMPLETED=false       Fail unless PDF job reaches completed',
      '  SMOKE_PDF_TIMEOUT_SECONDS=90            PDF completion wait timeout',
      '  SMOKE_PDF_POLL_INTERVAL_MS=2000         PDF status poll interval',
      '  SMOKE_WEBHOOK_TARGET_URL=<optional>     If set, creates a webhook endpoint',
      '',
      'Notes:',
      '  - This script creates and publishes a temporary assessment, runs full public flow,',
      '    queues a PDF, checks report template and CSV export, and exits non-zero on failures.'
    ].join('\n') + '\n'
  );
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

function asRecord(value: unknown): JsonRecord {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

async function request(
  options: SmokeOptions,
  input: {
    name: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    token?: string;
    expectedStatus: number | number[];
    headers?: Record<string, string>;
    body?: unknown;
  }
): Promise<unknown> {
  const url = `${options.baseUrl}${input.path}`;
  const headers: Record<string, string> = {
    ...(input.headers ?? {})
  };
  if (input.token) {
    headers.authorization = `Bearer ${input.token}`;
  }
  if (input.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }

  const init: RequestInit = {
    method: input.method,
    headers
  };
  if (input.body !== undefined) {
    init.body = JSON.stringify(input.body);
  }

  const response = await fetch(url, init);
  const parsed = await parseBody(response);

  const expected = Array.isArray(input.expectedStatus) ? input.expectedStatus : [input.expectedStatus];
  if (!expected.includes(response.status)) {
    throw new Error(
      `${input.name} failed (${input.method} ${input.path}) expected ${expected.join('/')} got ${response.status}: ${JSON.stringify(parsed)}`
    );
  }

  return parsed;
}

async function waitForPdfCompletion(
  options: SmokeOptions,
  input: { jobId: string }
): Promise<{ status: string; body: JsonRecord }> {
  const deadline = Date.now() + options.pdfTimeoutSeconds * 1000;
  let lastStatus = 'queued';
  let lastBody: JsonRecord = {};

  while (Date.now() <= deadline) {
    const body = asRecord(
      await request(options, {
        name: 'get-pdf-job',
        method: 'GET',
        path: `/v1/pdf-jobs/${input.jobId}`,
        expectedStatus: 200
      })
    );

    const status = typeof body.status === 'string' ? body.status : 'unknown';
    lastStatus = status;
    lastBody = body;

    if (status === 'completed' || status === 'failed') {
      return { status, body };
    }

    await sleep(options.pdfPollIntervalMs);
  }

  return { status: lastStatus, body: lastBody };
}

async function run(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const options = parseOptions();
  const runId = Date.now().toString(36);
  const slug = `${options.slugPrefix}-${runId}`;
  const leadEmail = `smoke+${runId}@example.com`;

  process.stdout.write(`Smoke start: base=${options.baseUrl}, slug=${slug}\n`);

  const loginBody = asRecord(
    await request(options, {
      name: 'auth-login',
      method: 'POST',
      path: '/v1/auth/login',
      expectedStatus: 200,
      body: {
        email: options.email,
        password: options.password,
        tenantSlug: options.tenantSlug
      }
    })
  );
  const token = assertString(loginBody.accessToken, 'accessToken');
  process.stdout.write('Step ok: login\n');

  const assessmentBody = asRecord(
    await request(options, {
      name: 'create-assessment',
      method: 'POST',
      path: '/v1/assessments',
      token,
      expectedStatus: 201,
      body: {
        name: `Smoke Assessment ${runId}`,
        slug
      }
    })
  );
  const assessmentId = assertString(assessmentBody.id, 'assessment.id');
  process.stdout.write('Step ok: create assessment\n');

  const versionBody = asRecord(
    await request(options, {
      name: 'create-version',
      method: 'POST',
      path: `/v1/assessments/${assessmentId}/versions`,
      token,
      expectedStatus: 201,
      body: {
        title: `Smoke Version ${runId}`
      }
    })
  );
  const versionId = assertString(versionBody.id, 'version.id');
  process.stdout.write('Step ok: create version\n');

  await request(options, {
    name: 'put-landing',
    method: 'PUT',
    path: `/v1/versions/${versionId}/landing`,
    token,
    expectedStatus: 200,
    body: {
      seoTitle: `Smoke Landing ${runId}`,
      seoDescription: 'Smoke test landing page',
      theme: { accent: 'teal' }
    }
  });
  process.stdout.write('Step ok: configure landing\n');

  const questionBody = asRecord(
    await request(options, {
      name: 'create-question',
      method: 'POST',
      path: `/v1/versions/${versionId}/questions`,
      token,
      expectedStatus: 201,
      body: {
        type: 'single_choice',
        prompt: 'How mature is your funnel?',
        position: 1,
        weight: 2
      }
    })
  );
  const questionId = assertString(questionBody.id, 'question.id');
  process.stdout.write('Step ok: create question\n');

  await request(options, {
    name: 'create-option-advanced',
    method: 'POST',
    path: `/v1/questions/${questionId}/options`,
    token,
    expectedStatus: 201,
    body: {
      label: 'Advanced',
      value: 'advanced',
      scoreValue: 3,
      position: 1
    }
  });

  await request(options, {
    name: 'create-option-basic',
    method: 'POST',
    path: `/v1/questions/${questionId}/options`,
    token,
    expectedStatus: 201,
    body: {
      label: 'Basic',
      value: 'basic',
      scoreValue: 1,
      position: 2
    }
  });
  process.stdout.write('Step ok: create options\n');

  await request(options, {
    name: 'publish-version',
    method: 'POST',
    path: `/v1/versions/${versionId}/publish`,
    token,
    expectedStatus: 200,
    body: {}
  });
  process.stdout.write('Step ok: publish version\n');

  if (options.webhookTargetUrl) {
    await request(options, {
      name: 'create-webhook',
      method: 'POST',
      path: '/v1/integrations/webhooks',
      token,
      expectedStatus: 201,
      body: {
        name: `Smoke Webhook ${runId}`,
        targetUrl: options.webhookTargetUrl,
        secret: `smoke-secret-${runId}-with-sufficient-length`,
        subscribedEvents: ['lead.created', 'session.completed', 'pdf.generated']
      }
    });
    process.stdout.write('Step ok: create webhook endpoint\n');
  }

  const bootstrapBody = asRecord(
    await request(options, {
      name: 'public-bootstrap',
      method: 'GET',
      path: `/v1/public/${slug}/bootstrap`,
      expectedStatus: 200
    })
  );
  const bootstrapQuestions = Array.isArray(bootstrapBody.questions)
    ? (bootstrapBody.questions as unknown[])
    : [];
  const bootstrapQuestionId = assertString(asRecord(bootstrapQuestions[0]).id, 'bootstrap.questions[0].id');
  if (bootstrapQuestionId !== questionId) {
    throw new Error(`Bootstrap returned unexpected question id (${bootstrapQuestionId} != ${questionId})`);
  }
  process.stdout.write('Step ok: public bootstrap\n');

  const sessionBody = asRecord(
    await request(options, {
      name: 'start-session',
      method: 'POST',
      path: `/v1/public/${slug}/sessions`,
      expectedStatus: 201,
      body: {
        utm: {
          source: 'smoke-script'
        }
      }
    })
  );
  const sessionId = assertString(sessionBody.id, 'session.id');
  process.stdout.write('Step ok: start session\n');

  await request(options, {
    name: 'upsert-lead',
    method: 'POST',
    path: `/v1/sessions/${sessionId}/lead`,
    expectedStatus: 200,
    headers: {
      'idempotency-key': `smoke-lead-${runId}`
    },
    body: {
      email: leadEmail,
      firstName: 'Smoke',
      lastName: 'Runner',
      consent: true
    }
  });
  process.stdout.write('Step ok: upsert lead\n');

  await request(options, {
    name: 'upsert-response',
    method: 'PUT',
    path: `/v1/sessions/${sessionId}/responses`,
    expectedStatus: 200,
    headers: {
      'idempotency-key': `smoke-response-${runId}`
    },
    body: {
      questionId: bootstrapQuestionId,
      answer: 'advanced'
    }
  });
  process.stdout.write('Step ok: upsert response\n');

  const completeBody = asRecord(
    await request(options, {
      name: 'complete-session',
      method: 'POST',
      path: `/v1/sessions/${sessionId}/complete`,
      expectedStatus: 200,
      headers: {
        'idempotency-key': `smoke-complete-${runId}`
      },
      body: {}
    })
  );
  if (typeof completeBody.normalizedScore !== 'number' && typeof completeBody.normalizedScore !== 'string') {
    throw new Error('complete-session missing normalizedScore');
  }
  process.stdout.write('Step ok: complete session\n');

  const pdfBody = asRecord(
    await request(options, {
      name: 'queue-pdf',
      method: 'POST',
      path: `/v1/sessions/${sessionId}/pdf`,
      expectedStatus: 202,
      body: {
        emailTo: leadEmail
      }
    })
  );
  const pdfJobId = assertString(pdfBody.id, 'pdfJob.id');
  process.stdout.write('Step ok: queue pdf\n');

  const pdfStatus = await waitForPdfCompletion(options, { jobId: pdfJobId });
  process.stdout.write(`Step info: pdf status=${pdfStatus.status}\n`);
  if (options.requirePdfCompleted && pdfStatus.status !== 'completed') {
    throw new Error(`Expected PDF completion but status is ${pdfStatus.status}`);
  }
  if (pdfStatus.status === 'failed') {
    throw new Error(`PDF job failed: ${JSON.stringify(pdfStatus.body)}`);
  }

  await request(options, {
    name: 'get-report-template',
    method: 'GET',
    path: `/v1/versions/${versionId}/report-template`,
    token,
    expectedStatus: 200
  });
  process.stdout.write('Step ok: report template retrieval\n');

  const csvBody = await request(options, {
    name: 'export-csv',
    method: 'GET',
    path: `/v1/assessments/${assessmentId}/leads/export`,
    token,
    expectedStatus: 200
  });
  const csvText = typeof csvBody === 'string' ? csvBody : JSON.stringify(csvBody);
  if (!csvText.includes(leadEmail)) {
    throw new Error('CSV export does not contain smoke lead email');
  }
  process.stdout.write('Step ok: leads export\n');

  process.stdout.write(
    [
      'Smoke completed successfully.',
      `assessmentId=${assessmentId}`,
      `versionId=${versionId}`,
      `sessionId=${sessionId}`,
      `pdfJobId=${pdfJobId}`,
      `pdfStatus=${pdfStatus.status}`
    ].join('\n') + '\n'
  );
}

run().catch((error) => {
  process.stderr.write(`Smoke failed: ${String(error)}\n`);
  process.exitCode = 1;
});
