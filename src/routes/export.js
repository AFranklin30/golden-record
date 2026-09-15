'use strict';

// Synchronous CSV export — first piece of the integration layer. Call it, get
// a file back. NOT a scheduled job.
//
// Deferred, not built here:
//   - Scheduling (Cloud Scheduler -> this endpoint). Needs Tanner. Adding a
//     schedule later requires no change to this endpoint.
//   - Delivery to a GCS bucket. Needs Tanner.
//   - Reasoning columns (confidence_score, signals_matched, trace data). Open
//     with Joseph — easy to add later, not easy to remove once a pipeline
//     depends on them.
//   - Incremental export / a `since` parameter. Would need a watermark;
//     export_run.started_at is the natural anchor if it happens.
//   - An operational UI reading export_run. The table exists so the data is
//     there when someone decides who operates this.

const crypto  = require('crypto');
const express = require('express');
const { stringify } = require('csv-stringify/sync');

const router = express.Router();
const logger = require('../lib/logger');

const EXPORT_TYPE = 'fan_snapshot';

const CSV_HEADER = [
  'fan_id', 'created_at', 'updated_at',
  'email', 'name', 'dob', 'zip', 'device_id', 'guardian_email',
  'email_last_seen_at', 'name_last_seen_at', 'dob_last_seen_at',
  'zip_last_seen_at', 'device_last_seen_at', 'guardian_email_last_seen_at',
  'merged_from'
];

// Same 6-way LEFT JOIN shape as resolverEngine.js's candidate projection, but:
//   - scoped to the whole org, no fan_id filter, no LIMIT (full snapshot, every call)
//   - WHERE f.deleted_at IS NULL (merged-away fans never appear as their own row)
//   - f.id/created_at/updated_at instead of f.id/org_id (resolverEngine doesn't
//     need timestamps; this export does)
// NOTE (scale): synchronous by design at current scale (53 prod fans, 27k in
// Thunder's full sample, well under Cloud Run's 300s default timeout). Would
// need streaming/pagination at ~millions of rows — not built here, not needed yet.
const FAN_PROJECTION_QUERY = `
  SELECT f.id, f.created_at, f.updated_at,
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
`;

// merged_from is a SEPARATE query, not a 7th LEFT JOIN on FAN_PROJECTION_QUERY.
// A join on merge_history multiplies the fan row itself once per matching
// merge_history row. Today that's capped at 1 (conflicts.js blocks multi-hop
// merges), but relying on that cap is backwards — a join-based approach turns
// into a real correctness bug (one export row per merge instead of one per
// fan) the moment multi-hop merge history ships. An aggregation query has no
// such failure mode regardless of how many merges land on one target.
const MERGED_FROM_QUERY = `
  SELECT fan_id_target, string_agg(fan_id_source::text, ';') AS merged_from
  FROM merge_history
  WHERE org_id = $1
    AND status = 'active'
  GROUP BY fan_id_target
`;

function toCsvValue(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

router.get('/v1/export/fans', async (req, res) => {
  // RECEIVE
  const org_id   = req.context.org_id;
  const org_name = req.context.org_name;

  // GUARD — in-memory only. This endpoint takes no query parameters: a full
  // snapshot every call, no `since`, no incremental export (see CLAUDE.md).
  // Silently ignoring an unknown parameter would let a caller believe they
  // got an incremental export when they got a full one — reject instead.
  if (Object.keys(req.query).length > 0) {
    return res.status(400).json({
      error:   'unsupported query parameter',
      message: 'this endpoint takes no query parameters — every call returns a full snapshot'
    });
  }

  // EXECUTE
  let export_run_id;
  try {
    export_run_id = crypto.randomUUID();
    await req.db.query(
      `INSERT INTO export_run (id, org_id, export_type, status, started_at, requested_by)
       VALUES ($1, $2, $3, 'running', NOW(), $4)`,
      [export_run_id, org_id, EXPORT_TYPE, org_name]
    );

    const fanResult    = await req.db.query(FAN_PROJECTION_QUERY, [org_id]);
    const mergedResult = await req.db.query(MERGED_FROM_QUERY, [org_id]);

    const mergedFromByFanId = new Map();
    for (const row of mergedResult.rows) {
      mergedFromByFanId.set(row.fan_id_target, row.merged_from);
    }

    const dataRows = fanResult.rows.map(row => [
      toCsvValue(row.id),
      toCsvValue(row.created_at),
      toCsvValue(row.updated_at),
      toCsvValue(row.email),
      toCsvValue(row.name),
      toCsvValue(row.dob),
      toCsvValue(row.zip),
      toCsvValue(row.device_id),
      toCsvValue(row.guardian_email),
      toCsvValue(row.email_last_seen_at),
      toCsvValue(row.name_last_seen_at),
      toCsvValue(row.dob_last_seen_at),
      toCsvValue(row.zip_last_seen_at),
      toCsvValue(row.device_last_seen_at),
      toCsvValue(row.guardian_email_last_seen_at),
      toCsvValue(mergedFromByFanId.get(row.id))
    ]);

    const csv = stringify([CSV_HEADER, ...dataRows]);

    await req.db.query(
      `UPDATE export_run SET status = 'success', row_count = $1, completed_at = NOW()
       WHERE id = $2`,
      [dataRows.length, export_run_id]
    );

    // RETURN
    const isoDate = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="golden-record-fans-${isoDate}.csv"`);
    return res.status(200).send(csv);

  } catch (err) {
    logger.error('fan export failed', {
      error:          err.message,
      org_id:         org_id,
      correlation_id: req.context.correlation_id
    });

    if (export_run_id) {
      await req.db.query(
        `UPDATE export_run SET status = 'failed', error_detail = $1, completed_at = NOW()
         WHERE id = $2`,
        [err.message, export_run_id]
      ).catch(updateErr => {
        logger.error('export_run failure update also failed', {
          error:          updateErr.message,
          org_id:         org_id,
          correlation_id: req.context.correlation_id
        });
      });
    }

    return res.status(500).json({
      error:          'export could not be completed',
      correlation_id: req.context.correlation_id
    });
  }
});

module.exports = router;
