'use strict';

const { PhoneNumberUtil, PhoneNumberFormat } = require('google-libphonenumber');

const phoneUtil = PhoneNumberUtil.getInstance();

class NormalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NormalizationError';
  }
}

const ALLOWED_TYPES = ['email', 'phone', 'nfc_uid', 'nba_id', 'ticketmaster_id'];
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
  if (identifierType === 'email')   return normalizeEmail(rawValue);
  if (identifierType === 'phone')   return normalizePhone(rawValue);
  if (identifierType === 'nfc_uid') return normalizeNfcUid(rawValue);
  if (identifierType === 'nba_id' || identifierType === 'ticketmaster_id') return rawValue.trim();

  // RETURN — unreachable but explicit
  throw new NormalizationError(`unhandled identifier_type: ${identifierType}`);
}

module.exports = { normalizeIdentifier, NormalizationError };
