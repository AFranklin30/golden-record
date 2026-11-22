'use strict';

const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const { Firestore } = require('@google-cloud/firestore');
const {
  scoreMatch,
  SCORER_VERSION,
  levenshteinDistance,
  givenNamesEquivalent,
  isListedGivenName,
  populatedFirstNamesConflict,
} = require('./probabilisticMatcher');
const { NORMALIZATION_VERSION }      = require('./normalizer');

const THRESHOLD_PATH_C = 0.85;
const THRESHOLD_PATH_D = 0.60;
const BLOCK_SIZE_CAP   = 50;

function hasNameAndDobAgreement(signals) {
  return Array.isArray(signals) && signals.some((s) => s && s.signal === 'name_plus_dob');
}

// Path for one scored pair. The stored score is not changed.
// Name + same birthday is review even when a penalty leaves the score under 0.60.
// A score already at or above 0.85 stays PATH C. No name_plus_dob signal uses the
// two thresholds exactly. A birthday veto returns no signals, so it stays PATH B.
function pathForMatch(score, signals) {
  if (score >= THRESHOLD_PATH_C) return 'C';
  if (score >= THRESHOLD_PATH_D) return 'D';
  if (hasNameAndDobAgreement(signals)) return 'D';
  return 'B';
}

const firestore = new Firestore({
  projectId:  process.env.FIRESTORE_PROJECT_ID,
  databaseId: 'golden-record',
});

// The wallet write is optional. Render has no Google credentials, and the
// client library rejects a second promise that try/catch cannot see. Calling
// set() there restarts the process in the middle of an import.
function firestoreSyncEnabled() {
  if (process.env.FIRESTORE_SYNC === 'off') return false;
  if (process.env.FIRESTORE_SYNC === 'on') return true;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.K_SERVICE) return true;
  const home = process.env.HOME || '';
  if (home === '') return false;
  return fs.existsSync(path.join(home, '.config', 'gcloud', 'application_default_credentials.json'));
}

const logger = require('../lib/logger');

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

class ResolverError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResolverError';
  }
}

// Checks whether a candidate has enough signal potential to be worth scoring.
// Existence-only check — no similarity math runs here.
// STRONG signals: email_similarity, name_plus_dob, guardian_email
// WEAK signals:   name_plus_zip, device_id, name_alone
// PASS if >= 1 strong OR >= 2 weak. FAIL otherwise — skip candidate entirely.
function passesSignalEligibilityGate(candidate, inbound) {
  let strongCount = 0;
  let weakCount   = 0;

  // email_similarity — strong
  if (inbound.email != null && candidate.email != null) {
    strongCount++;
  }

  // name_plus_dob — strong
  if (
    inbound.name != null && inbound.dob != null &&
    candidate.name != null && candidate.dob != null
  ) {
    strongCount++;
  }

  // guardian_email — strong
  if (inbound.guardian_email != null && candidate.guardian_email != null) {
    strongCount++;
  }

  // name_plus_zip — weak
  if (
    inbound.name != null && inbound.zip != null &&
    candidate.name != null && candidate.zip != null
  ) {
    weakCount++;
  }

  // device_id — weak
  if (inbound.device_id != null && candidate.device_id != null) {
    weakCount++;
  }

  // name_alone — weak
  if (inbound.name != null && candidate.name != null) {
    weakCount++;
  }

  return strongCount >= 1 || weakCount >= 2;
}

function nameWords(name) {
  if (name == null) return [];
  return String(name).trim().split(/\s+/).filter((word) => word !== '');
}

/**
 * Retrieval narrowing — finds fan_ids worth scoring instead of scanning.
 *
 * Six keys, unioned and deduped on fan_id:
 *   email            — identifier_link exact probe
 *   guardian_email   — identifier_link exact probe
 *   name_dob         — self-join on name_last_word + dob (migration_016)
 *   similar_surname  — exact first word, exact dob, surname Levenshtein <= 1
 *   exact_name       — exact normalized full name, including when dob is missing
 *   nickname_surname — listed given-name group + exact surname, any birthday
 *
 * similar_surname, exact_name, and nickname_surname are retrieval permission
 * only. They run after the exact singular lookup has already missed, and a
 * hit is scored with every other candidate. similar_surname distance 0 is
 * included and deduped with name_dob. A one-word name has no separate
 * surname, so the surname keys stay unavailable.
 *
 * A key is "available" when the inbound carries the field(s) to build it.
 * A block larger than BLOCK_SIZE_CAP is DROPPED WHOLE, not truncated: at that
 * size the key failed to discriminate, and scoring near-random members risks a
 * false conflict, which is worse than a missed duplicate. similar_surname
 * applies that cap to the distance-filtered fans, not to everyone who shares
 * the first name and birthday.
 *
 * Each probe joins fan and filters deleted_at IS NULL, so reported block sizes
 * reflect live fans only. Filtering in the downstream join instead would make
 * block_size lie.
 *
 * DEFERRED: a materialized blocking_key (fan_id, key_type, key_value, org_id)
 * table is the production answer. Self-join at query time is the narrow version.
 *
 * @returns {{ fanIds: string[], blockResults: object[], keysAvailable: string[] }}
 *   blockResults entries: { key, block_size, dropped }
 */
