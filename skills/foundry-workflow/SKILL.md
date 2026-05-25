---
name: foundry-workflow
description: TDD discipline for Solidity using Foundry. Project layout, forge test patterns, fuzz and invariant testing, cheatcodes, mainnet forking, coverage, and common pitfalls.
origin: Aegis
tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
---

# Foundry Workflow

Test-driven development discipline for Solidity projects using Foundry. Tests are not optional; they are the specification. A contract without tests is not ready for audit.

## When to Use

- Setting up a new Foundry project from scratch.
- Writing unit, fuzz, or invariant tests for a contract.
- Configuring mainnet fork tests for integration coverage.
- Running `forge coverage` and interpreting the report.
- Diagnosing a failing fuzz or invariant run.

## Scope Boundaries

This skill covers testing methodology and Foundry configuration. It does not cover:
- Security vulnerability patterns in tests (see `evm-security`)
- Gas optimization of test code (see `gas-optimization`)
- Specific ERC implementations (see `erc-standards`)

## Core Concepts

**Test-first.** Write the test before the implementation. The test encodes the specification. An implementation that passes all tests is correct by that specification. An implementation tested only after the fact is verified by a specification written to match existing behavior, not intended behavior.

**Three test layers.** Unit tests verify isolated functions with specific inputs. Fuzz tests verify properties across randomized input spaces. Invariant tests verify global protocol properties that must hold across arbitrary sequences of operations.

**Handlers.** Invariant tests operate through handler contracts that constrain the fuzzer to valid operation sequences. Without a handler, the fuzzer calls functions with arbitrary calldata that triggers precondition reverts rather than exploring meaningful state space.

**Cheatcodes.** Foundry's `Vm` interface exposes cheatcodes that manipulate EVM state: impersonating addresses, warping time, expecting reverts, expecting events, mocking return values. They are test-only; they are not callable in production.

**Mainnet forking.** `vm.createFork` downloads a snapshot of mainnet (or any EVM-compatible chain) state at a specified block and runs tests against it. This is the only reliable way to test integrations with live protocols.

---

## How It Works

### Project Layout

```
project/
├── foundry.toml          # Foundry configuration
├── remappings.txt        # Import path remappings
├── src/                  # Production contracts
│   ├── Vault.sol
│   ├── VaultLib.sol
│   └── interfaces/
│       └── IVault.sol
├── test/                 # Tests (mirrors src/ structure)
│   ├── unit/
│   │   └── Vault.t.sol
│   ├── fuzz/
│   │   └── VaultFuzz.t.sol
│   ├── invariant/
│   │   ├── VaultInvariant.t.sol
│   │   └── handlers/
│   │       └── VaultHandler.sol
│   ├── integration/
│   │   └── VaultFork.t.sol
│   └── helpers/
│       └── VaultFixtures.sol
├── script/               # Deployment and operational scripts
│   ├── Deploy.s.sol
│   └── Configure.s.sol
└── lib/                  # Dependencies (via forge install)
    ├── openzeppelin-contracts/
    └── solady/
```

**Naming conventions.** Test files end in `.t.sol`. Script files end in `.s.sol`. Test contract names match the target contract name with a `Test` suffix. Helper contracts used only in tests live under `test/helpers/`.

**`foundry.toml` baseline configuration:**

```toml
[profile.default]
src          = "src"
test         = "test"
script       = "script"
out          = "out"
libs         = ["lib"]
remappings   = ["@openzeppelin/=lib/openzeppelin-contracts/"]
optimizer    = true
optimizer_runs = 200
fuzz_runs    = 10000
invariant_runs = 500
invariant_depth = 100

[profile.ci]
fuzz_runs    = 50000
invariant_runs = 2000
```

Use the `ci` profile in continuous integration to run a deeper fuzz campaign than local development requires.

---

### Unit Tests

A unit test inherits from `forge-std/Test.sol`, deploys the contract under test in `setUp`, and asserts specific outputs for specific inputs.

