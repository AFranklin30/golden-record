'use strict';

require('dotenv').config();

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
const householdRouter      = require('./src/routes/household');
const jwtMiddleware        = require('./src/middleware/jwtMiddleware');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(express.json());

// Public routes — no middleware
app.use(healthRouter);

// Protected routes — rate limiter → orgAuth → correlationId → handler
// jwtMiddleware is added per-route for fan-authenticated endpoints (session, profile)
const rateLimiter = rateLimit({
  windowMs:    parseInt(process.env.RATE_LIMIT_WINDOW_MS)    || 60000,
  max:         parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders:   false
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

const householdProtectedRouter = express.Router();
householdProtectedRouter.use(rateLimiter);
householdProtectedRouter.use(orgAuthMiddleware);
householdProtectedRouter.use(rlsContextMiddleware);
householdProtectedRouter.use(correlationIdMiddleware);
householdProtectedRouter.use(jwtMiddleware);
householdProtectedRouter.use(householdRouter);

app.use(protectedRouter);
app.use(householdProtectedRouter);

app.listen(PORT, () => {
  console.log(`golden-record listening on port ${PORT}`);
});

module.exports = app;
