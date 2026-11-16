'use strict';

// Pool is required at the top of the file — before any jest.resetModules() call.
// This captures the original pool instance for FIX 2 and FIX 3 assertions.
const pool = require('../../src/db/pool');

// ---------------------------------------------------------------------------
// FIX 2 — Connection pool limits
// ---------------------------------------------------------------------------

describe('pool limits (FIX 2)', () => {
  test('max connections is 5', () => {
    expect(pool.options.max).toBe(5);
  });

  test('idleTimeoutMillis is 30000', () => {
    expect(pool.options.idleTimeoutMillis).toBe(30000);
  });

  test('connectionTimeoutMillis is 15000', () => {
    expect(pool.options.connectionTimeoutMillis).toBe(15000);
  });

  test('an idle client error is logged and does not escape', () => {
    expect(pool.listenerCount('error')).toBe(1);
    expect(() => {
      pool.emit('error', new Error('connection terminated unexpectedly'));
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — Statement timeout via rlsContextMiddleware (not pool.on connect)
//
// pool.on('connect') fires synchronously during connection establishment.
// Multiple simultaneous connections at startup cause concurrent client.query()
// calls which trigger a pg DeprecationWarning. The fix is to remove the connect
// handler and set statement_timeout inside rlsContextMiddleware where the client
// is already fully ready and the query is properly awaited.
// ---------------------------------------------------------------------------

const fs = require('fs');

describe('pool statement timeout (FIX 3)', () => {
  test('pool has no connect listener — avoids pg deprecation warning', () => {
    expect(pool.listenerCount('connect')).toBe(0);
  });

  test('rlsContextMiddleware sets statement_timeout via set_config', () => {
    const source = fs.readFileSync(
      require.resolve('../../src/middleware/rlsContextMiddleware.js'),
      'utf8'
    );
    expect(source).toContain('statement_timeout');
    expect(source).toContain('set_config');
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — SIGTERM graceful shutdown
// Requires a full index.js load. Uses PORT=0 so the OS assigns a free port.
// Intercepts http.Server.prototype.listen to capture the server for cleanup.
// ---------------------------------------------------------------------------

describe('SIGTERM handler (FIX 1)', () => {
  let serverRef       = null;
  let sigtermCountBefore;

  beforeAll((done) => {
    sigtermCountBefore = process.listenerCount('SIGTERM');

    // PORT=0 — OS picks a free port, no conflict with running services
    process.env.PORT = '0';

    // jwt.js throws StartupError if JWT keys are absent; provide placeholder values
    // so the module initializes without error. Actual signing is never called in this test.
    if (!process.env.JWT_PRIVATE_KEY) process.env.JWT_PRIVATE_KEY = 'startup-test-placeholder';
    if (!process.env.JWT_PUBLIC_KEY)  process.env.JWT_PUBLIC_KEY  = 'startup-test-placeholder';

    jest.resetModules();

    // Capture the server reference by intercepting http.Server.prototype.listen.
    // This lets us call serverRef.close() in afterAll so Jest does not hang on
    // an open handle.
    const http = require('http');
    const origListen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      serverRef = this;
      http.Server.prototype.listen = origListen; // restore immediately after first call
      return origListen.apply(this, args);
    };

    require('../../index');
    done();
  });

  afterAll((done) => {
    // Remove only the SIGTERM listeners added by this test's index.js load.
    const added = process.rawListeners('SIGTERM').slice(sigtermCountBefore);
    added.forEach((l) => process.removeListener('SIGTERM', l));

    if (serverRef) serverRef.close(done);
    else done();
  });

  test('process.on SIGTERM is registered after server starts', () => {
    expect(process.listenerCount('SIGTERM')).toBe(sigtermCountBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — Env var startup validation
// Each test sets the target var to '' (empty string is falsy).
// dotenv.config() inside index.js will NOT override an existing env key —
// even an empty one — so the validation check fires before any route loads.
// ---------------------------------------------------------------------------

describe('startup env var validation (FIX 4)', () => {
  let savedDatabaseUrl;
  let savedFirestoreProjectId;

  beforeEach(() => {
    jest.resetModules();
    savedDatabaseUrl        = process.env.DATABASE_URL;
    savedFirestoreProjectId = process.env.FIRESTORE_PROJECT_ID;
  });

  afterEach(() => {
    // Restore both vars to exactly their pre-test state
    if (savedDatabaseUrl !== undefined)        process.env.DATABASE_URL        = savedDatabaseUrl;
    else                                        delete process.env.DATABASE_URL;
    if (savedFirestoreProjectId !== undefined) process.env.FIRESTORE_PROJECT_ID = savedFirestoreProjectId;
    else                                        delete process.env.FIRESTORE_PROJECT_ID;
  });

  test('throws on missing DATABASE_URL', () => {
    process.env.DATABASE_URL = '';
    expect(() => require('../../index')).toThrow(
      'Missing required environment variable: DATABASE_URL',
    );
  });

  test('throws on missing FIRESTORE_PROJECT_ID', () => {
    process.env.FIRESTORE_PROJECT_ID = '';
    expect(() => require('../../index')).toThrow(
      'Missing required environment variable: FIRESTORE_PROJECT_ID',
    );
  });
});