```solidity
// test/unit/Vault.t.sol
pragma solidity 0.8.24;

import { Test, stdError } from "forge-std/Test.sol";
import { Vault } from "src/Vault.sol";
import { MockERC20 } from "test/helpers/MockERC20.sol";

contract VaultTest is Test {
    Vault    public vault;
    MockERC20 public token;
    address  public alice = makeAddr("alice");
    address  public bob   = makeAddr("bob");

    function setUp() public {
        token = new MockERC20("Token", "TKN", 18);
        vault = new Vault(address(token));

        token.mint(alice, 1000e18);
        token.mint(bob, 1000e18);

        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
    }

    function test_deposit_mintsShares() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(100e18, alice);

        assertEq(shares, 100e18, "first deposit: shares 1:1 with assets");
        assertEq(vault.balanceOf(alice), 100e18);
        assertEq(vault.totalAssets(), 100e18);
    }

    function test_deposit_revertsWhenZero() public {
        vm.prank(alice);
        vm.expectRevert(Vault.InvalidAmount.selector);
        vault.deposit(0, alice);
    }

    function test_withdraw_returnsAssets() public {
        vm.startPrank(alice);
        vault.deposit(100e18, alice);
        uint256 assets = vault.withdraw(50e18, alice, alice);
        vm.stopPrank();

        assertEq(assets, 50e18);
        assertEq(token.balanceOf(alice), 950e18);
    }
}
```

**Assertion discipline.** Every `assert*` call should have a message string as its last argument. Without a message, a failing assertion reports only the expected and actual values, not which assertion in the test failed. Use `assertEq(a, b, "label")` consistently.

**`setUp` scope.** `setUp` runs before every test function. It must establish a clean, deterministic initial state. Do not share mutable state between tests implicitly; if two tests need different initial states, use helper functions or separate test contracts.

**`makeAddr`.** Use `makeAddr("name")` rather than hardcoding addresses. The cheatcode derives a deterministic address from the label and assigns the label for readable output.

---

### Fuzz Tests

Fuzz tests replace specific input values with bounded random inputs. Foundry's fuzzer generates thousands of input combinations per run, exploring edge cases that manual testing misses.

```solidity
// test/fuzz/VaultFuzz.t.sol
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { Vault } from "src/Vault.sol";
import { MockERC20 } from "test/helpers/MockERC20.sol";

contract VaultFuzzTest is Test {
    Vault     public vault;
    MockERC20 public token;
    address   public user = makeAddr("user");

    function setUp() public {
        token = new MockERC20("Token", "TKN", 18);
        vault = new Vault(address(token));
        token.mint(user, type(uint128).max);
        vm.prank(user);
        token.approve(address(vault), type(uint256).max);
    }

    /// @dev Fuzz over deposit amounts. The bound cheatcode constrains inputs
    ///      to a valid range, preventing the fuzzer from wasting cycles on
    ///      inputs that trivially revert (zero amount, amount exceeding balance).
    function testFuzz_deposit_sharesNonZero(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);

        vm.prank(user);
        uint256 shares = vault.deposit(amount, user);

        assertGt(shares, 0, "shares must be non-zero for any valid deposit");
    }

    /// @dev Round-trip property: depositing then withdrawing the same shares
    ///      must return at least the original asset amount (no loss of principal
    ///      in a vault with no fees).
    function testFuzz_depositWithdraw_noLoss(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);

        vm.startPrank(user);
        uint256 shares  = vault.deposit(amount, user);
        uint256 returned = vault.redeem(shares, user, user);
        vm.stopPrank();

        assertGe(returned, amount, "redeem must return at least deposited assets");
    }
}
```

**`bound`.** Always bound fuzz inputs. Unbounded inputs will hit precondition reverts (zero amount, amount exceeding balance) and the fuzzer will report them as passing -- because the revert masked the test. Bound to the realistic operational range.

**Missing assertion anti-pattern.** A fuzz test with no `assert*` call passes trivially on all inputs. It is not a test; it is a gas estimate.

