---
description: Run forge snapshot, compare against the committed .gas-snapshot baseline, and produce a diff report. Pass --update to overwrite the baseline, --threshold <n> to fail if any regression exceeds n gas.
argument-hint: [--update] [--threshold <gas>]
---

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
