# Test Plan Mapping

- `unit/`: scoring, branching, normalization, and report rendering logic.
- `integration/`: session lifecycle, publish/version lock, webhook retries, PDF job transitions.
  - Includes `integration/env.integration.test.ts` covering strict secret-policy validation in environment loading.
  - Includes `integration/auth.integration.test.ts` covering OpenAPI request validation and auth token flows.
  - Includes `integration/assessments.integration.test.ts` covering landing builder + M2 CRUD, publish-lock, copy-version cloning, and RBAC.
  - Includes `integration/runtime.integration.test.ts` covering public bootstrap, session lifecycle, scoring/result completion, and PDF job queue/status.
  - Includes `integration/m5_platform.integration.test.ts` covering reports CRUD, analytics summary/dropoff, webhook CRUD, and leads CSV export.
- `e2e/`: landing -> lead capture -> questions -> completion -> result -> PDF retrieval.
  - Includes `e2e/platform.e2e.test.ts` covering published-version report lock, runtime-to-result flow, PDF worker processing, webhook dead-letter replay, and CSV/report retrieval.