```solidity
// Wrong: no assertion -- always passes, tests nothing
function testFuzz_deposit(uint256 amount) public {
    amount = bound(amount, 1, 1000e18);
    vm.prank(user);
    vault.deposit(amount, user); // no assert -- useless
}

// Correct: asserts a property
function testFuzz_deposit(uint256 amount) public {
    amount = bound(amount, 1, 1000e18);
    vm.prank(user);
    uint256 shares = vault.deposit(amount, user);
    assertGt(shares, 0, "deposit must mint shares");
    assertEq(vault.totalAssets(), amount, "totalAssets must reflect deposit");
}
```

**Multiple fuzz parameters.** Foundry supports multiple fuzz inputs. Use them to test interactions between parameters.

```solidity
function testFuzz_twoDepositors_sharesProportional(
    uint256 aliceAmount,
    uint256 bobAmount
) public {
    aliceAmount = bound(aliceAmount, 1e6, type(uint96).max);
    bobAmount   = bound(bobAmount, 1e6, type(uint96).max);
    // ...
}
```

---

### Invariant Tests

Invariant tests define properties that must hold across every sequence of protocol operations. Foundry generates random sequences of function calls against the system and verifies the invariant after each call.

**Handler pattern.** Without a handler, the fuzzer calls arbitrary functions with arbitrary calldata, most of which revert on preconditions. A handler contract wraps each protocol action with valid setup (minting tokens, approving, etc.) so the fuzzer explores meaningful state space.

```solidity
// test/invariant/handlers/VaultHandler.sol
pragma solidity 0.8.24;

import { CommonBase }  from "forge-std/Base.sol";
import { StdCheats }   from "forge-std/StdCheats.sol";
import { StdUtils }    from "forge-std/StdUtils.sol";
import { Vault }       from "src/Vault.sol";
import { MockERC20 }   from "test/helpers/MockERC20.sol";

contract VaultHandler is CommonBase, StdCheats, StdUtils {
    Vault     public vault;
    MockERC20 public token;

    address[] public actors;
    address   internal _currentActor;

    // Ghost variable: tracks expected total assets for comparison
    uint256 public ghost_totalDeposited;
    uint256 public ghost_totalWithdrawn;

    constructor(Vault _vault, MockERC20 _token) {
        vault = _vault;
        token = _token;
        for (uint256 i; i < 5; ++i) {
            actors.push(makeAddr(string(abi.encode("actor", i))));
        }
    }

    modifier useActor(uint256 actorSeed) {
        _currentActor = actors[bound(actorSeed, 0, actors.length - 1)];
        vm.startPrank(_currentActor);
        _;
        vm.stopPrank();
    }

    function deposit(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        amount = bound(amount, 1, 100_000e18);
        token.mint(_currentActor, amount);
        token.approve(address(vault), amount);
        vault.deposit(amount, _currentActor);
        ghost_totalDeposited += amount;
    }

    function withdraw(uint256 actorSeed, uint256 shareFraction) external useActor(actorSeed) {
        uint256 shares = vault.balanceOf(_currentActor);
        if (shares == 0) return;
        shares = bound(shareFraction, 1, shares);
        uint256 assets = vault.redeem(shares, _currentActor, _currentActor);
        ghost_totalWithdrawn += assets;
    }
}
```

