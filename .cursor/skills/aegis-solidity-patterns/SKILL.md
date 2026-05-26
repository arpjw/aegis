---
name: aegis-solidity-patterns
description: Modern Solidity 0.8.20+ idioms covering custom errors, immutable, transient storage, named returns, modifiers, NatSpec, file organization, and import discipline.
origin: Aegis
tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Solidity Patterns

Modern Solidity idioms that reduce gas costs, improve auditability, and enforce structural discipline. All patterns target Solidity 0.8.20 and later unless otherwise noted.

## When to Use

- Authoring a new contract or library from scratch.
- Reviewing a contract for idiomatic compliance before audit submission.
- Refactoring an existing contract to reduce gas consumption.
- Establishing file organization and import discipline in a new Foundry project.

## Scope Boundaries

This skill covers language-level idioms and project structure. It does not cover:
- Security vulnerability patterns (see `evm-security`)
- Gas profiling and measurement (see `gas-optimization`)
- ERC standard implementations (see `erc-standards`)
- Test discipline (see `foundry-workflow`)

## Core Concepts

**Custom errors.** Solidity 0.8.4+ allows defining typed errors with parameters. They encode as a 4-byte selector at the revert site, cost less gas than string reverts, and carry structured data that off-chain tooling can decode.

**`immutable`.** A storage variable assigned exactly once in the constructor. The value is inlined into bytecode at deployment; reads cost zero gas (no SLOAD).

**Transient storage (EIP-1153).** New opcodes `TSTORE` and `TLOAD` introduced in EIP-1153 (Cancun, available from Solidity 0.8.24 via `transient` keyword or inline assembly). Values persist for the duration of a transaction and are automatically cleared at transaction end. Gas cost: TSTORE = 100 gas, TLOAD = 100 gas, versus SSTORE warm = 100--2900 gas.

**Named return values.** Declaring return variable names in the function signature documents intent and enables `return` without restating the variable.

**Function modifiers as documentation.** Modifiers express preconditions that belong in the function signature, not in the body. Overuse is an anti-pattern; each modifier should correspond to one verifiable precondition.

**NatSpec.** The Ethereum Natural Specification format annotates contracts, functions, events, and errors for documentation generation and formal verification tooling.

**One contract per file.** Each Solidity file defines exactly one contract or library. The filename matches the contract name.

**Named imports.** Import only the symbols required, using named import syntax, to prevent namespace pollution and make dependencies explicit.

---

## How It Works

### Custom Errors

Define errors at the file or contract level. Include all data a caller needs to diagnose the revert without a separate lookup.

```solidity
// Bad: wastes gas, no structured data
function withdraw(uint256 amount) external {
    require(balances[msg.sender] >= amount, "Insufficient balance");
}

// Good: 4-byte selector, structured data, zero string storage
error InsufficientBalance(address account, uint256 requested, uint256 available);

function withdraw(uint256 amount) external {
    uint256 bal = balances[msg.sender];
    if (bal < amount) revert InsufficientBalance(msg.sender, amount, bal);
    balances[msg.sender] = bal - amount;
    (bool ok,) = msg.sender.call{value: amount}("");
    if (!ok) revert TransferFailed();
}
```

**Error parameter discipline.** Include the values that caused the failure, not just a label. An error named `InvalidAmount` with no parameters tells the caller nothing. An error `InvalidAmount(uint256 provided, uint256 minimum)` allows the caller to construct a corrective action.

**Error inheritance.** Errors can be defined in interfaces and inherited by implementations. Define protocol-level errors in the interface so integrators can catch them without importing the implementation.

```solidity
interface IVault {
    error InsufficientBalance(address account, uint256 requested, uint256 available);
    error Unauthorized(address caller, bytes32 requiredRole);
    error Paused();
}

contract Vault is IVault {
    function withdraw(uint256 amount) external {
        if (paused) revert Paused();
        // ...
    }
}
```

---

### `immutable` and `constant`

