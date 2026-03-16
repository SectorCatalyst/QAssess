import { type FormEvent, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';

import { ApiClient, ApiError } from './lib/api';
import { clearStoredAuth, loadStoredAuth, saveStoredAuth, type StoredAuth } from './lib/storage';
import { PublicRunnerPage } from './components/PublicRunnerPage';
import { StudioPage } from './components/StudioPage';

type Notice = { type: 'error' | 'success'; message: string } | null;

function getInitialBaseUrl(): string {
  const envValue = import.meta.env.VITE_API_BASE_URL;
  return typeof envValue === 'string' ? envValue : '';
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

interface LoginPanelProps {
  defaultApiBaseUrl: string;
  onAuthenticated: (value: StoredAuth) => void;
}

function LoginPanel(props: LoginPanelProps) {
  const [apiBaseUrl, setApiBaseUrl] = useState(props.defaultApiBaseUrl);
  const [email, setEmail] = useState('owner@acme.example');
  const [password, setPassword] = useState('ChangeMe123!');
  const [tenantSlug, setTenantSlug] = useState('acme');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setNotice(null);

    try {
      const client = new ApiClient(apiBaseUrl, null);
      const auth = await client.login({
        email,
        password,
        tenantSlug: tenantSlug.trim() || undefined
      });

      const next: StoredAuth = {
        apiBaseUrl,
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        expiresIn: auth.expiresIn,
        expiresAt: Date.now() + auth.expiresIn * 1000,
        userEmail: auth.user.email,
        tenantSlug: tenantSlug.trim() || undefined
      };

      saveStoredAuth(next);
      props.onAuthenticated(next);
    } catch (error) {
      setNotice({ type: 'error', message: formatError(error) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page login-page">
      <div className="login-shell">
        <section className="login-hero">
          <span className="login-eyebrow">Assessment Platform</span>
          <h1>Build scorecards, capture leads, and deliver reports from one clean workspace.</h1>
          <p className="muted">
            Designed for publishing conversion-focused assessments with structured analytics, result pages, and PDF delivery.
          </p>
          <div className="login-feature-list">
            <div>
              <strong>Landing Pages</strong>
              <span>Publish polished entry pages without leaving the studio.</span>
            </div>
            <div>
              <strong>Questions + Scoring</strong>
              <span>Configure weighted questions, answer logic, and results.</span>
            </div>
            <div>
              <strong>Reports + Integrations</strong>
              <span>Queue PDFs, export leads, and trigger webhook events.</span>
            </div>
          </div>
        </section>

        <section className="card login-card">
          <div className="login-card-head">
            <h2>Sign in to QAssess</h2>
            <p className="muted">Use your tenant credentials to open the Studio.</p>
          </div>
          <form onSubmit={submit} className="form-grid">
            <label>
              API Base URL
              <input
                value={apiBaseUrl}
                onChange={(event) => setApiBaseUrl(event.target.value)}
                placeholder="Leave blank to use same-origin"
                type="url"
                autoComplete="url"
              />
            </label>
            <label>
              Email
              <input value={email} onChange={(event) => setEmail(event.target.value)} required type="email" autoComplete="email" />
            </label>
            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                autoComplete="current-password"
              />
            </label>
            <label>
              Tenant Slug
              <input value={tenantSlug} onChange={(event) => setTenantSlug(event.target.value)} placeholder="acme" autoComplete="organization" />
            </label>
            <button disabled={loading} type="submit" className="btn btn-primary">
              {loading ? 'Signing In...' : 'Sign In'}
            </button>
          </form>
          {notice ? <p className={`notice ${notice.type}`}>{notice.message}</p> : null}
        </section>
      </div>
    </div>
  );
}

export function App() {
  const initialAuth = loadStoredAuth();
  const [auth, setAuth] = useState<StoredAuth | null>(initialAuth);
  const defaultApiBase = auth?.apiBaseUrl ?? getInitialBaseUrl();

  const api = useMemo(() => {
    return new ApiClient(auth?.apiBaseUrl ?? defaultApiBase, auth?.accessToken ?? null);
  }, [auth?.accessToken, auth?.apiBaseUrl, defaultApiBase]);

  const logout = () => {
    clearStoredAuth();
    setAuth(null);
  };

  return (
    <Routes>
      <Route
        path="/"
        element={
          auth ? (
            <StudioPage
              api={api}
              apiBaseUrl={auth.apiBaseUrl || '(same-origin/proxy)'}
              userEmail={auth.userEmail}
              tenantSlug={auth.tenantSlug}
              onLogout={logout}
            />
          ) : (
            <LoginPanel defaultApiBaseUrl={defaultApiBase} onAuthenticated={setAuth} />
          )
        }
      />
      <Route path="/run" element={<PublicRunnerPage apiBaseUrl={auth?.apiBaseUrl ?? defaultApiBase} />} />
      <Route path="/run/:slug" element={<PublicRunnerPage apiBaseUrl={auth?.apiBaseUrl ?? defaultApiBase} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function AppHeaderLink() {
  return (
    <Link to="/" className="link-chip">
      Studio
    </Link>
  );
}
