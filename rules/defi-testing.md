# DeFi Testing

Mandatory testing standards for all Solidity contracts in this repository. These thresholds are enforced by the CI workflow (`lint.yml`). A pull request that does not meet these thresholds does not merge.

---

## Coverage Thresholds

**Minimum forge coverage for `src/`: 90% line coverage, 85% branch coverage, 100% function coverage.**

Measure with:
```bash
forge coverage --report summary
```

The thresholds apply to the `src/` directory only. Test helpers in `test/` and deployment scripts in `script/` are excluded from coverage measurement.

**Function coverage at 100% is non-negotiable.** A function with zero test coverage is an untested function. Every function deployed to mainnet must have at least one test that calls it and asserts its output. If a function is unreachable by design, document why and remove it rather than leaving dead code.

**Branch coverage at 85%** allows for rare defensive branches (e.g., unreachable `else` clauses in library math that the compiler requires but cannot be triggered in practice). Every uncovered branch must be identified by name in the pull request description. The reviewer confirms that each uncovered branch is genuinely unreachable before approving.

Enforce in CI:
```yaml
- name: Coverage gate
  run: |
    forge coverage --report summary 2>&1 | tee coverage.txt
    # Parse line/branch/function percentages and fail if below threshold
    line=$(grep "src/" coverage.txt | awk '{print $NF}' | tr -d '%')
    if [ "$(echo "$line < 90" | bc)" -eq 1 ]; then
      echo "ERROR: Line coverage $line% is below 90% threshold"
      exit 1
    fi
```

---

## Fuzz Test Configuration

**Minimum fuzz iterations: 256 per test (standard contracts), 1024 per test (high-value contracts).**

Configure in `foundry.toml`:

```toml
[profile.default]
fuzz_runs = 256

[profile.ci]
fuzz_runs = 1024

[profile.intensive]
fuzz_runs = 100000
```

A **high-value contract** is any contract that: holds or routes more than $500,000 in user funds at expected TVL, implements a liquidation mechanism, or contains custom cryptographic verification logic. High-value contracts must use the `ci` profile minimum of 1024 fuzz runs in CI.

**Every fuzz test must have at least one `assert*` call.** A fuzz test with no assertions is a compilation check, not a property test. The CI workflow must verify that no `testFuzz_*` function contains zero assertions. Enforce via:

```bash
for f in $(grep -rl "function testFuzz_" test/ --include="*.sol"); do
  # Each fuzz function must contain assert
  if ! grep -A 30 "function testFuzz_" "$f" | grep -q "assert"; then
    echo "ERROR: Fuzz test in $f has no assertion"
    exit 1
  fi
done
```

**`bound` is required on all numeric fuzz inputs.** Unbounded inputs waste fuzzer budget on precondition reverts. The CI workflow checks that every `uint` or `int` fuzz parameter appears in a `bound(param, ...)` call within the same test function body. Parameters that are structurally bounded by type (e.g., `bool`, `address`) are exempt.

---

## Invariant Test Configuration

**Minimum invariant runs: 256. Minimum depth per run: 15.**

Configure in `foundry.toml`:

```toml
[profile.default]
invariant_runs  = 256
invariant_depth = 15

[profile.ci]
invariant_runs  = 512
invariant_depth = 30
```

**Invariant tests are required for every stateful protocol contract.** A contract is stateful if it maintains token balances, position records, accumulated fees, or governance state across multiple transactions. Every such contract must have at least one invariant test contract with at least one `invariant_*` function.

**Handler contracts are required.** An invariant test that does not use a handler will spend most of its budget on calls that revert on preconditions and will explore very shallow state space. Every invariant test must:

1. Define a `VaultHandler` (or equivalent) contract in `test/invariant/handlers/`.
2. Call `targetContract(address(handler))` in `setUp`.
3. Achieve a call success rate of at least 50% (verified by `forge test --verbosity 4` output). A success rate below 50% indicates the handler is misconfigured.

**Ghost variables are required for accounting invariants.** Any invariant that asserts a relationship between on-chain state and expected state must track expected state in ghost variables on the handler. An invariant that asserts only a tautological property (e.g., `totalSupply >= 0`) is not a valid invariant.

Required invariant coverage by contract type:

| Contract type | Required invariants |
|---|---|
| ERC-4626 vault | `totalAssets == token.balanceOf(vault)`, `totalSupply > 0 iff totalAssets > 0`, `no user can redeem more than deposited (no-free-lunch)` |
| Lending protocol | `sum(collateral) >= sum(debt) * minCollateralRatio`, `badDebtAccrued <= insuranceFund` |
| AMM | `k_after >= k_before (fees increase k)`, `reserves > 0 unless fully drained` |
| Token | `sum(balanceOf) == totalSupply`, `no mint without authorized caller` |
| Access-controlled contract | `no privileged state change without role check` |

---

## Mainnet Fork Testing

**Mainnet forking is required for any contract that integrates with an external deployed protocol.**

