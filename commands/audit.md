---
description: Run the full Aegis audit pipeline (Slither, Aderyn, forge test) and produce a dated findings report. Pass --deep to add Mythril symbolic execution, --target <file> to scope to one contract, --fix to request proposed fixes.
argument-hint: [--deep] [--target <path/to/Contract.sol>] [--fix]
---

# /audit

Orchestrates the `audit-finder` agent pipeline and produces a consolidated findings report at `audit-reports/YYYY-MM-DD-audit.md`.

**Input**: $ARGUMENTS

---

## Phase 0 -- Parse Flags

Parse `$ARGUMENTS` before executing any tool.

| Flag | Effect |
|---|---|
| `--deep` | Adds Mythril symbolic execution after Slither and Aderyn |
| `--target <file>` | Scopes all analysis to the specified file only |
| `--fix` | After the report is produced, delegates to `audit-finder` for minimal-diff fixes on all P0 and P1 findings |
| (none) | Full project scan, no Mythril, no fix proposals |

Store parsed values:

```
DEEP=false
TARGET=""
FIX=false

for each word in $ARGUMENTS:
  if word == "--deep":   DEEP=true
  if word == "--target": TARGET=next_word
  if word == "--fix":    FIX=true
```

If `--target` is supplied, verify the file exists before proceeding:

```bash
test -f "$TARGET" || { echo "ERROR: --target file not found: $TARGET"; exit 1; }
```

---

## Phase 1 -- Environment Check

```bash
forge  --version 2>/dev/null || { echo "ERROR: forge not found. Install Foundry."; exit 1; }
which slither  2>/dev/null && slither  --version || echo "MISSING: slither  (pip install slither-analyzer)"
which aderyn   2>/dev/null && aderyn   --version || echo "MISSING: aderyn   (cargo install aderyn)"
which myth     2>/dev/null && myth version       || { [ "$DEEP" = true ] && echo "MISSING: mythril (pip install mythril) -- --deep flag requires mythril"; }
```

If `forge` is missing, stop. Analysis of uncompiled code is not meaningful.

If `--deep` is set and `myth` is missing, warn and continue without Mythril rather than aborting. Note the omission in the report header.

---

## Phase 2 -- Compile

```bash
forge build 2>&1 | tee .audit/build.log
```

If compilation fails, stop and emit:

```
AUDIT ABORTED: forge build failed. Fix compilation errors before running /audit.
See: .audit/build.log
```

Compiler warnings are collected and included in the report as `[INFO]` findings.

---

## Phase 3 -- Aderyn

```bash
mkdir -p .audit

# Full project or scoped to target
if [ -n "$TARGET" ]; then
  aderyn --output .audit/aderyn-report.json "$TARGET" 2>&1 | tee .audit/aderyn.log
else
  aderyn --output .audit/aderyn-report.json . 2>&1 | tee .audit/aderyn.log
fi
```

Parse `.audit/aderyn-report.json` for `high_issues` and `low_issues`. Record finding count by severity.

---

## Phase 4 -- Slither

```bash
if [ -n "$TARGET" ]; then
  slither "$TARGET" \
    --json .audit/slither-report.json \
    2>&1 | tee .audit/slither.log
else
  slither . \
    --json .audit/slither-report.json \
    --checklist \
    2>&1 | tee .audit/slither.log
fi
```

Parse `.audit/slither-report.json` for `results.detectors`. Record findings by impact and confidence.

---

## Phase 5 -- Mythril (conditional)

Run only if `DEEP=true` and `myth` is installed.

If `--target` is set, analyze that file only. Otherwise analyze every contract in `src/` that received a High or Critical finding in Phase 3 or 4.

```bash
# For each target contract identified above:
myth analyze "$CONTRACT_PATH" \
  --solv "$(cat .solc-version 2>/dev/null || forge config --json | jq -r .solc_version)" \
  --execution-timeout 300 \
  --output json \
  > ".audit/mythril-$(basename $CONTRACT_PATH .sol).json" 2>&1
```

A Mythril run that times out produces partial results. Note `[TIMEOUT]` in the finding source field for that contract.

---

## Phase 6 -- Forge Test and Gas Report

