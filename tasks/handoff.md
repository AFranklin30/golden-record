Completed: Component 26 — POST /v1/conflicts/:id/unmerge built and verified. 15 new tests (including org isolation + non-UUID guard). 179/179 full suite green.
Next: Component 27 — POST /v1/household (new file: src/routes/household.js — create it, does not exist yet).
Blocked: GCP credentials from Tanner — migrations 003/004/005 not yet run on Cloud SQL. private.key and public.key sitting locally — do not delete until stored in Secret Manager.
Decisions: merged_from_fan_id set to NULL after identifier move — provenance cleaned up post-reversal. related_fans written on every unmerge with fan_id_a = fan_id_target, fan_id_b = fan_id_source.
Warnings: Component 27 starts the household endpoints — new file src/routes/household.js. Create it from scratch. jwtMiddleware IS required for household (fan action, not staff action) — different from conflicts.js middleware stack.
