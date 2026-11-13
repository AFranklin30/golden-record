# Golden Record — Fan Identity Resolution Platform

Golden Record  
Author: Aaron Franklin  
Stack: Node.js/Express · PostgreSQL on Cloud SQL · Firestore · GCP Cloud Run  
Status: Production — Sprint 3 Complete

---

## What This Is

Golden Record is a production-grade fan identity resolution platform. It resolves fragmented fan identifiers — NFC card UIDs, emails, phone numbers, NBA IDs, Ticketmaster IDs — into a single canonical fan record.

Every fan tap, login, or ingestion event flows through the identity graph. The system is the source of truth for who a fan is across every touchpoint.

Live URL: `https://YOUR_CLOUD_RUN_HOST`

---

## Local Setup

### Prerequisites
- Node.js 20+
- PostgreSQL 14+
- Google Cloud SDK (`gcloud`)
- Cloud SQL Auth Proxy

### Steps

**1. Clone the repo**
```bash
git clone https://github.com/AFranklin30/golden-record.git
cd golden-record
```

**2. Install dependencies**
```bash
npm install
```

**3. Set up environment variables**
```bash
cp .env.example .env
```
Fill in the values in `.env`. See Environment Variables section below.

**4. Create local database**
```bash
createdb golden_record
```

**5. Run migrations in order**
```bash
psql $DATABASE_URL -f migrations/migration_001.sql
psql $DATABASE_URL -f migrations/migration_002.sql
psql $DATABASE_URL -f migrations/migration_003.sql
psql $DATABASE_URL -f migrations/migration_004.sql
psql $DATABASE_URL -f migrations/migration_005.sql
psql $DATABASE_URL -f migrations/migration_006.sql
psql $DATABASE_URL -f migrations/migration_007.sql
psql $DATABASE_URL -f migrations/migration_008.sql
psql $DATABASE_URL -f migrations/migration_009.sql
psql $DATABASE_URL -f migrations/migration_010.sql
```

**6. Seed development data**
```bash
psql $DATABASE_URL -f seeds/seed_dev.sql
```

**7. Start the server**
```bash
node index.js
```

**8. Verify**
```bash
curl http://localhost:3000/health
```

---

## Environment Variables

| Variable | Description |
|---|---|
| DATABASE_URL | PostgreSQL connection string |
| FIRESTORE_PROJECT_ID | GCP project ID for Firestore |
| JWT_PRIVATE_KEY | RS256 private key (local only — Secret Manager in Cloud Run) |
| JWT_PUBLIC_KEY | RS256 public key (local only — Secret Manager in Cloud Run) |
| DEV_ORG_API_KEY | API key for the development org seed |
| CORS_ORIGIN | Exact allowed frontend origin domain |

---

## Authentication

All API requests require:
```
Authorization: Bearer your-org-api-key
```

Fan-facing endpoints additionally require:
```
X-Fan-Token: your-fan-jwt
```

JWTs are issued by `POST /v1/session`. Standard tokens expire in 15 minutes. Child session tokens expire in 8 hours.

---

## Migration Rules

- Always run migrations in order — 001 through 010
- Never skip a migration
- Always verify with the queries at the bottom of each migration file
- Cloud SQL migrations are run manually and deliberately — never automated without review
- Never run seed_dev.sql against production
- Never modify a migration that has already been run on any database — fix forward with a new migration

---

## Architecture

**Identity Resolution Flow:**
Fan event (NFC tap / login / ingest) → Normalizer → Resolver Engine → Canonical Fan Record

**Resolution Paths:**
- Path A — exact identifier match, existing fan returned
- Path B — new fan record created
- Path C — probabilistic match above threshold, existing fan returned
- Path D — probabilistic match below threshold, conflict queued for staff review

**Pipeline:**
- Bronze — raw ingest
- Silver — normalized and resolved
- Gold — analytics ready (BigQuery — Phase 3)

**Database:**
- PostgreSQL on Cloud SQL — identity graph and audit trail
- Row Level Security enforced on all 10 tenant tables — tenant isolation at database level
- Firestore — fan wallet and loyalty data (golden-record database, golden-record collection)

---

## API Endpoints

### Health
- `GET /health`

### Fan Identity
- `POST /v1/resolve`
- `POST /v1/ingest/nfc`
- `POST /v1/session`
- `GET /v1/fan/:id/profile`

### Conflicts
- `GET /v1/conflicts`
- `POST /v1/conflicts/:id/confirm`
- `POST /v1/conflicts/:id/reject`
- `POST /v1/conflicts/:id/unmerge`

### Household
- `POST /v1/household`
- `GET /v1/household/:adult_fan_id`
- `POST /v1/household/:adult_fan_id/members`
- `GET /v1/household/:adult_fan_id/members/:child_fan_id`
- `PUT /v1/household/:adult_fan_id/members/:child_fan_id`
- `DELETE /v1/household/:adult_fan_id/members/:child_fan_id`
- `POST /v1/household/:adult_fan_id/members/:child_fan_id/session`
- `POST /v1/household/:adult_fan_id/members/:child_fan_id/age-up`
- `GET /v1/household/claim/:token`
- `GET /v1/admin/household/:fan_id`

Full API reference: see `golden-record-api-docs.md`

---

## Deployment

### Prerequisites
- JWT keys stored in Secret Manager (`jwt-private-key`, `jwt-public-key`)
- DATABASE_URL stored in Secret Manager (`database-url`) — URL-encode special characters in password
- All 10 migrations run on Cloud SQL
- Firestore `golden-record` database and `golden-record` collection exist
- Cloud Run service account has these roles:
  - `roles/secretmanager.secretAccessor`
  - `roles/cloudsql.client`
  - `roles/datastore.user`

### Build and Deploy
```bash
gcloud builds submit --tag gcr.io/YOUR_GCP_PROJECT/golden-record

gcloud run deploy golden-record \
  --image gcr.io/YOUR_GCP_PROJECT/golden-record \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars FIRESTORE_PROJECT_ID=YOUR_GCP_PROJECT \
  --set-secrets JWT_PRIVATE_KEY=jwt-private-key:latest,JWT_PUBLIC_KEY=jwt-public-key:latest,DATABASE_URL=database-url:latest \
  --add-cloudsql-instances YOUR_GCP_PROJECT:us-central1:YOUR_SQL_INSTANCE
```

### Verify
```bash
curl https://YOUR_CLOUD_RUN_HOST/health
```

### Rollback
```bash
# List revisions
gcloud run revisions list --service golden-record --region us-central1

# Roll back to previous revision
gcloud run services update-traffic golden-record \
  --to-revisions REVISION_NAME=100 \
  --region us-central1
```

---

## Running Tests
```bash
npm test
```

360 tests across 12 test suites. All must pass before deploying.

---

## Sprint Status

| Sprint | Status | Components |
|---|---|---|
| Sprint 1 — Core identity resolution | ✅ Complete | 12 |
| Sprint 2 — Probabilistic matching, conflict queue | ✅ Complete | 9 |
| Sprint 3 — Household identity, merge history | ✅ Complete | 16 |

---

## Known Gaps — Roadmap Before Real Fan Traffic

- Email delivery is stubbed — SendGrid integration needed for age-up claim tokens
- Firestore DLQ not implemented — failed wallet syncs disappear silently
- resolve.js DLQ not implemented — failed resolutions not captured
- Household member idempotency — mobile retry storms could create duplicate records
- Paths C and D not tested with real fan data — signal weights need tuning
- CORS_ORIGIN must be confirmed with King before frontend deployment

---

## Contact

Aaron Franklin — afrank25303@gmail.com  
Backend Engineer