**`constant`** -- for values known at compile time. Inlined by the compiler. Cannot be set in a constructor.

**`immutable`** -- for values set once in the constructor. Inlined into bytecode at deployment.

```solidity
// Bad: paid SLOAD on every access
address public token;
uint256 public fee;

constructor(address _token, uint256 _fee) {
    token = _token;
    fee = _fee;
}

// Good: zero-cost reads
address public immutable token;
uint256 public constant FEE_DENOMINATOR = 10_000;
uint256 public immutable feeBps;

constructor(address _token, uint256 _feeBps) {
    token = _token;
    feeBps = _feeBps;
}
```

**When `immutable` is not applicable.** Values that must be updatable after deployment (e.g., fee parameters subject to governance) cannot be `immutable`. Do not force `immutable` on values that have a legitimate update path.

**Naming convention.** Constant names use `SCREAMING_SNAKE_CASE`. Immutable names use `camelCase` or `lowerCamelCase` matching other state variables.

---

### Transient Storage (EIP-1153)

Transient storage provides per-transaction scratch space. Values written with `TSTORE` are readable within the same transaction and cleared automatically at transaction end. The primary use case is reentrancy locks that do not need to persist across transactions.

**Reentrancy guard using transient storage** (Solidity 0.8.24+):

```solidity
// Using the `transient` keyword (Solidity 0.8.28+)
contract ReentrancyGuard {
    bool private transient _entered;

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }
}

// Using inline assembly for Solidity 0.8.24-0.8.27
contract ReentrancyGuard {
    // keccak256("reentrancy.guard.slot") - 1
    uint256 private constant _REENTRANCY_SLOT =
        0x167c7ac9876c9a4dbe8bb2e65c0e3f0fd78b5d0e3e44cc1cc1f3c1e0f3c6d234;

    modifier nonReentrant() {
        assembly {
            // SAFETY: reading transient slot; 0 = not entered
            // PRECEDENT: OpenZeppelin ReentrancyGuardTransient
            if tload(_REENTRANCY_SLOT) {
                mstore(0, 0xab143c06) // Reentrancy.selector
                revert(0, 4)
            }
            tstore(_REENTRANCY_SLOT, 1)
        }
        _;
        assembly {
            tstore(_REENTRANCY_SLOT, 0)
        }
    }
}
```

**Flash accounting pattern.** Transient storage enables flash accounting: a callback-based settlement pattern where a caller incurs an obligation at the start of a transaction, performs arbitrary operations via callbacks, and must clear the obligation before the transaction ends.

```solidity
// Simplified Uniswap v4-style flash accounting
contract Pool {
    // Tracks net token obligation for the current transaction
    int256 private transient _delta0;
    int256 private transient _delta1;

    function swap(int256 amount0, int256 amount1, bytes calldata data)
        external
        returns (int256 delta0, int256 delta1)
    {
        _delta0 += amount0;
        _delta1 += amount1;

        ISwapCallback(msg.sender).swapCallback(amount0, amount1, data);

        // Caller must have cleared the delta
        if (_delta0 != 0 || _delta1 != 0) revert UnresolvedDelta();
        return (amount0, amount1);
    }
}
```

**What transient storage is not.** Transient storage is not a substitute for persistent state. Values are cleared at transaction end. Do not use transient storage for: balances, ownership records, accumulated fees, or any value that must survive beyond a single transaction.

---

### Named Return Values

Named returns document the meaning of each output and allow implicit returns in simple functions. Use them when the return type alone does not communicate meaning.

```solidity
// Ambiguous: what is the second uint256?
function getPosition(uint256 id) external view returns (uint256, uint256, bool) {
    return (positions[id].size, positions[id].collateral, positions[id].isLong);
}

// Explicit: readable at the call site and in the ABI
function getPosition(uint256 id)
    external
    view
    returns (uint256 size, uint256 collateral, bool isLong)
{
    Position storage pos = positions[id];
    size = pos.size;
    collateral = pos.collateral;
    isLong = pos.isLong;
}
```

