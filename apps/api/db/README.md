# Database (M1-M5)

## Migration

```bash
npm run db:migrate
```

## Seed (development)

```bash
psql "$DATABASE_URL" -f db/seeds/0001_dev_seed.sql
```

Default seeded login:

- `tenantSlug`: `acme`
- `email`: `owner@acme.example`
- `password`: `ChangeMe123!`
