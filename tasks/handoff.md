Completed: MEDIUM-1 (redact raw token + guardian_email from age-up log), MEDIUM-2 (POST /v1/household wrapped in transaction), MEDIUM-3 (health rate limiter 10/min), MEDIUM-4/5 (cors function-based origin, fail secure). 336 tests pass.
Next: HIGH-3 — child session JWT enforcement (jwtMiddleware acting_as claim, household session scope).
Blocked: GCP credentials from Tanner still pending — migrations 003–007 not run on Cloud SQL.
Decisions: cors uses function-based origin handler so server blocks unlisted origins at header level (not just browser-level). Logger uses arrow functions so jest.spyOn works in tests.
Warnings: Run migration_007 locally before continuing. Do not deploy to Cloud SQL until Tanner provides credentials.
