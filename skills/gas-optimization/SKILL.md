---
name: gas-optimization
description: Solidity gas optimization patterns with before/after code and measured savings per pattern. Covers storage packing, bitmaps, custom errors, unchecked blocks, calldata, visibility, immutable/constant, increment style, and loop length caching.
origin: Aegis
tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
---

# Gas Optimization

Concrete optimization patterns for Solidity contracts. Each entry includes the mechanism, before/after code, and measured or estimated gas savings. Savings figures are derived from EVM opcode costs (Berlin/London/Cancun schedule) and from `forge test --gas-report` output on reference implementations.

## When to Use

- Profiling a contract after `forge snapshot` reveals unexpected gas costs.
- Reviewing a contract for optimization opportunities before deployment.
- Selecting between two equivalent implementations based on gas efficiency.
- Consulting estimated savings to decide whether an optimization is worth its readability cost.

## Scope Boundaries

This skill covers pure gas optimization. It does not cover:
- Security implications of arithmetic changes (see `evm-security`, especially `unchecked` blocks)
- Assembly optimizations (handled by the `gas-optimizer` agent under its assembly gate)
- Protocol-level economic design (see `defi-economist` agent)

---

## Core Concepts

**Opcode cost reference (post-Berlin):**

| Opcode | Cost |
|---|---|
| `SLOAD` (cold slot) | 2,100 gas |
| `SLOAD` (warm slot) | 100 gas |
| `SSTORE` (new value, was zero) | 20,000 gas |
| `SSTORE` (dirty, was non-zero) | 2,900 gas |
| `SSTORE` (set to zero from non-zero) | 2,900 gas + 4,800 gas refund |
| `MLOAD` | 3 gas |
| `MSTORE` | 3 gas |
| `CALLDATALOAD` | 3 gas |
| `CALLDATACOPY` (per 32 bytes) | 3 gas + memory expansion |
| `TSTORE` (transient) | 100 gas |
| `TLOAD` (transient) | 100 gas |

**Rule:** Every optimization in this skill trades readability or code complexity for opcode savings. Apply the optimization when the gas saving is material relative to the function's total cost and when the change does not compromise auditability.

---

## Pattern 1: Storage Slot Packing

**Mechanism.** Solidity assigns storage variables to 32-byte slots sequentially. Variables smaller than 32 bytes are packed into shared slots when declared consecutively and their combined size fits within 32 bytes. Reading a packed slot costs one SLOAD regardless of how many variables it contains. An unpacked layout may require multiple SLOADs to read variables that could have fit in one slot.

**Before:**

```solidity
contract Unpacked {
    uint256 public totalSupply;   // slot 0 (32 bytes -- full slot)
    bool    public paused;        // slot 1 (1 byte -- wastes 31 bytes)
    address public owner;         // slot 2 (20 bytes -- wastes 12 bytes)
    uint128 public rewardRate;    // slot 3 (16 bytes -- wastes 16 bytes)
    uint128 public lastUpdate;    // slot 4 (16 bytes -- wastes 16 bytes)
    // Total: 5 slots
}
```

**After:**

```solidity
contract Packed {
    uint256 public totalSupply;   // slot 0 (32 bytes -- full slot)
    address public owner;         // slot 1 (20 bytes)
    bool    public paused;        // slot 1 (1 byte, packed with owner)
    // 11 bytes remain in slot 1 -- available for future small vars
    uint128 public rewardRate;    // slot 2 (16 bytes)
    uint128 public lastUpdate;    // slot 2 (16 bytes, packed with rewardRate)
    // Total: 3 slots
}
```

**Savings:** 2 fewer slots. Each function that reads both `owner` and `paused` saves one cold SLOAD (2,100 gas) on first access per transaction, or one warm SLOAD (100 gas) on subsequent accesses. Functions reading both `rewardRate` and `lastUpdate` save similarly.

**Struct packing:**

