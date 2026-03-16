import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ApiClient, ApiError } from '../lib/api';
import type { AnswerOption, PdfJob, PublicBootstrapResponse, Question, ResponseAnswer, Result, Session } from '../types';

interface PublicRunnerPageProps {
  apiBaseUrl: string;
}

type Notice = { type: 'success' | 'error' | 'info'; message: string } | null;
type RunnerStage = 'setup' | 'lead' | 'questions' | 'result';

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

function getOptionList(question: Question): Array<{ label: string; value: string }> {
  if (Array.isArray(question.options) && question.options.length > 0) {
    return question.options.map((option: AnswerOption) => ({ label: option.label, value: option.value }));
  }

  const metadataOptions = (question.metadata as { options?: Array<{ label?: string; value?: string }> }).options;
  if (!Array.isArray(metadataOptions)) {
    return [];
  }

  return metadataOptions
    .filter((entry) => typeof entry?.value === 'string')
    .map((entry) => ({
      label: typeof entry?.label === 'string' && entry.label ? entry.label : String(entry?.value),
      value: String(entry?.value)
    }));
}

export function PublicRunnerPage(props: PublicRunnerPageProps) {
  const params = useParams<{ slug: string }>();

  const [slug, setSlug] = useState(params.slug ?? '');
  const [bootstrap, setBootstrap] = useState<PublicBootstrapResponse | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [stage, setStage] = useState<RunnerStage>('setup');
  const [currentIndex, setCurrentIndex] = useState(0);

  const [leadEmail, setLeadEmail] = useState('');
  const [leadFirstName, setLeadFirstName] = useState('');
  const [leadLastName, setLeadLastName] = useState('');
  const [leadCompany, setLeadCompany] = useState('');
  const [leadConsent, setLeadConsent] = useState(true);

  const [answerInput, setAnswerInput] = useState('');
  const [multiInput, setMultiInput] = useState<string[]>([]);

  const [result, setResult] = useState<Result | null>(null);
  const [pdfJob, setPdfJob] = useState<PdfJob | null>(null);
  const [pdfEmail, setPdfEmail] = useState('');

  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState('');

  const api = useMemo(() => new ApiClient(props.apiBaseUrl), [props.apiBaseUrl]);

  const currentQuestion = bootstrap?.questions[currentIndex] ?? null;
  const options = currentQuestion ? getOptionList(currentQuestion) : [];
  const progressPercent = bootstrap?.questions.length
    ? Math.round((((stage === 'result' ? bootstrap.questions.length : currentIndex + 1) || 0) / bootstrap.questions.length) * 100)
    : 0;

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

  useEffect(() => {
    if (params.slug) {
      setSlug(params.slug);
    }
  }, [params.slug]);

  useEffect(() => {
    const routeSlug = params.slug;
    if (!routeSlug) {
      return;
    }

    void withTask('Loading assessment', async () => {
      const loaded = await api.getPublicBootstrap(routeSlug);
      setBootstrap(loaded);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.slug]);

  const loadAssessment = async () => {
    if (!slug.trim()) {
      throw new Error('Enter your assessment link key');
    }

    const loaded = await api.getPublicBootstrap(slug.trim());
    setBootstrap(loaded);
    setSession(null);
    setStage('setup');
    setCurrentIndex(0);
    setResult(null);
    setPdfJob(null);
    setNotice({ type: 'success', message: 'Assessment loaded. You can start now.' });
  };

  const startAssessment = async () => {
    if (!slug.trim()) {
      throw new Error('Enter your assessment link key first');
    }

    if (!bootstrap) {
      const loaded = await api.getPublicBootstrap(slug.trim());
      setBootstrap(loaded);
    }

    const started = await api.startPublicSession(slug.trim(), {});
    setSession(started);
    setStage('lead');
    setCurrentIndex(0);
    setAnswerInput('');
    setMultiInput([]);
    setResult(null);
    setPdfJob(null);
    setNotice({ type: 'success', message: 'Great. Tell us where to send your results.' });
  };

  const saveLead = async () => {
    if (!session) {
      throw new Error('Please start the assessment first');
    }
    if (!leadEmail.trim()) {
      throw new Error('Email is required');
    }

    await api.upsertLead(session.id, {
      email: leadEmail.trim(),
      firstName: leadFirstName.trim() || undefined,
      lastName: leadLastName.trim() || undefined,
      company: leadCompany.trim() || undefined,
      consent: leadConsent
    });

    setStage('questions');
    setNotice({ type: 'success', message: 'Thanks. Now answer the questions below.' });
  };

  const buildAnswer = (question: Question): ResponseAnswer => {
    if (question.type === 'multi_choice') {
      if (options.length > 0) {
        return multiInput;
      }
      return answerInput
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    }

    if (question.type === 'numeric' || question.type === 'scale') {
      const numeric = Number(answerInput);
      if (!Number.isFinite(numeric)) {
        throw new Error('Please enter a number');
      }
      return numeric;
    }

    return answerInput.trim();
  };

  const submitAnswer = async () => {
    if (!session || !currentQuestion) {
      throw new Error('No active question');
    }

    await api.upsertResponse(session.id, {
      questionId: currentQuestion.id,
      answer: buildAnswer(currentQuestion)
    });

    const nextIndex = currentIndex + 1;
    setAnswerInput('');
    setMultiInput([]);

    if (bootstrap && nextIndex >= bootstrap.questions.length) {
      const completed = await api.completeSession(session.id);
      setResult(completed);
      setStage('result');
      setNotice({ type: 'success', message: 'Assessment complete.' });
    } else {
      setCurrentIndex(nextIndex);
      setNotice({ type: 'info', message: 'Saved. Keep going.' });
    }
  };

  const queuePdf = async () => {
    if (!session) {
      throw new Error('Complete the assessment first');
    }

    const job = await api.queuePdf(session.id, {
      emailTo: pdfEmail.trim() || undefined
    });
    setPdfJob(job);
    setNotice({ type: 'info', message: 'PDF queued. Refresh status in a few seconds.' });
  };

  const refreshPdf = async () => {
    if (!pdfJob) {
      throw new Error('No PDF job yet');
    }
    const latest = await api.getPdfJob(pdfJob.id);
    setPdfJob(latest);
  };

  return (
    <div className="page runner-page">
      <header className="runner-header">
        <div>
          <span className="runner-eyebrow">Client Experience</span>
          <h1>{bootstrap?.landing.seoTitle ?? 'Assessment'}</h1>
          <p className="muted">{bootstrap?.landing.seoDescription ?? 'Simple, guided flow for your clients.'}</p>
        </div>
        <Link to="/" className="btn btn-secondary">
          Back to Studio
        </Link>
      </header>

      {notice ? <p className={`notice ${notice.type}`}>{notice.message}</p> : null}
      {busy ? <p className="notice info">{busy}...</p> : null}

      {stage === 'setup' ? (
        <section className="runner-stage runner-stage-setup">
          <article className="card runner-card">
            <h2>Load assessment</h2>
            <p className="muted">Enter your assessment key, confirm the page copy, then launch the flow.</p>
            <div className="inline-grid two">
              <label>
                Assessment key
                <input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="smoke-mm488jnw" autoComplete="off" />
              </label>
              <label>
                API URL
                <input value={props.apiBaseUrl} readOnly type="url" />
              </label>
            </div>
            <div className="button-row">
              <button className="btn" type="button" onClick={() => void withTask('Loading assessment', loadAssessment)}>
                Load
              </button>
              <button className="btn btn-primary" type="button" onClick={() => void withTask('Starting assessment', startAssessment)}>
                Start Assessment
              </button>
            </div>
          </article>

          <article className="card runner-card runner-preview-card">
            <div className="runner-preview-top">
              <span className="status-pill live">READY</span>
              <span className="muted small">{bootstrap?.questions.length ?? 0} questions</span>
            </div>
            <h3>{bootstrap?.landing.seoTitle ?? 'Load an assessment to preview it'}</h3>
            <p className="muted">{bootstrap?.landing.seoDescription ?? 'Answer a few quick questions to get your score.'}</p>
            <div className="runner-preview-stats">
              <div>
                <span className="metric-label">Lead capture</span>
                <strong>{bootstrap?.leadCaptureMode ?? 'before_results'}</strong>
              </div>
              <div>
                <span className="metric-label">Result delivery</span>
                <strong>Web + PDF</strong>
              </div>
            </div>
          </article>
        </section>
      ) : null}

      {stage === 'lead' ? (
        <section className="card runner-card">
          <h2>Your Details</h2>
          <p className="muted">We’ll use this to send your report and recommendations.</p>
          <div className="inline-grid two">
            <label>
              Email
              <input
                type="email"
                value={leadEmail}
                onChange={(event) => setLeadEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </label>
            <label>
              First name
              <input value={leadFirstName} onChange={(event) => setLeadFirstName(event.target.value)} autoComplete="given-name" />
            </label>
            <label>
              Last name
              <input value={leadLastName} onChange={(event) => setLeadLastName(event.target.value)} autoComplete="family-name" />
            </label>
            <label>
              Company
              <input value={leadCompany} onChange={(event) => setLeadCompany(event.target.value)} autoComplete="organization" />
            </label>
          </div>
          <label className="inline-label">
            <input type="checkbox" checked={leadConsent} onChange={(event) => setLeadConsent(event.target.checked)} />
            I agree to data processing
          </label>
          <button className="btn btn-primary" type="button" onClick={() => void withTask('Saving details', saveLead)}>
            Continue
          </button>
        </section>
      ) : null}

      {stage === 'questions' && currentQuestion ? (
        <section className="card runner-card">
          <div className="question-progress">
            <div className="runner-progress-meta">
              <span className="runner-eyebrow">Question {currentIndex + 1}</span>
              <span className="muted small">{bootstrap?.questions.length} total</span>
            </div>
            <div className="question-progress-track">
              <span style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }} />
            </div>
            <p className="muted">
              Question {currentIndex + 1} of {bootstrap?.questions.length}
            </p>
          </div>

          <h2>{currentQuestion.prompt}</h2>
          {currentQuestion.helpText ? <p className="muted">{currentQuestion.helpText}</p> : null}

          {currentQuestion.type === 'single_choice' ? (
            options.length ? (
              <fieldset className="choice-fieldset">
                <legend>Choose one</legend>
                <div className="choice-stack">
                  {options.map((option) => {
                    const selected = answerInput === option.value;
                    return (
                      <label key={option.value} className={`choice-pill ${selected ? 'selected' : ''}`}>
                        <input
                          type="radio"
                          name="single-choice"
                          checked={selected}
                          value={option.value}
                          onChange={(event) => setAnswerInput(event.target.value)}
                        />
                        <span>{option.label}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ) : (
              <label>
                Answer
                <input value={answerInput} onChange={(event) => setAnswerInput(event.target.value)} />
              </label>
            )
          ) : null}

          {currentQuestion.type === 'multi_choice' ? (
            options.length ? (
              <fieldset className="choice-fieldset">
                <legend>Choose one or more</legend>
                <div className="choice-stack">
                  {options.map((option) => {
                    const selected = multiInput.includes(option.value);
                    return (
                      <label key={option.value} className={`choice-pill ${selected ? 'selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(event) => {
                            if (event.target.checked) {
                              setMultiInput((current) => [...current, option.value]);
                            } else {
                              setMultiInput((current) => current.filter((value) => value !== option.value));
                            }
                          }}
                        />
                        <span>{option.label}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ) : (
              <label>
                Answers (comma-separated)
                <input value={answerInput} onChange={(event) => setAnswerInput(event.target.value)} />
              </label>
            )
          ) : null}

          {currentQuestion.type === 'numeric' || currentQuestion.type === 'scale' ? (
            <label>
              Number
              <input type="number" value={answerInput} onChange={(event) => setAnswerInput(event.target.value)} />
            </label>
          ) : null}

          {currentQuestion.type === 'short_text' ? (
            <label>
              Answer
              <textarea rows={4} value={answerInput} onChange={(event) => setAnswerInput(event.target.value)} />
            </label>
          ) : null}

          <button className="btn btn-primary" type="button" onClick={() => void withTask('Saving answer', submitAnswer)}>
            Next
          </button>
        </section>
      ) : null}

      {stage === 'result' && result ? (
        <section className="card runner-card">
          <h2>Your Results</h2>
          <div className="metric-grid runner-result-grid">
            <div>
              <span className="metric-label">Score</span>
              <strong>{result.normalizedScore}</strong>
            </div>
            <div>
              <span className="metric-label">Band</span>
              <strong>{result.scoreBand?.label ?? 'N/A'}</strong>
            </div>
            <div>
              <span className="metric-label">Raw</span>
              <strong>{result.rawScore}</strong>
            </div>
          </div>

          <h3>Recommendations</h3>
          <ul className="runner-recommendations">
            {result.recommendations.length ? result.recommendations.map((item) => <li key={item}>{item}</li>) : <li>No recommendations available.</li>}
          </ul>

          <hr />

          <h3>PDF report</h3>
          <label>
            Email for PDF (optional)
            <input type="email" value={pdfEmail} onChange={(event) => setPdfEmail(event.target.value)} placeholder="you@example.com" />
          </label>
          <div className="button-row">
            <button className="btn btn-primary" type="button" onClick={() => void withTask('Queueing PDF', queuePdf)}>
              Generate PDF
            </button>
            <button className="btn" type="button" onClick={() => void withTask('Checking PDF', refreshPdf)}>
              Refresh PDF Status
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => void withTask('Restarting', startAssessment)}>
              Start Again
            </button>
          </div>
          {pdfJob ? (
            <p className="muted">
              PDF status: <strong>{pdfJob.status}</strong>
              {pdfJob.fileUrl ? ` | Download: ${pdfJob.fileUrl}` : ''}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
