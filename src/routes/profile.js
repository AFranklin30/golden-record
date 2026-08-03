'use strict';

const express       = require('express');
const { Firestore } = require('@google-cloud/firestore');
const jwtMiddleware = require('../middleware/jwtMiddleware');

const router    = express.Router();
const logger    = require('../lib/logger');
const firestore = new Firestore({
  projectId:  process.env.FIRESTORE_PROJECT_ID,
  databaseId: 'golden-record',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FAN_SELECT =
  `SELECT id, org_id, stewardship_tier, record_version, created_at, updated_at, deleted_at
   FROM fan WHERE id = $1 AND org_id = $2`;

// Shared by the primary fan and the merge-survivor forwarding path — same
// identifier_link + Firestore wallet lookups, same response shape.
async function buildProfilePayload(db, fan) {
  const linksResult = await db.query(
    `SELECT identifier_type, source_system, confidence_score, first_seen_at, last_seen_at
     FROM identifier_link WHERE fan_id = $1 AND org_id = $2`,
    [fan.id, fan.org_id]
  );

  let walletData = { loyalty_points: 0, stamps: [], avatar: null };
  try {
    const firestoreDoc = await firestore.collection('golden-record').doc(fan.id).get();
    if (firestoreDoc.exists) {
      const raw = firestoreDoc.data();
      if (typeof raw.loyalty_points !== 'number' || !isFinite(raw.loyalty_points) || raw.loyalty_points < 0) raw.loyalty_points = 0;
      if (!Array.isArray(raw.stamps)) raw.stamps = [];
      if (raw.avatar !== null && typeof raw.avatar !== 'string') raw.avatar = null;
      walletData = raw;
    }
  } catch (fsErr) {
    logger.warn('Firestore read failed — returning empty wallet', { fan_id: fan.id, error: fsErr.message });
  }

  return {
    fan_id:           fan.id,
    org_id:           fan.org_id,
    stewardship_tier: fan.stewardship_tier,
    record_version:   fan.record_version,
    linked_systems:   linksResult.rows.map(l => ({
      type:       l.identifier_type,
      source:     l.source_system,
      confidence: l.confidence_score,
      first_seen: l.first_seen_at,
      last_seen:  l.last_seen_at
    })),
    wallet: {
      loyalty_points: walletData.loyalty_points,
      stamps:         walletData.stamps,
      avatar:         walletData.avatar
    },
    record_created_at: fan.created_at,
    record_updated_at: fan.updated_at
  };
}

router.get('/v1/fan/:id/profile', jwtMiddleware, async (req, res) => {
  // RECEIVE
  const url_fan_id = req.params.id;
  const jwt_fan_id = req.context.fan_id;
  const org_id     = req.context.org_id;

  // GUARD — in-memory only
  if (!url_fan_id || !url_fan_id.trim()) {
    return res.status(400).json({ error: 'fan_id is required' });
  }
  if (!UUID_RE.test(url_fan_id)) {
    return res.status(400).json({ error: 'fan_id must be a valid UUID' });
  }
  if (url_fan_id !== jwt_fan_id) {
    return res.status(403).json({ error: 'forbidden', message: 'token does not match requested profile' });
  }

  // EXECUTE
  let payload;
  try {
    const fanResult = await req.db.query(FAN_SELECT, [jwt_fan_id, org_id]);
    const fan = fanResult.rows[0];
    if (!fan) {
      return res.status(404).json({ error: 'fan record not found' });
    }

    if (fan.deleted_at) {
      // Canonical-ID forwarding. Multi-hop merges are blocked (conflicts.js),
      // so at most one active merge_history row can exist per source fan —
      // this lookup is unambiguous. If chain-history ever ships, this becomes
      // a walk instead of a single lookup.
      const survivorResult = await req.db.query(
        `SELECT fan_id_target FROM merge_history
         WHERE fan_id_source = $1 AND org_id = $2 AND status = 'active'`,
        [jwt_fan_id, org_id]
      );
      if (survivorResult.rows.length === 0) {
        return res.status(403).json({ error: 'fan record has been erased' });
      }

      const survivorId       = survivorResult.rows[0].fan_id_target;
      const survivorFanResult = await req.db.query(FAN_SELECT, [survivorId, org_id]);
      const survivorFan       = survivorFanResult.rows[0];
      // The multi-hop block guarantees the survivor was active and unmerged
      // at merge time — this should always resolve. Fall back to the erased
      // response rather than a broken partial profile if it somehow doesn't.
      if (!survivorFan || survivorFan.deleted_at) {
        return res.status(403).json({ error: 'fan record has been erased' });
      }

      const survivorPayload = await buildProfilePayload(req.db, survivorFan);
      return res.status(200).json({
        ...survivorPayload,
        merged_from: jwt_fan_id,
        message:     'fan record was merged'
      });
    }

    payload = await buildProfilePayload(req.db, fan);
  } catch (err) {
    logger.error('fan profile fetch failed', {
      error:          err.message,
      fan_id:         jwt_fan_id,
      org_id,
      correlation_id: req.context.correlation_id
    });
    return res.status(500).json({ error: 'profile could not be retrieved' });
  }

  // RETURN
  return res.status(200).json(payload);
});

module.exports = router;
