'use strict';

const express       = require('express');
const { Firestore } = require('@google-cloud/firestore');
const pool          = require('../db/pool');
const jwtMiddleware = require('../middleware/jwtMiddleware');

const router    = express.Router();
const logger    = { error: console.error, warn: console.warn };
const firestore = new Firestore({ projectId: process.env.FIRESTORE_PROJECT_ID });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  let fan, linksResult, walletData;
  try {
    const fanResult = await pool.query(
      `SELECT id, org_id, stewardship_tier, record_version, created_at, updated_at, deleted_at
       FROM fan WHERE id = $1 AND org_id = $2`,
      [jwt_fan_id, org_id]
    );
    fan = fanResult.rows[0];
    if (!fan) {
      return res.status(404).json({ error: 'fan record not found' });
    }
    if (fan.deleted_at) {
      return res.status(403).json({ error: 'fan record has been erased' });
    }

    linksResult = await pool.query(
      `SELECT identifier_type, source_system, confidence_score, first_seen_at, last_seen_at
       FROM identifier_link WHERE fan_id = $1 AND org_id = $2`,
      [jwt_fan_id, org_id]
    );

    walletData = { loyalty_points: 0, stamps: [], avatar: null };
    try {
      const firestoreDoc = await firestore.collection('fans').doc(jwt_fan_id).get();
      if (firestoreDoc.exists) walletData = firestoreDoc.data();
    } catch (fsErr) {
      logger.warn('Firestore read failed — returning empty wallet', { fan_id: jwt_fan_id, error: fsErr.message });
    }
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
  return res.status(200).json({
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
  });
});

module.exports = router;