**Implicit return.** Named returns allow omitting the `return` statement. Use implicit return only when the function body is short enough that the reader can track the named variable assignment without scrolling.

```solidity
function computeFee(uint256 amount) internal pure returns (uint256 fee) {
    fee = (amount * FEE_BPS) / FEE_DENOMINATOR;
}
```

**Do not mix.** Do not declare named return values and then return an unnamed tuple. Pick one style and apply it consistently within a function.

---

### Function Modifiers as Documentation

A modifier is a named precondition. The name must state the condition in the affirmative.

```solidity
// Bad: name does not communicate the condition
modifier check() {
    require(msg.sender == owner, "Not owner");
    _;
}

// Good: name is the condition
modifier onlyOwner() {
    if (msg.sender != owner) revert Unauthorized(msg.sender);
    _;
}

modifier onlyWhenActive() {
    if (!active) revert Paused();
    _;
}

modifier validAmount(uint256 amount) {
    if (amount == 0) revert InvalidAmount(amount);
    _;
}
```

**Modifier composition.** Functions may have multiple modifiers. Apply them in order of most-to-least-obvious precondition; access control before state checks, state checks before value validation.

```solidity
function deposit(uint256 amount)
    external
    onlyWhitelisted
    onlyWhenActive
    validAmount(amount)
{
    // Body is free of precondition logic
}
```

**Modifier anti-patterns:**
- Modifiers with complex logic that has multiple exit points are harder to audit than inline checks. Keep modifier bodies to one or two statements.
- Modifiers that modify state (other than reentrancy guards) are unexpected and should be replaced with explicit function calls.
- Reusing a modifier for two distinct conditions in different contexts produces misleading function signatures.

---

### NatSpec Discipline

NatSpec is not optional for production contracts. It is the primary interface between the contract and auditors, documentation generators, and formal verification tools.

**Contract-level NatSpec:**

```solidity
/// @title Vault
/// @notice Accepts ERC-20 deposits, issues shares, and distributes yield.
/// @dev Shares are computed using ERC-4626 rounding semantics. Fee-on-transfer
///      tokens are not supported; the contract assumes token.transferFrom delivers
///      exactly the stated amount.
/// @custom:security-contact security@example.com
contract Vault is ERC4626 {
```

**Function-level NatSpec:**

```solidity
/// @notice Deposits `assets` and mints shares to `receiver`.
/// @dev Emits {Deposit}. Reverts if the vault is paused or if assets exceeds
///      the per-user deposit cap.
/// @param assets The quantity of the underlying token to deposit.
/// @param receiver The address that will receive the minted shares.
/// @return shares The number of shares minted.
function deposit(uint256 assets, address receiver)
    public
    override
    onlyWhenActive
    returns (uint256 shares)
```

**Error-level NatSpec:**

```solidity
/// @notice Thrown when a deposit would exceed the per-user cap.
/// @param account The depositing address.
/// @param attempted The deposit amount attempted.
/// @param cap The maximum deposit allowed for this account.
error DepositCapExceeded(address account, uint256 attempted, uint256 cap);
```

**What to include.** Every `@param` must describe units and valid range if non-obvious. Every `@return` must describe what the value represents. `@dev` is for information auditors need that users do not: rounding behavior, assumptions, invariants.

**What to omit.** Do not write `@notice` that restates the function name ("Deposits tokens into the vault"). Write what is non-obvious about the deposit (e.g., "Shares are minted using round-down semantics per ERC-4626").

---

### File Organization

**One contract per file.** Each `.sol` file contains exactly one contract or library. The filename matches the identifier.

```
src/
  Vault.sol           // contract Vault
  VaultLib.sol        // library VaultLib
  interfaces/
    IVault.sol        // interface IVault
  types/
    VaultTypes.sol    // struct and enum definitions
```

**Library extraction.** Pure computation (fee calculations, bitmap operations, fixed-point math, encoding) belongs in libraries, not in contracts. Libraries with only internal functions are inlined by the compiler and add no deployment overhead.

