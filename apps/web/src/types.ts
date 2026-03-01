export type UserRole = 'owner' | 'editor' | 'analyst' | 'viewer';
export type AssessmentStatus = 'draft' | 'published' | 'archived';
export type QuestionType = 'single_choice' | 'multi_choice' | 'scale' | 'numeric' | 'short_text';
export type SessionStatus = 'in_progress' | 'completed' | 'abandoned';
export type PdfJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface ApiErrorPayload {
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  status: string;
  firstName?: string;
  lastName?: string;
  createdAt: string;
}

export interface AuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
}

export interface Assessment {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description?: string;
  status: AssessmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Pagination {
  nextCursor?: string;
  hasMore: boolean;
}

export interface PaginatedAssessments {
  data: Assessment[];
  pagination: Pagination;
}

export interface AssessmentVersion {
  id: string;
  assessmentId: string;
  versionNo: number;
  isPublished: boolean;
  publishedAt?: string;
  title: string;
  introCopy?: string;
  outroCopy?: string;
  leadCaptureMode: 'start' | 'middle' | 'before_results';
  leadCaptureStep?: number;
  runtimeSettings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PageBlock {
  id: string;
  type: string;
  position: number;
  config: Record<string, unknown>;
  isVisible: boolean;
}

export interface LandingPage {
  id: string;
  assessmentVersionId: string;
  seoTitle?: string;
  seoDescription?: string;
  theme: Record<string, unknown>;
  blocks: PageBlock[];
}

export interface AnswerOption {
  id: string;
  questionId: string;
  label: string;
  value: string;
  scoreValue: number;
  position: number;
  metadata: Record<string, unknown>;
}

export interface Question {
  id: string;
  assessmentVersionId: string;
  type: QuestionType;
  prompt: string;
  helpText?: string;
  isRequired: boolean;
  position: number;
  weight: number;
  minValue?: number;
  maxValue?: number;
  metadata: Record<string, unknown>;
  options?: AnswerOption[];
}

export interface LogicRule {
  id: string;
  assessmentVersionId: string;
  name: string;
  priority: number;
  ifExpression: Record<string, unknown>;
  thenAction: Record<string, unknown>;
  isActive: boolean;
}

export interface ReportSection {
  id: string;
  reportTemplateId: string;
  sectionKey: string;
  title: string;
  bodyTemplate: string;
  displayCondition: Record<string, unknown>;
  position: number;
}

export interface ReportTemplate {
  id: string;
  assessmentVersionId: string;
  title: string;
  headerContent: Record<string, unknown>;
  footerContent: Record<string, unknown>;
  sections: ReportSection[];
}

export interface AnalyticsSummary {
  assessmentId: string;
  dateFrom: string;
  dateTo: string;
  visits: number;
  starts: number;
  completions: number;
  leads: number;
  conversionRate: number;
  averageScore?: number;
}

export interface DropoffMetric {
  questionId: string;
  questionPrompt?: string;
  views: number;
  exits: number;
  dropoffRate: number;
}

export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  name: string;
  targetUrl: string;
  subscribedEvents: Array<'lead.created' | 'session.completed' | 'pdf.generated'>;
  isActive: boolean;
}

export interface Session {
  id: string;
  assessmentId: string;
  assessmentVersionId: string;
  leadId?: string;
  status: SessionStatus;
  currentQuestionPosition?: number;
  startedAt: string;
  completedAt?: string;
}

export interface Lead {
  id: string;
  tenantId: string;
  assessmentId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  company?: string;
  customFields: Record<string, unknown>;
  consent: boolean;
  consentAt?: string;
  createdAt: string;
}

export type ResponseAnswer = string | number | string[] | Record<string, unknown>;

export interface ResponseRecord {
  id: string;
  sessionId: string;
  questionId: string;
  answer: ResponseAnswer;
  computedScore: number;
  answeredAt: string;
}

export interface ScoreBand {
  id: string;
  assessmentVersionId: string;
  label: string;
  minScore: number;
  maxScore: number;
  colorHex?: string;
  summary?: string;
  recommendationTemplate?: string;
  position: number;
}

export interface Result {
  sessionId: string;
  rawScore: number;
  normalizedScore: number;
  maxPossibleRawScore: number;
  scoreBand?: ScoreBand;
  breakdown: Record<string, unknown>;
  recommendations: string[];
  generatedReport: Record<string, unknown>;
  finalizedAt: string;
}

export interface PdfJob {
  id: string;
  sessionId: string;
  status: PdfJobStatus;
  storageKey?: string;
  fileUrl?: string;
  errorMessage?: string;
  attemptCount: number;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PublicBootstrapResponse {
  assessmentId: string;
  assessmentVersionId: string;
  landing: LandingPage;
  questions: Question[];
  logicRules: LogicRule[];
  leadCaptureMode: 'start' | 'middle' | 'before_results';
  leadCaptureStep?: number;
}
