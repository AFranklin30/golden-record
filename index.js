'use strict';

require('dotenv').config();

const express   = require('express');
const rateLimit = require('express-rate-limit');

const healthRouter         = require('./src/routes/health');
const orgAuthMiddleware    = require('./src/middleware/orgAuthMiddleware');
const correlationIdMiddleware = require('./src/middleware/correlationIdMiddleware');
const resolveRouter        = require('./src/routes/resolve');
const nfcRouter            = require('./src/routes/nfc');
const sessionRouter        = require('./src/routes/session');
const profileRouter        = require('./src/routes/profile');

const app  = express();
const PORT = process.env.PORT || 3000;

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
protectedRouter.use(correlationIdMiddleware);
protectedRouter.use(resolveRouter);
protectedRouter.use(nfcRouter);
protectedRouter.use(sessionRouter);
protectedRouter.use(profileRouter);

app.use(protectedRouter);

app.listen(PORT, () => {
  console.log(`golden-record listening on port ${PORT}`);
});

module.exports = app;
