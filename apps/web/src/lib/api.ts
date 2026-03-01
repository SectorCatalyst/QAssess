import type {
  AnalyticsSummary,
  AnswerOption,
  ApiErrorPayload,
  Assessment,
  AssessmentVersion,
  AuthTokenResponse,
  DropoffMetric,
  LandingPage,
  Lead,
  LogicRule,
  PageBlock,
  PaginatedAssessments,
  PdfJob,
  PublicBootstrapResponse,
  Question,
  ReportSection,
  ReportTemplate,
  ResponseAnswer,
  ResponseRecord,
  Result,
  Session,
  WebhookEndpoint
} from '../types';

export class ApiError extends Error {
  status: number;
  payload?: ApiErrorPayload;

  constructor(status: number, payload?: ApiErrorPayload) {
    super(payload?.message ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export class ApiClient {
  private baseUrl: string;
  private accessToken: string | null;

  constructor(baseUrl: string, accessToken: string | null = null) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.accessToken = accessToken;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private buildUrl(path: string): string {
    if (!this.baseUrl) {
      return path;
    }
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(path: string, options: RequestInit = {}, auth = true): Promise<T> {
    const headers = new Headers(options.headers ?? {});
    if (!headers.has('content-type') && options.body !== undefined && !(options.body instanceof FormData)) {
      headers.set('content-type', 'application/json');
    }
    if (auth && this.accessToken) {
      headers.set('authorization', `Bearer ${this.accessToken}`);
    }

    const response = await fetch(this.buildUrl(path), {
      ...options,
      headers
    });

    if (!response.ok) {
      let payload: ApiErrorPayload | undefined;
      try {
        payload = (await response.json()) as ApiErrorPayload;
      } catch {
        payload = undefined;
      }
      throw new ApiError(response.status, payload);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return (await response.json()) as T;
    }

    return (await response.text()) as T;
  }

  login(input: { email: string; password: string; tenantSlug?: string }): Promise<AuthTokenResponse> {
    return this.request<AuthTokenResponse>(
      '/v1/auth/login',
      {
        method: 'POST',
        body: JSON.stringify(input)
      },
      false
    );
  }

  refresh(refreshToken: string): Promise<AuthTokenResponse> {
    return this.request<AuthTokenResponse>(
      '/v1/auth/refresh',
      {
        method: 'POST',
        body: JSON.stringify({ refreshToken })
      },
      false
    );
  }

  me() {
    return this.request<{ id: string; email: string; role: string; tenantId: string; firstName?: string; lastName?: string }>('/v1/users/me');
  }

  listAssessments(params: { status?: string } = {}): Promise<PaginatedAssessments> {
    const query = new URLSearchParams();
    if (params.status) {
      query.set('status', params.status);
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.request<PaginatedAssessments>(`/v1/assessments${suffix}`);
  }

  createAssessment(input: { name: string; slug: string; description?: string }): Promise<Assessment> {
    return this.request<Assessment>('/v1/assessments', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  updateAssessment(assessmentId: string, input: Partial<Pick<Assessment, 'name' | 'slug' | 'description' | 'status'>>): Promise<Assessment> {
    return this.request<Assessment>(`/v1/assessments/${assessmentId}`, {
      method: 'PATCH',
      body: JSON.stringify(input)
    });
  }

  listVersions(assessmentId: string): Promise<{ data: AssessmentVersion[] }> {
    return this.request<{ data: AssessmentVersion[] }>(`/v1/assessments/${assessmentId}/versions`);
  }

  createVersion(assessmentId: string, input: { title: string; copyFromVersionId?: string }): Promise<AssessmentVersion> {
    return this.request<AssessmentVersion>(`/v1/assessments/${assessmentId}/versions`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  getVersion(versionId: string): Promise<AssessmentVersion> {
    return this.request<AssessmentVersion>(`/v1/versions/${versionId}`);
  }

  updateVersion(
    versionId: string,
    input: Partial<
      Pick<AssessmentVersion, 'title' | 'introCopy' | 'outroCopy' | 'leadCaptureMode' | 'leadCaptureStep' | 'runtimeSettings'>
    >
  ): Promise<AssessmentVersion> {
    return this.request<AssessmentVersion>(`/v1/versions/${versionId}`, {
      method: 'PATCH',
      body: JSON.stringify(input)
    });
  }

  publishVersion(versionId: string): Promise<AssessmentVersion> {
    return this.request<AssessmentVersion>(`/v1/versions/${versionId}/publish`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  }

  getLanding(versionId: string): Promise<LandingPage> {
    return this.request<LandingPage>(`/v1/versions/${versionId}/landing`);
  }

  updateLanding(versionId: string, input: { seoTitle?: string; seoDescription?: string; theme?: Record<string, unknown> }): Promise<LandingPage> {
    return this.request<LandingPage>(`/v1/versions/${versionId}/landing`, {
      method: 'PUT',
      body: JSON.stringify(input)
    });
  }

  listBlocks(versionId: string): Promise<{ data: PageBlock[] }> {
    return this.request<{ data: PageBlock[] }>(`/v1/versions/${versionId}/landing/blocks`);
  }

  createBlock(versionId: string, input: { type: string; position: number; config: Record<string, unknown> }): Promise<PageBlock> {
    return this.request<PageBlock>(`/v1/versions/${versionId}/landing/blocks`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  updateBlock(blockId: string, input: { type?: string; position?: number; config?: Record<string, unknown>; isVisible?: boolean }): Promise<PageBlock> {
    return this.request<PageBlock>(`/v1/landing/blocks/${blockId}`, {
      method: 'PATCH',
      body: JSON.stringify(input)
    });
  }

  deleteBlock(blockId: string): Promise<void> {
    return this.request<void>(`/v1/landing/blocks/${blockId}`, {
      method: 'DELETE'
    });
  }

  listQuestions(versionId: string): Promise<{ data: Question[] }> {
    return this.request<{ data: Question[] }>(`/v1/versions/${versionId}/questions`);
  }

  createQuestion(
    versionId: string,
    input: {
      type: Question['type'];
      prompt: string;
      helpText?: string;
      isRequired?: boolean;
      position: number;
      weight?: number;
      minValue?: number;
      maxValue?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Question> {
    return this.request<Question>(`/v1/versions/${versionId}/questions`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  updateQuestion(questionId: string, input: Partial<Question>): Promise<Question> {
    return this.request<Question>(`/v1/questions/${questionId}`, {
      method: 'PATCH',
      body: JSON.stringify(input)
    });
  }

  deleteQuestion(questionId: string): Promise<void> {
    return this.request<void>(`/v1/questions/${questionId}`, {
      method: 'DELETE'
    });
  }

  listOptions(questionId: string): Promise<{ data: AnswerOption[] }> {
    return this.request<{ data: AnswerOption[] }>(`/v1/questions/${questionId}/options`);
  }

  createOption(
    questionId: string,
    input: { label: string; value: string; scoreValue: number; position: number; metadata?: Record<string, unknown> }
  ): Promise<AnswerOption> {
    return this.request<AnswerOption>(`/v1/questions/${questionId}/options`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  updateOption(optionId: string, input: Partial<AnswerOption>): Promise<AnswerOption> {
    return this.request<AnswerOption>(`/v1/answer-options/${optionId}`, {
      method: 'PATCH',
      body: JSON.stringify(input)
    });
  }

  deleteOption(optionId: string): Promise<void> {
    return this.request<void>(`/v1/answer-options/${optionId}`, {
      method: 'DELETE'
    });
  }

  listLogicRules(versionId: string): Promise<{ data: LogicRule[] }> {
    return this.request<{ data: LogicRule[] }>(`/v1/versions/${versionId}/logic-rules`);
  }

  createLogicRule(
    versionId: string,
    input: {
      name: string;
      priority?: number;
      ifExpression: Record<string, unknown>;
      thenAction: Record<string, unknown>;
      isActive?: boolean;
    }
  ): Promise<LogicRule> {
    return this.request<LogicRule>(`/v1/versions/${versionId}/logic-rules`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  updateLogicRule(ruleId: string, input: Partial<LogicRule>): Promise<LogicRule> {
    return this.request<LogicRule>(`/v1/logic-rules/${ruleId}`, {
      method: 'PATCH',
      body: JSON.stringify(input)
    });
  }

  deleteLogicRule(ruleId: string): Promise<void> {
    return this.request<void>(`/v1/logic-rules/${ruleId}`, {
      method: 'DELETE'
    });
  }

  getReportTemplate(versionId: string): Promise<ReportTemplate> {
    return this.request<ReportTemplate>(`/v1/versions/${versionId}/report-template`);
  }

  upsertReportTemplate(
    versionId: string,
    input: { title: string; headerContent?: Record<string, unknown>; footerContent?: Record<string, unknown> }
  ): Promise<ReportTemplate> {
    return this.request<ReportTemplate>(`/v1/versions/${versionId}/report-template`, {
      method: 'PUT',
      body: JSON.stringify(input)
    });
  }

  createReportSection(
    templateId: string,
    input: {
      sectionKey: string;
      title: string;
      bodyTemplate: string;
      displayCondition?: Record<string, unknown>;
      position: number;
    }
  ): Promise<ReportSection> {
    return this.request<ReportSection>(`/v1/report-templates/${templateId}/sections`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  updateReportSection(
    sectionId: string,
    input: Partial<Pick<ReportSection, 'title' | 'bodyTemplate' | 'displayCondition' | 'position'>>
  ): Promise<ReportSection> {
    return this.request<ReportSection>(`/v1/report-sections/${sectionId}`, {
      method: 'PATCH',
      body: JSON.stringify(input)
    });
  }

  deleteReportSection(sectionId: string): Promise<void> {
    return this.request<void>(`/v1/report-sections/${sectionId}`, {
      method: 'DELETE'
    });
  }

  getAnalyticsSummary(assessmentId: string): Promise<AnalyticsSummary> {
    return this.request<AnalyticsSummary>(`/v1/analytics/assessments/${assessmentId}/summary`);
  }

  getAnalyticsDropoff(assessmentId: string): Promise<{ data: DropoffMetric[] }> {
    return this.request<{ data: DropoffMetric[] }>(`/v1/analytics/assessments/${assessmentId}/dropoff`);
  }

  listWebhooks(): Promise<{ data: WebhookEndpoint[] }> {
    return this.request<{ data: WebhookEndpoint[] }>('/v1/integrations/webhooks');
  }

  createWebhook(input: {
    name: string;
    targetUrl: string;
    secret: string;
    subscribedEvents: Array<'lead.created' | 'session.completed' | 'pdf.generated'>;
  }): Promise<WebhookEndpoint> {
    return this.request<WebhookEndpoint>('/v1/integrations/webhooks', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  updateWebhook(
    endpointId: string,
    input: {
      name?: string;
      targetUrl?: string;
      secret?: string;
      subscribedEvents?: Array<'lead.created' | 'session.completed' | 'pdf.generated'>;
      isActive?: boolean;
    }
  ): Promise<WebhookEndpoint> {
    return this.request<WebhookEndpoint>(`/v1/integrations/webhooks/${endpointId}`, {
      method: 'PATCH',
      body: JSON.stringify(input)
    });
  }

  deleteWebhook(endpointId: string): Promise<void> {
    return this.request<void>(`/v1/integrations/webhooks/${endpointId}`, {
      method: 'DELETE'
    });
  }

  async exportLeadsCsv(assessmentId: string): Promise<string> {
    const headers = new Headers();
    if (this.accessToken) {
      headers.set('authorization', `Bearer ${this.accessToken}`);
    }
    const response = await fetch(this.buildUrl(`/v1/assessments/${assessmentId}/leads/export`), {
      method: 'GET',
      headers
    });
    if (!response.ok) {
      let payload: ApiErrorPayload | undefined;
      try {
        payload = (await response.json()) as ApiErrorPayload;
      } catch {
        payload = undefined;
      }
      throw new ApiError(response.status, payload);
    }
    return response.text();
  }

  getPublicBootstrap(slug: string): Promise<PublicBootstrapResponse> {
    return this.request<PublicBootstrapResponse>(`/v1/public/${encodeURIComponent(slug)}/bootstrap`, {}, false);
  }

  startPublicSession(slug: string, input: { utm?: Record<string, string> } = {}): Promise<Session> {
    return this.request<Session>(
      `/v1/public/${encodeURIComponent(slug)}/sessions`,
      {
        method: 'POST',
        body: JSON.stringify(input)
      },
      false
    );
  }

  upsertLead(sessionId: string, input: {
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    company?: string;
    consent: boolean;
    customFields?: Record<string, unknown>;
  }): Promise<Lead> {
    return this.request<Lead>(
      `/v1/sessions/${sessionId}/lead`,
      {
        method: 'POST',
        body: JSON.stringify(input),
        headers: {
          'idempotency-key': `lead-${sessionId}`
        }
      },
      false
    );
  }

  upsertResponse(sessionId: string, input: { questionId: string; answer: ResponseAnswer }): Promise<ResponseRecord> {
    return this.request<ResponseRecord>(
      `/v1/sessions/${sessionId}/responses`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
        headers: {
          'idempotency-key': `resp-${sessionId}-${input.questionId}`
        }
      },
      false
    );
  }

  completeSession(sessionId: string): Promise<Result> {
    return this.request<Result>(
      `/v1/sessions/${sessionId}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
          'idempotency-key': `complete-${sessionId}`
        }
      },
      false
    );
  }

  getResult(sessionId: string): Promise<Result> {
    return this.request<Result>(`/v1/sessions/${sessionId}/result`, {}, false);
  }

  queuePdf(sessionId: string, input: { emailTo?: string } = {}): Promise<PdfJob> {
    return this.request<PdfJob>(
      `/v1/sessions/${sessionId}/pdf`,
      {
        method: 'POST',
        body: JSON.stringify(input)
      },
      false
    );
  }

  getPdfJob(jobId: string): Promise<PdfJob> {
    return this.request<PdfJob>(`/v1/pdf-jobs/${jobId}`, {}, false);
  }
}