```bash
forge test --gas-report 2>&1 | tee .audit/gas-report.log
forge snapshot --check 2>&1 | tee .audit/snapshot-diff.log || true
```

Capture test pass/fail status. Any failing test is included in the report as a `[CRITICAL]` finding -- a failing test suite means the contract cannot be audited in a known-good state.

Gas regressions from `forge snapshot --check` are included as `[GAS]` findings.

---

## Phase 7 -- Deduplicate and Prioritize

Apply the `audit-finder` deduplication and prioritization protocol:

1. Merge findings from Aderyn, Slither, and Mythril into a unified list.
2. Deduplicate by location and SWC ID.
3. Tag findings confirmed by multiple tools as `Confidence: Corroborated`.
4. Apply the severity-exploitability matrix to assign Priority tiers P0-P3.
5. Sort: P0 first, then by severity, then alphabetically by contract.

---

## Phase 8 -- Write Report

Determine the output path:

```bash
DATE=$(date +%Y-%m-%d)
REPORT_DIR="audit-reports"
mkdir -p "$REPORT_DIR"

if [ -n "$TARGET" ]; then
  CONTRACT=$(basename "$TARGET" .sol)
  REPORT="$REPORT_DIR/${DATE}-audit-${CONTRACT}.md"
else
  REPORT="$REPORT_DIR/${DATE}-audit.md"
fi
```

Write the consolidated Markdown report to `$REPORT` using the `audit-finder` output format:

```markdown
# Audit Report

**Project:** <name from foundry.toml>
**Date:** YYYY-MM-DD
**Commit:** <git rev-parse HEAD>
**Scope:** <full project | path/to/Contract.sol>
**Tools:** Slither <v> | Aderyn <v> | Mythril <v if run> | Forge <v>
**Missing tools:** <list or "None">
**Flags:** <--deep if set | --target <file> if set>

---

## Summary

| Priority | Count |
|---|---|
| P0 | N |
| P1 | N |
| P2 | N |
| P3 | N |
| GAS | N |
| INFO | N |
| **Total** | **N** |

**Test suite:** <PASS | FAIL -- N tests failing>

---

## Findings

<one block per finding per audit-finder output format>

---

## Gas Regressions

<forge snapshot diff table or "None">

---

## Appendix: Raw Tool Output

- Slither:  .audit/slither-report.json
- Aderyn:   .audit/aderyn-report.json
- Mythril:  .audit/mythril-<Contract>.json (if run)
- Gas:      .audit/gas-report.log
- Build:    .audit/build.log
```

---

## Phase 9 -- Fix Proposals (conditional)

Run only if `FIX=true`.

Invoke the `audit-finder` agent with the completed report, requesting minimal-diff fix proposals for all P0 and P1 findings. The agent reads the report, reads the affected source files, and produces unified diffs for each finding.

Fix proposals are appended to the report under a `## Proposed Fixes` section. They are not automatically applied. The engineer reviews and applies each fix manually.

---

## Phase 10 -- Output to User

```
/audit complete.

Report:    audit-reports/YYYY-MM-DD-audit.md
Findings:  <P0_count> P0  |  <P1_count> P1  |  <P2_count> P2  |  <P3_count> P3
Gas:       <regression_count> regressions
Tests:     <PASS | FAIL>

<if any P0 or P1>
ACTION REQUIRED: This codebase has blocking findings. Do not deploy until all P0 and P1 findings are resolved.
</if>

<if FIX=true>
Fix proposals appended to report. Review each diff before applying.
</if>
```

---

## Edge Cases

| Situation | Behavior |
|---|---|
| No `.sol` files in `src/` | Stop with: "No Solidity source files found in src/." |
| `forge build` fails | Abort; do not run analysis on broken code |
| Slither unavailable | Note in report header; continue with Aderyn and forge only |
| Aderyn unavailable | Note in report header; continue with Slither and forge only |
| Both Slither and Aderyn unavailable | Warn strongly; proceed with forge only; note severely limited coverage |
| `--deep` with no Mythril | Warn; continue without Mythril; note in report |
| `--target` file not in `src/` | Warn that the file is outside the standard source directory; proceed |
| Report file already exists for today | Append `-2`, `-3`, etc. to filename to avoid overwriting |
| `forge test` fails | Include failing test names in report as CRITICAL findings; continue |