```solidity
// Before: 3 slots per struct entry in a mapping
struct Position {
    uint256 size;        // slot 0
    address owner;       // slot 1 (20 bytes, 12 wasted)
    bool    isLong;      // slot 2 (1 byte, 31 wasted)
}

// After: 2 slots per struct entry
struct Position {
    uint256 size;        // slot 0
    address owner;       // slot 1 (20 bytes)
    bool    isLong;      // slot 1 (1 byte, packed with owner)
    // 11 bytes remaining in slot 1
}
```

**Savings per struct read:** 1 cold SLOAD (2,100 gas) per position accessed for the first time in a transaction. For a function that reads 100 positions, the savings approach 210,000 gas.

**Packing rules:**
- Declare `uint256` and `address` variables first (they fill a full slot and cannot share).
- Group smaller types (`uint128`, `uint64`, `uint32`, `uint16`, `uint8`, `bool`) together in descending size order.
- Do not pack variables that are always written independently. A packed write to one variable requires reading the slot, modifying the relevant bytes, and writing the full slot back -- an SLOAD plus SSTORE. Packing variables that are written together (atomically) maximizes benefit; packing variables that are written independently can add cost.

---

## Pattern 2: Bitmap for Boolean State

**Mechanism.** A `mapping(uint256 => bool)` stores one boolean per storage slot (31 bytes wasted per entry). A `uint256` stores 256 booleans in a single slot using bitwise operations. For N boolean values, a bitmap requires `ceil(N / 256)` slots versus N slots for a mapping.

**Before:**

```solidity
contract WithMapping {
    mapping(uint256 => bool) public claimed;

    function claim(uint256 tokenId) external {
        require(!claimed[tokenId], AlreadyClaimed());
        claimed[tokenId] = true; // SSTORE: 20,000 gas (new slot)
        _mint(msg.sender, tokenId);
    }

    function isClaimed(uint256 tokenId) external view returns (bool) {
        return claimed[tokenId]; // SLOAD: 2,100 gas (cold)
    }
}
```

**After:**

```solidity
contract WithBitmap {
    // 256 booleans per slot: slot i covers tokenIds [i*256, (i+1)*256)
    mapping(uint256 => uint256) private _claimedBitmap;

    function claim(uint256 tokenId) external {
        uint256 slotIndex = tokenId >> 8;       // tokenId / 256
        uint256 bitIndex  = tokenId & 0xff;     // tokenId % 256
        uint256 slot      = _claimedBitmap[slotIndex];

        if ((slot >> bitIndex) & 1 == 1) revert AlreadyClaimed();

        // Set the bit; SSTORE on a dirty slot: 2,900 gas (vs 20,000 for a new slot)
        _claimedBitmap[slotIndex] = slot | (1 << bitIndex);
        _mint(msg.sender, tokenId);
    }

    function isClaimed(uint256 tokenId) external view returns (bool) {
        uint256 slotIndex = tokenId >> 8;
        uint256 bitIndex  = tokenId & 0xff;
        return (_claimedBitmap[slotIndex] >> bitIndex) & 1 == 1;
    }
}
```

**Savings:**
- First `claim` per 256-token batch: SSTORE new slot (20,000 gas) vs SSTORE new slot (20,000 gas) -- same for the first bit in a slot.
- Subsequent `claim` calls within the same 256-token batch: SSTORE dirty slot (2,900 gas) vs SSTORE new slot (20,000 gas) -- **savings of 17,100 gas per call**.
- `isClaimed` for any token after the first in a batch: SLOAD warm (100 gas) vs SLOAD cold (2,100 gas per token) -- **savings of 2,000 gas per check after first access**.

**When to use:** Bitmaps are effective when the key space is a bounded integer (token IDs, epoch indices, user IDs derived from a registry). They are not applicable when keys are arbitrary `address` values.

**OpenZeppelin BitMaps:**

