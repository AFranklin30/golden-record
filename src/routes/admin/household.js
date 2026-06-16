'use strict';

const express = require('express');

const router = express.Router();
const logger = require('../../lib/logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// COMPONENT 36 — GET /v1/admin/household/:fan_id
// Staff-facing read-only view of a fan's full household history.
// Auth: orgAuthMiddleware only — no jwtMiddleware.
// Returns all household records, memberships (all statuses),
// soft links, and related_fans. claim_token is never returned.

router.get('/v1/admin/household/:fan_id', async (req, res) => {
  // RECEIVE
  const fan_id = req.params.fan_id;
  const org_id = req.context.org_id;

  // GUARD — in-memory only, no db calls
  if (!fan_id || !UUID_RE.test(fan_id)) {
    return res.status(400).json({ error: 'fan_id must be a valid UUID' });
  }

  // EXECUTE — Pattern 1: single TRY wraps all db work
  try {
    // READ 1 — verify fan exists and belongs to org
    const fanResult = await req.db.query(
      'SELECT id, deleted_at, created_at FROM fan WHERE id = $1 AND org_id = $2',
      [fan_id, org_id]
    );
    const fan = fanResult.rows[0];
    if (!fan) {
      return res.status(404).json({ error: 'fan not found' });
    }

    // READ 2 — households where this fan is the adult
    const householdsResult = await req.db.query(
      `SELECT id, adult_fan_id, created_at, created_by
       FROM household
       WHERE adult_fan_id = $1 AND org_id = $2`,
      [fan_id, org_id]
    );

    // READ 3 — all household_member records where fan appears as adult or minor
    // No status filter — staff sees active, severed, and aged_up.
    // claim_token is intentionally excluded — only claim_token_expires_at is safe to return.
    const membershipsResult = await req.db.query(
      `SELECT id, household_id, adult_fan_id, minor_fan_id,
              link_type, status, dob,
              aged_up_at, aged_up_initiated_by, claim_token_expires_at,
              severed_at, severed_by, created_at
       FROM household_member
       WHERE (adult_fan_id = $1 OR minor_fan_id = $1) AND org_id = $2`,
      [fan_id, org_id]
    );
    const allMembers = membershipsResult.rows;

    // READ 4 — related_fans records where fan appears on either side
    const relatedResult = await req.db.query(
      `SELECT id, fan_id_a, fan_id_b, relationship, source, created_at
       FROM related_fans
       WHERE (fan_id_a = $1 OR fan_id_b = $1) AND org_id = $2`,
      [fan_id, org_id]
    );

    // COMPUTE — soft_links derived from READ 3 results, no extra db round-trip
    const softLinks = allMembers.filter(m => m.link_type === 'soft');

    // RETURN
    return res.status(200).json({
      fan_id:       fan.id,
      deleted_at:   fan.deleted_at,
      created_at:   fan.created_at,
      households:   householdsResult.rows.map(h => ({
        household_id: h.id,
        adult_fan_id: h.adult_fan_id,
        created_at:   h.created_at,
        created_by:   h.created_by,
      })),
      memberships:  allMembers.map(m => ({
        member_id:              m.id,
        household_id:           m.household_id,
        adult_fan_id:           m.adult_fan_id,
        minor_fan_id:           m.minor_fan_id,
        link_type:              m.link_type,
        status:                 m.status,
        dob:                    m.dob,
        aged_up_at:             m.aged_up_at,
        aged_up_initiated_by:   m.aged_up_initiated_by,
        claim_token_expires_at: m.claim_token_expires_at,
        severed_at:             m.severed_at,
        severed_by:             m.severed_by,
        created_at:             m.created_at,
      })),
      soft_links:   softLinks.map(m => ({
        member_id:   m.id,
        adult_fan_id: m.adult_fan_id,
        minor_fan_id: m.minor_fan_id,
        link_type:   m.link_type,
        status:      m.status,
        created_at:  m.created_at,
      })),
      related_fans: relatedResult.rows.map(r => ({
        record_id:    r.id,
        fan_id_a:     r.fan_id_a,
        fan_id_b:     r.fan_id_b,
        relationship: r.relationship,
        source:       r.source,
        created_at:   r.created_at,
      })),
    });
  } catch (err) {
    logger.error('admin household view failed', {
      error:          err.message,
      fan_id,
      org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'admin household view could not be retrieved' });
  }
});

module.exports = router;