```solidity
// test/invariant/VaultInvariant.t.sol
pragma solidity 0.8.24;

import { Test }         from "forge-std/Test.sol";
import { Vault }        from "src/Vault.sol";
import { MockERC20 }    from "test/helpers/MockERC20.sol";
import { VaultHandler } from "./handlers/VaultHandler.sol";

contract VaultInvariantTest is Test {
    Vault        public vault;
    MockERC20    public token;
    VaultHandler public handler;

    function setUp() public {
        token   = new MockERC20("Token", "TKN", 18);
        vault   = new Vault(address(token));
        handler = new VaultHandler(vault, token);

        // Restrict the fuzzer to calling only handler functions
        targetContract(address(handler));
    }

    /// @dev The vault's totalAssets must always equal the token balance held
    ///      by the vault contract. Any divergence implies a token accounting bug.
    function invariant_totalAssetsEqTokenBalance() public view {
        assertEq(
            vault.totalAssets(),
            token.balanceOf(address(vault)),
            "totalAssets must equal token balance"
        );
    }

    /// @dev Total shares outstanding must be zero if and only if totalAssets is zero.
    function invariant_sharesZeroIffAssetsZero() public view {
        if (vault.totalSupply() == 0) {
            assertEq(vault.totalAssets(), 0, "zero shares implies zero assets");
        }
        if (vault.totalAssets() == 0) {
            assertEq(vault.totalSupply(), 0, "zero assets implies zero shares");
        }
    }

    /// @dev Total withdrawn must never exceed total deposited (no funds created from nothing).
    function invariant_noValueCreation() public view {
        assertLe(
            handler.ghost_totalWithdrawn(),
            handler.ghost_totalDeposited(),
            "withdrawn cannot exceed deposited"
        );
    }
}
```

**Ghost variables.** Handler contracts maintain ghost variables that track expected state separately from on-chain state. Invariants compare the on-chain state against ghost variables to detect divergence. Ghost variables are the mechanism by which invariant tests catch accounting bugs.

**Weak invariant anti-pattern.** An invariant that always holds regardless of protocol state is not an invariant; it is a tautology.

```solidity
// Weak: always true by construction, catches nothing
function invariant_totalSupplyGteZero() public view {
    assertGe(vault.totalSupply(), 0);
}

// Strong: asserts a relationship that a bug could violate
function invariant_totalAssetsEqTokenBalance() public view {
    assertEq(vault.totalAssets(), token.balanceOf(address(vault)));
}
```

**`targetContract` and `targetSelector`.** By default Foundry calls every deployed contract. Use `targetContract` to restrict the fuzzer to handler contracts. Use `targetSelector` to further restrict to specific functions if the handler has internal helpers that should not be called directly.

---

### Cheatcodes

Cheatcodes are called via the `vm` object inherited from `forge-std/Test.sol`.

**Identity and authorization:**

```solidity
// Execute the next call as alice
vm.prank(alice);
vault.deposit(100e18, alice);

// Execute a block of calls as alice
vm.startPrank(alice);
vault.deposit(100e18, alice);
vault.transfer(bob, 50e18);
vm.stopPrank();

// Give alice an ETH balance
vm.deal(alice, 10 ether);

// Set a storage variable directly (bypass access control in tests)
vm.store(address(vault), bytes32(uint256(0)), bytes32(uint256(1)));
```

**Time manipulation:**

```solidity
// Set block.timestamp to a specific value
vm.warp(block.timestamp + 7 days);

// Set block.number
vm.roll(block.number + 100);
```

**Expect revert.** `vm.expectRevert` must be placed immediately before the call expected to revert. Every `expectRevert` must be followed by exactly one call. A test that calls `expectRevert` and then the call does not revert will fail.

```solidity
// Expect a specific custom error
vm.expectRevert(Vault.InsufficientBalance.selector);
vault.withdraw(1000e18, alice, alice);

// Expect a custom error with parameters
vm.expectRevert(
    abi.encodeWithSelector(
        Vault.InsufficientBalance.selector,
        alice,
        1000e18,
        0
    )
);
vault.withdraw(1000e18, alice, alice);

// Expect any revert (use sparingly; prefer specific selectors)
vm.expectRevert();
vault.withdraw(1000e18, alice, alice);
```

**Expect emit.** `vm.expectEmit` asserts that the next call emits a specific event. The four boolean arguments control which event fields are checked: `(checkTopic1, checkTopic2, checkTopic3, checkData)`.

```solidity
// Assert that Deposit is emitted with specific arguments
vm.expectEmit(true, true, false, true);
emit Vault.Deposit(alice, alice, 100e18, 100e18);
vm.prank(alice);
vault.deposit(100e18, alice);
```

