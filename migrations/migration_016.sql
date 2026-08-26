-- =============================================================================
-- Golden Record — Fan Identity Platform
-- Blocking retrieval — schema (step 1 of 4)
-- migration_016.sql
--
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Version: 1.0 · August 2026 · Confidential
--
-- Build order: depends on identifier_link (migration_001) and resolution_trace
--              (migration_014, both exist). Later prompts (candidate retrieval,
--              resolverEngine wiring, instrumentation) depend on this.
--
-- What this migration does:
--   1. identifier_link.name_last_word — generated column + partial index,
--      so name candidates can be retrieved by last-name key instead of the
--      current unfiltered LIMIT 100 scan.
--   2. resolution_trace block-metadata columns — record what the block phase
--      did, once it exists.
--
-- Nothing reads or writes either addition yet. This is schema only.
-- =============================================================================


-- =============================================================================
-- SAFETY GUARD
-- Prevents accidental re-run on a database where this migration already ran.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'identifier_link'
    AND column_name = 'name_last_word'
  ) THEN
    RAISE EXCEPTION
      'migration_016 already applied — identifier_link.name_last_word exists. Aborting.';
  END IF;
END $$;


-- =============================================================================
-- identifier_link.name_last_word
--
-- Generated off the LAST WORD of a normalized name, not the full name.
-- Exact-string blocking on a fuzzy-compared field would drop the jon/john
-- case Sprint 5 fixed. Last-word keying retrieves 'bob smith' and 'robert
-- smith' under the same key 'smith' — dob carries the selectivity, and the
-- fuzzy name comparison still runs downstream on whatever this key retrieves.
--
-- Handles middle names ('mary jane watson' -> 'watson') and single-word
-- names ('cher' -> 'cher') the same way: both are just "the last word."
--
-- [^[:space:]]+$ , not [^ ]+$ , deliberately. normalizeName collapses \s+ to
-- a single space, so on normalized input the two patterns are identical. But
-- rows written through the NFC path before identifiers-object normalization
-- landed (see the nfc.js blocking prompt 1) may carry raw tabs. The POSIX
-- class handles those too, and costs nothing extra.
--
-- WARNING: ADD COLUMN ... GENERATED ALWAYS ... STORED rewrites the table and
-- holds ACCESS EXCLUSIVE for the duration. Irrelevant on this empty/small
-- local table — relevant when this syncs to prod. Schedule it, do not run it
-- mid-traffic.
-- =============================================================================

ALTER TABLE identifier_link
  ADD COLUMN name_last_word text
  GENERATED ALWAYS AS (
    CASE WHEN identifier_type = 'name'
         THEN substring(identifier_value from '[^[:space:]]+$')
    END
  ) STORED;

CREATE INDEX idx_identifier_link_name_last_word
  ON identifier_link (org_id, name_last_word)
  WHERE identifier_type = 'name';


-- =============================================================================
-- resolution_trace block-metadata columns
--
-- No existing column fits: signal_results is the scorer's output,
-- inbound_identifiers is the tap as received — block behavior is retrieval,
-- happening before either of those, not scoring. New columns:
--
--   block_keys_available — which block keys were available for this tap
--                           (e.g. {"email","name_dob"}) — retrieval inputs,
--                           not results.
--   block_results         — per-key retrieval outcome. Intentionally NOT a
--                           CHECK-constrained shape (see the audit_log
--                           event_type lesson — three prod breaks from
--                           enumerating values in a constraint). Documented
--                           shape only, e.g.:
--                             [{"key":"email","block_size":3,"dropped":false},
--                              {"key":"guardian_email","block_size":61,"dropped":true},
--                              {"key":"name_dob","block_size":0,"dropped":false}]
--   blocks_dropped        — count of block keys dropped for exceeding the
--                           size cap (oversized blocks are skipped, not
--                           truncated — see block_size_cap).
--   block_size_cap        — the cap in effect for this resolution, so a
--                           later change to the cap doesn't retroactively
--                           reinterpret old traces.
--
-- All four are nullable/defaulted: PATH A (deterministic match) and every
-- pre-migration trace row have no block phase at all.
-- =============================================================================

ALTER TABLE resolution_trace
  ADD COLUMN block_keys_available text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN block_results        jsonb,
  ADD COLUMN blocks_dropped       integer NOT NULL DEFAULT 0,
  ADD COLUMN block_size_cap       integer;


-- =============================================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm all objects are in place.
--
-- Expected results:
--   identifier_link_col_count = 1  (name_last_word)
--   name_last_word_index_count = 1 (idx_identifier_link_name_last_word)
--   resolution_trace_new_col_count = 4
--     (block_keys_available, block_results, blocks_dropped, block_size_cap)
-- =============================================================================

SELECT column_name, data_type, is_generated
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'identifier_link'
  AND column_name = 'name_last_word';

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'idx_identifier_link_name_last_word';

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'resolution_trace'
  AND column_name IN (
    'block_keys_available', 'block_results', 'blocks_dropped', 'block_size_cap'
  )
ORDER BY column_name;