async function findBlockCandidates(inbound, org_id, db) {
  const words = nameWords(inbound.name);
  const keysAvailable = [];
  if (inbound.email != null)          keysAvailable.push('email');
  if (inbound.guardian_email != null) keysAvailable.push('guardian_email');
  if (inbound.name != null && inbound.dob != null) keysAvailable.push('name_dob');
  if (words.length >= 2 && inbound.dob != null) keysAvailable.push('similar_surname');
  if (words.length >= 2) keysAvailable.push('exact_name');
  if (words.length >= 2 && isListedGivenName(words[0])) keysAvailable.push('nickname_surname');

  if (keysAvailable.length === 0) {
    return { fanIds: [], blockResults: [], keysAvailable: [] };
  }

  const probeLimit  = BLOCK_SIZE_CAP + 1;
  const blockResults = [];
  const fanIdSet      = new Set();
  const fansByKey     = {};

  for (const key of keysAvailable) {
    let rows;

    if (key === 'email') {
      const result = await db.query(
        `SELECT il.fan_id
         FROM identifier_link il
         JOIN fan f ON f.id = il.fan_id
         WHERE il.org_id = $1
           AND il.identifier_type = 'email'
           AND il.identifier_value = $2
           AND f.deleted_at IS NULL
         LIMIT $3`,
        [org_id, inbound.email, probeLimit]
      );
      rows = result.rows;

    } else if (key === 'guardian_email') {
      const result = await db.query(
        `SELECT il.fan_id
         FROM identifier_link il
         JOIN fan f ON f.id = il.fan_id
         WHERE il.org_id = $1
           AND il.identifier_type = 'guardian_email'
           AND il.identifier_value = $2
           AND f.deleted_at IS NULL
         LIMIT $3`,
        [org_id, inbound.guardian_email, probeLimit]
      );
      rows = result.rows;

    } else if (key === 'name_dob') {
      const lastWord = String(inbound.name).trim().split(/\s+/).pop();
      const result = await db.query(
        `SELECT il_n.fan_id
         FROM identifier_link il_n
         JOIN identifier_link il_d
           ON il_d.fan_id = il_n.fan_id
          AND il_d.org_id = il_n.org_id
          AND il_d.identifier_type = 'dob'
          AND il_d.identifier_value = $3
         JOIN fan f ON f.id = il_n.fan_id
         WHERE il_n.org_id = $1
           AND il_n.identifier_type = 'name'
           AND il_n.name_last_word = $2
           AND f.deleted_at IS NULL
         LIMIT $4`,
        [org_id, lastWord, inbound.dob, probeLimit]
      );
      rows = result.rows;

    } else if (key === 'similar_surname') {
      // Exact first word and exact dob, then one surname edit.
      // No LIMIT here. The cap applies after the distance filter, so a common
      // first name and birthday cannot drop the one-edit surname before it is seen.
      const firstName = words[0];
      const surname = words[words.length - 1];
      const result = await db.query(
        `SELECT il_n.fan_id, il_n.name_last_word
         FROM identifier_link il_n
         JOIN identifier_link il_d
           ON il_d.fan_id = il_n.fan_id
          AND il_d.org_id = il_n.org_id
          AND il_d.identifier_type = 'dob'
          AND il_d.identifier_value = $3
         JOIN fan f ON f.id = il_n.fan_id
         WHERE il_n.org_id = $1
           AND il_n.identifier_type = 'name'
           AND split_part(il_n.identifier_value, ' ', 1) = $2
           AND f.deleted_at IS NULL`,
        [org_id, firstName, inbound.dob]
      );
      const seen = new Set();
      rows = [];
      for (const row of result.rows) {
        if (seen.has(row.fan_id)) continue;
        if (typeof row.name_last_word !== 'string' || row.name_last_word === '') continue;
        if (levenshteinDistance(surname, row.name_last_word) > 1) continue;
        seen.add(row.fan_id);
        rows.push(row);
      }

    } else if (key === 'exact_name') {
      const result = await db.query(
        `SELECT il.fan_id
         FROM identifier_link il
         JOIN fan f ON f.id = il.fan_id
         WHERE il.org_id = $1
           AND il.identifier_type = 'name'
           AND il.identifier_value = $2
           AND f.deleted_at IS NULL
         LIMIT $3`,
        [org_id, inbound.name, probeLimit]
      );
      rows = result.rows;

    } else if (key === 'nickname_surname') {
      // Listed given name plus the exact surname. Birthday is not a filter.
      // The cap applies after the nickname filter, same as similar_surname.
      const firstName = words[0];
      const surname = words[words.length - 1];
      const result = await db.query(
        `SELECT il.fan_id, il.identifier_value
         FROM identifier_link il
         JOIN fan f ON f.id = il.fan_id
         WHERE il.org_id = $1
           AND il.identifier_type = 'name'
           AND il.name_last_word = $2
           AND f.deleted_at IS NULL`,
        [org_id, surname]
      );
      const seen = new Set();
      rows = [];
      for (const row of result.rows) {
        if (seen.has(row.fan_id)) continue;
        const storedFirst = nameWords(row.identifier_value)[0];
        if (!givenNamesEquivalent(firstName, storedFirst)) continue;
        seen.add(row.fan_id);
        rows.push(row);
      }
    }

    const block_size = rows.length;
    const dropped     = block_size > BLOCK_SIZE_CAP;
    blockResults.push({ key, block_size, dropped });

    if (!dropped) {
      const ids = [];
      for (const row of rows) {
        fanIdSet.add(row.fan_id);
        ids.push(row.fan_id);
      }
      fansByKey[key] = ids;
    }
  }

  return { fanIds: Array.from(fanIdSet), blockResults, keysAvailable, fansByKey };
}