```solidity
// VaultMath.sol
library VaultMath {
    uint256 internal constant WAD = 1e18;

    /// @dev Rounds down. Use for share minting (protects vault from inflation attack).
    function toShares(uint256 assets, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256 shares)
    {
        if (totalShares == 0) return assets;
        shares = (assets * totalShares) / totalAssets;
    }

    /// @dev Rounds up. Use for asset redemption (protects vault from inflation attack).
    function toAssets(uint256 shares, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256 assets)
    {
        if (totalShares == 0) return shares;
        assets = (shares * totalAssets + totalShares - 1) / totalShares;
    }
}
```

**Type files.** Structs, enums, and type aliases shared across contracts are defined in a dedicated types file and imported by name.

```solidity
// types/VaultTypes.sol
struct Position {
    uint128 size;
    uint128 collateral;
    uint64  openTimestamp;
    bool    isLong;
    // 7 bytes padding (slot boundary)
}

enum PositionStatus { Open, Closed, Liquidated }
```

---

### Import Patterns

**Named imports only.** Wildcard imports (`import "./Token.sol"`) pollute the namespace and make dependency tracking imprecise. Import only the symbols used.

```solidity
// Bad: imports everything, including internal symbols
import "./IVault.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Good: explicit symbols
import { IVault } from "./interfaces/IVault.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
```

**Foundry remappings.** Configure remappings in `remappings.txt` (preferred) or `foundry.toml`. Do not use relative path imports for dependencies installed via `forge install`.

```
# remappings.txt
@openzeppelin/=lib/openzeppelin-contracts/
@solady/=lib/solady/src/
```

**Import ordering.** Group imports in this order, separated by blank lines:
1. External dependencies (OpenZeppelin, Solady, etc.)
2. Internal interfaces
3. Internal libraries
4. Internal types

```solidity
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IVault } from "./interfaces/IVault.sol";
import { IStrategy } from "./interfaces/IStrategy.sol";

import { VaultMath } from "./VaultMath.sol";

import { Position, PositionStatus } from "./types/VaultTypes.sol";
```

---

## Common Patterns

**Pattern: Error catalog in interface.** Define all protocol errors in the top-level interface. Implementations inherit and throw them. Integrators catch them without importing the implementation.

**Pattern: Modifier stack.** Order modifiers `onlyRole -> onlyWhenActive -> validInput`. Readers see access, then state, then value invariants at a glance.

**Pattern: Transient reentrancy guard.** Replace `uint256 private _status` (1 SLOAD + 1 SSTORE per call) with transient storage (1 TLOAD + 1 TSTORE). Saves approximately 2,200 gas on first call per transaction.

**Pattern: Library for math, contract for state.** Keep all arithmetic in a `pure` library. The contract owns state; the library owns computation. This makes unit-testing arithmetic trivial (no deployment needed).

**Pattern: Explicit `0` pragma.** Lock the pragma to an exact version in production contracts. Use a range only in libraries intended for external consumption.

```solidity
// Production contract: locked
pragma solidity 0.8.24;

// Library for external use: range
pragma solidity ^0.8.20;
```

---

## Quick Reference

| Idiom | Gas impact | Minimum version |
|---|---|---|
| Custom error (no params) | ~24 gas saved per revert vs string | 0.8.4 |
| Custom error (with params) | ~50-200 gas saved vs string | 0.8.4 |
| `immutable` | ~2,100 gas saved per read (cold SLOAD) | 0.6.5 |
| `constant` | ~2,100 gas saved per read | all versions |
| `TSTORE` reentrancy guard | ~2,200 gas saved vs SSTORE guard | 0.8.24 (EIP-1153) |
| Named import | No gas impact; audit clarity benefit | all versions |
| `external` vs `public` | ~24 gas saved per call (no memory copy) | all versions |
| Named return | No gas impact; readability benefit | all versions |
| `unchecked` loop counter | ~30 gas saved per iteration | 0.8.0 |
