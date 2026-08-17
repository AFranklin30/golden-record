'use strict';

const { PhoneNumberUtil, PhoneNumberFormat } = require('google-libphonenumber');

const phoneUtil = PhoneNumberUtil.getInstance();

class NormalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NormalizationError';
  }
}

const ALLOWED_TYPES = [
  'email', 'phone', 'nfc_uid', 'nba_id', 'ticketmaster_id',
  'name', 'dob', 'zip', 'guardian_email', 'guardian_phone'
];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  const normalized = value.trim().toLowerCase();
  if (!EMAIL_REGEX.test(normalized)) {
    throw new NormalizationError(`email format invalid: ${value}`);
  }
  return normalized;
}

function normalizePhone(value) {
  const stripped = value.replace(/[()\-\s.]/g, '').replace(/[^0-9+]/g, '');
  let parsed;
  try {
    parsed = phoneUtil.parse(stripped, 'US');
  } catch {
    throw new NormalizationError(`phone not a valid number: ${value}`);
  }
  if (!phoneUtil.isValidNumber(parsed)) {
    throw new NormalizationError(`phone not a valid number: ${value}`);
  }
  return phoneUtil.format(parsed, PhoneNumberFormat.E164);
}

function normalizeNfcUid(value) {
  const stripped = value.replace(/[:\-\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]+$/.test(stripped)) {
    throw new NormalizationError(`nfc_uid contains non-hex characters: ${value}`);
  }
  if (stripped.length !== 8 && stripped.length !== 14) {
    throw new NormalizationError(`nfc_uid invalid length — expected 4 or 7 byte UID`);
  }
  return stripped.match(/.{2}/g).join(':');
}

function normalizeName(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') {
    throw new NormalizationError('name cannot be blank');
  }
  if (normalized.length > 256) {
    throw new NormalizationError('name exceeds max length');
  }
  return normalized.replace(/\s+/g, ' ');
}

function normalizeDob(value) {
  let parsed = null;

  // Try YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    parsed = new Date(`${value.trim()}T00:00:00.000Z`);
    if (isNaN(parsed.getTime())) parsed = null;
  }

  // Try MM/DD/YYYY
  if (parsed === null) {
    const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      parsed = new Date(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T00:00:00.000Z`);
      if (isNaN(parsed.getTime())) parsed = null;
    }
  }

  if (parsed === null || isNaN(parsed.getTime())) {
    throw new NormalizationError(`dob format invalid: ${value}`);
  }

  const now = new Date();
  if (parsed > now) {
    throw new NormalizationError('dob cannot be in the future');
  }

  const msIn120Years = 120 * 365.25 * 24 * 60 * 60 * 1000;
  if (now - parsed > msIn120Years) {
    throw new NormalizationError('dob is not a valid birth date');
  }

  return parsed.toISOString().split('T')[0];
}

function normalizeZip(value) {
  const stripped = value.trim().replace(/[^0-9]/g, '');
  if (stripped.length !== 5) {
    throw new NormalizationError(`zip must be 5 digits: ${value}`);
  }
  return stripped;
}

const NORMALIZATION_VERSION = 'v1';

const IDENTIFIER_FIELDS   = ['email', 'name', 'dob', 'zip', 'device_id', 'guardian_email'];
const NORMALIZABLE_FIELDS = ['email', 'name', 'dob', 'zip', 'guardian_email'];

/**
 * Type-checks and normalizes the advisory identifiers object shared by
 * /v1/resolve and /v1/ingest/nfc. Returns { ok: true, value } or
 * { ok: false, status, body }. Returns { ok: true, value: null } when
 * identifiers is absent. device_id passes through unnormalized — not in
 * ALLOWED_TYPES (soft signal only, never a hard identifier).
 */
function normalizeIdentifiersObject(identifiers) {
  if (identifiers === null || identifiers === undefined) {
    return { ok: true, value: null };
  }
  if (typeof identifiers !== 'object' || Array.isArray(identifiers)) {
    return { ok: false, status: 400, body: {
      error:   'identifiers must be an object',
      message: 'identifiers, when provided, must be a JSON object of signal fields',
    }};
  }
  for (const field of IDENTIFIER_FIELDS) {
    const v = identifiers[field];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      return { ok: false, status: 400, body: {
        error:   'identifiers field must be a string',
        message: `identifiers.${field} must be a string when provided`,
      }};
    }
  }
  const out = {};
  for (const field of NORMALIZABLE_FIELDS) {
    const v = identifiers[field];
    if (v != null) {
      try {
        out[field] = normalizeIdentifier(field, v);
      } catch (err) {
        if (err instanceof NormalizationError) {
          return { ok: false, status: 400, body: {
            error:  'identifiers field failed normalization',
            detail: err.message,
          }};
        }
        throw err;
      }
    }
  }
  if (identifiers.device_id != null) {
    out.device_id = identifiers.device_id;
  }
  return { ok: true, value: out };
}

// RECEIVE
function normalizeIdentifier(type, value) {
  const identifierType = type;
  const rawValue = value;

  // GUARD
  if (identifierType === null || identifierType === undefined || String(identifierType).trim() === '') {
    throw new NormalizationError('identifier_type is required');
  }
  if (rawValue === null || rawValue === undefined) {
    throw new NormalizationError('identifier_value is required');
  }
  if (typeof rawValue !== 'string') {
    throw new NormalizationError('identifier_value must be a string');
  }
  if (rawValue.trim() === '') {
    throw new NormalizationError('identifier_value cannot be blank');
  }
  if (rawValue.length > 512) {
    throw new NormalizationError('identifier_value exceeds max length');
  }
  if (!ALLOWED_TYPES.includes(identifierType)) {
    throw new NormalizationError(`unknown identifier_type: ${identifierType}`);
  }

  // EXECUTE
  if (identifierType === 'email')            return normalizeEmail(rawValue);
  if (identifierType === 'phone')            return normalizePhone(rawValue);
  if (identifierType === 'nfc_uid')          return normalizeNfcUid(rawValue);
  if (identifierType === 'nba_id' || identifierType === 'ticketmaster_id') return rawValue.trim();
  if (identifierType === 'name')             return normalizeName(rawValue);
  if (identifierType === 'dob')              return normalizeDob(rawValue);
  if (identifierType === 'zip')              return normalizeZip(rawValue);
  if (identifierType === 'guardian_email')   return normalizeEmail(rawValue);
  if (identifierType === 'guardian_phone')   return normalizePhone(rawValue);

  // RETURN — unreachable but explicit
  throw new NormalizationError(`unhandled identifier_type: ${identifierType}`);
}

module.exports = { normalizeIdentifier, NormalizationError, NORMALIZATION_VERSION, normalizeIdentifiersObject };
