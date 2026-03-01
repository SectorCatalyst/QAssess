# Backend Structure (Starter)

This layout is optimized for an API-first, domain-module architecture with versioned contracts and clear runtime separation.

## Directory Layout

```text
apps/api
├── src
│   ├── config
│   │   └── env.ts
│   ├── lib
│   │   ├── db.ts
│   │   └── logger.ts
│   ├── middleware
│   │   └── auth.ts
│   ├── modules
│   │   ├── auth
│   │   │   └── routes.ts
│   │   ├── assessments
│   │   │   └── routes.ts
│   │   ├── public
│   │   │   └── routes.ts
│   │   ├── sessions
│   │   │   └── routes.ts
│   │   ├── reports
│   │   │   └── routes.ts
│   │   ├── analytics
│   │   │   └── routes.ts
│   │   └── integrations
│   │       └── routes.ts
│   ├── jobs
│   │   ├── pdf-worker.ts
│   │   └── webhook-worker.ts
│   ├── types
│   │   └── http.ts
│   └── index.ts
└── tests
    ├── unit
    ├── integration
    └── e2e
```

## Module Boundaries

- `auth`: admin auth and current user context.
- `assessments`: authoring endpoints for assessments, versions, landing blocks, questions, logic, and score bands.
- `public`: unauthenticated bootstrap + session start.
- `sessions`: lead capture, responses, completion, and result retrieval.
- `reports`: report template authoring and report assembly.
- `analytics`: funnel and dropoff read models.
- `integrations`: webhook endpoint management and delivery observability.

## Runtime Jobs

- `pdf-worker`: consumes `pdf_jobs` queue and persists output URL/status.
- `webhook-worker`: pulls pending deliveries and retries with exponential backoff.

## Engineering Constraints

- Keep API handlers thin; push business rules into service layer (next implementation step).
- Validate request payloads against OpenAPI-generated schemas.
- Enforce tenant scope in every data access path.
- Keep publish operation transactional to guarantee one published version per assessment.
