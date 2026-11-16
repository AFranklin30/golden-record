# Golden Record dashboard

How this product applies `docs/engineering/frontend-engineering-framework.md`. The framework stays general. The choices below are for this dashboard only.

The browser shows what the API returns and sends the operator's choice back. Matching stays in `src/modules/resolverEngine.js`. The screen does not decide that two people are the same, and it does not merge anyone on its own.

## Stack

`web/` is a Vite, React, and TypeScript app. The API stays CommonJS Express. TypeScript is not applied to the API. There is no second application server.

Styling is CSS variables in `web/src/styles.css`. There is no component library. Lists that come from the server use TanStack Query. Routes use React Router.

## Session

An operator signs in with an email and password. The server sets an httpOnly cookie named `gr_session`. The raw token is stored only as a sha256 hash. The organization API key never enters browser code, `localStorage`, or a bundle.

`operator` and `operator_session` are auth tables, like `org`: no RLS, because the lookup happens before `app.current_org_id` is set. Every query still filters by the session's `org_id`.

Creating the organization and the first operator is `scripts/createOperator.js`. It is not a public signup.

Dashboard routes are a separate stack, not a change to the API-key stack:

```
rate limiter
 → dashboardSessionMiddleware
 → rlsContextMiddleware
 → correlationIdMiddleware
 → handler
```

Sign-in is mounted before that stack. It uses the pool directly.

Confirm, reject, and export keep their existing handlers. The dashboard route forwards the request after the session has set `req.context` and `req.db`. The browser calls `/v1/dashboard/...`, not the API-key routes.

## Routes

- `/sign-in`
- `/` overview, from the pending reviews and recent imports already returned by the API
- `/account` organization name and operator email from the session
- `/imports`
- `/imports/new`
- `/imports/:id`
- `/records`
- `/records/:id`
- `/reviews`
- `/reviews/:id`
- `/exports`

There is no identity-resolution page. A row's result stays on the import detail.

Signed-in screens share one shell. A route guard loads `GET /v1/dashboard/session`. A 401 sends the person to `/sign-in`. If this tab already had a session, the sign-in page says the session ended. A network or server failure stays on a retry screen. Sign-out deletes the session and clears the cached lists.

## Upload

The operator maps file columns to `first_name`, `last_name`, `email`, `birthday`, `zip`, and `phone`. Preview calls `parseCustomerRow` and writes nothing. Import calls `importCustomers`. One bad row stays a row error. Progress and history are `import_batch` and `import_row`.

## What this UI does not do

It does not change the resolver or the scorer. It does not calculate matches or scores. It does not auto-merge. It does not change email or phone uniqueness. Review stays pending until a person confirms or rejects it.

## Security follow-up

These are open. A working sign-in screen does not close them.

- Row-level security is proven locally by `tests/routes/tenantIsolation.test.js`, which logs in as `golden_record_app`. The dashboard tests still use the local superuser. Neon has not been created, so the hosted role is not proven yet.
- The Vite dev server proxies `/v1` to the API, so the cookie is first-party in development. A split origin still needs `CORS_ORIGIN` set to that exact origin. `credentials` is already true on the API.
- `SameSite=Lax` keeps the cookie off a cross-site POST in current browsers. There is no separate CSRF token. A foreign site that can make a same-site request is outside that control.
- Sign-in hashes a normal-length password even when the email is unknown. The time that takes has not been measured.
- The general rate limiter is in memory on one process.
- The route guard is tested in jsdom with a mocked fetch. There is no browser end-to-end runner, so this does not prove a real cookie in a real browser.

These stay open for a later hosting slice. Slice 1 does not close them. The database contract is `docs/engineering/hosted-database-contract.md`. Local row-level security is proven there for `golden_record_app`. The hosted database is not.

- A quoted comma in a CSV is split as two columns.
- `express.json()` caps a request near 100 KB. The CSV guard allows 1,000,000 characters, and a larger file never reaches that guard.
- A new database connection waits 15 seconds. The pool does not retry.
- The hosted database role is not proven until the same checks run on Neon.
- A CSV import runs to completion inside the request.
- Sign-in uses `SameSite=Lax`. Origin and Referer checks are not added.
- A real customer file needs a backup and restore step. A free-tier restore window is not that step.
- More than one operator identity is future product work.