```solidity
import { BitMaps } from "@openzeppelin/contracts/utils/structs/BitMaps.sol";

contract WithOZBitmap {
    using BitMaps for BitMaps.BitMap;
    BitMaps.BitMap private _claimed;

    function claim(uint256 tokenId) external {
        if (_claimed.get(tokenId)) revert AlreadyClaimed();
        _claimed.set(tokenId);
        _mint(msg.sender, tokenId);
    }
}
```

---

## Pattern 3: Custom Errors over Revert Strings

**Mechanism.** `revert("error string")` encodes the string as ABI-encoded `bytes` (4-byte selector for `Error(string)` + 32-byte offset + 32-byte length + padded string data). A custom error `revert CustomError()` encodes only the 4-byte selector. A custom error with parameters adds 32 bytes per parameter, which is still more compact than an equivalent string in most cases.

**Before:**

```solidity
function withdraw(uint256 amount) external {
    require(amount > 0, "Amount must be positive");
    require(balances[msg.sender] >= amount, "Insufficient balance");
    require(!paused, "Contract is paused");
}
```

**After:**

```solidity
error InvalidAmount();
error InsufficientBalance(address account, uint256 requested, uint256 available);
error Paused();

function withdraw(uint256 amount) external {
    if (amount == 0)                        revert InvalidAmount();
    uint256 bal = balances[msg.sender];
    if (bal < amount)                       revert InsufficientBalance(msg.sender, amount, bal);
    if (paused)                             revert Paused();
}
```

**Savings:**

| Revert type | Deployment cost delta | Runtime gas saved per revert |
|---|---|---|
| No-param custom error vs. short string (< 32 chars) | -150 to -300 bytes bytecode | ~24 gas |
| No-param custom error vs. long string (> 32 chars) | -300 to -600 bytes bytecode | ~120 gas |
| Parameterized error vs. equivalent string | -100 to -200 bytes bytecode | ~50 gas |

Deployment cost savings are material for large contracts approaching the 24KB bytecode limit. Runtime savings are modest per call but compound across many revert sites and high-frequency contracts.

**Selector collision check.** When defining many custom errors, verify there are no 4-byte selector collisions with existing function or error selectors. `cast sig "ErrorName()"` computes the selector; compare against your full interface.

---

## Pattern 4: Unchecked Arithmetic for Provably Safe Operations

**Mechanism.** Solidity 0.8+ adds overflow/underflow checks to every arithmetic operation (approximately 3-5 additional opcodes per operation). When the operation is provably safe, wrapping in `unchecked` removes these checks.

**Before:**

```solidity
function sumArray(uint256[] calldata values) external pure returns (uint256 total) {
    for (uint256 i = 0; i < values.length; i++) {
        total += values[i]; // Checked addition on every iteration and on i++
    }
}
```

**After:**

```solidity
function sumArray(uint256[] calldata values) external pure returns (uint256 total) {
    uint256 len = values.length;
    for (uint256 i; i < len;) {
        // SAFETY: i is bounded by len (array length); cannot overflow uint256
        // SAFETY: total accumulation assumed bounded by caller; document if not
        unchecked {
            total += values[i];
            ++i;
        }
    }
}
```

**Savings:** Approximately 25-35 gas per arithmetic operation removed from checking. For a loop running 100 iterations with 2 operations per iteration, savings approach 5,000-7,000 gas.

**Safe operations:**
- Loop counter incrementing from 0 to `array.length`: the counter cannot exceed `type(uint256).max`.
- Subtraction after an explicit `>=` check: `if (a >= b) unchecked { a -= b; }`.
- Addition of two `uint128` values stored in a packed slot: both are at most `type(uint128).max`, so their sum is at most `type(uint256).max / 2`, which cannot overflow `uint256`.

**Unsafe operations (never use `unchecked` for):**
- User-supplied values without prior bounds validation.
- Financial arithmetic where the overflow argument depends on off-chain assumptions.
- Any operation where the one-sentence safety argument cannot be written.

---

## Pattern 5: `calldata` vs `memory` for External Function Arguments

**Mechanism.** External function parameters declared `memory` trigger a `CALLDATACOPY` to copy the argument into memory before the function body executes. Declaring them `calldata` reads directly from the calldata region without copying. The cost difference is proportional to the argument size.

