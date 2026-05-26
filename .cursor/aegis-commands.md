# Aegis Commands -- Cursor Reference

Cursor does not support native slash commands. The following documents each Aegis command protocol and how to invoke it as a Cursor Composer task.

---

## /aegis:audit

Run the full Aegis audit pipeline (Slither, Aderyn, forge test) and produce a dated findings report. Pass --deep to add Mythril symbolic execution, --target <file> to scope to one contract, --fix to request proposed fixes.

**Arguments:** `[--deep] [--target <path/to/Contract.sol>] [--fix]`

**Invocation:** Open the Composer, attach the relevant Aegis agent via `@Aegis`, and submit the command body below as the task prompt.

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

---

## /aegis:gas-snapshot

Run forge snapshot, compare against the committed .gas-snapshot baseline, and produce a diff report. Pass --update to overwrite the baseline, --threshold <n> to fail if any regression exceeds n gas.

**Arguments:** `[--update] [--threshold <gas>]`

**Invocation:** Open the Composer, attach the relevant Aegis agent via `@Aegis`, and submit the command body below as the task prompt.

# /gas-snapshot

Measures current gas costs against the committed `.gas-snapshot` baseline, reports regressions and improvements, and optionally overwrites the baseline.

**Input**: $ARGUMENTS

---

## Phase 0 -- Parse Flags

Parse `$ARGUMENTS` before executing any tool.

| Flag | Effect |
|---|---|
| `--update` | Overwrites `.gas-snapshot` with the current measurement after reporting |
| `--threshold <n>` | Fails the command if any single function regresses by more than `n` gas |
| (none) | Compare only; no baseline update; no threshold enforcement |

```
UPDATE=false
THRESHOLD=0   # 0 = no threshold enforcement

for each word in $ARGUMENTS:
  if word == "--update":    UPDATE=true
  if word == "--threshold": THRESHOLD=next_word (integer)
```

Validate `--threshold` is a positive integer if supplied:

```bash
if [ "$THRESHOLD" != "0" ] && ! echo "$THRESHOLD" | grep -qE '^[0-9]+$'; then
  echo "ERROR: --threshold must be a positive integer. Got: $THRESHOLD"
  exit 1
fi
```

---

## Phase 1 -- Environment Check

```bash
forge --version 2>/dev/null || { echo "ERROR: forge not found. Install Foundry."; exit 1; }
```

Check for an existing baseline:

```bash
if [ ! -f .gas-snapshot ]; then
  echo "No .gas-snapshot baseline found."
  echo "Run /gas-snapshot --update to create the initial baseline."
  exit 0
fi
```

If no baseline exists and `--update` was not passed, stop and instruct the user to create the baseline first. Do not silently create a baseline without explicit intent.

---

## Phase 2 -- Compile

```bash
forge build 2>&1 | tee /tmp/gas-build.log
```

If compilation fails, stop:

```
GAS SNAPSHOT ABORTED: forge build failed. Fix compilation errors first.
See: /tmp/gas-build.log
```

---

## Phase 3 -- Run Tests and Capture Current Snapshot

```bash
# Run full test suite; gas-report surfaces per-function costs
forge test --gas-report 2>&1 | tee /tmp/gas-report.log

# Capture current snapshot into a temporary file
forge snapshot --snap /tmp/gas-snapshot-current 2>&1
```

If `forge test` has any failing tests, note them in the report but continue. Gas costs from a partially-failing test suite are still meaningful for the passing subset.

---

## Phase 4 -- Diff Against Baseline

Compare `.gas-snapshot` (baseline) against `/tmp/gas-snapshot-current` (current):

```bash
diff .gas-snapshot /tmp/gas-snapshot-current > /tmp/gas-snapshot.diff || true
```

Parse the diff to extract three categories:

**Regressions** (gas cost increased):

Lines where the current value exceeds the baseline value for the same test function signature.

```bash
# Lines removed from baseline (prefixed with -)
grep '^-' /tmp/gas-snapshot.diff | grep -v '^---' > /tmp/gas-regressions-old.txt
# Lines added in current (prefixed with +)
grep '^+' /tmp/gas-snapshot.diff | grep -v '^+++' > /tmp/gas-regressions-new.txt
```

For each changed function, compute:
```
delta = current_gas - baseline_gas
```

Positive delta = regression. Negative delta = improvement.

**New functions** (appear in current but not in baseline): functions added since the baseline was recorded.

**Removed functions** (appear in baseline but not in current): functions removed or renamed since the baseline was recorded.

---

## Phase 5 -- Threshold Check (conditional)

Run only if `THRESHOLD > 0`.

