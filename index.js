'use strict';

require('dotenv').config();

const REQUIRED_ENV = ['DATABASE_URL', 'FIRESTORE_PROJECT_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const cors      = require('cors');
const express   = require('express');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const healthRouter            = require('./src/routes/health');
const orgAuthMiddleware       = require('./src/middleware/orgAuthMiddleware');
const rlsContextMiddleware    = require('./src/middleware/rlsContextMiddleware');
const correlationIdMiddleware = require('./src/middleware/correlationIdMiddleware');
const resolveRouter        = require('./src/routes/resolve');
const nfcRouter            = require('./src/routes/nfc');
const sessionRouter        = require('./src/routes/session');
const profileRouter        = require('./src/routes/profile');
const conflictsRouter      = require('./src/routes/conflicts');
const householdRouter          = require('./src/routes/household');
const { householdClaimRouter } = householdRouter;
const adminHouseholdRouter     = require('./src/routes/admin/household');
const jwtMiddleware        = require('./src/middleware/jwtMiddleware');
const pool                 = require('./src/db/pool');

const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// CORS — first middleware: fail secure when CORS_ORIGIN is not set.
// Function-based origin so unlisted origins are blocked at the server level,
// not just at the browser level (static-string config always sends the header).
const corsOptions = {
  origin: (requestOrigin, callback) => {
    const allowed = process.env.CORS_ORIGIN;
    if (!requestOrigin) return callback(null, true);   // server-to-server: no Origin header
    if (!allowed)       return callback(null, false);  // no config → block all browser origins
    callback(null, requestOrigin === allowed);          // exact-match only
  },
  methods:        ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Api-Key', 'X-Fan-Token', 'X-Correlation-Id'],
  credentials:    false,
};
app.use(cors(corsOptions));

app.use(helmet());
app.use(express.json());

// Health endpoint — stricter rate limit, no auth required
// Legitimate callers hit this once every 30 seconds at most
const healthRateLimiter = rateLimit({
  windowMs:        60000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
});
const healthLimitedRouter = express.Router();
healthLimitedRouter.use(healthRateLimiter);
healthLimitedRouter.use(healthRouter);
app.use(healthLimitedRouter);

// Protected routes — rate limiter → orgAuth → correlationId → handler
// jwtMiddleware is added per-route for fan-authenticated endpoints (session, profile)
const rateLimiter = rateLimit({
  windowMs:    parseInt(process.env.RATE_LIMIT_WINDOW_MS)    || 60000,
  max:         parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders:   false,
});

const protectedRouter = express.Router();
protectedRouter.use(rateLimiter);
protectedRouter.use(orgAuthMiddleware);
protectedRouter.use(rlsContextMiddleware);
protectedRouter.use(correlationIdMiddleware);
protectedRouter.use(resolveRouter);
protectedRouter.use(nfcRouter);
protectedRouter.use(sessionRouter);
protectedRouter.use(profileRouter);
protectedRouter.use(conflictsRouter);
protectedRouter.use(adminHouseholdRouter);

const householdProtectedRouter = express.Router();
householdProtectedRouter.use(rateLimiter);
householdProtectedRouter.use(orgAuthMiddleware);
householdProtectedRouter.use(rlsContextMiddleware);
householdProtectedRouter.use(correlationIdMiddleware);
householdProtectedRouter.use(jwtMiddleware);
householdProtectedRouter.use(householdRouter);

// householdPublicRouter — claim endpoint only, no jwtMiddleware
// Must be mounted BEFORE householdProtectedRouter so Express matches
// /v1/household/claim/:token here before matching :adult_fan_id below.
const householdPublicRouter = express.Router();
householdPublicRouter.use(rateLimiter);
householdPublicRouter.use(orgAuthMiddleware);
householdPublicRouter.use(rlsContextMiddleware);
householdPublicRouter.use(correlationIdMiddleware);
householdPublicRouter.use(householdClaimRouter);

app.use(protectedRouter);
app.use(householdPublicRouter);
app.use(householdProtectedRouter);

const server = app.listen(PORT, () => {
  console.log(`golden-record listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    pool.end();
    process.exit(0);
  });
});

module.exports = app;