**Before:**

```solidity
// Copies the entire array into memory on every call
function processIds(uint256[] memory ids) external returns (uint256 total) {
    for (uint256 i; i < ids.length; ++i) {
        total += ids[i];
    }
}
```

**After:**

```solidity
// Reads directly from calldata -- no copy
function processIds(uint256[] calldata ids) external returns (uint256 total) {
    uint256 len = ids.length;
    for (uint256 i; i < len;) {
        total += ids[i];
        unchecked { ++i; }
    }
}
```

**Savings:**

| Array size | `memory` cost (copy) | `calldata` cost | Savings |
|---|---|---|---|
| 10 elements (320 bytes) | ~600 gas | 30 gas | ~570 gas |
| 100 elements (3,200 bytes) | ~6,000 gas | 300 gas | ~5,700 gas |
| 1,000 elements (32,000 bytes) | ~60,000 gas | 3,000 gas | ~57,000 gas |

**When `memory` is required:**
- The parameter is modified inside the function body.
- The parameter is passed to an `internal` function that expects `memory`.
- The parameter is a struct returned from an expression (not directly from calldata).

**Struct in calldata:**

```solidity
struct Order {
    address maker;
    uint256 price;
    uint256 size;
}

// Before: copies 96-byte struct into memory
function fillOrder(Order memory order) external { ... }

// After: reads 96-byte struct from calldata directly
function fillOrder(Order calldata order) external { ... }
```

---

## Pattern 6: Function Visibility (`external` vs `public`)

**Mechanism.** A `public` function generates two entry points: one for external calls (reads arguments from calldata) and one for internal calls (passes arguments through memory). The `external` entry point alone is generated for `external` functions. If a function is never called internally, the `public` designation wastes bytecode and costs marginal extra gas on each external invocation.

**Before:**

```solidity
// Called only from external; no internal callers
function deposit(uint256 amount) public {
    _deposit(msg.sender, amount);
}
```

**After:**

```solidity
function deposit(uint256 amount) external {
    _deposit(msg.sender, amount);
}
```

**Savings:** 10-24 gas per call (elimination of memory-copying entry point overhead). More significant is the bytecode size reduction, which affects deployment cost and matters for contracts near the 24KB limit.

**Audit method:**

```bash
# Find public functions in src/ and cross-check for internal callers
grep -rn "function .* public" src/ --include="*.sol" | grep -v "override"
# For each result, search for internal call sites
grep -rn "functionName(" src/ --include="*.sol"
```

---

## Pattern 7: `constant` vs `immutable`

**Mechanism.** Both `constant` and `immutable` variables cost zero gas to read (inlined into bytecode). The distinction is when the value is known: `constant` at compile time, `immutable` at deployment. A state variable set in the constructor but not declared `immutable` is stored in a storage slot and costs 2,100 gas (cold SLOAD) on first read per transaction.

**Before:**

```solidity
contract Before {
    address public token;         // 2,100 gas per cold read
    uint256 public feeBps;        // 2,100 gas per cold read
    uint256 public maxSupply = 1_000_000e18; // 2,100 gas per cold read

    constructor(address _token, uint256 _feeBps) {
        token    = _token;
        feeBps   = _feeBps;
    }
}
```

**After:**

```solidity
contract After {
    address  public immutable token;    // 0 gas to read
    uint256  public immutable feeBps;   // 0 gas to read
    uint256  public constant  MAX_SUPPLY = 1_000_000e18; // 0 gas to read

    constructor(address _token, uint256 _feeBps) {
        token   = _token;
        feeBps  = _feeBps;
    }
}
```

**Savings per read:** 2,100 gas (cold SLOAD) or 100 gas (warm SLOAD). For a contract where `token` and `feeBps` are read on every user interaction, savings per transaction are 4,200 gas (two cold SLOADs on first access) plus 200 gas on subsequent accesses within the same transaction.