```bash
# For each regression where delta > THRESHOLD:
for each regression in parsed_regressions:
  if delta > THRESHOLD:
    THRESHOLD_VIOLATIONS.append(function_name, delta)
```

If any violation exists, the command will exit with a non-zero status after the report is written. Do not exit early; write the full report first.

---

## Phase 6 -- Write Report

Print the report to stdout and write to `/tmp/gas-snapshot-report.md`:

```markdown
# Gas Snapshot Report

**Date:**     YYYY-MM-DD HH:MM UTC
**Commit:**   <git rev-parse HEAD>
**Baseline:** .gas-snapshot (<git log -1 --format="%h %s" -- .gas-snapshot>)
**Threshold:** <n gas per function | "none">

---

## Summary

| Category       | Count | Net gas delta |
|---|---|---|
| Regressions    | N     | +X gas total  |
| Improvements   | N     | -Y gas total  |
| Unchanged      | N     | 0             |
| New functions  | N     | --            |
| Removed        | N     | --            |

**Overall delta:** <+X | -Y | 0> gas across all changed functions.

---

## Regressions

| Function | Contract | Baseline | Current | Delta |
|---|---|---|---|---|
| `deposit(uint256,address)` | `Vault` | 42,300 | 45,100 | **+2,800** |
| `withdraw(uint256,address,address)` | `Vault` | 38,200 | 38,950 | **+750** |

<if threshold violations>
### Threshold Violations (> N gas)

The following functions exceed the --threshold of N gas:

| Function | Contract | Delta |
|---|---|---|
| `deposit(uint256,address)` | `Vault` | +2,800 gas |
</if>

---

## Improvements

| Function | Contract | Baseline | Current | Delta |
|---|---|---|---|---|
| `_computeFee(uint256)` | `FeeLib` | 5,100 | 4,600 | -500 |

---

## New Functions (not in baseline)

| Function | Contract | Gas |
|---|---|---|
| `claimRewards(address)` | `Distributor` | 38,400 |

---

## Removed Functions (in baseline, not in current)

| Function | Contract | Baseline gas |
|---|---|---|
| `legacyWithdraw(uint256)` | `Vault` | 40,100 |

---

## Test Suite Status

<PASS: all tests passed | FAIL: N tests failed -- see forge test output>

---

## Raw Output

- Gas report:      /tmp/gas-report.log
- Snapshot diff:   /tmp/gas-snapshot.diff
- Current snap:    /tmp/gas-snapshot-current
```

---

## Phase 7 -- Update Baseline (conditional)

Run only if `UPDATE=true`.

```bash
cp /tmp/gas-snapshot-current .gas-snapshot
git add .gas-snapshot
```

Do not `git commit`. Leave the staging to the engineer so the snapshot update can be bundled with the associated code change in the same commit.

After copying:

```
Baseline updated: .gas-snapshot
The file has been staged. Commit it with your next change:
  git commit -m "chore: update gas snapshot"
```

If `UPDATE=true` and there are regressions, still update the baseline. The engineer has explicitly requested the update; do not silently block it. Note the regressions prominently in the report.

---

## Phase 8 -- Output to User

```
/gas-snapshot complete.

Regressions:  N functions  (+X gas total)
Improvements: N functions  (-Y gas total)
Net delta:    <+X | -Y | 0> gas

<if regressions>
Regressed functions:
  <function_name> (<contract>): +N gas
  ...

To investigate regressions, invoke: gas-optimizer
</if>

<if threshold violations>
THRESHOLD VIOLATED: N functions regressed by more than <THRESHOLD> gas.
This run exits with status 1.
</if>

<if UPDATE=true>
Baseline updated. Stage .gas-snapshot is ready to commit.
</if>

Report: /tmp/gas-snapshot-report.md
```

If threshold violations exist, exit with status 1 so CI detects the failure.

---

## Edge Cases

| Situation | Behavior |
|---|---|
| No `.gas-snapshot` file, `--update` not set | Stop; instruct user to run with `--update` first |
| No `.gas-snapshot` file, `--update` set | Run snapshot, write new baseline, no diff (nothing to compare against) |
| `forge build` fails | Abort; log error |
| `forge test` has failures | Note failing tests in report; continue with gas analysis for passing tests |
| `forge snapshot` produces empty output | Stop; likely a test configuration issue |
| All functions unchanged | Report "No gas changes detected." and exit 0 |
| Function renamed (appears as removed + added) | Report as one removed and one new; do not infer continuity |
| `--threshold 0` | Treat as "no threshold"; never fail on threshold |
| `--update` with no regressions | Update normally; note "No regressions -- baseline updated as requested" |
| CI environment without `MAINNET_RPC_URL` | Fork tests are skipped by forge; snapshot covers non-fork tests only; note in report |

---
