# Housekeeping — clean git baseline before next work batch
# Session: 2026-08-02

No behavior changes. No production source file is edited by this task —
production modules are committed as-is, not modified.

---

## Investigation findings (read-only, already done)

**1. `.claude/CLAUDE.md` diff** — NOT project-knowledge duplication. It's the
inverse: this diff REMOVES the ~140-line project-knowledge tail that used to be
appended to this file (architecture invariants, resolution paths, JWT rules,
audit_log discipline, table levels, standard ops, status) and adds:
  - version bump (1.0 April -> 1.1 July) + a header note declaring
    "THIS FILE = AGENT RULES ONLY" (matches current file content already
    shown in context)
  - new Section 9 "Documentation Drift — Flag, Don't Silently Fix" (agent
    behavior rule), citing the Firestore collection-name mistake as precedent
  - removed one line: "Subagents acceptable for: orgAuthMiddleware +
    correlationIdMiddleware in parallel only" (stale — mount order changed)
  - minor wording tightening in session-start-sequence + verification section
    (added an EXCEPTION for correcting a test that documents a bug)
  - renumbering (9->10->11) from the new section insertion
This reads as a deliberate, coordinated split between root CLAUDE.md (project
knowledge) and .claude/CLAUDE.md (agent rules) — root CLAUDE.md's own header
says it "replaces... the project-knowledge tail that was appended to
.claude/CLAUDE.md." Per the instructions: this is a genuine agent-rule change,
not project knowledge creeping in — report and CHECK IN, do not auto-revert.

**2. Diagnostic files** — both are throwaway. Confirmed:
  - `tests/diag.janedemo.js` / `tests/diag.janedemo.poolrepro.js`: standalone
    `node tests/diag.*.js` scripts (not `*.test.js`, so jest's default
    testMatch never picks them up — they do not affect the jest baseline).
    No `expect`/`describe`/`test` — pure console.log diagnostics with a
    localhost-only DB guard and FK-ordered cleanup in `finally`. Both
    self-label "TEMPORARY DIAGNOSTIC SCRIPT — delete after root-cause is
    confirmed." No assertions to lose. Safe to delete.
  - `ARCHITECTURE_REVIEW.md`: 171 lines, a repo review doc (scope statement,
    system overview, request flow diagram). Not deleting or committing —
    Aaron's call per DO NOT list.

**3. Production module diffs** — reviewed line by line:
  - `normalizer.js`: 2-line change. Adds `NORMALIZATION_VERSION = 'v1'` export.
    Matches CLAUDE.md Stage 7 description exactly.
  - `probabilisticMatcher.js`: Sprint 5 anti-signal scoring, full diff
    matches CLAUDE.md's "Scoring (post-Sprint-5)" section — SIGNAL_CONFIG,
    DOB veto, name-double-count fix, exact-email/fuzzy-name re-aim,
    SCORER_VERSION/computeScorerFingerprint, injected clock. No surprises.
  - `resolverEngine.js`: Stage 7 resolution_trace write-half, matches
    CLAUDE.md. **BUT contains one leftover line:**
    `console.log(\`[DIAG resolverEngine] candidateRows.rows.length = ...\`)`
    at (per handoff.md) line 246. This is NOT a fresh discovery — it's
    already tracked: `tasks/handoff.md`'s own diff says "flagged in three
    straight handoffs, still not removed," and git log shows a commit
    literally titled "remove diagnostic logging" (04a6d06) that evidently
    didn't remove this specific line, or a later uncommitted edit
    reintroduced it. Per DO NOT list, this task does not touch production
    source — so this ships into the commit as-is. Flagging loudly at
    check-in as the clear next fix, separate from this task.

**4. Untracked new work** — `eval/` (harness.js, runCorpus.js, empty runs/
    dir — nothing generated to worry about), `migrations/migration_014.sql`,
    `scripts/` (resetLocalDb.sh, seedDemoOrg.js, demo-org-summary.txt),
    `tests/eval.harness.test.js`, `tests/migration_014.test.js`,
    `tests/seedDemoOrg.test.js` — all match the suggested commit grouping.

---

## Plan

- [x] Checked in with Aaron on the two open decisions:
      (a) `.claude/CLAUDE.md` — KEEP (confirmed genuine agent-rule split, not
      project-knowledge creep).
      (b) delete both `tests/diag.janedemo*.js` files — YES, deleted.
      Bonus decision surfaced at check-in: Aaron approved a one-line
      exception to remove the leftover `console.log('[DIAG resolverEngine]...')`
      from `resolverEngine.js` before committing (already flagged three
      handoffs running) — done, single-line removal, no other production
      logic touched.
- [x] Commit A (9fdf5a8) — Stage 7 write-half: `normalizer.js`,
      `probabilisticMatcher.js`, `resolverEngine.js`, `migrations/migration_014.sql`,
      `tests/migration_014.test.js`, `tests/modules/probabilisticMatcher.test.js`,
      `tests/modules/resolverEngine.test.js`, `tests/resolverEngine.smoke.js`
- [x] Commit B (d7779a6) — Evaluation harness: `eval/harness.js`, `eval/runCorpus.js`
- [x] Commit C (0026787) — Demo org seed + local DB reset: `scripts/resetLocalDb.sh`,
      `scripts/seedDemoOrg.js`, `scripts/demo-org-summary.txt`,
      `tests/seedDemoOrg.test.js`, `tests/eval.harness.test.js`
- [x] Diag files deleted before Commit A was staged (so no separate commit needed).
- [x] Ran `npx jest 2>&1 | tail -60` — baseline: **11 failed, 465 passed, 476
      total**, 2 failed suites out of 14. Matches the earlier "11 pre-existing
      failures" claim exactly — now with a committed baseline to verify against.
      Failing suites: `tests/modules/resolverEngine.test.js` (2 tests),
      `tests/routes/household.test.js` (9 tests). Full names in handoff/chat.
      Not fixed — baseline only, per DO NOT list.
- [ ] Commit D — Documentation: `CLAUDE.md`, `.claude/CLAUDE.md`,
      `tasks/lessons.md`, `tasks/todo.md`, `tasks/handoff.md`
- [ ] Verify: `git status --short` clean except `ARCHITECTURE_REVIEW.md`;
      `git log --oneline -5`; `git diff HEAD~4 --stat` shows only
      already-existing changes, no new edits (the one console.log removal
      is the sole exception, approved at check-in).
- [ ] Update `tasks/handoff.md` (5 lines) at session end.

## DO NOT (carried from prompt)
- Fix any failing test.
- Modify any production source file (commit what exists, change nothing —
  includes NOT removing the stray console.log in resolverEngine.js here).
- Delete or commit ARCHITECTURE_REVIEW.md without Aaron's decision.
- Revert .claude/CLAUDE.md without asking.
- Squash into one commit.
- Add AI attribution/co-author footers.
- Push.
- Run resetLocalDb.sh.
- Delete a diag file with real assertions (confirmed: neither has any).
