# Golden Record — Fan Identity Resolution Platform

OKC Thunder — Thunder Innovations Cohort
Author: Aaron Franklin
Stack: Node.js/Express · PostgreSQL on Cloud SQL · Firestore · GCP Cloud Run

---

## What This Is

Golden Record is a production-grade fan identity resolution platform. It resolves fragmented fan identifiers — NFC card UIDs, emails, phone numbers, NBA IDs, Ticketmaster IDs — into a single canonical fan record.

Every fan tap, login, or ingestion event flows through the identity graph. The system is the source of truth for who a fan is across all Thunder touchpoints.

---

## Local Setup

### Prerequisites
- Node.js 20+
- PostgreSQL 14+
- Google Cloud SDK (gcloud)

### Steps

1. Clone the repo
git clone https://github.com/Thunder-Innovations/identity-resolution-project.git
cd identity-resolution-project

2. Install dependencies
npm install

3. Set up environment variables
cp .env.example .env
Fill in the values in .env

4. Create local database
createdb golden_record

5. Run migrations in order
psql $DATABASE_URL -f migrations/migration_001.sql
psql $DATABASE_URL -f migrations/migration_002.sql
psql $DATABASE_URL -f migrations/migration_003.sql
psql $DATABASE_URL -f migrations/migration_004.sql
psql $DATABASE_URL -f migrations/migration_005.sql

6. Seed development data
psql $DATABASE_URL -f seeds/seed_dev.sql

7. Start the server
node index.js

8. Verify
curl http://localhost:3000/health

---

## Environment Variables

DATABASE_URL — PostgreSQL connection string
FIRESTORE_PROJECT_ID — GCP project ID for Firestore
JWT_PRIVATE_KEY — RS256 private key (local only — Secret Manager in Cloud Run)
JWT_PUBLIC_KEY — RS256 public key (local only — Secret Manager in Cloud Run)
DEV_ORG_API_KEY — API key for the development org seed

---

## Migration Rules

- Always run migrations in order 001 through 005
- Never skip a migration
- Always verify with the queries at the bottom of each migration file
- Cloud SQL migrations are run manually and deliberately
- Never run seed_dev.sql against production

---

## Architecture

Identity Resolution Flow:
Fan event (NFC tap / login / ingest) → Normalizer → Resolver Engine → Canonical Fan Record

Matching layers:
- Deterministic — exact identifier match
- Probabilistic — weighted signal scoring across email, phone, name, DOB, zip, guardian signals

Pipeline:
- Bronze — raw ingest
- Silver — normalized and resolved
- Gold — analytics ready (BigQuery)

Database:
- PostgreSQL on Cloud SQL — identity graph and audit trail
- Firestore — fan wallet and loyalty data
- Row Level Security enforced on all tables — tenant isolation at database level

---

## API Endpoints

Health
- GET /health

Fan
- GET /v1/fan/:id/profile
- POST /v1/resolve
- POST /v1/ingest/nfc
- POST /v1/session

Conflicts
- GET /v1/conflicts
- POST /v1/conflicts/:id/confirm
- POST /v1/conflicts/:id/reject
- POST /v1/conflicts/:id/unmerge

Household
- POST /v1/household
- GET /v1/household/:adult_fan_id
- POST /v1/household/:adult_fan_id/members
- GET /v1/household/:adult_fan_id/members/:child_fan_id
- PUT /v1/household/:adult_fan_id/members/:child_fan_id
- DELETE /v1/household/:adult_fan_id/members/:child_fan_id
- POST /v1/household/:adult_fan_id/members/:child_fan_id/session
- POST /v1/household/:adult_fan_id/members/:child_fan_id/age-up
- GET /v1/household/claim/:token
- GET /v1/admin/household/:fan_id

---

## Deployment

Cloud Run deployment requires:
1. JWT keys stored in Secret Manager
2. All migrations run on Cloud SQL
3. Container built and pushed via Cloud Build
4. Environment variables configured on Cloud Run service

Contact Aaron Franklin for deployment access and procedures.

---

## Sprint Status

Sprint 1 — Core identity resolution (12 components) — Complete
Sprint 2 — Probabilistic matching, conflict queue (9 components) — Complete
Sprint 3 — Household identity, merge history (18 components) — In Progress