A contract integrates with an external protocol if it: calls a Chainlink feed, calls a Uniswap pool, calls an Aave lending pool, calls any bridge, or transfers tokens to or from any address that is not a contract deployed in the same test run.

Fork test requirements:

- **Block number must be pinned.** Every `vm.createFork` call must specify an explicit block number. Unpinned forks produce non-deterministic tests.
- **Fork RPC URL must be loaded from environment.** Use `vm.envString("MAINNET_RPC_URL")`. Do not hardcode RPC URLs.
- **Fork tests must live in `test/integration/`.** Separate from unit and fuzz tests to allow selective CI execution.
- **At minimum, one fork test must verify the happy path of every external protocol integration.** If the protocol integrates Chainlink ETH/USD, a fork test must confirm that the price feed returns a non-zero, non-stale price at the pinned block.

```toml
# foundry.toml
[rpc_endpoints]
mainnet  = "${MAINNET_RPC_URL}"
arbitrum = "${ARBITRUM_RPC_URL}"
```

```solidity
// In every integration test setUp():
uint256 public constant FORK_BLOCK = 22_000_000; // Pin explicitly

function setUp() public {
    vm.createFork(vm.envString("MAINNET_RPC_URL"), FORK_BLOCK);
}
```

Fork test CI gate:
```yaml
- name: Integration tests (fork)
  env:
    MAINNET_RPC_URL: ${{ secrets.MAINNET_RPC_URL }}
  run: forge test --match-path "test/integration/*" --fork-url $MAINNET_RPC_URL
```

---

## Gas Snapshot Discipline

**Gas snapshots must be committed and CI-enforced.**

A gas snapshot records the gas cost of every test function. It is the mechanism by which gas regressions are caught before they reach production.

**Baseline snapshot protocol:**

1. After every merge to `main`, run `forge snapshot` and commit the result as `.gas-snapshot`.
2. In CI, every pull request runs `forge snapshot --check`, which fails if any test's gas cost exceeds the baseline.
3. A gas increase in any function requires one of:
   - A written justification in the pull request ("this function now does X which costs Y gas because Z").
   - An invocation of the `gas-optimizer` agent to identify whether the regression can be eliminated.

**Snapshot commands:**

```bash
# Record baseline after merge
forge snapshot --snap .gas-snapshot

# Check in CI (fails on any regression)
forge snapshot --check

# Check with tolerance (allow up to 1% increase)
forge snapshot --check --tolerance 1
```

**Snapshots must cover all functions in `src/`.** Run `forge test --gas-report` and confirm that every function in `src/` appears in the report. A function not exercised by any test is also a coverage gap (see coverage thresholds above).

**Gas snapshot is committed to version control.** The `.gas-snapshot` file is not gitignored. Every pull request that changes gas costs (up or down) will show a diff in `.gas-snapshot`. Reviewers are expected to inspect this diff as part of the review.

---

## Test Organization

Tests are organized by type in the following directories. The structure is enforced at review time.

```
test/
  unit/          # Deterministic tests with specific inputs
  fuzz/          # Property tests with randomized inputs
  invariant/     # Protocol-level invariant tests
    handlers/    # Handler contracts for invariant campaigns
  integration/   # Fork tests against live protocols
  helpers/       # Shared fixtures, mocks, base contracts
```

**Naming conventions** (enforced by CI grep):

| Test type | Function prefix | Example |
|---|---|---|
| Unit | `test_` | `test_deposit_mintsShares` |
| Unit (failure) | `test_revert_` | `test_revert_deposit_whenZero` |
| Fuzz | `testFuzz_` | `testFuzz_deposit_sharesProportional` |
| Invariant | `invariant_` | `invariant_totalAssetsEqBalance` |
| Fork | `testFork_` | `testFork_chainlinkFeed_notStale` |

**No test function may share a name across test contracts.** Duplicate test names produce misleading coverage reports. The CI workflow runs `grep -rn "function test_\|function testFuzz_\|function invariant_" test/ --include="*.sol" | sort | uniq -d` and fails if any duplicates are found.

---

## Enforcement Summary

| Rule | Blocking? | Enforced by |
|---|---|---|
| Slither: no High/Critical | Yes | CI lint workflow |
| Aderyn: no High | Yes | CI lint workflow |
| Line coverage >= 90% | Yes | CI coverage gate |
| Branch coverage >= 85% | Yes | CI coverage gate |
| Function coverage == 100% | Yes | CI coverage gate |
| Fuzz runs >= 256 (standard) | Yes | `foundry.toml` profile |
| Fuzz runs >= 1024 (high-value) | Yes | `foundry.toml` CI profile |
| Fuzz tests have assertions | Yes | CI grep check |
| Invariant runs >= 256, depth >= 15 | Yes | `foundry.toml` profile |
| Invariant tests use handlers | Yes | PR review |
| Fork tests for external integrations | Yes | PR review + CI fork gate |
| Fork block pinned | Yes | PR review |
| Gas snapshot committed | Yes | Git diff check in CI |
| `forge snapshot --check` passes | Yes | CI gas gate |