**`vm.assume`.** In fuzz tests, `vm.assume` discards inputs that do not satisfy a condition. Use sparingly: excessive assumptions reduce the effective fuzz space. Prefer `bound` for numeric ranges; reserve `assume` for structural conditions (e.g., `vm.assume(a != b)`).

```solidity
function testFuzz_twoActors_independent(address a, address b, uint256 amount) public {
    vm.assume(a != b);                   // structural: actors must be distinct
    vm.assume(a != address(0));
    vm.assume(b != address(0));
    amount = bound(amount, 1, 1000e18); // numeric: use bound, not assume
    // ...
}
```

**`vm.label`.** Labels attached to addresses appear in traces and stack traces, making output readable.

```solidity
vm.label(address(vault), "Vault");
vm.label(address(token), "Token");
vm.label(alice, "Alice");
```

---

### Mainnet Fork Tests

Fork tests run against a live chain state. They are the only way to test real integrations with deployed protocols (Uniswap, Aave, Chainlink feeds).

```solidity
// test/integration/VaultFork.t.sol
pragma solidity 0.8.24;

import { Test }    from "forge-std/Test.sol";
import { Vault }   from "src/Vault.sol";
import { IERC20 }  from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract VaultForkTest is Test {
    // Pin the block number. Tests must be deterministic.
    uint256 constant FORK_BLOCK = 20_000_000;

    address constant USDC         = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDC_WHALE   = 0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503;
    address constant CHAINLINK_ETH = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;

    Vault   public vault;
    uint256 public forkId;

    function setUp() public {
        // RPC URL is loaded from the environment or foundry.toml [rpc_endpoints]
        forkId = vm.createFork(vm.envString("MAINNET_RPC_URL"), FORK_BLOCK);
        vm.selectFork(forkId);

        vault = new Vault(USDC);
    }

    function test_fork_deposit_withRealUSDC() public {
        uint256 amount = 10_000e6; // 10,000 USDC

        // Impersonate a USDC whale
        vm.startPrank(USDC_WHALE);
        IERC20(USDC).approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, USDC_WHALE);
        vm.stopPrank();

        assertGt(shares, 0, "shares minted against real USDC");
        assertEq(IERC20(USDC).balanceOf(address(vault)), amount);
    }

    function test_fork_chainlinkFeed_notStale() public {
        (, int256 price,, uint256 updatedAt,) =
            AggregatorV3Interface(CHAINLINK_ETH).latestRoundData();

        assertGt(price, 0, "price must be positive");
        assertLt(block.timestamp - updatedAt, 3600, "feed must not be stale");
    }
}
```

**`foundry.toml` RPC configuration:**

```toml
[rpc_endpoints]
mainnet  = "${MAINNET_RPC_URL}"
arbitrum = "${ARBITRUM_RPC_URL}"

[etherscan]
mainnet  = { key = "${ETHERSCAN_API_KEY}" }
```

**Pin the block number.** Always pass a specific block number to `createFork`. Unpinned forks run against the latest block; as the chain advances, test behavior changes and tests become non-deterministic.

**Fork caching.** Foundry caches fork state in `~/.foundry/cache`. The first run of a fork test fetches state from the RPC; subsequent runs are served from cache. Do not disable caching in CI; it dramatically reduces test run time.

**Multiple forks.** `vm.createFork` returns a fork ID. Use `vm.selectFork(forkId)` to switch between forks within a single test. This enables cross-chain interaction testing.

---

### Coverage

```bash
# Generate coverage report
forge coverage

# Generate LCOV report for IDE integration
forge coverage --report lcov

# Generate detailed line-level HTML report
forge coverage --report debug
```

**Interpreting the report.** Coverage is reported per file as: line coverage, branch coverage, and function coverage. Branch coverage is the most meaningful metric for security: it identifies conditional paths (require statements, if/else branches) that no test exercises.

