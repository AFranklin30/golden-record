# Agent Configuration — Golden Record Fan Identity Platform
# Golden Record
# Author: Aaron
# Version: 1.1 · July 2026 · Confidential
#
# FILE LOCATION IN REPO: .claude/CLAUDE.md
#
# Claude Code reads this file at session start.
# Read tasks/handoff.md second. Then load only the file you are working on.
# Never load the full codebase into context.
#
# THIS FILE = AGENT RULES ONLY.
# Project knowledge (architecture, invariants, scoring, schema, status) lives in
# the root CLAUDE.md. Do NOT append project knowledge here — a duplicated copy
# was appended to this file once and went stale, and Claude Code spent a whole
# sprint reading April rules that contradicted the code. One fact, one home.

---

## 1. Plan Mode — Default Behavior

- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- Write plan to tasks/todo.md with checkable items before touching any file
- Check in with Aaron before starting implementation
- If something goes sideways — STOP and re-plan immediately, do not keep pushing
- Use plan mode for verification steps, not just building
- Ask yourself before every step: "Would a staff engineer approve this?"

---

## 2. Subagent Strategy — Surgical Not Liberal

- Use subagents for isolated, bounded tasks only
- Use subagents for parallel work only — two independent files with zero shared dependencies
- Never spawn a subagent for a task the main agent can do in one step
- Pass only the minimum context a subagent needs — never the full conversation
- Subagent output returns as a summary, not raw output
- Sequential components (normalizer → jwt → resolver) do NOT use subagents

---

## 3. Token Efficiency — This Is Law

- Read only the files needed for the current task
- Never load the full codebase into context — load by dependency order
- Load one module at a time
- Summarize completed work before starting the next task
- tasks/todo.md is the handoff document between sessions
- tasks/handoff.md is the session boundary document — 5 lines max

**Session start sequence — always in this order:**
1. Read tasks/handoff.md (5 lines — what was done, what is next)
2. Read CLAUDE.md (project knowledge — architecture, invariants, status)
3. Read .claude/CLAUDE.md (this file — agent rules)
4. Load only the file being worked on
5. Begin

---

## 4. File Scope Rule

- One file per task unless files are tightly coupled
- Never edit more than 3 files in a single agent step
- If a change touches more than 3 files — stop and re-plan
- Minimal code impact — simplest correct solution always wins
- No temporary fixes — find root causes, senior developer standards

---

## 5. Self-Improvement Loop

- After ANY correction from Aaron: update tasks/lessons.md with the pattern
- Write rules that prevent the same mistake from happening again
- lessons.md has a 20-entry cap — oldest entries rotate out when cap is hit
- Review lessons.md at session start if it exists
- Ruthlessly iterate on lessons until mistake rate drops

---

## 6. Verification Before Done

- Never mark a task complete without proving it works
- Run tests, check logs, demonstrate correctness
- Never fix a test to match broken code — fix the code to match the test
- EXCEPTION: when a fix corrects a bug the test was documenting, the test is
  wrong and must be updated. Say so explicitly and show the old vs new expected
  value — do not silently edit an assertion.
- Ask: "Would a staff engineer approve this?"

---

## 7. Autonomous Bug Fixing

- When given a bug report: just fix it, no hand-holding required
- Read the failing test first, then the code
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from Aaron

---

## 8. Demand Elegance

- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: implement the elegant solution
- Skip for simple obvious fixes — do not over-engineer
- Challenge your own work before presenting it

---

## 9. Documentation Drift — Flag, Don't Silently Fix

- If a change makes the root CLAUDE.md factually wrong, SAY SO at check-in and
  name the exact line. Do not edit CLAUDE.md unless Aaron says to.
- If CLAUDE.md contradicts the code you just read, the CODE is the truth —
  stop and surface the contradiction before building on either.
  Precedent: CLAUDE.md claimed the Firestore collection was `fans` and that the
  wallet doc was written on PATH B only. Both were false in code (`golden-record`;
  written whenever `is_new_record === true`, i.e. PATH B/C/D).

---

## 10. Session Handoff — Required at Every Session End

Write to tasks/handoff.md before closing. 5 lines max:

```
Completed: [what was finished this session]
Next: [exact next file / next prompt in build order]
Blocked: [anything waiting on Aaron, a customer, or credentials]
Decisions: [any architectural decisions made that affect downstream files]
Warnings: [anything the next session needs to know before touching code]
```

---

## 11. Task Management

1. Write plan to tasks/todo.md with checkable items
2. Check in with Aaron before starting implementation
3. Mark items complete as you go
4. High-level summary at each step
5. Add review section to tasks/todo.md on completion
6. Update tasks/lessons.md after any correction

---

## Core Principles

- Simplicity first — minimal code, minimal impact
- No laziness — find root causes, no temporary fixes
- Senior developer standards on every file
- One job per function, one job per endpoint
- The spec is the spec — translate it, do not redesign it
- Trace real code, never infer. If a file isn't in context, ask for it.