function sameNormalizedName(left, right) {
  if (left == null || right == null) return false;
  const normalize = (value) => String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  const a = normalize(left);
  const b = normalize(right);
  return a !== '' && a === b;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// When scoring would store a new person, hold a retrieved exact name with a
// missing or conflicting birthday, or a retrieved nickname with a
// conflicting birthday. Retrieval itself does not choose the person.
function reviewForRetrievedCandidate(candidates, inbound, block) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const missingBirthday = rows.find((candidate) =>
    sameNormalizedName(candidate.name, inbound.name)
    && (candidate.dob == null || inbound.dob == null)
  );
  if (missingBirthday) {
    return {
      fanId: missingBirthday.id,
      signal: 'exact_name_missing_birthday',
      withholdIdentifier: false,
    };
  }

  // Shape 3. An exact name was retrieved and the birthdays differ.
  // The disagreement stays a conflict and does not become a silent new person.
  const birthdayConflict = rows.find((candidate) =>
    sameNormalizedName(candidate.name, inbound.name)
    && inbound.dob != null
    && candidate.dob != null
    && candidate.dob !== inbound.dob
  );
  if (birthdayConflict) {
    return {
      fanId: birthdayConflict.id,
      signal: 'dob_veto',
      withholdIdentifier: false,
    };
  }

  const nicknameIds = new Set(
    (block && block.fansByKey && block.fansByKey.nickname_surname) || []
  );
  const nicknameConflict = rows.find((candidate) =>
    nicknameIds.has(candidate.id)
    && inbound.dob != null
    && candidate.dob != null
    && candidate.dob !== inbound.dob
  );
  if (nicknameConflict) {
    return {
      fanId: nicknameConflict.id,
      signal: 'nickname_birthday_conflict',
      withholdIdentifier: false,
    };
  }
  return null;
}

function applyHeldReview(trace, best, heldReview) {
  best.score = 0;
  best.signals = [{ signal: heldReview.signal }];
  best.match = { id: heldReview.fanId };
  trace.scoring_status = 'performed';
  trace.skip_reason = null;
  trace.best_score = 0;
  trace.best_signals = best.signals;
  trace.best_candidate_id = heldReview.fanId;
  if (!trace.candidate_ids.includes(heldReview.fanId)) {
    trace.candidate_ids.push(heldReview.fanId);
  }
}