**Coverage targets.** There is no universally correct coverage figure. For production DeFi contracts, the following minimums are appropriate:
- Line coverage: 95%
- Branch coverage: 85%
- Function coverage: 100%

A function with 0% coverage is an untested function. Every function must have at least one test.

**Coverage anti-pattern.** Tests written solely to increase coverage metrics (called "coverage theater") are worse than no tests. They establish a false baseline and create maintenance overhead. Coverage is a diagnostic tool, not a goal.

---

## Common Pitfalls

**Missing assertion in fuzz test.** A fuzz function with no `assert*` call tests only that the function does not revert. This is a weak property. Every fuzz test must assert at least one meaningful relationship between the input and the output.

**Weak invariant.** An invariant that is true by construction (e.g., `totalSupply >= 0`) catches nothing. Invariants must express relationships that a real bug could violate.

**Unbounded fuzz input.** Using raw fuzz parameters without `bound` causes the fuzzer to spend the majority of its budget on inputs that revert on preconditions. The fuzzer reports these as passing, creating a false sense of coverage.

**Shared mutable state between tests.** State set in one test function must not affect another. Each test function runs against a fresh `setUp`. If a test appears to pass in isolation but fails in sequence, a storage variable is being mutated outside the test's scope (e.g., a singleton pattern using a storage variable initialized once).

**`vm.expectRevert` followed by multiple calls.** `expectRevert` intercepts exactly one call. If the test makes multiple calls after `expectRevert`, only the first is checked. The remaining calls execute normally and their reverts (if any) become test failures.

**`vm.prank` not wrapping the intended call.** `vm.prank` applies to exactly one call. If any view function is called between `vm.prank` and the intended call, the prank is consumed by the view call.

```solidity
// Wrong: vm.prank consumed by balanceOf, not by deposit
vm.prank(alice);
uint256 bal = vault.balanceOf(alice); // consumes prank
vault.deposit(100e18, alice);        // runs as address(this), not alice

// Correct
uint256 bal = vault.balanceOf(alice);
vm.prank(alice);
vault.deposit(100e18, alice);
```

**Not pinning fork block.** Unpinned fork tests use the latest block. The test passes today and fails next week because the on-chain state changed. Pin every fork test to a specific block number.

**Invariant handler calling revert-heavy paths.** If the handler frequently calls functions that revert (because input bounds are too wide), the fuzzer's effective call throughput drops and the invariant campaign explores shallow state. Monitor `forge test --verbosity 4` output to confirm that handler calls are succeeding at a high rate.

---

## Quick Reference

| Command | Purpose |
|---|---|
| `forge test` | Run all tests |
| `forge test --match-test testFuzz_ -vv` | Run fuzz tests with trace output |
| `forge test --match-contract Invariant` | Run invariant tests only |
| `forge test --fork-url $RPC --fork-block N` | Run tests against a fork |
| `forge coverage` | Generate coverage report |
| `forge snapshot` | Record gas snapshot baseline |
| `forge snapshot --check` | Compare current gas against baseline |
| `forge build` | Compile contracts |
| `forge clean` | Remove build artifacts |

| Cheatcode | Purpose |
|---|---|
| `vm.prank(addr)` | Next call executes as `addr` |
| `vm.startPrank(addr)` / `vm.stopPrank()` | Block of calls as `addr` |
| `vm.deal(addr, amount)` | Set ETH balance |
| `vm.warp(timestamp)` | Set `block.timestamp` |
| `vm.roll(blockNumber)` | Set `block.number` |
| `vm.expectRevert(selector)` | Assert next call reverts with selector |
| `vm.expectEmit(t1,t2,t3,data)` | Assert next call emits event |
| `vm.createFork(url, block)` | Create a fork at a pinned block |
| `vm.selectFork(id)` | Switch active fork |
| `vm.label(addr, name)` | Label address for trace output |
| `bound(x, min, max)` | Constrain fuzz input to range |
| `makeAddr("name")` | Deterministic labeled address |
