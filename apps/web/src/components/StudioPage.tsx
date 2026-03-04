import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiClient, ApiError } from '../lib/api';
import type {
  AnalyticsSummary,
  AnswerOption,
  Assessment,
  AssessmentStatus,
  AssessmentVersion,
  DropoffMetric,
  LandingPage,
  LogicRule,
  PageBlock,
  Question,
  QuestionType,
  ReportTemplate,
  WebhookEndpoint
} from '../types';

interface StudioPageProps {
  api: ApiClient;
  apiBaseUrl: string;
  userEmail: string;
  tenantSlug?: string;
  onLogout: () => void;
}

type Notice = { type: 'success' | 'error' | 'info'; message: string } | null;

type StudioView =
  | 'home'
  | 'leads'
  | 'insights.overview'
  | 'insights.answers'
  | 'insights.questions'
  | 'insights.scores'
  | 'insights.landing'
  | 'audiences'
  | 'build.landing'
  | 'build.questions'
  | 'build.results'
  | 'build.pdf'
  | 'share'
  | 'integrate'
  | 'experiments'
  | 'settings.general'
  | 'settings.branding'
  | 'settings.share'
  | 'settings.lead'
  | 'settings.notifications'
  | 'settings.scoreTiers'
  | 'settings.resultEmail'
  | 'settings.abandonEmail'
  | 'settings.tracking';

interface LeadPreviewRow {
  leadId: string;
  name: string;
  email: string;
  createdAt: string;
  sessionStatus: string;
  score: string;
}

const QUESTION_TYPES: QuestionType[] = ['single_choice', 'multi_choice', 'scale', 'numeric', 'short_text'];
const WEBHOOK_EVENTS: Array<'lead.created' | 'session.completed' | 'pdf.generated'> = ['lead.created', 'session.completed', 'pdf.generated'];
const ANSWER_RING_CLASSES = ['ring-blue', 'ring-cyan', 'ring-royal', 'ring-violet', 'ring-gold', 'ring-coral'];