// RECEIVE
async function resolverEngine(input, db) {
  const identifier_type  = input.identifier_type;
  const identifier_value = input.identifier_value;
  const org_id           = input.org_id;
  const schema_version   = input.schema_version;
  const idempotency_key  = input.idempotency_key;
  const source_system    = input.source_system;

  let fan_id           = null;
  let match_type       = null;
  let confidence_score = null;
  let is_new_record    = null;
  let audit_event_id   = null;
  let conflict_id      = null;
  let linked_systems   = [];
  let linked_count     = 0;

  // One resolution, one moment. Every scoreMatch call in the candidate loop
  // and the scoring_clock stamped on the trace all read this same value, so
  // a resolution is internally consistent and the trace records the instant
  // scoring actually happened — not the instant the trace row was inserted
  // after COMMIT. created_at is the insert time; these are deliberately
  // different columns (see migration_014).
  const scoring_clock = Date.now();

  const trace = {
    resolution_path:       null,
    scoring_status:        'skipped',
    skip_reason:           'deterministic_match',
    inbound:               null,
    candidate_ids:         [],
    candidates_considered: 0,
    candidates_gated:      0,
    candidates_scored:     0,
    best_signals:          null,
    best_candidate_id:     null,
    best_score:            null,
    block_keys_available:  [],
    block_results:         null,
    blocks_dropped:        0,
    block_size_cap:        null,
  };

  // OUTER TRY — Pattern 2: wraps GUARD and EXECUTE together
  try {

    // GUARD 1 — verify org exists and is active
    const orgResult = await db.query(
      'SELECT id, is_active FROM org WHERE id = $1',
      [org_id]
    );
    if (orgResult.rows.length === 0) {
      throw new ResolverError(`org_id not found: ${org_id}`);
    }
    if (orgResult.rows[0].is_active === false) {
      throw new ResolverError(`org is inactive: ${org_id}`);
    }

    // GUARD 2 — idempotency check
    const idempotencyResult = await db.query(
      `SELECT fan_id, match_type, confidence_score, is_new_record, id
       FROM audit_log
       WHERE idempotency_key = $1 AND org_id = $2
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [idempotency_key, org_id]
    );
    if (idempotencyResult.rows.length > 0) {
      const e = idempotencyResult.rows[0];
      return {
        fan_id:           e.fan_id,
        match_type:       e.match_type,
        confidence_score: e.confidence_score,
        is_new_record:    false,
        linked_systems:   [],
        linked_count:     0,
        audit_event_id:   e.id,
        conflict_id:      null  // not stored in audit_log — query GET /v1/conflicts if needed
      };
    }

    // EXECUTE — BEGIN TRANSACTION
    await db.query('BEGIN');

    const linkResult = await db.query(
      `SELECT il.fan_id, il.confidence_score
       FROM identifier_link il
       JOIN fan f ON f.id = il.fan_id
       WHERE il.identifier_type = $1
         AND il.identifier_value = $2
         AND il.org_id = $3
         AND f.deleted_at IS NULL`,
      [identifier_type, identifier_value, org_id]
    );

    let takeHardMatch = linkResult.rows.length > 0;
    let heldReview = null;
    if (takeHardMatch && (identifier_type === 'email' || identifier_type === 'name')) {
      const matchedFanId = linkResult.rows[0].fan_id;
      const storedIds = await db.query(
        `SELECT identifier_type, identifier_value
           FROM identifier_link
          WHERE fan_id = $1 AND org_id = $2
            AND identifier_type IN ('name', 'dob')`,
        [matchedFanId, org_id]
      );
      const storedNames = storedIds.rows
        .filter((row) => row.identifier_type === 'name')
        .map((row) => row.identifier_value);
      const storedDobs = storedIds.rows
        .filter((row) => row.identifier_type === 'dob')
        .map((row) => row.identifier_value);
      const extra = input.identifiers || {};
      const inboundDob = textOrNull(identifier_type === 'dob' ? identifier_value : extra.dob);
      const inboundName = textOrNull(identifier_type === 'name' ? identifier_value : extra.name);
      const incomingEmail = textOrNull(identifier_type === 'email' ? identifier_value : extra.email);
      const birthdayConflicts = inboundDob != null
        && storedDobs.length > 0
        && storedDobs.every((value) => value !== inboundDob);
      const birthdaysEqual = inboundDob != null
        && storedDobs.some((value) => value === inboundDob);
      const eitherBirthdayMissing = inboundDob == null || storedDobs.length === 0;

      if (birthdayConflicts) {
        takeHardMatch = false;
        heldReview = {
          fanId: matchedFanId,
          signal: 'dob_veto',
          withholdIdentifier: identifier_type === 'email',
        };
      } else if (
        identifier_type === 'email'
        && populatedFirstNamesConflict(storedNames[0], inboundName)
      ) {
        // Decision 1. The email stays on the stored person.
        takeHardMatch = false;
        heldReview = {
          fanId: matchedFanId,
          signal: 'first_name_conflict',
          withholdIdentifier: true,
        };
      } else if (identifier_type === 'name' && eitherBirthdayMissing) {
        // Decision 6. The candidate stays, and the link is a review.
        takeHardMatch = false;
        heldReview = {
          fanId: matchedFanId,
          signal: 'exact_name_missing_birthday',
          withholdIdentifier: false,
        };
      } else if (identifier_type === 'name' && birthdaysEqual && incomingEmail == null) {
        // Decision 3. An incoming email, even a different one, keeps the hard match.
        takeHardMatch = false;
        heldReview = {
          fanId: matchedFanId,
          signal: 'exact_name_missing_email',
          withholdIdentifier: false,
        };
      }
    }

    if (takeHardMatch) {
      // PATH A — hard match
      fan_id           = linkResult.rows[0].fan_id;
      match_type       = 'hard';
      confidence_score = 1.0;
      is_new_record    = false;

      trace.resolution_path = 'A';
      trace.inbound         = { [identifier_type]: identifier_value };

      await db.query(
        `UPDATE identifier_link SET last_seen_at = NOW()
         WHERE identifier_type = $1 AND identifier_value = $2 AND org_id = $3`,
        [identifier_type, identifier_value, org_id]
      );

    } else {
      // Build inbound object — singular identifier_type mapping always wins
      // (it drives the hard-match lookup above and must not be overridden).
      // Additional fields fall back to input.identifiers when provided.
      const extra = input.identifiers || {};
      const inbound = {
        org_id:         org_id,
        email:          identifier_type === 'email'          ? identifier_value : (extra.email          ?? null),
        name:           identifier_type === 'name'           ? identifier_value : (extra.name           ?? null),
        dob:            identifier_type === 'dob'            ? identifier_value : (extra.dob            ?? null),
        zip:            identifier_type === 'zip'            ? identifier_value : (extra.zip            ?? null),
        device_id:      identifier_type === 'device_id'      ? identifier_value : (extra.device_id      ?? null),
        guardian_email: identifier_type === 'guardian_email' ? identifier_value : (extra.guardian_email ?? null),
      };
      trace.inbound = inbound;

      // STEP 1 — find candidates for probabilistic scoring (module call before any db write)
      // Blocking: narrow to fans a retrieval key can reach, then score within
      // that set. Replaces the LIMIT 100 scan, which took 100 arbitrary fans
      // per org and at production scale essentially never contained the true match.
      const block = await findBlockCandidates(inbound, org_id, db);

      trace.block_keys_available = block.keysAvailable;
      trace.block_results        = block.blockResults;
      trace.blocks_dropped       = block.blockResults.filter(r => r.dropped).length;
      trace.block_size_cap       = BLOCK_SIZE_CAP;

      let candidateRows = { rows: [] };
      if (block.fanIds.length > 0) {
        candidateRows = await db.query(
          `SELECT f.id, f.org_id,
                  il_email.identifier_value    AS email,
                  il_email.last_seen_at        AS email_last_seen_at,
                  il_name.identifier_value     AS name,
                  il_name.last_seen_at         AS name_last_seen_at,
                  il_dob.identifier_value      AS dob,
                  il_dob.last_seen_at          AS dob_last_seen_at,
                  il_zip.identifier_value      AS zip,
                  il_zip.last_seen_at          AS zip_last_seen_at,
                  il_device.identifier_value   AS device_id,
                  il_device.last_seen_at       AS device_last_seen_at,
                  il_gemail.identifier_value   AS guardian_email,
                  il_gemail.last_seen_at       AS guardian_email_last_seen_at
           FROM fan f
           LEFT JOIN identifier_link il_email
             ON il_email.fan_id = f.id
             AND il_email.identifier_type = 'email'
             AND il_email.org_id = $1
           LEFT JOIN identifier_link il_name
             ON il_name.fan_id = f.id
             AND il_name.identifier_type = 'name'
             AND il_name.org_id = $1
           LEFT JOIN identifier_link il_dob
             ON il_dob.fan_id = f.id
             AND il_dob.identifier_type = 'dob'
             AND il_dob.org_id = $1
           LEFT JOIN identifier_link il_zip
             ON il_zip.fan_id = f.id
             AND il_zip.identifier_type = 'zip'
             AND il_zip.org_id = $1
           LEFT JOIN identifier_link il_device
             ON il_device.fan_id = f.id
             AND il_device.identifier_type = 'device_id'
             AND il_device.org_id = $1
           LEFT JOIN identifier_link il_gemail
             ON il_gemail.fan_id = f.id
             AND il_gemail.identifier_type = 'guardian_email'
             AND il_gemail.org_id = $1
           WHERE f.org_id = $1
             AND f.deleted_at IS NULL
             AND f.id = ANY($2::uuid[])`,
          [org_id, block.fanIds]
        );
      }

      // STEP 2 — score each candidate, track best
      let bestMatch    = null;
      let bestScore    = 0.0;
      let bestSignals  = [];
      let floorMatch   = null;
      let floorScore   = -1;
      let floorSignals = [];

      // Deduped, post-block set that reached the join — not a raw table scan.
      trace.candidates_considered = candidateRows.rows.length;
      for (const candidate of candidateRows.rows) {
        trace.candidate_ids.push(candidate.id);
        if (!passesSignalEligibilityGate(candidate, inbound)) {
          trace.candidates_gated++;
          continue;
        }
        trace.candidates_scored++;
        const result = scoreMatch(candidate, inbound, scoring_clock);
        if (result.score > bestScore) {
          bestScore   = result.score;
          bestMatch   = candidate;
          bestSignals = result.signals_matched;
        }
        // Score 0 still counts. Penalties can clamp a real name_plus_dob hit to 0,
        // and `score > bestScore` would otherwise never record it.
        if (hasNameAndDobAgreement(result.signals_matched) && result.score > floorScore) {
          floorScore   = result.score;
          floorMatch   = candidate;
          floorSignals = result.signals_matched;
        }
      }

      // A name-and-birthday agreement under 0.60 is still the pair a person
      // should see, unless some other candidate already clears 0.60.
      if (pathForMatch(bestScore, bestSignals) === 'B' && floorMatch !== null) {
        bestScore   = floorScore;
        bestMatch   = floorMatch;
        bestSignals = floorSignals;
      }

      if (trace.candidates_considered === 0) {
        trace.scoring_status = 'skipped';
        if (block.keysAvailable.length === 0) {
          trace.skip_reason = 'no_block_key';
        } else if (trace.blocks_dropped > 0) {
          trace.skip_reason = 'block_dropped_oversize';
        } else {
          trace.skip_reason = 'empty_block';
        }
      } else if (trace.candidates_scored === 0) {
        trace.scoring_status = 'skipped';
        trace.skip_reason    = 'all_candidates_gated';
      } else {
        trace.scoring_status    = 'performed';
        trace.skip_reason       = null;
        trace.best_score        = bestScore;
        trace.best_signals      = bestSignals;
        trace.best_candidate_id = bestMatch ? bestMatch.id : null;
      }

      // Lookup holds (birthday conflict, first-name conflict, Decision 3,
      // Decision 6) replace whatever the block scored. A retrieved exact
      // name with a missing birthday, or a retrieved nickname with a
      // birthday conflict, becomes a review only when scoring would
      // otherwise store a new person.
      if (!heldReview && pathForMatch(bestScore, bestSignals) === 'B') {
        heldReview = reviewForRetrievedCandidate(candidateRows.rows, inbound, block);
      }
      if (heldReview) {
        const best = { score: bestScore, signals: bestSignals, match: bestMatch };
        applyHeldReview(trace, best, heldReview);
        bestScore = best.score;
        bestSignals = best.signals;
        bestMatch = best.match;
      }

      // Soft link detection — guardian_email signal triggers staging write.
      // child_name is NOT NULL. A null incoming name would abort the transaction
      // and discard the review, so skip the side write and keep the resolution.
      const guardianEmailSignal = bestSignals.find(s => s.signal === 'guardian_email');
      if (guardianEmailSignal !== undefined && inbound.name != null) {
        await db.query('SAVEPOINT staging_household');
        try {
          await db.query(
            `INSERT INTO staging_household_data
               (id, adult_fan_id, org_id, child_name, child_dob,
                source, raw_data, confidence, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT DO NOTHING`,
            [
              crypto.randomUUID(),
              bestMatch.id,
              org_id,
              inbound.name,
              inbound.dob,
              source_system,
              JSON.stringify(inbound),
              guardianEmailSignal.adjusted_score,
            ]
          );
          await db.query('RELEASE SAVEPOINT staging_household');
        } catch (stagingErr) {
          await db.query('ROLLBACK TO SAVEPOINT staging_household');
          logger.warn('soft link staging failed', {
            event:  'soft_link_staging_failure',
            error:  stagingErr.message,
            org_id: org_id,
          });
        }
      }

      const resolutionPath = heldReview
        ? 'D'
        : pathForMatch(bestScore, bestSignals);

      if (resolutionPath === 'C') {
        // PATH C — high confidence soft match, hold for staff review (priority 1)
        trace.resolution_path = 'C';
        const new_fan_id = crypto.randomUUID();
        fan_id           = new_fan_id;
        match_type       = 'soft';
        confidence_score = bestScore;
        is_new_record    = true;

        await db.query(
          `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
           VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
          [new_fan_id, org_id]
        );
        await db.query(
          `INSERT INTO identifier_link
             (fan_id, identifier_type, identifier_value, org_id, source_system,
              schema_version, confidence_score, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
          [new_fan_id, identifier_type, identifier_value, org_id,
           source_system, schema_version, bestScore]
        );

        conflict_id = crypto.randomUUID();
        await db.query(
          `INSERT INTO conflict_queue
             (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())`,
          [conflict_id, bestMatch.id, new_fan_id, org_id,
           bestScore, JSON.stringify(bestSignals)]
        );

      } else if (resolutionPath === 'D') {
        // PATH D — review. Score is in [0.60, 0.85), or name_plus_dob fired below 0.60.
        // The queue stores bestScore, which may be under 0.60. Nothing auto-merges.
        trace.resolution_path = 'D';
        const new_fan_id = crypto.randomUUID();
        fan_id           = new_fan_id;
        match_type       = 'conflict';
        confidence_score = bestScore;
        is_new_record    = true;

        await db.query(
          `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
           VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
          [new_fan_id, org_id]
        );
        if (!(heldReview && heldReview.withholdIdentifier)) {
          await db.query(
            `INSERT INTO identifier_link
               (fan_id, identifier_type, identifier_value, org_id, source_system,
                schema_version, confidence_score, first_seen_at, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
            [new_fan_id, identifier_type, identifier_value, org_id,
             source_system, schema_version, bestScore]
          );
        }

        conflict_id = crypto.randomUUID();
        await db.query(
          `INSERT INTO conflict_queue
             (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())`,
          [conflict_id, bestMatch.id, new_fan_id, org_id,
           bestScore, JSON.stringify(bestSignals)]
        );

      } else {
        // PATH B — no name-and-birthday agreement and score below 0.60, or no candidates
        trace.resolution_path = 'B';
        const new_fan_id = crypto.randomUUID();

        await db.query(
          `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
           VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
          [new_fan_id, org_id]
        );
        await db.query(
          `INSERT INTO identifier_link
             (fan_id, identifier_type, identifier_value, org_id, source_system,
              schema_version, confidence_score, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1.0, NOW(), NOW())`,
          [new_fan_id, identifier_type, identifier_value, org_id, source_system, schema_version]
        );

        fan_id           = new_fan_id;
        match_type       = 'hard';
        confidence_score = 1.0;
        is_new_record    = true;
      }
    }

    // STEP 3 — audit event — always last write in transaction
    audit_event_id = crypto.randomUUID();
    await db.query(
      `INSERT INTO audit_log
         (id, fan_id, org_id, event_type, match_type, confidence_score,
          is_new_record, idempotency_key, identifier_type, schema_version, status, created_at)
       VALUES ($1, $2, $3, 'resolution', $4, $5, $6, $7, $8, $9, 'success', NOW())`,
      [audit_event_id, fan_id, org_id, match_type, confidence_score,
       is_new_record, idempotency_key, identifier_type, schema_version]
    );

    await db.query('COMMIT');

    // STEP 4B — Firestore sync — after COMMIT, outside transaction, new records only
    if (is_new_record === true && firestoreSyncEnabled()) {
      try {
        await firestore.collection('golden-record').doc(fan_id).set({
          fan_id:         fan_id,
          org_id:         org_id,
          loyalty_points: 0,
          stamps:         [],
          avatar:         null,
          created_at:     new Date().toISOString()
        });
      } catch (firestoreErr) {
        logger.error('Firestore sync failed for new fan', {
          fan_id:  fan_id,
          org_id:  org_id,
          error:   firestoreErr.message
        });
        // do NOT throw — Postgres record is committed and valid
      }
    }

    // STEP 4C — resolution trace — after COMMIT, outside transaction,
    // diagnostic only. A failure here MUST NOT affect the resolution,
    // which is already committed. Best-effort by design (Stage 7 decision B).
    try {
      await db.query(
        `INSERT INTO resolution_trace
           (id, org_id, audit_event_id, resolution_path, scoring_status,
            skip_reason, inbound_identifiers, candidate_ids,
            candidates_considered, candidates_gated, candidates_scored,
            signal_results, best_candidate_id, best_score,
            threshold_path_c, threshold_path_d, scorer_version,
            normalization_version, scoring_clock, resulting_fan_id,
            is_new_record, conflict_id, block_keys_available, block_results,
            blocks_dropped, block_size_cap, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 $18,$19,$20,$21,$22,$23,$24,$25,$26, NOW())`,
        [
          crypto.randomUUID(),
          org_id,
          audit_event_id,
          trace.resolution_path,
          trace.scoring_status,
          trace.skip_reason,
          JSON.stringify(trace.inbound),
          trace.candidate_ids,
          trace.candidates_considered,
          trace.candidates_gated,
          trace.candidates_scored,
          trace.best_signals ? JSON.stringify(trace.best_signals) : null,
          trace.best_candidate_id,
          trace.best_score,
          THRESHOLD_PATH_C,
          THRESHOLD_PATH_D,
          SCORER_VERSION,
          NORMALIZATION_VERSION,
          new Date(scoring_clock).toISOString(),
          fan_id,
          is_new_record,
          conflict_id,
          trace.block_keys_available,
          trace.block_results ? JSON.stringify(trace.block_results) : null,
          trace.blocks_dropped,
          trace.block_size_cap
        ]
      );
    } catch (traceErr) {
      logger.error('resolution_trace write failed', {
        fan_id:  fan_id,
        org_id:  org_id,
        error:   traceErr.message
      });
      // do NOT throw — resolution is committed and valid
    }

    // STEP 5 — linked systems query — after COMMIT, outside transaction
    const linkedResult = await db.query(
      'SELECT DISTINCT source_system FROM identifier_link WHERE fan_id = $1 AND org_id = $2',
      [fan_id, org_id]
    );
    linked_systems = linkedResult.rows.map(row => row.source_system);
    linked_count   = linked_systems.length;

  } catch (err) {

    if (err instanceof ConflictError || err.code === '40001') {
      await db.query('ROLLBACK').catch(() => {});
      throw new ConflictError('record_version conflict — concurrent write');
    }

    // 23505 — unique_violation on identifier_link (uq_identifier_per_org).
    // The losing concurrent writer's transaction (including any orphan fan row
    // it inserted in PATH B/C/D) is rolled back here. The winning request has
    // already committed that identifier, so the PATH A re-query below finds it.
    // This is a successful resolution to an existing fan — not an error.
    if (err.code === '23505') {
      await db.query('ROLLBACK').catch(() => {});
      const winnerResult = await db.query(
        `SELECT il.fan_id FROM identifier_link il
         JOIN fan f ON f.id = il.fan_id
         WHERE il.identifier_type = $1 AND il.identifier_value = $2
           AND il.org_id = $3 AND f.deleted_at IS NULL`,
        [identifier_type, identifier_value, org_id]
      );
      if (winnerResult.rows.length > 0) {
        const winner_fan_id = winnerResult.rows[0].fan_id;
        const audit_id      = crypto.randomUUID();
        await db.query(
          `INSERT INTO audit_log
             (id, fan_id, org_id, event_type, match_type, confidence_score,
              is_new_record, idempotency_key, identifier_type, schema_version, status, created_at)
           VALUES ($1, $2, $3, 'resolution', 'hard', 1.0, false, $4, $5, $6, 'success', NOW())`,
          [audit_id, winner_fan_id, org_id, idempotency_key, identifier_type, schema_version]
        );
        return {
          fan_id:           winner_fan_id,
          match_type:       'hard',
          confidence_score: 1.0,
          is_new_record:    false,
          linked_systems:   [],
          linked_count:     0,
          audit_event_id:   audit_id,
          conflict_id:      null
        };
      }
      // re-query found nothing (should not happen after 23505) — fall through to error path
    }

    await db.query('ROLLBACK').catch(() => {});

    try {
      await db.query(
        `INSERT INTO audit_log
           (id, org_id, event_type, identifier_type, idempotency_key, status, error_detail, created_at)
         VALUES ($1, $2, 'resolution', $3, $4, 'error', $5, NOW())`,
        [crypto.randomUUID(), org_id, identifier_type, idempotency_key, err.message]
      );
    } catch {
      logger.error('audit log write failed', { org_id, identifier_type, error: err.message });
    }

    throw new ResolverError(`resolver failure: ${err.message}`);

  }

  // RETURN
  return { fan_id, match_type, confidence_score, is_new_record,
           linked_systems, linked_count, audit_event_id, conflict_id };
}

module.exports = {
  resolverEngine,
  ConflictError,
  ResolverError,
  passesSignalEligibilityGate,
  findBlockCandidates,
  THRESHOLD_PATH_C,
  THRESHOLD_PATH_D,
  BLOCK_SIZE_CAP,
  pathForMatch,
  firestoreSyncEnabled,
};