**Decision table:**

| Variable | `constant`? | `immutable`? | Regular state? |
|---|---|---|---|
| Value known at compile time | Yes | No | No |
| Value set once in constructor | No | Yes | No |
| Value must be updateable after deploy | No | No | Yes |
| Value computed from other constants | Yes | -- | No |

---

## Pattern 8: Prefix Increment (`++i` vs `i++`)

**Mechanism.** The postfix increment `i++` returns the pre-increment value, which historically required the compiler to retain a copy of the original value. In many Solidity 0.8.x versions the compiler eliminates this distinction; however, `++i` is the conventional form, costs the same or less, and should be used consistently in loop counters.

**Before:**

```solidity
for (uint256 i = 0; i < length; i++) { ... }
```

**After:**

```solidity
for (uint256 i; i < length; ++i) { ... }
```

**Combined with `unchecked` for loop counters:**

```solidity
uint256 len = arr.length;
for (uint256 i; i < len;) {
    // loop body
    unchecked { ++i; }
}
```

**Savings:** 0-5 gas per iteration depending on compiler version and optimization settings. The material saving comes from combining with `unchecked` (25-30 gas per iteration from removing the overflow check on `++i`).

**Additional note:** Initializing loop counters as `uint256 i` (without `= 0`) omits an unnecessary `PUSH 0` in some compiler versions since zero is the default value for uninitialized `uint256`.

---

## Pattern 9: Cache Storage Reads in Local Variables

**Mechanism.** Every `SLOAD` costs 2,100 gas (cold) or 100 gas (warm). Reading the same storage variable twice in one function pays the cost twice. Assigning the storage value to a `memory` local variable on the first read and using the local variable thereafter reduces subsequent reads to `MLOAD` (3 gas).

**Before:**

```solidity
function distribute(address[] calldata recipients) external {
    // Reads totalRewards from storage on every iteration
    for (uint256 i; i < recipients.length; ++i) {
        uint256 share = totalRewards / recipients.length; // 2 SLOADs per iteration
        pendingRewards[recipients[i]] += share;
    }
}
```

**After:**

```solidity
function distribute(address[] calldata recipients) external {
    uint256 len      = recipients.length;       // Cache calldata .length
    uint256 rewards  = totalRewards;            // 1 SLOAD (cold or warm)
    uint256 share    = rewards / len;           // MLOAD, then arithmetic

    for (uint256 i; i < len;) {
        pendingRewards[recipients[i]] += share; // One SSTORE per iteration; no SLOAD
        unchecked { ++i; }
    }
}
```

**Savings:** For a loop over 50 recipients:
- Before: 50 * 2 * 100 gas (warm SLOADs) = 10,000 gas for reading `totalRewards` and `recipients.length`.
- After: 1 cold SLOAD (2,100 gas) + 50 * 3 gas (MLOADs) = 2,250 gas.
- Net saving: ~7,750 gas.

**Storage struct caching:**

```solidity
// Before: multiple SLOADs for struct fields
function computeValue(uint256 posId) external view returns (uint256) {
    return positions[posId].size * positions[posId].price / 1e18;
    // Reads positions[posId] slot twice (or more, if struct spans multiple slots)
}

// After: one SLOAD per slot, then MLOADs
function computeValue(uint256 posId) external view returns (uint256) {
    Position memory pos = positions[posId]; // Copies entire struct into memory
    return pos.size * pos.price / 1e18;     // MLOADs only
}
```

---

## Pattern 10: Cache Array Length Outside Loops

**Mechanism.** In a `for` loop with condition `i < arr.length`, the length is re-evaluated on every iteration. For a `memory` array, this is an `MLOAD` (3 gas -- negligible). For a `storage` array, this is an `SLOAD` (100 gas warm or 2,100 gas cold) on every iteration.

**Before:**

```solidity
// Storage array: SLOAD on every iteration to read length
for (uint256 i; i < storageArray.length; ++i) { ... }

// Memory array: MLOAD on every iteration (cheaper but still avoidable)
function process(uint256[] memory arr) external {
    for (uint256 i; i < arr.length; ++i) { ... }
}
```