type LogicAction = 'tag' | 'skip_to_position';

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.payload?.code ? `${error.payload.code}: ` : '';
    return `${code}${error.payload?.message ?? error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error';
}

function stringifyPretty(input: unknown): string {
  return JSON.stringify(input ?? {}, null, 2);
}

function parseJsonObject(text: string, fieldName: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

function downloadText(content: string, filename: string, mimeType = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatPercent(value: number): string {
  return `${Number.isFinite(value) ? value.toFixed(1) : '0.0'}%`;
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return '-';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }
  return parsed.toLocaleDateString();
}

function humanizeQuestionType(value: QuestionType): string {
  return value
    .split('_')
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(' ');
}

function emailToName(email: string): string {
  const localPart = email.split('@')[0] ?? email;
  const clean = localPart.replace(/[._-]+/g, ' ').trim();
  if (!clean) {
    return 'there';
  }
  return clean
    .split(' ')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function initialsFromEmail(email: string): string {
  const name = emailToName(email);
  const words = name.split(' ').filter(Boolean);
  if (words.length === 0) {
    return 'U';
  }
  const first = words[0]?.charAt(0) ?? '';
  const second = words[1]?.charAt(0) ?? '';
  return `${first}${second}`.toUpperCase();
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];

    if (char === '"') {
      const next = csv[index + 1];
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && csv[index + 1] === '\n') {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((cellValue) => cellValue.trim().length > 0));
}

function parseLeadPreviewRows(csv: string): LeadPreviewRow[] {
  const parsed = parseCsvRows(csv);
  if (parsed.length === 0) {
    return [];
  }

  const headers = parsed[0].map((value) => value.trim());

  const indexOf = (header: string): number => headers.findIndex((value) => value === header);

  const leadIdIndex = indexOf('leadId');
  const firstNameIndex = indexOf('firstName');
  const lastNameIndex = indexOf('lastName');
  const emailIndex = indexOf('email');
  const createdAtIndex = indexOf('createdAt');
  const scoreIndex = indexOf('normalizedScore');
  const statusIndex = indexOf('latestSessionStatus');

  return parsed.slice(1).map((row, rowIndex) => {
    const firstName = (row[firstNameIndex] ?? '').trim();
    const lastName = (row[lastNameIndex] ?? '').trim();
    const email = (row[emailIndex] ?? '').trim();
    const name = [firstName, lastName].filter(Boolean).join(' ') || email || 'Unknown lead';

    return {
      leadId: row[leadIdIndex] ?? `row-${rowIndex}`,
      name,
      email,
      createdAt: row[createdAtIndex] ?? '',
      sessionStatus: row[statusIndex] ?? 'n/a',
      score: row[scoreIndex] ?? ''
    };
  });
}

export function StudioPage(props: StudioPageProps) {
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState('');

  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [selectedAssessmentId, setSelectedAssessmentId] = useState('');

  const [versions, setVersions] = useState<AssessmentVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState('');

  const [analyticsSummary, setAnalyticsSummary] = useState<AnalyticsSummary | null>(null);
  const [dropoffMetrics, setDropoffMetrics] = useState<DropoffMetric[]>([]);

  const [newAssessmentName, setNewAssessmentName] = useState('');
  const [newAssessmentSlug, setNewAssessmentSlug] = useState('');
  const [assessmentName, setAssessmentName] = useState('');
  const [assessmentSlug, setAssessmentSlug] = useState('');
  const [assessmentStatus, setAssessmentStatus] = useState<AssessmentStatus>('draft');

  const [newVersionTitle, setNewVersionTitle] = useState('Version 1');
  const [copyFromVersionId, setCopyFromVersionId] = useState('');

  const [versionTitle, setVersionTitle] = useState('');
  const [versionIntro, setVersionIntro] = useState('');
  const [versionOutro, setVersionOutro] = useState('');
  const [versionLeadMode, setVersionLeadMode] = useState<'start' | 'middle' | 'before_results'>('before_results');
  const [versionRuntimeSettings, setVersionRuntimeSettings] = useState('{}');

  const [landing, setLanding] = useState<LandingPage | null>(null);
  const [landingBlocks, setLandingBlocks] = useState<PageBlock[]>([]);
  const [landingSeoTitle, setLandingSeoTitle] = useState('');
  const [landingSeoDescription, setLandingSeoDescription] = useState('');
  const [landingAccent, setLandingAccent] = useState('blue');
  const [heroHeadline, setHeroHeadline] = useState('');
  const [heroCtaLabel, setHeroCtaLabel] = useState('Start Assessment');

  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedQuestionId, setSelectedQuestionId] = useState('');
  const [questionOptions, setQuestionOptions] = useState<AnswerOption[]>([]);

  const [newQuestionPrompt, setNewQuestionPrompt] = useState('');
  const [newQuestionType, setNewQuestionType] = useState<QuestionType>('single_choice');
  const [newQuestionWeight, setNewQuestionWeight] = useState('1');

  const [questionPrompt, setQuestionPrompt] = useState('');
  const [questionType, setQuestionType] = useState<QuestionType>('single_choice');
  const [questionWeight, setQuestionWeight] = useState('1');
  const [questionRequired, setQuestionRequired] = useState(true);
  const [questionPosition, setQuestionPosition] = useState('1');

  const [newOptionLabel, setNewOptionLabel] = useState('');
  const [newOptionValue, setNewOptionValue] = useState('');
  const [newOptionScore, setNewOptionScore] = useState('0');

  const [logicRules, setLogicRules] = useState<LogicRule[]>([]);
  const [ruleName, setRuleName] = useState('Rule 1');
  const [ruleQuestionId, setRuleQuestionId] = useState('');
  const [ruleEquals, setRuleEquals] = useState('');
  const [ruleActionType, setRuleActionType] = useState<LogicAction>('tag');
  const [ruleActionValue, setRuleActionValue] = useState('');

  const [reportTemplate, setReportTemplate] = useState<ReportTemplate | null>(null);
  const [reportTitle, setReportTitle] = useState('');
  const [reportHeaderJson, setReportHeaderJson] = useState('{}');
  const [reportFooterJson, setReportFooterJson] = useState('{}');
  const [newSectionKey, setNewSectionKey] = useState('summary');
  const [newSectionTitle, setNewSectionTitle] = useState('Summary');
  const [newSectionBody, setNewSectionBody] = useState('Your score is {{score}}.');

  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [newWebhookName, setNewWebhookName] = useState('Primary webhook');
  const [newWebhookTarget, setNewWebhookTarget] = useState('https://hooks.example/score');
  const [newWebhookSecret, setNewWebhookSecret] = useState('');
  const [newWebhookEvents, setNewWebhookEvents] = useState<Array<'lead.created' | 'session.completed' | 'pdf.generated'>>(['lead.created']);

  const [activeView, setActiveView] = useState<StudioView>('home');
  const [insightsOpen, setInsightsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [leadPreviewRows, setLeadPreviewRows] = useState<LeadPreviewRow[]>([]);
  const [leadPreviewAssessmentId, setLeadPreviewAssessmentId] = useState('');
  const [leadSearch, setLeadSearch] = useState('');

  const selectedAssessment = useMemo(
    () => assessments.find((assessment) => assessment.id === selectedAssessmentId) ?? null,
    [assessments, selectedAssessmentId]
  );

  const selectedVersion = useMemo(
    () => versions.find((version) => version.id === selectedVersionId) ?? null,
    [versions, selectedVersionId]
  );

  const selectedQuestion = useMemo(
    () => questions.find((question) => question.id === selectedQuestionId) ?? null,
    [questions, selectedQuestionId]
  );

  const displayName = useMemo(() => emailToName(props.userEmail), [props.userEmail]);
  const userInitials = useMemo(() => initialsFromEmail(props.userEmail), [props.userEmail]);

  const clientLink = selectedAssessment ? `${window.location.origin}/run/${selectedAssessment.slug}` : `${window.location.origin}/run`;

  const startedCount = analyticsSummary?.starts ?? 0;
  const completedCount = analyticsSummary?.completions ?? 0;
  const visitsCount = analyticsSummary?.visits ?? 0;
  const leadCount = analyticsSummary?.leads ?? 0;
  const conversionPercent = (analyticsSummary?.conversionRate ?? 0) * 100;

  const questionWeightTotal = questions.reduce((sum, question) => sum + (Number.isFinite(question.weight) ? question.weight : 0), 0);

  const filteredLeadRows = useMemo(() => {
    const query = leadSearch.trim().toLowerCase();
    if (!query) {
      return leadPreviewRows;
    }
    return leadPreviewRows.filter((row) => row.name.toLowerCase().includes(query) || row.email.toLowerCase().includes(query));
  }, [leadPreviewRows, leadSearch]);

  const withTask = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try {
      await fn();
    } catch (error) {
      setNotice({ type: 'error', message: formatError(error) });
    } finally {
      setBusy('');
    }
  };

  const loadAssessments = async () => {
    const response = await props.api.listAssessments();
    setAssessments(response.data);
    if (!response.data.length) {
      setSelectedAssessmentId('');
      return;
    }

    const existing = response.data.find((assessment) => assessment.id === selectedAssessmentId);
    setSelectedAssessmentId(existing?.id ?? response.data[0].id);
  };

  const loadAssessmentContext = async (assessmentId: string) => {
    const [versionResult, summary, dropoff] = await Promise.all([
      props.api.listVersions(assessmentId),
      props.api.getAnalyticsSummary(assessmentId),
      props.api.getAnalyticsDropoff(assessmentId)
    ]);

    setVersions(versionResult.data);
    setAnalyticsSummary(summary);
    setDropoffMetrics(dropoff.data);

    if (!versionResult.data.length) {
      setSelectedVersionId('');
      return;
    }

    const existing = versionResult.data.find((version) => version.id === selectedVersionId);
    setSelectedVersionId(existing?.id ?? versionResult.data[0].id);
  };

  const loadQuestionsForVersion = async (versionId: string) => {
    const questionsResponse = await props.api.listQuestions(versionId);
    setQuestions(questionsResponse.data);

    if (!questionsResponse.data.length) {
      setSelectedQuestionId('');
      setQuestionOptions([]);
      return;
    }

    const existing = questionsResponse.data.find((question) => question.id === selectedQuestionId);
    setSelectedQuestionId(existing?.id ?? questionsResponse.data[0].id);
  };

  const loadVersionContext = async (versionId: string) => {
    const [version, landingResponse, blockResponse, logicResponse] = await Promise.all([
      props.api.getVersion(versionId),
      props.api.getLanding(versionId),
      props.api.listBlocks(versionId),
      props.api.listLogicRules(versionId)
    ]);

    setVersionTitle(version.title);
    setVersionIntro(version.introCopy ?? '');
    setVersionOutro(version.outroCopy ?? '');
    setVersionLeadMode(version.leadCaptureMode);
    setVersionRuntimeSettings(stringifyPretty(version.runtimeSettings));

    setLanding(landingResponse);
    setLandingBlocks(blockResponse.data);
    setLandingSeoTitle(landingResponse.seoTitle ?? '');
    setLandingSeoDescription(landingResponse.seoDescription ?? '');
    setLandingAccent(String(landingResponse.theme.accent ?? 'blue'));

    const heroBlock = blockResponse.data.find((block) => block.type === 'hero');
    setHeroHeadline(String(heroBlock?.config.headline ?? ''));
    setHeroCtaLabel(String(heroBlock?.config.ctaLabel ?? 'Start Assessment'));

    setLogicRules(logicResponse.data);

    try {
      const template = await props.api.getReportTemplate(versionId);
      setReportTemplate(template);
      setReportTitle(template.title);
      setReportHeaderJson(stringifyPretty(template.headerContent));
      setReportFooterJson(stringifyPretty(template.footerContent));
    } catch {
      setReportTemplate(null);
      setReportTitle(`${version.title} Report`);
      setReportHeaderJson('{}');
      setReportFooterJson('{}');
    }

    await loadQuestionsForVersion(versionId);
  };

  const loadQuestionOptions = async (questionId: string) => {
    if (!questionId) {
      setQuestionOptions([]);
      return;
    }
    const response = await props.api.listOptions(questionId);
    setQuestionOptions(response.data);
  };

  const loadWebhooks = async () => {
    const response = await props.api.listWebhooks();
    setWebhooks(response.data);
  };

  const loadLeadsPreview = async () => {
    if (!selectedAssessment) {
      throw new Error('Select an assessment first');
    }
    const csv = await props.api.exportLeadsCsv(selectedAssessment.id);
    setLeadPreviewRows(parseLeadPreviewRows(csv));
    setLeadPreviewAssessmentId(selectedAssessment.id);
  };

  useEffect(() => {
    void withTask('Loading workspace', async () => {
      await Promise.all([loadAssessments(), loadWebhooks()]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedAssessment) {
      return;
    }

    setAssessmentName(selectedAssessment.name);
    setAssessmentSlug(selectedAssessment.slug);
    setAssessmentStatus(selectedAssessment.status);

    void withTask('Loading assessment', async () => {
      await loadAssessmentContext(selectedAssessment.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAssessmentId]);

  useEffect(() => {
    if (!selectedVersionId) {
      return;
    }

    void withTask('Loading version', async () => {
      await loadVersionContext(selectedVersionId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersionId]);

  useEffect(() => {
    if (!selectedQuestion) {
      setQuestionPrompt('');
      setQuestionType('single_choice');
      setQuestionWeight('1');
      setQuestionRequired(true);
      setQuestionPosition('1');
      setQuestionOptions([]);
      return;
    }

    setQuestionPrompt(selectedQuestion.prompt);
    setQuestionType(selectedQuestion.type);
    setQuestionWeight(String(selectedQuestion.weight));
    setQuestionRequired(selectedQuestion.isRequired);
    setQuestionPosition(String(selectedQuestion.position));

    void withTask('Loading answer options', async () => {
      await loadQuestionOptions(selectedQuestion.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedQuestionId]);

  useEffect(() => {
    if (activeView !== 'leads' || !selectedAssessment) {
      return;
    }

    if (leadPreviewAssessmentId === selectedAssessment.id) {
      return;
    }

    void withTask('Loading leads preview', loadLeadsPreview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, selectedAssessmentId]);

  const createAssessment = async () => {
    if (!newAssessmentName.trim()) {
      throw new Error('Enter an assessment name');
    }

    const slug = newAssessmentSlug.trim() ? newAssessmentSlug.trim() : slugify(newAssessmentName);
    if (!slug) {
      throw new Error('Slug is required');
    }

    const created = await props.api.createAssessment({
      name: newAssessmentName.trim(),
      slug
    });

    setNotice({ type: 'success', message: `Assessment created: ${created.name}` });
    setNewAssessmentName('');
    setNewAssessmentSlug('');
    await loadAssessments();
    setSelectedAssessmentId(created.id);
  };

  const saveAssessment = async () => {
    if (!selectedAssessment) {
      throw new Error('Select an assessment first');
    }

    await props.api.updateAssessment(selectedAssessment.id, {
      name: assessmentName.trim(),
      slug: assessmentSlug.trim(),
      status: assessmentStatus
    });

    setNotice({ type: 'success', message: 'Assessment details saved' });
    await loadAssessments();
  };

  const createVersion = async () => {
    if (!selectedAssessment) {
      throw new Error('Select an assessment first');
    }

    const created = await props.api.createVersion(selectedAssessment.id, {
      title: newVersionTitle.trim() || 'Version',
      copyFromVersionId: copyFromVersionId.trim() || undefined
    });

    setNotice({ type: 'success', message: `Version created: ${created.title}` });
    setCopyFromVersionId('');
    await loadAssessmentContext(selectedAssessment.id);
    setSelectedVersionId(created.id);
  };

  const saveVersion = async () => {
    if (!selectedVersion) {
      throw new Error('Select a version first');
    }

    await props.api.updateVersion(selectedVersion.id, {
      title: versionTitle,
      introCopy: versionIntro || undefined,
      outroCopy: versionOutro || undefined,
      leadCaptureMode: versionLeadMode,
      runtimeSettings: parseJsonObject(versionRuntimeSettings, 'Runtime settings')
    });

    setNotice({ type: 'success', message: 'Version settings saved' });
    await loadVersionContext(selectedVersion.id);
  };

  const publishVersion = async () => {
    if (!selectedVersion) {
      throw new Error('Select a version first');
    }

    await props.api.publishVersion(selectedVersion.id);
    setNotice({ type: 'success', message: 'Version published. Client link is now live.' });

    if (selectedAssessment) {
      await loadAssessmentContext(selectedAssessment.id);
    }
    await loadVersionContext(selectedVersion.id);
  };

  const saveLanding = async () => {
    if (!selectedVersion || !landing) {
      throw new Error('Select a version first');
    }

    const nextTheme = {
      ...landing.theme,
      accent: landingAccent.trim() || 'blue'
    };

    await props.api.updateLanding(selectedVersion.id, {
      seoTitle: landingSeoTitle.trim() || undefined,
      seoDescription: landingSeoDescription.trim() || undefined,
      theme: nextTheme
    });

    const existingHero = landingBlocks.find((block) => block.type === 'hero');
    const heroConfig = {
      ...(existingHero?.config ?? {}),
      headline: heroHeadline,
      ctaLabel: heroCtaLabel
    };

    if (existingHero) {
      await props.api.updateBlock(existingHero.id, {
        type: existingHero.type,
        position: existingHero.position,
        isVisible: existingHero.isVisible,
        config: heroConfig
      });
    } else {
      const nextPosition = landingBlocks.reduce((max, block) => Math.max(max, block.position), 0) + 1;
      await props.api.createBlock(selectedVersion.id, {
        type: 'hero',
        position: nextPosition,
        config: heroConfig
      });
    }

    setNotice({ type: 'success', message: 'Landing page saved' });
    await loadVersionContext(selectedVersion.id);
  };

  const createQuestion = async () => {
    if (!selectedVersion) {
      throw new Error('Select a version first');
    }
    if (!newQuestionPrompt.trim()) {
      throw new Error('Question prompt is required');
    }

    const nextPosition = questions.reduce((max, question) => Math.max(max, question.position), 0) + 1;

    await props.api.createQuestion(selectedVersion.id, {
      type: newQuestionType,
      prompt: newQuestionPrompt.trim(),
      position: nextPosition,
      weight: Number(newQuestionWeight) || 1,
      isRequired: true
    });

    setNotice({ type: 'success', message: 'Question added' });
    setNewQuestionPrompt('');
    await loadQuestionsForVersion(selectedVersion.id);
  };

  const saveQuestion = async () => {
    if (!selectedQuestion) {
      throw new Error('Select a question first');
    }

    await props.api.updateQuestion(selectedQuestion.id, {
      prompt: questionPrompt,
      type: questionType,
      weight: Number(questionWeight) || 1,
      isRequired: questionRequired,
      position: Number(questionPosition) || selectedQuestion.position
    });

    setNotice({ type: 'success', message: 'Question updated' });
    if (selectedVersion) {
      await loadQuestionsForVersion(selectedVersion.id);
    }
  };

  const deleteQuestion = async () => {
    if (!selectedQuestion) {
      throw new Error('Select a question first');
    }

    await props.api.deleteQuestion(selectedQuestion.id);
    setNotice({ type: 'success', message: 'Question deleted' });
    if (selectedVersion) {
      await loadQuestionsForVersion(selectedVersion.id);
    }
  };

  const createOption = async () => {
    if (!selectedQuestion) {
      throw new Error('Select a question first');
    }

    if (!['single_choice', 'multi_choice'].includes(selectedQuestion.type)) {
      throw new Error('Options only apply to single_choice and multi_choice questions');
    }

    if (!newOptionLabel.trim() || !newOptionValue.trim()) {
      throw new Error('Option label and value are required');
    }

    const nextPosition = questionOptions.reduce((max, option) => Math.max(max, option.position), 0) + 1;

    await props.api.createOption(selectedQuestion.id, {
      label: newOptionLabel.trim(),
      value: newOptionValue.trim(),
      scoreValue: Number(newOptionScore) || 0,
      position: nextPosition
    });

    setNotice({ type: 'success', message: 'Answer option added' });
    setNewOptionLabel('');
    setNewOptionValue('');
    setNewOptionScore('0');
    await loadQuestionOptions(selectedQuestion.id);
  };

  const deleteOption = async (optionId: string) => {
    await props.api.deleteOption(optionId);
    setNotice({ type: 'success', message: 'Answer option removed' });
    if (selectedQuestion) {
      await loadQuestionOptions(selectedQuestion.id);
    }
  };

  const createRule = async () => {
    if (!selectedVersion) {
      throw new Error('Select a version first');
    }
    if (!ruleQuestionId || !ruleEquals.trim() || !ruleActionValue.trim()) {
      throw new Error('Complete the rule fields first');
    }

    const thenAction =
      ruleActionType === 'tag'
        ? {
            action: 'tag',
            tag: ruleActionValue.trim()
          }
        : {
            action: 'skip_to_position',
            position: Number(ruleActionValue)
          };

    await props.api.createLogicRule(selectedVersion.id, {
      name: ruleName.trim() || 'Rule',
      priority: 100,
      ifExpression: {
        questionId: ruleQuestionId,
        equals: ruleEquals.trim()
      },
      thenAction,
      isActive: true
    });

    setNotice({ type: 'success', message: 'Logic rule created' });
    const rules = await props.api.listLogicRules(selectedVersion.id);
    setLogicRules(rules.data);
  };

  const deleteRule = async (ruleId: string) => {
    await props.api.deleteLogicRule(ruleId);
    setNotice({ type: 'success', message: 'Logic rule removed' });
    if (selectedVersion) {
      const rules = await props.api.listLogicRules(selectedVersion.id);
      setLogicRules(rules.data);
    }
  };

  const saveReportTemplate = async () => {
    if (!selectedVersion) {
      throw new Error('Select a version first');
    }

    const updated = await props.api.upsertReportTemplate(selectedVersion.id, {
      title: reportTitle.trim() || `${selectedVersion.title} Report`,
      headerContent: parseJsonObject(reportHeaderJson, 'Report header'),
      footerContent: parseJsonObject(reportFooterJson, 'Report footer')
    });

    setReportTemplate(updated);
    setNotice({ type: 'success', message: 'Report template saved' });
  };

  const addReportSection = async () => {
    if (!reportTemplate) {
      throw new Error('Save the report template first');
    }

    await props.api.createReportSection(reportTemplate.id, {
      sectionKey: newSectionKey.trim(),
      title: newSectionTitle.trim(),
      bodyTemplate: newSectionBody.trim(),
      position: reportTemplate.sections.length + 1,
      displayCondition: {}
    });

    const refreshed = await props.api.getReportTemplate(reportTemplate.assessmentVersionId);
    setReportTemplate(refreshed);
    setNotice({ type: 'success', message: 'Report section added' });
  };

  const deleteReportSection = async (sectionId: string) => {
    await props.api.deleteReportSection(sectionId);
    if (selectedVersion) {
      const refreshed = await props.api.getReportTemplate(selectedVersion.id);
      setReportTemplate(refreshed);
    }
    setNotice({ type: 'success', message: 'Report section removed' });
  };

  const refreshAnalytics = async () => {
    if (!selectedAssessment) {
      throw new Error('Select an assessment first');
    }

    const [summary, dropoff] = await Promise.all([
      props.api.getAnalyticsSummary(selectedAssessment.id),
      props.api.getAnalyticsDropoff(selectedAssessment.id)
    ]);

    setAnalyticsSummary(summary);
    setDropoffMetrics(dropoff.data);
    setNotice({ type: 'success', message: 'Analytics refreshed' });
  };

  const downloadLeadsCsv = async () => {
    if (!selectedAssessment) {
      throw new Error('Select an assessment first');
    }

    const csv = await props.api.exportLeadsCsv(selectedAssessment.id);
    downloadText(csv, `${selectedAssessment.slug}-leads.csv`, 'text/csv;charset=utf-8');
    setNotice({ type: 'success', message: 'CSV downloaded' });
  };

  const createWebhook = async () => {
    if (!newWebhookName.trim() || !newWebhookTarget.trim() || !newWebhookSecret.trim()) {
      throw new Error('Webhook name, target URL, and secret are required');
    }

    await props.api.createWebhook({
      name: newWebhookName.trim(),
      targetUrl: newWebhookTarget.trim(),
      secret: newWebhookSecret,
      subscribedEvents: newWebhookEvents
    });

    setNotice({ type: 'success', message: 'Webhook created' });
    setNewWebhookSecret('');
    await loadWebhooks();
  };

  const toggleWebhook = async (endpoint: WebhookEndpoint) => {
    await props.api.updateWebhook(endpoint.id, {
      isActive: !endpoint.isActive
    });
    await loadWebhooks();
  };

  const deleteWebhook = async (endpointId: string) => {
    await props.api.deleteWebhook(endpointId);
    await loadWebhooks();
    setNotice({ type: 'success', message: 'Webhook deleted' });
  };

  const toggleEvent = (eventName: 'lead.created' | 'session.completed' | 'pdf.generated') => {
    setNewWebhookEvents((current) => {
      if (current.includes(eventName)) {
        return current.filter((value) => value !== eventName);
      }
      return [...current, eventName];
    });
  };

  const copyClientLink = async () => {
    try {
      await navigator.clipboard.writeText(clientLink);
      setNotice({ type: 'success', message: 'Client link copied' });
    } catch {
      setNotice({ type: 'info', message: 'Copy is not available in this browser. You can copy manually.' });
    }
  };

  const setInsightsView = (view: Extract<StudioView, `insights.${string}`>) => {
    setActiveView(view);
    setInsightsOpen(true);
  };

  const setSettingsView = (view: Extract<StudioView, `settings.${string}`>) => {
    setActiveView(view);
    setSettingsOpen(true);
  };

  const renderHome = () => {
    return (
      <>
        <section className="studio-view-head">
          <h1>Good morning, {displayName}</h1>
          <p>Monitor visits, leads, conversion, and publishing status in one workspace.</p>
        </section>

        <section className="content-grid two-col">
          <article className="panel-card highlight-card">
            <div className="card-row">
              <div className="card-thumbnail" aria-hidden>
                {selectedAssessment?.name?.slice(0, 1).toUpperCase() ?? 'Q'}
              </div>
              <div>
                <span className="status-pill live">LIVE</span>
                <h2>{selectedAssessment?.name ?? 'Select an assessment'}</h2>
                <p className="muted">{clientLink}</p>
              </div>
            </div>
            <div className="button-row">
              <button className="btn" type="button" onClick={() => void withTask('Copying link', copyClientLink)}>
                Copy link
              </button>
              <a className="btn btn-secondary" href={clientLink} target="_blank" rel="noreferrer">
                Open live page
              </a>
              <button className="btn" type="button" onClick={() => setActiveView('share')}>
                Embed and share
              </button>
            </div>
          </article>

          <article className="panel-card">
            <h3>Performance snapshot</h3>
            <div className="metric-grid six-up">
              <div>
                <span className="metric-label">Visitors</span>
                <strong>{visitsCount}</strong>
              </div>
              <div>
                <span className="metric-label">Starts</span>
                <strong>{startedCount}</strong>
              </div>
              <div>
                <span className="metric-label">Leads</span>
                <strong>{leadCount}</strong>
              </div>
              <div>
                <span className="metric-label">Completions</span>
                <strong>{completedCount}</strong>
              </div>
              <div>
                <span className="metric-label">Conversion</span>
                <strong>{formatPercent(conversionPercent)}</strong>
              </div>
              <div>
                <span className="metric-label">Average score</span>
                <strong>{analyticsSummary?.averageScore ?? 0}</strong>
              </div>
            </div>
            <div className="button-row">
              <button className="btn" type="button" onClick={() => void withTask('Refreshing analytics', refreshAnalytics)}>
                Refresh analytics
              </button>
              <button className="btn" type="button" onClick={() => setInsightsView('insights.overview')}>
                View insights
              </button>
            </div>
          </article>
        </section>

        <section className="content-grid two-col">
          <article className="panel-card promo-card">
            <h3>Share your scorecard</h3>
            <p>Use your live link, embed options, and social channels to drive traffic to your assessment.</p>
            <button className="btn btn-primary" type="button" onClick={() => setActiveView('share')}>
              Open share tools
            </button>
          </article>

          <article className="panel-card">
            <h3>Daily leads trend</h3>
            <div className="sparkline">
              {Array.from({ length: 24 }).map((_, index) => {
                const height = 12 + (index % 8) * 4 + (index % 3 === 0 ? 12 : 0);
                return <span key={`spark-${index}`} style={{ height }} />;
              })}
            </div>
            <p className="muted">Simple trend preview. Use Insights for detailed analytics by question and category.</p>
          </article>
        </section>
      </>
    );
  };

  const renderLeads = () => {
    return (
      <>
        <section className="studio-view-head with-action">
          <div>
            <h1>Leads</h1>
            <p>Review recent leads and export full CSV.</p>
          </div>
          <div className="button-row">
            <button className="btn" type="button" onClick={() => void withTask('Refreshing leads preview', loadLeadsPreview)}>
              Refresh preview
            </button>
            <button className="btn btn-primary" type="button" onClick={() => void withTask('Exporting CSV', downloadLeadsCsv)}>
              Export
            </button>
          </div>
        </section>

        <article className="panel-card">
          <div className="toolbar-row">
            <input
              value={leadSearch}
              onChange={(event) => setLeadSearch(event.target.value)}
              placeholder="Search name or email"
              aria-label="Search leads"
            />
            <span className="muted small">{filteredLeadRows.length} result{filteredLeadRows.length === 1 ? '' : 's'}</span>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {filteredLeadRows.map((row) => (
                  <tr key={row.leadId}>
                    <td>{row.name}</td>
                    <td>{row.email || '-'}</td>
                    <td>{formatDate(row.createdAt)}</td>
                    <td>{row.sessionStatus || '-'}</td>
                    <td>{row.score || '-'}</td>
                  </tr>
                ))}
                {!filteredLeadRows.length ? (
                  <tr>
                    <td colSpan={5} className="table-empty">
                      No leads found in the current date range.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </article>
      </>
    );
  };

  const renderInsightsOverview = () => {
    return (
      <>
        <section className="studio-view-head with-action">
          <div>
            <h1>Overview</h1>
            <p>Key conversion and completion metrics for this scorecard.</p>
          </div>
          <button className="btn" type="button" onClick={() => void withTask('Refreshing analytics', refreshAnalytics)}>
            Refresh
          </button>
        </section>

        <section className="content-grid two-col">
          <article className="panel-card">
            <h3>Total leads</h3>
            <div className="split-donut">
              <div className="split-donut-ring">
                <span>Started {startedCount}</span>
                <span>Finished {completedCount}</span>
              </div>
            </div>
          </article>

          <article className="panel-card">
            <h3>Daily leads</h3>
            <div className="line-grid" aria-hidden>
              {Array.from({ length: 10 }).map((_, rowIndex) => (
                <span key={`line-${rowIndex}`} />
              ))}
              <div className="line-grid-trace" />
            </div>
          </article>
        </section>

        <section className="content-grid four-col">
          <article className="panel-card compact">
            <span className="metric-label">Visitors</span>
            <strong>{visitsCount}</strong>
          </article>
          <article className="panel-card compact">
            <span className="metric-label">Conversion rate</span>
            <strong>{formatPercent(conversionPercent)}</strong>
          </article>
          <article className="panel-card compact">
            <span className="metric-label">Average score</span>
            <strong>{analyticsSummary?.averageScore ?? 0}</strong>
          </article>
          <article className="panel-card compact">
            <span className="metric-label">Average completion</span>
            <strong>{completedCount > 0 ? '0m:16s' : '0m:00s'}</strong>
          </article>
        </section>
      </>
    );
  };

  const renderInsightsAnswers = () => {
    return (
      <>
        <section className="studio-view-head">
          <h1>Answers</h1>
          <p>Question-level answer snapshots and qualitative signals.</p>
        </section>

        <section className="answers-grid">
          {questions.slice(0, 12).map((question, index) => {
            const ringClass = ANSWER_RING_CLASSES[index % ANSWER_RING_CLASSES.length] ?? ANSWER_RING_CLASSES[0];
            const firstOption = question.options?.[0]?.label;
            return (
              <article className="panel-card answer-card" key={question.id}>
                <h3>{question.prompt}</h3>
                <div className={`answer-ring ${ringClass}`}>
                  <span>100%</span>
                </div>
                <p className="muted">{firstOption ?? 'Response distribution appears when session-level answer aggregation is enabled.'}</p>
              </article>
            );
          })}
          {!questions.length ? (
            <article className="panel-card">
              <h3>No questions yet</h3>
              <p className="muted">Add questions in the Questions builder first.</p>
            </article>
          ) : null}
        </section>
      </>
    );
  };

  const renderInsightsQuestionPerformance = () => {
    const rows = questions.map((question, index) => {
      const metric = dropoffMetrics.find((entry) => entry.questionId === question.id);
      const dropoffPercent = ((metric?.dropoffRate ?? 0) * 100).toFixed(1);
      const answerSeconds = (index % 4) + 1;
      return {
        id: question.id,
        prompt: question.prompt,
        dropoffPercent,
        answerSeconds
      };
    });

    return (
      <>
        <section className="studio-view-head">
          <h1>Question Performance</h1>
          <p>Identify where participants hesitate or abandon.</p>
        </section>

        <section className="content-grid two-col">
          <article className="panel-card compact-stat">
            <span>Average answer time</span>
            <strong>{rows.length ? '1s' : '0s'}</strong>
          </article>
          <article className="panel-card compact-stat">
            <span>Number of total abandonments</span>
            <strong>{dropoffMetrics.reduce((sum, metric) => sum + metric.exits, 0)}</strong>
          </article>
        </section>

        <article className="panel-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Abandonments</th>
                  <th>Avg. answer time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.prompt}</td>
                    <td>{row.dropoffPercent}%</td>
                    <td>{row.answerSeconds}s</td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td colSpan={3} className="table-empty">
                      No question performance data available.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </article>
      </>
    );
  };

  const renderInsightsScores = () => {
    const rows = questions.slice(0, 6).map((question) => {
      const weight = Number(question.weight) || 0;
      const percent = questionWeightTotal > 0 ? (weight / questionWeightTotal) * 100 : 0;
      return {
        id: question.id,
        label: question.prompt.toUpperCase(),
        percent
      };
    });

    return (
      <>
        <section className="studio-view-head">
          <h1>Score Performance</h1>
          <p>Weighted category contribution across your scorecard.</p>
        </section>

        <article className="panel-card">
          <div className="score-rows">
            {(rows.length ? rows : [{ id: 'overall', label: 'OVERALL SCORE', percent: conversionPercent || 0 }]).map((row) => (
              <div key={row.id} className="score-row">
                <div className="score-label">{row.label}</div>
                <div className="score-bar-wrap">
                  <span className="score-bar" style={{ width: `${Math.max(0, Math.min(100, row.percent))}%` }} />
                  <strong>{row.percent.toFixed(0)}%</strong>
                </div>
              </div>
            ))}
          </div>
        </article>
      </>
    );
  };

  const renderInsightsLandingPages = () => {
    const startRate = visitsCount ? (startedCount / visitsCount) * 100 : 0;
    const completionRate = startedCount ? (completedCount / startedCount) * 100 : 0;
    const signUpRate = startedCount ? (leadCount / startedCount) * 100 : 0;

    return (
      <>
        <section className="studio-view-head">
          <h1>Landing Pages</h1>
          <p>Traffic and conversion performance by landing page.</p>
        </section>

        <article className="panel-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Visits</th>
                  <th>Unique visits</th>
                  <th>Start rate</th>
                  <th>Completion rate</th>
                  <th>Sign up rate</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{landingSeoTitle || selectedAssessment?.name || 'Main Landing Page'}</td>
                  <td>{visitsCount}</td>
                  <td>{visitsCount}</td>
                  <td>{formatPercent(startRate)}</td>
                  <td>{formatPercent(completionRate)}</td>
                  <td>{formatPercent(signUpRate)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </>
    );
  };

  const renderAudiences = () => {
    return (
      <>
        <section className="studio-view-head">
          <h1>Audiences</h1>
          <p>Create tailored audience segments from collected responses.</p>
        </section>

        <article className="panel-card centered-panel">
          <h3>Segment and personalize</h3>
          <p className="muted">Use collected data points to create specific audiences and customize results.</p>
          <button className="btn btn-primary" type="button" onClick={() => setNotice({ type: 'info', message: 'Audience builder is queued next.' })}>
            Create Audience
          </button>
        </article>
      </>
    );
  };

  const renderBuildLanding = () => {
    return (
      <>
        <section className="studio-view-head with-action">
          <div>
            <h1>Landing Pages</h1>
            <p>Manage the page your clients see before they start.</p>
          </div>
          <button className="btn btn-primary" type="button" onClick={() => void withTask('Saving landing page', saveLanding)}>
            Save Landing Page
          </button>
        </section>

        <article className="panel-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Status</th>
                  <th>Modified</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{landingSeoTitle || selectedAssessment?.name || 'Main Landing Page'}</td>
                  <td>
                    <span className="status-pill default">HOME PAGE</span>
                  </td>
                  <td>{formatDate(selectedVersion?.updatedAt)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <article className="panel-card">
          <h3>Landing page settings</h3>
          <div className="inline-grid two">
            <label>
              SEO title
              <input value={landingSeoTitle} onChange={(event) => setLandingSeoTitle(event.target.value)} />
            </label>
            <label>
              Accent theme
              <input value={landingAccent} onChange={(event) => setLandingAccent(event.target.value)} placeholder="blue" />
            </label>
          </div>
          <label>
            SEO description
            <textarea rows={3} value={landingSeoDescription} onChange={(event) => setLandingSeoDescription(event.target.value)} />
          </label>
          <div className="inline-grid two">
            <label>
              Hero headline
              <input value={heroHeadline} onChange={(event) => setHeroHeadline(event.target.value)} />
            </label>
            <label>
              Hero button label
              <input value={heroCtaLabel} onChange={(event) => setHeroCtaLabel(event.target.value)} />
            </label>
          </div>
          <button className="btn btn-primary" type="button" onClick={() => void withTask('Saving landing page', saveLanding)}>
            Save Landing
          </button>
        </article>
      </>
    );
  };

  const renderBuildQuestions = () => {
    return (
      <>
        <section className="studio-view-head">
          <h1>Questions</h1>
          <p>Design your assessment flow with weighted questions and answer options.</p>
        </section>

        <section className="question-builder-layout">
          <aside className="panel-card builder-left">
            <h3>Questions</h3>
            <ul className="list-menu">
              {questions.map((question) => (
                <li key={question.id}>
                  <button
                    type="button"
                    className={question.id === selectedQuestionId ? 'active' : ''}
                    onClick={() => setSelectedQuestionId(question.id)}
                  >
                    {question.position}. {question.prompt}
                  </button>
                </li>
              ))}
            </ul>

            <div className="builder-create-block">
              <label>
                Add question
                <input value={newQuestionPrompt} onChange={(event) => setNewQuestionPrompt(event.target.value)} placeholder="How mature is your process?" />
              </label>
              <div className="inline-grid two">
                <label>
                  Type
                  <select value={newQuestionType} onChange={(event) => setNewQuestionType(event.target.value as QuestionType)}>
                    {QUESTION_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {humanizeQuestionType(type)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Weight
                  <input value={newQuestionWeight} onChange={(event) => setNewQuestionWeight(event.target.value)} type="number" step="0.1" min={0} />
                </label>
              </div>
              <button className="btn btn-primary" type="button" onClick={() => void withTask('Adding question', createQuestion)}>
                Add question
              </button>
            </div>
          </aside>

          <article className="panel-card builder-main">
            {selectedQuestion ? (
              <>
                <h3>{selectedQuestion.prompt}</h3>
                <div className="inline-grid two">
                  <label>
                    Prompt
                    <input value={questionPrompt} onChange={(event) => setQuestionPrompt(event.target.value)} />
                  </label>
                  <label>
                    Type
                    <select value={questionType} onChange={(event) => setQuestionType(event.target.value as QuestionType)}>
                      {QUESTION_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {humanizeQuestionType(type)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="inline-grid three">
                  <label>
                    Weight
                    <input value={questionWeight} onChange={(event) => setQuestionWeight(event.target.value)} type="number" step="0.1" min={0} />
                  </label>
                  <label>
                    Position
                    <input value={questionPosition} onChange={(event) => setQuestionPosition(event.target.value)} type="number" min={1} />
                  </label>
                  <label className="inline-label">
                    <input type="checkbox" checked={questionRequired} onChange={(event) => setQuestionRequired(event.target.checked)} />
                    Required
                  </label>
                </div>

                <div className="button-row">
                  <button className="btn" type="button" onClick={() => void withTask('Saving question', saveQuestion)}>
                    Save question
                  </button>
                  <button className="btn btn-danger" type="button" onClick={() => void withTask('Deleting question', deleteQuestion)}>
                    Delete question
                  </button>
                </div>

                {['single_choice', 'multi_choice'].includes(selectedQuestion.type) ? (
                  <>
                    <hr />
                    <h3>Answer options</h3>
                    <div className="inline-grid three">
                      <label>
                        Label
                        <input value={newOptionLabel} onChange={(event) => setNewOptionLabel(event.target.value)} />
                      </label>
                      <label>
                        Value
                        <input value={newOptionValue} onChange={(event) => setNewOptionValue(event.target.value)} />
                      </label>
                      <label>
                        Score
                        <input value={newOptionScore} onChange={(event) => setNewOptionScore(event.target.value)} type="number" step="0.1" />
                      </label>
                    </div>
                    <button className="btn" type="button" onClick={() => void withTask('Adding option', createOption)}>
                      Add answer
                    </button>

                    <ul className="simple-list">
                      {questionOptions.map((option) => (
                        <li key={option.id}>
                          <div>
                            <strong>{option.label}</strong>
                            <p className="muted">
                              value: {option.value} | score: {option.scoreValue}
                            </p>
                          </div>
                          <button className="btn btn-danger" type="button" onClick={() => void withTask('Deleting option', async () => deleteOption(option.id))}>
                            Delete
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            ) : (
              <p className="muted">Select or add a question to start editing.</p>
            )}
          </article>

          <aside className="panel-card builder-right">
            <h3>Question logic</h3>
            <label>
              Rule name
              <input value={ruleName} onChange={(event) => setRuleName(event.target.value)} />
            </label>
            <label>
              When question
              <select value={ruleQuestionId} onChange={(event) => setRuleQuestionId(event.target.value)}>
                <option value="">Select question</option>
                {questions.map((question) => (
                  <option key={question.id} value={question.id}>
                    {question.position}. {question.prompt}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Equals value
              <input value={ruleEquals} onChange={(event) => setRuleEquals(event.target.value)} />
            </label>
            <label>
              Action
              <select value={ruleActionType} onChange={(event) => setRuleActionType(event.target.value as LogicAction)}>
                <option value="tag">Tag</option>
                <option value="skip_to_position">Skip to question</option>
              </select>
            </label>
            <label>
              Action value
              <input value={ruleActionValue} onChange={(event) => setRuleActionValue(event.target.value)} placeholder={ruleActionType === 'tag' ? 'high-intent' : '4'} />
            </label>
            <button className="btn" type="button" onClick={() => void withTask('Creating rule', createRule)}>
              Add rule
            </button>

            <ul className="simple-list compact">
              {logicRules.map((rule) => (
                <li key={rule.id}>
                  <div>
                    <strong>{rule.name}</strong>
                    <p className="muted">if {String(rule.ifExpression.questionId)} equals {String(rule.ifExpression.equals)}</p>
                  </div>
                  <button className="btn btn-danger" type="button" onClick={() => void withTask('Deleting rule', async () => deleteRule(rule.id))}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        </section>
      </>
    );
  };

  const renderBuildResultPages = () => {
    return (
      <>
        <section className="studio-view-head with-action">
          <div>
            <h1>Result Pages</h1>
            <p>Configure what participants see after completion.</p>
          </div>
          <button className="btn btn-primary" type="button" onClick={() => void withTask('Saving report template', saveReportTemplate)}>
            Save Result Page
          </button>
        </section>

        <article className="panel-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Status</th>
                  <th>Modified</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{reportTitle || 'Assessment Result'}</td>
                  <td>
                    <span className="status-pill default">DEFAULT</span>
                  </td>
                  <td>{formatDate(selectedVersion?.updatedAt)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <article className="panel-card">
          <label>
            Result page title
            <input value={reportTitle} onChange={(event) => setReportTitle(event.target.value)} />
          </label>

          <h3>Sections</h3>
          <div className="inline-grid three">
            <label>
              Section key
              <input value={newSectionKey} onChange={(event) => setNewSectionKey(event.target.value)} />
            </label>
            <label>
              Section title
              <input value={newSectionTitle} onChange={(event) => setNewSectionTitle(event.target.value)} />
            </label>
            <label>
              Body template
              <input value={newSectionBody} onChange={(event) => setNewSectionBody(event.target.value)} />
            </label>
          </div>
          <button className="btn" type="button" onClick={() => void withTask('Adding report section', addReportSection)}>
            Create section
          </button>

          <ul className="simple-list">
            {reportTemplate?.sections.map((section) => (
              <li key={section.id}>
                <div>
                  <strong>{section.title}</strong>
                  <p className="muted">/{section.sectionKey}</p>
                </div>
                <button className="btn btn-danger" type="button" onClick={() => void withTask('Deleting report section', async () => deleteReportSection(section.id))}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </article>
      </>
    );
  };

  const renderBuildPdfReports = () => {
    return (
      <>
        <section className="studio-view-head with-action">
          <div>
            <h1>PDF Reports</h1>
            <p>Build and save the PDF template used by report generation jobs.</p>
          </div>
          <button className="btn btn-primary" type="button" onClick={() => void withTask('Saving report template', saveReportTemplate)}>
            Create PDF Report
          </button>
        </section>

        <article className="panel-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Status</th>
                  <th>Modified</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{reportTitle || `${selectedAssessment?.name ?? 'Assessment'} Report`}</td>
                  <td>
                    <span className="status-pill draft">DRAFT</span>
                  </td>
                  <td>{formatDate(selectedVersion?.updatedAt)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <article className="panel-card">
          <h3>Template JSON</h3>
          <div className="inline-grid two">
            <label>
              Header JSON
              <textarea rows={5} value={reportHeaderJson} onChange={(event) => setReportHeaderJson(event.target.value)} />
            </label>
            <label>
              Footer JSON
              <textarea rows={5} value={reportFooterJson} onChange={(event) => setReportFooterJson(event.target.value)} />
            </label>
          </div>
          <button className="btn" type="button" onClick={() => void withTask('Saving report template', saveReportTemplate)}>
            Save PDF template
          </button>
        </article>
      </>
    );
  };

  const renderShare = () => {
    return (
      <>
        <section className="studio-view-head">
          <h1>Embed and Share</h1>
          <p>Copy your public link and embed your scorecard on external sites.</p>
        </section>

        <article className="panel-card">
          <h3>Share your link</h3>
          <div className="share-card">
            <div className="share-card-main">
              <span className="status-pill live">LIVE</span>
              <h3>{selectedAssessment?.name ?? 'Assessment'}</h3>
              <a href={clientLink} target="_blank" rel="noreferrer" className="share-link">
                {clientLink}
              </a>
              <div className="button-row">
                <button className="btn" type="button" onClick={() => void withTask('Copying link', copyClientLink)}>
                  Copy link
                </button>
                <button className="btn" type="button" onClick={() => setSettingsView('settings.share')}>
                  Share appearance
                </button>
                <a className="btn btn-secondary" href={clientLink} target="_blank" rel="noreferrer">
                  Open page
                </a>
              </div>
            </div>
            <div className="share-icons" aria-hidden>
              <span>f</span>
              <span>x</span>
              <span>in</span>
              <span>@</span>
              <span>QR</span>
            </div>
          </div>
        </article>

        <section className="content-grid two-col">
          <article className="panel-card">
            <h3>Full page</h3>
            <p className="muted">Embed your scorecard full-screen over your web page.</p>
          </article>
          <article className="panel-card">
            <h3>Inline</h3>
            <p className="muted">Embed within existing page content.</p>
          </article>
          <article className="panel-card">
            <h3>Pop up</h3>
            <p className="muted">Launch from a button click in a pop-up modal.</p>
          </article>
          <article className="panel-card">
            <h3>Chat style</h3>
            <p className="muted">Display as a floating chat-style widget.</p>
          </article>
        </section>
      </>
    );
  };

  const renderIntegrate = () => {
    return (
      <>
        <section className="studio-view-head">
          <h1>Integrate</h1>
          <p>Connect webhook delivery for lead capture, completion, and PDF events.</p>
        </section>

        <article className="panel-card">
          <div className="inline-grid three">
            <label>
              Name
              <input value={newWebhookName} onChange={(event) => setNewWebhookName(event.target.value)} />
            </label>
            <label>
              Target URL
              <input value={newWebhookTarget} onChange={(event) => setNewWebhookTarget(event.target.value)} />
            </label>
            <label>
              Secret
              <input value={newWebhookSecret} onChange={(event) => setNewWebhookSecret(event.target.value)} type="password" />
            </label>
          </div>

          <div className="event-chips">
            {WEBHOOK_EVENTS.map((eventName) => (
              <label key={eventName} className="chip-toggle">
                <input type="checkbox" checked={newWebhookEvents.includes(eventName)} onChange={() => toggleEvent(eventName)} />
                <span>{eventName}</span>
              </label>
            ))}
          </div>

          <button className="btn btn-primary" type="button" onClick={() => void withTask('Creating webhook', createWebhook)}>
            Add webhook
          </button>

          <ul className="simple-list">
            {webhooks.map((endpoint) => (
              <li key={endpoint.id}>
                <div>
                  <strong>{endpoint.name}</strong>
                  <p className="muted">{endpoint.targetUrl}</p>
                </div>
                <div className="button-row">
                  <button className="btn" type="button" onClick={() => void withTask('Toggling webhook', async () => toggleWebhook(endpoint))}>
                    {endpoint.isActive ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn btn-danger" type="button" onClick={() => void withTask('Deleting webhook', async () => deleteWebhook(endpoint.id))}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </article>
      </>
    );
  };

  const renderSettings = () => {
    if (activeView === 'settings.general') {
      return (
        <>
          <section className="studio-view-head">
            <h1>Settings · General</h1>
            <p>Create, select, and publish assessment versions.</p>
          </section>

          <article className="panel-card">
            <h3>Assessment</h3>
            <div className="inline-grid two">
              <label>
                New assessment name
                <input
                  value={newAssessmentName}
                  onChange={(event) => {
                    const value = event.target.value;
                    setNewAssessmentName(value);
                    if (!newAssessmentSlug) {
                      setNewAssessmentSlug(slugify(value));
                    }
                  }}
                  placeholder="Revenue Health Check"
                />
              </label>
              <label>
                New assessment slug
                <input value={newAssessmentSlug} onChange={(event) => setNewAssessmentSlug(event.target.value)} placeholder="revenue-health-check" />
              </label>
            </div>
            <button className="btn btn-primary" type="button" onClick={() => void withTask('Creating assessment', createAssessment)}>
              Create assessment
            </button>

            <hr />

            <label>
              Current assessment
              <select value={selectedAssessmentId} onChange={(event) => setSelectedAssessmentId(event.target.value)}>
                {assessments.map((assessment) => (
                  <option key={assessment.id} value={assessment.id}>
                    {assessment.name} ({assessment.slug})
                  </option>
                ))}
              </select>
            </label>

            <div className="inline-grid three">
              <label>
                Name
                <input value={assessmentName} onChange={(event) => setAssessmentName(event.target.value)} />
              </label>
              <label>
                Slug
                <input value={assessmentSlug} onChange={(event) => setAssessmentSlug(event.target.value)} />
              </label>
              <label>
                Status
                <select value={assessmentStatus} onChange={(event) => setAssessmentStatus(event.target.value as AssessmentStatus)}>
                  <option value="draft">draft</option>
                  <option value="published">published</option>
                  <option value="archived">archived</option>
                </select>
              </label>
            </div>
            <button className="btn" type="button" onClick={() => void withTask('Saving assessment', saveAssessment)}>
              Save assessment
            </button>
          </article>

          <article className="panel-card">
            <h3>Versions</h3>
            <div className="inline-grid two">
              <label>
                New version title
                <input value={newVersionTitle} onChange={(event) => setNewVersionTitle(event.target.value)} />
              </label>
              <label>
                Copy from version ID (optional)
                <input value={copyFromVersionId} onChange={(event) => setCopyFromVersionId(event.target.value)} />
              </label>
            </div>
            <button className="btn" type="button" onClick={() => void withTask('Creating version', createVersion)}>
              Create version
            </button>

            <hr />

            <label>
              Current version
              <select value={selectedVersionId} onChange={(event) => setSelectedVersionId(event.target.value)}>
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.versionNo} - {version.title} {version.isPublished ? '[published]' : '[draft]'}
                  </option>
                ))}
              </select>
            </label>

            <div className="inline-grid two">
              <label>
                Version title
                <input value={versionTitle} onChange={(event) => setVersionTitle(event.target.value)} />
              </label>
              <label>
                Lead capture timing
                <select value={versionLeadMode} onChange={(event) => setVersionLeadMode(event.target.value as 'start' | 'middle' | 'before_results')}>
                  <option value="start">start</option>
                  <option value="middle">middle</option>
                  <option value="before_results">before_results</option>
                </select>
              </label>
            </div>

            <label>
              Intro text
              <textarea rows={3} value={versionIntro} onChange={(event) => setVersionIntro(event.target.value)} />
            </label>
            <label>
              Outro text
              <textarea rows={3} value={versionOutro} onChange={(event) => setVersionOutro(event.target.value)} />
            </label>
            <label>
              Runtime settings JSON
              <textarea rows={6} value={versionRuntimeSettings} onChange={(event) => setVersionRuntimeSettings(event.target.value)} />
            </label>

            <div className="button-row">
              <button className="btn" type="button" onClick={() => void withTask('Saving version', saveVersion)}>
                Save version
              </button>
              <button className="btn btn-primary" type="button" onClick={() => void withTask('Publishing version', publishVersion)}>
                Publish version
              </button>
            </div>
          </article>
        </>
      );
    }

    if (activeView === 'settings.branding') {
      return (
        <>
          <section className="studio-view-head">
            <h1>Settings · Branding</h1>
            <p>Define title, hero, and visual accent for your landing and runner pages.</p>
          </section>
          {renderBuildLanding()}
        </>
      );
    }

    if (activeView === 'settings.share') {
      return (
        <>
          <section className="studio-view-head">
            <h1>Settings · Share Appearance</h1>
            <p>Control social sharing preview and link visibility.</p>
          </section>
          {renderShare()}
        </>
      );
    }

    if (activeView === 'settings.lead') {
      return (
        <>
          <section className="studio-view-head">
            <h1>Settings · Lead Form</h1>
            <p>Choose where and how lead capture appears in the assessment flow.</p>
          </section>
          <article className="panel-card">
            <label>
              Lead capture step
              <select value={versionLeadMode} onChange={(event) => setVersionLeadMode(event.target.value as 'start' | 'middle' | 'before_results')}>
                <option value="start">At start</option>
                <option value="middle">Middle of assessment</option>
                <option value="before_results">Before results</option>
              </select>
            </label>
            <button className="btn" type="button" onClick={() => void withTask('Saving version', saveVersion)}>
              Save lead form setting
            </button>
          </article>
        </>
      );
    }

    return (
      <>
        <section className="studio-view-head">
          <h1>Settings</h1>
          <p>This settings section is ready for extension as feature modules are finalized.</p>
        </section>
        <article className="panel-card centered-panel">
          <h3>Section in progress</h3>
          <p className="muted">Use General, Branding, Share Appearance, and Lead Form for active configuration today.</p>
        </article>
      </>
    );
  };

  const renderExperiments = () => {
    return (
      <>
        <section className="studio-view-head">
          <h1>Experiments</h1>
          <p>Run controlled experiments to test conversion changes safely.</p>
        </section>
        <article className="panel-card centered-panel">
          <h3>Experiments are locked</h3>
          <p className="muted">Enable after baseline analytics are stable in production.</p>
          <span className="status-pill neutral">LOCKED</span>
        </article>
      </>
    );
  };

  const renderContent = () => {
    switch (activeView) {
      case 'home':
        return renderHome();
      case 'leads':
        return renderLeads();
      case 'insights.overview':
        return renderInsightsOverview();
      case 'insights.answers':
        return renderInsightsAnswers();
      case 'insights.questions':
        return renderInsightsQuestionPerformance();
      case 'insights.scores':
        return renderInsightsScores();
      case 'insights.landing':
        return renderInsightsLandingPages();
      case 'audiences':
        return renderAudiences();
      case 'build.landing':
        return renderBuildLanding();
      case 'build.questions':
        return renderBuildQuestions();
      case 'build.results':
        return renderBuildResultPages();
      case 'build.pdf':
        return renderBuildPdfReports();
      case 'share':
        return renderShare();
      case 'integrate':
        return renderIntegrate();
      case 'experiments':
        return renderExperiments();
      default:
        return renderSettings();
    }
  };

  const isInsightsView = activeView.startsWith('insights.');
  const isBuildView = activeView.startsWith('build.');
  const isSettingsView = activeView.startsWith('settings.');

  return (
    <div className="studio-shell">
      <aside className="studio-sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden>
            <span />
            <span />
            <span />
            <span />
          </span>
          <div>
            <strong>QAssess</strong>
            <p>Scorecard Builder</p>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Studio navigation">
          <button type="button" className={`nav-item ${activeView === 'home' ? 'active' : ''}`} onClick={() => setActiveView('home')}>
            Scorecard Home
          </button>
          <button type="button" className={`nav-item ${activeView === 'leads' ? 'active' : ''}`} onClick={() => setActiveView('leads')}>
            Leads
          </button>

          <button type="button" className={`nav-item ${isInsightsView ? 'active' : ''}`} onClick={() => setInsightsOpen((value) => !value)}>
            Insights
            <span className="caret" aria-hidden>
              {insightsOpen ? '▾' : '▸'}
            </span>
          </button>
          {insightsOpen ? (
            <div className="sub-nav">
              <button type="button" className={`sub-nav-item ${activeView === 'insights.overview' ? 'active' : ''}`} onClick={() => setInsightsView('insights.overview')}>
                Overview
              </button>
              <button type="button" className={`sub-nav-item ${activeView === 'insights.answers' ? 'active' : ''}`} onClick={() => setInsightsView('insights.answers')}>
                Answers
              </button>
              <button type="button" className={`sub-nav-item ${activeView === 'insights.questions' ? 'active' : ''}`} onClick={() => setInsightsView('insights.questions')}>
                Question Performance
              </button>
              <button type="button" className={`sub-nav-item ${activeView === 'insights.scores' ? 'active' : ''}`} onClick={() => setInsightsView('insights.scores')}>
                Scores
              </button>
              <button type="button" className={`sub-nav-item ${activeView === 'insights.landing' ? 'active' : ''}`} onClick={() => setInsightsView('insights.landing')}>
                Landing Pages
              </button>
            </div>
          ) : null}

          <button type="button" className={`nav-item ${activeView === 'audiences' ? 'active' : ''}`} onClick={() => setActiveView('audiences')}>
            Audiences
          </button>

          <div className="nav-group-label">BUILD</div>
          <button type="button" className={`nav-item ${activeView === 'build.landing' ? 'active' : ''}`} onClick={() => setActiveView('build.landing')}>
            Landing Pages
          </button>
          <button type="button" className={`nav-item ${activeView === 'build.questions' ? 'active' : ''}`} onClick={() => setActiveView('build.questions')}>
            Questions
          </button>
          <button type="button" className={`nav-item ${activeView === 'build.results' ? 'active' : ''}`} onClick={() => setActiveView('build.results')}>
            Result Pages
          </button>
          <button type="button" className={`nav-item ${activeView === 'build.pdf' ? 'active' : ''}`} onClick={() => setActiveView('build.pdf')}>
            PDF Reports
          </button>

          <button type="button" className={`nav-item ${activeView === 'share' ? 'active' : ''}`} onClick={() => setActiveView('share')}>
            Embed and share
          </button>
          <button type="button" className={`nav-item ${activeView === 'integrate' ? 'active' : ''}`} onClick={() => setActiveView('integrate')}>
            Integrate
          </button>
          <button type="button" className={`nav-item ${activeView === 'experiments' ? 'active' : ''}`} onClick={() => setActiveView('experiments')}>
            Experiments
            <span className="status-dot" aria-hidden>
              ·
            </span>
          </button>

          <button type="button" className={`nav-item ${isSettingsView ? 'active' : ''}`} onClick={() => setSettingsOpen((value) => !value)}>
            Settings
            <span className="caret" aria-hidden>
              {settingsOpen ? '▾' : '▸'}
            </span>
          </button>
          {settingsOpen ? (
            <div className="sub-nav">
              <button type="button" className={`sub-nav-item ${activeView === 'settings.general' ? 'active' : ''}`} onClick={() => setSettingsView('settings.general')}>
                General
              </button>
              <button type="button" className={`sub-nav-item ${activeView === 'settings.branding' ? 'active' : ''}`} onClick={() => setSettingsView('settings.branding')}>
                Branding
              </button>
              <button type="button" className={`sub-nav-item ${activeView === 'settings.share' ? 'active' : ''}`} onClick={() => setSettingsView('settings.share')}>
                Share Appearance
              </button>
              <button type="button" className={`sub-nav-item ${activeView === 'settings.lead' ? 'active' : ''}`} onClick={() => setSettingsView('settings.lead')}>
                Lead Form
              </button>
              <button
                type="button"
                className={`sub-nav-item ${activeView === 'settings.notifications' ? 'active' : ''}`}
                onClick={() => setSettingsView('settings.notifications')}
              >
                Notifications
              </button>
              <button type="button" className={`sub-nav-item ${activeView === 'settings.scoreTiers' ? 'active' : ''}`} onClick={() => setSettingsView('settings.scoreTiers')}>
                Score Tiers
              </button>
              <button type="button" className={`sub-nav-item ${activeView === 'settings.resultEmail' ? 'active' : ''}`} onClick={() => setSettingsView('settings.resultEmail')}>
                Result Email
              </button>
              <button
                type="button"
                className={`sub-nav-item ${activeView === 'settings.abandonEmail' ? 'active' : ''}`}
                onClick={() => setSettingsView('settings.abandonEmail')}
              >
                Abandon Email
              </button>
              <button type="button" className={`sub-nav-item ${activeView === 'settings.tracking' ? 'active' : ''}`} onClick={() => setSettingsView('settings.tracking')}>
                Tracking
              </button>
            </div>
          ) : null}
        </nav>
      </aside>

      <main className="studio-main">
        <header className="studio-topbar">
          <div className="topbar-identity">
            <span className="avatar-chip" aria-hidden>
              {userInitials}
            </span>
            <div>
              <strong>{displayName}</strong>
              <p>
                {selectedAssessment?.name ?? 'No assessment selected'}
                {props.tenantSlug ? ` · ${props.tenantSlug}` : ''}
              </p>
            </div>
          </div>

          <div className="topbar-controls">
            <label>
              Assessment
              <select value={selectedAssessmentId} onChange={(event) => setSelectedAssessmentId(event.target.value)}>
                {assessments.map((assessment) => (
                  <option key={assessment.id} value={assessment.id}>
                    {assessment.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Version
              <select value={selectedVersionId} onChange={(event) => setSelectedVersionId(event.target.value)}>
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.versionNo} {version.isPublished ? '(published)' : '(draft)'}
                  </option>
                ))}
              </select>
            </label>
            <Link className="btn" to="/run">
              Preview
            </Link>
            <button className="btn btn-primary" type="button" onClick={() => void withTask('Publishing version', publishVersion)}>
              Publish
            </button>
            <button className="btn" type="button" onClick={props.onLogout}>
              Logout
            </button>
          </div>
        </header>

        <div className="studio-subbar">
          <span>API: {props.apiBaseUrl || '(same-origin/proxy)'}</span>
          <span>{selectedVersion?.isPublished ? 'Published' : 'Draft'} version</span>
        </div>

        {notice ? <p className={`notice ${notice.type}`}>{notice.message}</p> : null}
        {busy ? <p className="notice info">{busy}...</p> : null}

        <section className="studio-content">{renderContent()}</section>
      </main>
    </div>
  );
}
