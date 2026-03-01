export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    if (details) {
      this.details = details;
    }
  }
}

export interface ErrorPayload {
  statusCode: number;
  body: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

interface FastifyLikeError {
  statusCode: number;
  code?: string;
  message: string;
  validation?: unknown;
}

interface DbLikeError {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  message: string;
}

function isFastifyLikeError(error: unknown): error is FastifyLikeError {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const withStatus = error as Partial<FastifyLikeError>;
  return typeof withStatus.statusCode === 'number' && typeof withStatus.message === 'string';
}

function isDbLikeError(error: unknown): error is DbLikeError {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const value = error as Partial<DbLikeError>;
  return typeof value.message === 'string';
}

const UNIQUE_CONFLICT_MAP: Record<string, { code: string; message: string }> = {
  users_tenant_email_unique: {
    code: 'USER_EMAIL_CONFLICT',
    message: 'User email already exists for this tenant'
  },
  assessments_tenant_slug_unique: {
    code: 'ASSESSMENT_SLUG_CONFLICT',
    message: 'Assessment slug already exists for this tenant'
  },
  assessment_versions_assessment_version_unique: {
    code: 'VERSION_CONFLICT',
    message: 'Version number already exists for this assessment'
  },
  uq_assessment_versions_one_published: {
    code: 'VERSION_PUBLISH_CONFLICT',
    message: 'Only one version can be published per assessment'
  },
  page_blocks_landing_position_unique: {
    code: 'LANDING_BLOCK_POSITION_CONFLICT',
    message: 'Landing block position already exists for this page'
  },
  questions_version_position_unique: {
    code: 'QUESTION_POSITION_CONFLICT',
    message: 'Question position already exists in this version'
  },
  answer_options_question_position_unique: {
    code: 'ANSWER_OPTION_POSITION_CONFLICT',
    message: 'Answer option position already exists for this question'
  },
  logic_rules_version_priority_name_unique: {
    code: 'LOGIC_RULE_CONFLICT',
    message: 'Logic rule already exists for this priority and name'
  },
  score_bands_version_position_unique: {
    code: 'SCORE_BAND_POSITION_CONFLICT',
    message: 'Score band position already exists in this version'
  },
  report_sections_template_position_unique: {
    code: 'REPORT_SECTION_POSITION_CONFLICT',
    message: 'Report section position already exists in this template'
  },
  report_sections_template_key_unique: {
    code: 'REPORT_SECTION_KEY_CONFLICT',
    message: 'Report section key already exists in this template'
  },
  report_templates_assessment_version_id_key: {
    code: 'REPORT_TEMPLATE_CONFLICT',
    message: 'Report template already exists for this assessment version'
  },
  analytics_daily_assessment_unique: {
    code: 'ANALYTICS_DAILY_ASSESSMENT_CONFLICT',
    message: 'Analytics daily summary already exists for this assessment and date'
  },
  analytics_daily_question_dropoff_unique: {
    code: 'ANALYTICS_DAILY_DROPOFF_CONFLICT',
    message: 'Analytics daily dropoff row already exists for this question and date'
  },
  webhook_deliveries_event_endpoint_unique: {
    code: 'WEBHOOK_DELIVERY_CONFLICT',
    message: 'Webhook delivery already exists for this event and endpoint'
  }
};

function extractUniqueConstraintName(error: DbLikeError): string | undefined {
  if (typeof error.constraint === 'string' && error.constraint.length > 0) {
    return error.constraint;
  }

  const message = error.message;
  const match = message.match(/unique constraint ["']([^"']+)["']/i);
  if (match?.[1]) {
    return match[1];
  }

  return undefined;
}

function isUniqueConstraintViolation(error: DbLikeError): boolean {
  if (error.code === '23505') {
    return true;
  }

  const message = error.message.toLowerCase();
  return message.includes('duplicate key value violates unique constraint') || message.includes('unique constraint');
}

function buildDbConflictDetails(error: DbLikeError, constraint: string | undefined): Record<string, unknown> {
  const details: Record<string, unknown> = {
    detail: error.detail ?? error.message
  };
  if (constraint) {
    details.constraint = constraint;
  }
  if (typeof error.table === 'string' && error.table.length > 0) {
    details.table = error.table;
  }
  return details;
}

interface ConflictFallback {
  code?: string;
  message?: string;
}

export function toUniqueConflictAppError(error: unknown, fallback: ConflictFallback = {}): AppError | null {
  if (!isDbLikeError(error) || !isUniqueConstraintViolation(error)) {
    return null;
  }

  const constraint = extractUniqueConstraintName(error);
  const mapped = constraint ? UNIQUE_CONFLICT_MAP[constraint] : undefined;

  return new AppError(
    409,
    mapped?.code ?? fallback.code ?? 'CONFLICT',
    mapped?.message ?? fallback.message ?? 'A resource conflict occurred',
    buildDbConflictDetails(error, constraint)
  );
}

export function toErrorPayload(error: unknown, requestId: string): ErrorPayload {
  if (error instanceof AppError) {
    const body: ErrorPayload['body'] = {
      code: error.code,
      message: error.message,
      requestId
    };
    if (error.details) {
      body.details = error.details;
    }

    return {
      statusCode: error.statusCode,
      body
    };
  }

  const dbConflict = toUniqueConflictAppError(error);
  if (dbConflict) {
    const body: ErrorPayload['body'] = {
      code: dbConflict.code,
      message: dbConflict.message,
      requestId
    };
    if (dbConflict.details) {
      body.details = dbConflict.details;
    }
    return {
      statusCode: dbConflict.statusCode,
      body
    };
  }

  if (isFastifyLikeError(error)) {
    const body: ErrorPayload['body'] = {
      code: error.code ?? (error.statusCode === 400 ? 'VALIDATION_ERROR' : 'REQUEST_ERROR'),
      message: error.message,
      requestId
    };

    if (error.validation !== undefined) {
      body.details = { validation: error.validation };
    }

    return {
      statusCode: error.statusCode,
      body
    };
  }

  return {
    statusCode: 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId
    }
  };
}
