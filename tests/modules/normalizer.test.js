'use strict';

const { normalizeIdentifier, NormalizationError } = require('../../src/modules/normalizer');

// --- name ---

describe('normalizer — name', () => {
  test('normalizes to lowercase', () => {
    expect(normalizeIdentifier('name', 'John DOE')).toBe('john doe');
  });

  test('trims leading and trailing whitespace', () => {
    expect(normalizeIdentifier('name', '  Jane Smith  ')).toBe('jane smith');
  });

  test('collapses multiple spaces to single space', () => {
    expect(normalizeIdentifier('name', 'Bob   Builder')).toBe('bob builder');
  });

  test('throws NormalizationError on empty string', () => {
    expect(() => normalizeIdentifier('name', '')).toThrow(NormalizationError);
  });

  test('throws NormalizationError on string over 256 characters', () => {
    const long = 'a'.repeat(257);
    expect(() => normalizeIdentifier('name', long)).toThrow(NormalizationError);
  });

  test('accepts name at exactly 256 characters', () => {
    const exact = 'a'.repeat(256);
    expect(normalizeIdentifier('name', exact)).toBe(exact);
  });
});

// --- dob ---

describe('normalizer — dob', () => {
  test('accepts YYYY-MM-DD format and returns it unchanged', () => {
    expect(normalizeIdentifier('dob', '2000-06-15')).toBe('2000-06-15');
  });

  test('accepts MM/DD/YYYY and converts to YYYY-MM-DD', () => {
    expect(normalizeIdentifier('dob', '06/15/2000')).toBe('2000-06-15');
  });

  test('rejects DD/MM/YYYY format — US-only platform', () => {
    expect(() => normalizeIdentifier('dob', '31/03/2000')).toThrow(NormalizationError);
    expect(() => normalizeIdentifier('dob', '31/03/2000')).toThrow('dob format invalid');
  });

  test('always returns YYYY-MM-DD format', () => {
    const result = normalizeIdentifier('dob', '01/01/1990');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('throws NormalizationError on future date', () => {
    expect(() => normalizeIdentifier('dob', '2099-01-01')).toThrow(NormalizationError);
    expect(() => normalizeIdentifier('dob', '2099-01-01')).toThrow('dob cannot be in the future');
  });

  test('throws NormalizationError on date more than 120 years ago', () => {
    expect(() => normalizeIdentifier('dob', '1890-01-01')).toThrow(NormalizationError);
    expect(() => normalizeIdentifier('dob', '1890-01-01')).toThrow('dob is not a valid birth date');
  });

  test('throws NormalizationError on invalid format', () => {
    expect(() => normalizeIdentifier('dob', 'not-a-date')).toThrow(NormalizationError);
    expect(() => normalizeIdentifier('dob', 'not-a-date')).toThrow('dob format invalid');
  });

  test('throws NormalizationError on invalid calendar date', () => {
    expect(() => normalizeIdentifier('dob', '2000-13-01')).toThrow(NormalizationError);
  });
});

// --- zip ---

describe('normalizer — zip', () => {
  test('accepts a 5-digit string', () => {
    expect(normalizeIdentifier('zip', '73101')).toBe('73101');
  });

  test('strips non-numeric characters when result is exactly 5 digits', () => {
    // "73.101" → "73101"
    expect(normalizeIdentifier('zip', '73.101')).toBe('73101');
  });

  test('throws NormalizationError if stripped result is not exactly 5 digits', () => {
    expect(() => normalizeIdentifier('zip', '731')).toThrow(NormalizationError);
    expect(() => normalizeIdentifier('zip', '731')).toThrow('zip must be 5 digits');
  });

  test('throws NormalizationError on zip+4 (9 digits after stripping)', () => {
    // "73101-6789" → "731016789" (9 digits) → throws
    expect(() => normalizeIdentifier('zip', '73101-6789')).toThrow(NormalizationError);
  });

  test('throws NormalizationError on empty string', () => {
    expect(() => normalizeIdentifier('zip', '')).toThrow(NormalizationError);
  });
});

// --- guardian_email ---

describe('normalizer — guardian_email', () => {
  test('normalizes to lowercase', () => {
    expect(normalizeIdentifier('guardian_email', 'GUARDIAN@EXAMPLE.COM')).toBe('guardian@example.com');
  });

  test('trims whitespace', () => {
    expect(normalizeIdentifier('guardian_email', '  guardian@example.com  ')).toBe('guardian@example.com');
  });

  test('throws NormalizationError on invalid email format', () => {
    expect(() => normalizeIdentifier('guardian_email', 'not-an-email')).toThrow(NormalizationError);
    expect(() => normalizeIdentifier('guardian_email', 'not-an-email')).toThrow('email format invalid');
  });

  test('accepts a valid email', () => {
    expect(normalizeIdentifier('guardian_email', 'parent@thunder.com')).toBe('parent@thunder.com');
  });
});

// --- guardian_phone ---

describe('normalizer — guardian_phone', () => {
  test('formats valid US number to E.164', () => {
    expect(normalizeIdentifier('guardian_phone', '4055551234')).toBe('+14055551234');
  });

  test('accepts formatted number and normalizes to E.164', () => {
    expect(normalizeIdentifier('guardian_phone', '(405) 555-1234')).toBe('+14055551234');
  });

  test('throws NormalizationError on invalid phone number', () => {
    expect(() => normalizeIdentifier('guardian_phone', '123')).toThrow(NormalizationError);
    expect(() => normalizeIdentifier('guardian_phone', '123')).toThrow('phone not a valid number');
  });
});
