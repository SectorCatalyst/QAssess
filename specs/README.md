# QAssess Specifications

This directory contains build-ready specifications for the ScoreApp-style assessment platform.

## Contents

- `api/openapi.yaml`: OpenAPI 3.1 contract for admin and public runtime APIs.
- `database/postgres.sql`: Postgres schema, constraints, indexes, and trigger utilities.
- `architecture/backend-structure.md`: Starter backend layout and module boundaries.

## Notes

- These specs assume a multi-tenant SaaS model.
- Assessment sessions are version-pinned for scoring consistency.
- API and schema are designed to support both MVP and phase-2 expansion without breaking contracts.
