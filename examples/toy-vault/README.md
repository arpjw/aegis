# ToyVault -- Aegis Audit Demo

A minimal ERC-4626-style yield vault built to demonstrate the Aegis audit
pipeline. Three defects have been intentionally planted in `src/ToyVault.sol`.
They span security, correctness, and gas efficiency -- the full spectrum that
a production audit must cover.

**Do not deploy this contract.**

---

## Setup

Dependencies are excluded from version control. Install before building:

```bash
forge install foundry-rs/forge-std
forge build
forge test
```

## Running the audit

From the `examples/toy-vault/` directory:

```bash
/audit --target src/ToyVault.sol
```

Installing Slither and Aderyn first produces the richest output:

```bash
pip install slither-analyzer
cargo install aderyn
```

The pipeline continues without them, falling back to `forge test --gas-report`
and agent-driven pattern analysis.

---

## Planted defects

### Defect 1 -- ERC-4626 share inflation attack (P0 / CRITICAL)

**Location:** `convertToShares` and `convertToAssets` (~line 215)

**Class:** ERC-4626 first-depositor manipulation, SWC-101

The conversion functions implement the naive ratio without a virtual-shares
offset. Attack sequence:

1. Attacker deposits 1 wei, receiving 1 share (zero-supply path, 1:1 ratio).
2. Attacker transfers D tokens directly to the vault address, inflating
   `totalAssets` to `D + 1` without minting shares.
3. Victim deposits V tokens: `convertToShares(V) = V * 1 / (D+1)`. For `V <= D`
   this rounds to 0 and reverts. For `V > D` the victim receives far fewer shares.
4. Attacker redeems 1 share for a disproportionate fraction of the pool.

`test_DEFECT1_inflationAttack_valueExtraction` demonstrates the attacker
recovering 110 ether after investing 101 ether, while the victim loses 10 ether
from a 1000 ether deposit.

**Mitigation -- virtual shares:**

```solidity
// OpenZeppelin ERC4626 v5 default. _decimalsOffset() returns 0 by default.
return assets.mulDiv(
    totalSupply() + 10 ** _decimalsOffset(),
    totalAssets() + 1,
    rounding
);
```

**Expected detectors:** Aderyn `FirstDepositInflation`, audit-finder agent.

---

### Defect 2 -- Missing Chainlink oracle staleness check (P1 / HIGH)

**Location:** `assetPrice()` (~line 190)

**Class:** Stale price oracle, SWC-116

`latestRoundData()` returns five values; only `answer` is inspected:

```solidity
(, int256 answer, , , ) = IAggregatorV3(oracle).latestRoundData();
require(answer > 0, "ToyVault: non-positive price");
```

Missing checks:
- `block.timestamp - updatedAt <= MAX_STALENESS` -- staleness window
- `answeredInRound >= roundId` -- round completeness
- L2 sequencer uptime feed (required on Arbitrum, Optimism, Base)

`test_DEFECT2_staleOracle` confirms that `assetPrice()` returns the 25-hour-old
price without reverting.

**Mitigation:**

```solidity
uint256 constant MAX_STALENESS = 1 hours + 5 minutes;

(uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound)
    = IAggregatorV3(oracle).latestRoundData();

require(answer > 0,                                  "non-positive price");
require(block.timestamp - updatedAt <= MAX_STALENESS, "stale price");
require(answeredInRound >= roundId,                   "incomplete round");
```

**Expected detectors:** Aderyn `MissingChainlinkOracleCheck`, Slither oracle
detector, audit-finder agent cross-referencing the oracle-integration skill.

---

### Defect 3 -- Sub-optimal storage layout (GAS)

**Location:** Storage variable declarations (~line 100)

**Class:** Unnecessary cold SLOADs from misaligned slot packing

The six mutable state variables occupy six slots; optimal ordering fits them
in four:

```
Current  (6 slots):                Optimal  (4 slots):
  slot n+0  address oracle (12 B wasted)    slot n+0  address oracle
  slot n+1  uint256 feeRate                            + bool depositsPaused
  slot n+2  uint256 totalFees                          + bool withdrawsPaused
  slot n+3  bool depositsPaused (31 B wasted)  slot n+1  uint256 feeRate
  slot n+4  bool withdrawsPaused (31 B wasted) slot n+2  uint256 totalFees
  slot n+5  address feeRecipient (12 B wasted) slot n+3  address feeRecipient
```

`deposit()` and `redeem()` each read four of these fields: 4 cold SLOADs at
8,400 gas instead of the optimal 2 at 4,200 gas -- 50% overhead per call.

`test_DEFECT3_storageLayout_gasOverhead` isolates the four-field read pattern
so the gas report reflects the overhead explicitly.

**Mitigation:** Reorder declarations so address + two bools share one slot:

```solidity
address public oracle;
bool    public depositsPaused;
bool    public withdrawsPaused;
uint256 public feeRate;
uint256 public totalFees;
address public feeRecipient;
```

**Expected detectors:** gas-optimizer agent, audit-finder agent, `/gas-snapshot`
diff after applying the fix.

---

## Bonus findings (not planted)

The admin functions `setOracle`, `setDepositsPaused`, `setWithdrawalsPaused`,
and `collectFees` carry no access control. Any caller can replace the oracle,
pause the vault, or drain accrued fees. Slither and Aderyn will surface these
as additional P0 findings alongside the planted defects.

---

## Expected audit summary

| Priority | Finding | Expected source |
|---|---|---|
| P0 | Share inflation attack | Aderyn, audit-finder |
| P0 | Unprotected `setOracle` | Slither, Aderyn |
| P0 | Unprotected `setDepositsPaused` | Slither, Aderyn |
| P0 | Unprotected `setWithdrawalsPaused` | Slither, Aderyn |
| P1 | Missing oracle staleness check | Aderyn, audit-finder |
| GAS | Storage layout inefficiency | gas-optimizer, audit-finder |

A `/audit --deep` run with Mythril installed will additionally verify the
rounding properties of `convertToShares` and `convertToAssets` through
symbolic execution.

---

## Test output reference

```
forge test -vv

[PASS] test_DEFECT1_inflationAttack_valueExtraction  attacker +10 ether, victim -10 ether
[PASS] test_DEFECT1_inflationAttack_victimReverts    victim reverts at large donation
[PASS] test_DEFECT2_staleOracle                     stale price returned, no revert
[PASS] test_DEFECT3_storageLayout_gasOverhead        four cold SLOADs logged
[PASS] test_deposit_and_redeem                       happy path
[PASS] testFuzz_depositRedeem_roundTrip              256 fuzz runs, all pass
```

## Project structure

```
examples/toy-vault/
  src/
    ToyVault.sol    -- vault with three planted defects (inline DEFECT markers)
  test/
    ToyVault.t.sol  -- unit, fuzz, and defect-demonstration tests
  foundry.toml      -- Foundry configuration
  README.md         -- this file
```
