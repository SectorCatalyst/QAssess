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

const QUESTION_TYPES: QuestionType[] = ['single_choice', 'multi_choice', 'scale', 'numeric', 'short_text'];
const WEBHOOK_EVENTS: Array<'lead.created' | 'session.completed' | 'pdf.generated'> = ['lead.created', 'session.completed', 'pdf.generated'];

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

  const clientLink = selectedAssessment ? `${window.location.origin}/run/${selectedAssessment.slug}` : `${window.location.origin}/run`;

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

  const exportLeadsCsv = async () => {
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

  return (
    <div className="page studio-page">
      <div className="aurora" />

      <header className="studio-header">
        <div>
          <h1>QAssess Studio</h1>
          <p className="muted">
            Logged in as <strong>{props.userEmail}</strong>
            {props.tenantSlug ? ` (${props.tenantSlug})` : ''} | API: {props.apiBaseUrl || '(same-origin)'}
          </p>
        </div>
        <div className="header-actions">
          <Link className="btn btn-secondary" to="/run">
            Open Client View
          </Link>
          <button className="btn" onClick={props.onLogout} type="button">
            Logout
          </button>
        </div>
      </header>

      {notice ? <p className={`notice ${notice.type}`}>{notice.message}</p> : null}
      {busy ? <p className="notice info">{busy}...</p> : null}

      <section className="simple-steps">
        <article className="card step-card">
          <h2>
            <span>1</span> Choose Assessment
          </h2>
          <p className="muted">Create a new assessment or pick an existing one.</p>

          <div className="inline-grid two">
            <label>
              New assessment name
              <input
                placeholder="Revenue Health Check"
                value={newAssessmentName}
                onChange={(event) => {
                  const value = event.target.value;
                  setNewAssessmentName(value);
                  if (!newAssessmentSlug) {
                    setNewAssessmentSlug(slugify(value));
                  }
                }}
              />
            </label>
            <label>
              Slug
              <input placeholder="revenue-health-check" value={newAssessmentSlug} onChange={(event) => setNewAssessmentSlug(event.target.value)} />
            </label>
          </div>
          <button className="btn btn-primary" type="button" onClick={() => void withTask('Creating assessment', createAssessment)}>
            Create Assessment
          </button>

          <hr />

          <label>
            Current assessment
            <select value={selectedAssessmentId} onChange={(event) => setSelectedAssessmentId(event.target.value)}>
              {assessments.map((assessment) => (
                <option key={assessment.id} value={assessment.id}>
                  {assessment.name} ({assessment.slug}) [{assessment.status}]
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
            Save Assessment
          </button>
        </article>

        <article className="card step-card">
          <h2>
            <span>2</span> Version & Publishing
          </h2>
          <p className="muted">Select the draft version you want to edit, then publish when ready.</p>

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
          <button className="btn btn-primary" type="button" onClick={() => void withTask('Creating version', createVersion)}>
            Create Version
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

          <details>
            <summary>Advanced runtime settings (optional)</summary>
            <label>
              Runtime settings JSON
              <textarea rows={6} value={versionRuntimeSettings} onChange={(event) => setVersionRuntimeSettings(event.target.value)} />
            </label>
          </details>

          <div className="button-row">
            <button className="btn" type="button" onClick={() => void withTask('Saving version', saveVersion)}>
              Save Version
            </button>
            <button className="btn btn-primary" type="button" onClick={() => void withTask('Publishing version', publishVersion)}>
              Publish Version
            </button>
          </div>
        </article>

        <article className="card step-card">
          <h2>
            <span>3</span> Landing Page
          </h2>
          <p className="muted">Set your public page title, description, branding, and hero call-to-action.</p>

          <div className="inline-grid two">
            <label>
              SEO title
              <input value={landingSeoTitle} onChange={(event) => setLandingSeoTitle(event.target.value)} />
            </label>
            <label>
              Accent theme name
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
              <input value={heroHeadline} onChange={(event) => setHeroHeadline(event.target.value)} placeholder="Get your score in 2 minutes" />
            </label>
            <label>
              Hero button label
              <input value={heroCtaLabel} onChange={(event) => setHeroCtaLabel(event.target.value)} placeholder="Start assessment" />
            </label>
          </div>

          <button className="btn btn-primary" type="button" onClick={() => void withTask('Saving landing page', saveLanding)}>
            Save Landing
          </button>
        </article>

        <article className="card step-card">
          <h2>
            <span>4</span> Questions
          </h2>
          <p className="muted">Add your assessment questions and scoring weights.</p>

          <div className="inline-grid three">
            <label>
              New question
              <input value={newQuestionPrompt} onChange={(event) => setNewQuestionPrompt(event.target.value)} placeholder="How mature is your funnel?" />
            </label>
            <label>
              Type
              <select value={newQuestionType} onChange={(event) => setNewQuestionType(event.target.value as QuestionType)}>
                {QUESTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Weight
              <input value={newQuestionWeight} onChange={(event) => setNewQuestionWeight(event.target.value)} type="number" min={0} step="0.1" />
            </label>
          </div>

          <button className="btn btn-primary" type="button" onClick={() => void withTask('Adding question', createQuestion)}>
            Add Question
          </button>

          <hr />

          <label>
            Current question
            <select value={selectedQuestionId} onChange={(event) => setSelectedQuestionId(event.target.value)}>
              {questions.map((question) => (
                <option key={question.id} value={question.id}>
                  {question.position}. {question.prompt}
                </option>
              ))}
            </select>
          </label>

          <div className="inline-grid three">
            <label>
              Prompt
              <input value={questionPrompt} onChange={(event) => setQuestionPrompt(event.target.value)} />
            </label>
            <label>
              Type
              <select value={questionType} onChange={(event) => setQuestionType(event.target.value as QuestionType)}>
                {QUESTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Weight
              <input value={questionWeight} onChange={(event) => setQuestionWeight(event.target.value)} type="number" min={0} step="0.1" />
            </label>
          </div>

          <div className="inline-grid two">
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
              Save Question
            </button>
            <button className="btn btn-danger" type="button" onClick={() => void withTask('Deleting question', deleteQuestion)}>
              Delete Question
            </button>
          </div>

          {selectedQuestion && ['single_choice', 'multi_choice'].includes(selectedQuestion.type) ? (
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
                Add Option
              </button>

              <ul className="simple-list">
                {questionOptions.map((option) => (
                  <li key={option.id}>
                    <div>
                      <strong>{option.label}</strong> ({option.value}) - score {option.scoreValue}
                    </div>
                    <button className="btn btn-danger" type="button" onClick={() => void withTask('Deleting option', async () => deleteOption(option.id))}>
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </article>

        <article className="card step-card">
          <h2>
            <span>5</span> Logic (optional)
          </h2>
          <p className="muted">Create simple conditional behavior without JSON.</p>

          <div className="inline-grid two">
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
          </div>

          <div className="inline-grid three">
            <label>
              Equals value
              <input value={ruleEquals} onChange={(event) => setRuleEquals(event.target.value)} placeholder="advanced" />
            </label>
            <label>
              Action
              <select value={ruleActionType} onChange={(event) => setRuleActionType(event.target.value as LogicAction)}>
                <option value="tag">tag</option>
                <option value="skip_to_position">skip_to_position</option>
              </select>
            </label>
            <label>
              Action value
              <input
                value={ruleActionValue}
                onChange={(event) => setRuleActionValue(event.target.value)}
                placeholder={ruleActionType === 'tag' ? 'high-intent' : '2'}
              />
            </label>
          </div>

          <button className="btn" type="button" onClick={() => void withTask('Creating rule', createRule)}>
            Add Rule
          </button>

          <ul className="simple-list">
            {logicRules.map((rule) => (
              <li key={rule.id}>
                <div>
                  <strong>{rule.name}</strong>
                  <p className="muted">
                    if {String(rule.ifExpression.questionId)} equals {String(rule.ifExpression.equals)} then {String(rule.thenAction.action)}
                  </p>
                </div>
                <button className="btn btn-danger" type="button" onClick={() => void withTask('Deleting rule', async () => deleteRule(rule.id))}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </article>

        <article className="card step-card">
          <h2>
            <span>6</span> Report Output
          </h2>
          <p className="muted">Configure what users see on final report pages.</p>

          <label>
            Report title
            <input value={reportTitle} onChange={(event) => setReportTitle(event.target.value)} />
          </label>

          <details>
            <summary>Advanced header/footer JSON (optional)</summary>
            <label>
              Header JSON
              <textarea rows={4} value={reportHeaderJson} onChange={(event) => setReportHeaderJson(event.target.value)} />
            </label>
            <label>
              Footer JSON
              <textarea rows={4} value={reportFooterJson} onChange={(event) => setReportFooterJson(event.target.value)} />
            </label>
          </details>

          <button className="btn" type="button" onClick={() => void withTask('Saving report template', saveReportTemplate)}>
            Save Report Template
          </button>

          <hr />

          <h3>Add section</h3>
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
            Add Section
          </button>

          <ul className="simple-list">
            {reportTemplate?.sections.map((section) => (
              <li key={section.id}>
                <div>
                  <strong>{section.title}</strong> ({section.sectionKey})
                </div>
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => void withTask('Deleting report section', async () => deleteReportSection(section.id))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </article>

        <article className="card step-card">
          <h2>
            <span>7</span> Go Live
          </h2>
          <p className="muted">Preview the client flow, export leads, and publish.</p>

          <label>
            Client link
            <input value={clientLink} readOnly />
          </label>

          <div className="button-row">
            <a className="btn btn-secondary" href={clientLink} target="_blank" rel="noreferrer">
              Open Client Preview
            </a>
            <button className="btn" type="button" onClick={() => void withTask('Exporting CSV', exportLeadsCsv)}>
              Export Leads CSV
            </button>
            <button className="btn btn-primary" type="button" onClick={() => void withTask('Publishing version', publishVersion)}>
              Publish Current Version
            </button>
          </div>
        </article>

        <article className="card step-card">
          <h2>
            <span>8</span> Integrations & Performance
          </h2>
          <p className="muted">Connect webhooks and monitor conversion performance.</p>

          <button className="btn" type="button" onClick={() => void withTask('Refreshing analytics', refreshAnalytics)}>
            Refresh Analytics
          </button>
          <div className="metric-grid">
            <div>
              <span className="metric-label">Visits</span>
              <strong>{analyticsSummary?.visits ?? 0}</strong>
            </div>
            <div>
              <span className="metric-label">Starts</span>
              <strong>{analyticsSummary?.starts ?? 0}</strong>
            </div>
            <div>
              <span className="metric-label">Completions</span>
              <strong>{analyticsSummary?.completions ?? 0}</strong>
            </div>
            <div>
              <span className="metric-label">Leads</span>
              <strong>{analyticsSummary?.leads ?? 0}</strong>
            </div>
            <div>
              <span className="metric-label">Conversion</span>
              <strong>{((analyticsSummary?.conversionRate ?? 0) * 100).toFixed(1)}%</strong>
            </div>
            <div>
              <span className="metric-label">Avg score</span>
              <strong>{analyticsSummary?.averageScore ?? 0}</strong>
            </div>
          </div>

          {dropoffMetrics.length ? (
            <ul className="simple-list compact">
              {dropoffMetrics.map((metric) => (
                <li key={metric.questionId}>
                  <div>
                    <strong>{metric.questionPrompt ?? metric.questionId}</strong>
                    <p className="muted">
                      views {metric.views} | exits {metric.exits} | dropoff {(metric.dropoffRate * 100).toFixed(1)}%
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          <hr />

          <h3>Webhook delivery</h3>
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

          <button className="btn" type="button" onClick={() => void withTask('Creating webhook', createWebhook)}>
            Add Webhook
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
      </section>
    </div>
  );
}