**After:**

```solidity
// Cache storage array length
uint256 len = storageArray.length; // 1 SLOAD (cold first access)
for (uint256 i; i < len;) {
    unchecked { ++i; }
}

// Cache memory array length (minor saving, but consistent)
function process(uint256[] calldata arr) external {
    uint256 len = arr.length;
    for (uint256 i; i < len;) {
        unchecked { ++i; }
    }
}
```

**Savings for storage arrays:** 100 gas per iteration (warm SLOAD saved). For 100 iterations: 10,000 gas saved.

---

## Savings Summary Table

| Pattern | Typical saving | Conditions for maximum saving |
|---|---|---|
| Storage slot packing | 2,100 gas per slot eliminated (cold read) | Variables read together, never written independently |
| Struct packing | 2,100 gas per slot eliminated (cold read) | Struct fields read in same function; fields grouped by size |
| Bitmap for booleans | 17,100 gas per write (2nd+ entry in same slot) | Dense integer key space; frequent writes within a 256-key bucket |
| Custom errors (no params) | 24 gas per revert; ~200 bytes bytecode | Applied to all `require` statements |
| Custom errors (with params) | 50-200 gas per revert; ~400 bytes bytecode | Replaces long string reverts |
| `unchecked` loop counter | 25-30 gas per iteration | Counters bounded by array length |
| `unchecked` safe arithmetic | 25-35 gas per operation | One-sentence safety argument available |
| `calldata` vs `memory` (10 elem) | ~570 gas per call | Array read but not modified |
| `calldata` vs `memory` (100 elem) | ~5,700 gas per call | Array read but not modified |
| `external` vs `public` | 10-24 gas per call | Function has no internal callers |
| `immutable` vs state var | 2,100 gas per cold read | Variable set once in constructor |
| `constant` vs state var | 2,100 gas per cold read | Value known at compile time |
| `++i` + `unchecked` | 25-35 gas per iteration | All loop counters |
| Cache storage array `.length` | 100 gas per iteration (warm) | Loop over storage array |
| Cache storage variable | 97 gas per re-read (warm SLOAD vs MLOAD) | Variable read 2+ times in a function |
| Cache storage struct | 97 gas per field per re-read | Struct with 3+ fields read in one function |

---

## Common Pitfalls

**Packing variables that are written independently.** Writing to any variable in a packed slot requires reading the slot first (SLOAD) to preserve the other variables, then writing (SSTORE). If `owner` and `paused` are packed but `paused` is written frequently without touching `owner`, each write incurs an extra SLOAD that would not exist if `paused` occupied its own slot.

**`calldata` on `internal` or `public` functions.** `calldata` parameters are only valid for `external` functions. The compiler rejects `calldata` on `internal` function parameters; use `memory` for internal function arguments.

**`unchecked` without a written safety argument.** An `unchecked` block without a comment explaining why each expression is safe is a latent vulnerability. The `gas-optimizer` agent requires a one-sentence safety argument for every expression inside an `unchecked` block.

**Premature `constant` on values that may need governance.** Declaring a parameter `constant` prevents governance from adjusting it. Reserve `constant` for values that are definitionally fixed (mathematical constants, denominators in well-known scaling conventions). Use `immutable` for deploy-time configuration. Use regular state variables for governance-adjustable parameters.

**Struct caching when only one field is needed.** Copying an entire struct into memory costs gas proportional to the struct size. If a function reads only one field of a five-field struct, caching the whole struct adds cost. Cache only the fields accessed, or read the storage reference directly.

```solidity
// Wasteful: copies 5-slot struct to read one field
function getSize(uint256 id) external view returns (uint256) {
    Position memory pos = positions[id];
    return pos.size;
}

// Correct: read only the needed field from storage
function getSize(uint256 id) external view returns (uint256) {
    return positions[id].size;
}
```
