# QAssess Web GUI

Browser UI for the QAssess API.

## What This Includes

- Admin Studio (`/`)
  - Login
  - Assessments + versions
  - Landing page settings + block layout controls
  - Question builder with weightings
  - Answer options and logic rules
  - Report template + sections
  - Analytics summary/dropoff
  - Webhook integrations
  - Leads CSV export
- Public Client Experience (`/run/:slug`)
  - Landing load by slug
  - Lead capture
  - Question-by-question response flow
  - Completion + result view
  - PDF queue/status

## Local Run

### 1) Start API

```bash
cd /Users/troysullivan/Documents/QAssess/apps/api
set -a && source .env && set +a
npm run dev
```

API should be available at:
- `http://127.0.0.1:4000/healthz`

### 2) Start Web GUI

```bash
cd /Users/troysullivan/Documents/QAssess/apps/web
npm install
npm run dev
```

Web GUI:
- `http://127.0.0.1:4173`

The Vite dev server proxies `/v1`, `/healthz`, and `/readyz` to `http://127.0.0.1:4000` by default.

## Login Defaults (local seed)

Use your seeded/local API credentials. Example values commonly used in this workspace:

- Email: `owner@acme.example`
- Password: `ChangeMe123!`
- Tenant Slug: `acme`

## API Base URL Field in Login

- Leave blank to use same-origin/proxy in local dev.
- Set explicit URL (for deployed API), for example:
  - `https://api.yourdomain.com`

## Build

```bash
cd /Users/troysullivan/Documents/QAssess/apps/web
npm run build
```
