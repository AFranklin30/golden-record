'use strict';

const { firestoreSyncEnabled } = require('../../src/modules/resolverEngine');

describe('firestoreSyncEnabled', () => {
  const keys = ['FIRESTORE_SYNC', 'GOOGLE_APPLICATION_CREDENTIALS', 'K_SERVICE'];
  const saved = {};

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('off skips the wallet write even on Cloud Run', () => {
    process.env.FIRESTORE_SYNC = 'off';
    process.env.K_SERVICE = 'golden-record';
    expect(firestoreSyncEnabled()).toBe(false);
  });

  test('on keeps the wallet write', () => {
    process.env.FIRESTORE_SYNC = 'on';
    expect(firestoreSyncEnabled()).toBe(true);
  });

  test('Cloud Run keeps the wallet write', () => {
    process.env.K_SERVICE = 'golden-record';
    expect(firestoreSyncEnabled()).toBe(true);
  });
});
