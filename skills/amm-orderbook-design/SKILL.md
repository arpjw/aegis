---
name: amm-orderbook-design
description: Mathematical derivations, code skeletons, and trade-off analysis for CPMM, CLMM, and StableSwap AMM designs, CLOB construction with price-time priority, and the verifiability axis as realized in Vela Exchange (SSRN 6579199). Designed for protocol engineers building or auditing DeFi trading infrastructure.
origin: Aegis
tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
---

# AMM and Orderbook Design

Mathematical foundations, implementation patterns, and design trade-offs for automated market makers and central limit order books. The verifiability axis section draws on Arya Somu, "Vela: A High-Performance Verifiable Spot Exchange," SSRN 6579199 (April 2026).

## When to Use

- Designing or auditing a new AMM or perpetuals protocol.
- Selecting between CPMM, CLMM, StableSwap, or CLOB as the core trading primitive.
- Analyzing price impact, MEV surface, or capital efficiency trade-offs for an existing design.
- Understanding how verifiable off-chain execution differs from purely on-chain AMMs.

## Scope Boundaries

This skill covers economic mechanism design and protocol architecture. It does not cover:
- Smart contract security vulnerabilities in the implementation (see `evm-security`)
- Oracle integration for mark price feeds (see `oracle-integration`)
- Gas optimization of the implementation (see `gas-optimization`)

---

## Part I: Automated Market Makers

### 1.1 Constant Product Market Maker (CPMM)

#### Invariant and Derivation

The CPMM maintains the invariant:

```
x * y = k
```

where `x` and `y` are the reserve quantities of the two tokens and `k` is a constant that changes only when liquidity is added or removed.

**Spot price.** The marginal price of token X in terms of token Y is the negative slope of the invariant curve:

```
P_spot = dy/dx|_{x*y=k} = -y/x
```

That is, at reserves `(x, y)`, one unit of token X is worth `y/x` units of token Y.

**Swap formula (exact input).** Given an input of `dx` units of token X and a fee rate `f` (where `f = 0.003` for a 0.3% fee):

```
dx_with_fee = dx * (1 - f)
y_out = y - k / (x + dx_with_fee)
      = y * dx_with_fee / (x + dx_with_fee)
```

The fee is retained in the pool by computing on the reduced `dx_with_fee`. Reserves update to `(x + dx, y - y_out)`.

**Swap formula (exact output).** Given a desired output `dy` units of token Y:

```
dx_required = k / (y - dy) - x
            = x * dy / (y - dy)

dx_with_fee = dx_required / (1 - f)
```

**Price impact.** The effective price received by the trader deviates from the spot price:

```
effective_price = y_out / dx = y / (x + dx_with_fee)

price_impact = 1 - effective_price / P_spot
             = 1 - (y / (x + dx_with_fee)) / (y / x)
             = dx_with_fee / (x + dx_with_fee)
```

For a pool with reserves `x = 1,000,000` and a trade of `dx = 10,000`:
```
price_impact = 10,000 / (1,000,000 + 10,000) = 0.99% impact
```

Price impact scales roughly linearly with trade size as a fraction of pool depth.

**LP share accounting.** Liquidity providers receive pool shares proportional to their contribution. On deposit of `(dx, dy)`:

```
shares_minted = min(dx / x, dy / y) * total_shares
```

On the first deposit, `shares = sqrt(dx * dy)` (geometric mean) to prevent share-price manipulation.

#### CPMM Code Skeleton

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

contract CPMM {
    using SafeERC20 for IERC20;

    IERC20  public immutable token0;
    IERC20  public immutable token1;
    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public totalShares;

    // Fee: 30 bps = 0.3%
    uint256 public constant FEE_BPS   = 30;
    uint256 public constant BPS_DENOM = 10_000;

    mapping(address => uint256) public shares;

    error InsufficientOutput(uint256 out, uint256 minOut);
    error InsufficientLiquidity();
    error InvariantViolated();

    // ---------------------------------------------------------- Swap

    /// @notice Swap an exact amount of token0 for token1.
    function swap0For1(uint256 amountIn, uint256 minAmountOut, address to)
        external
        returns (uint256 amountOut)
    {
        uint256 x = reserve0;
        uint256 y = reserve1;
        if (x == 0 || y == 0) revert InsufficientLiquidity();

        // Apply fee to input
        uint256 amountInWithFee = amountIn * (BPS_DENOM - FEE_BPS) / BPS_DENOM;

        // Constant product: (x + amountInWithFee)(y - amountOut) = x * y
        amountOut = (y * amountInWithFee) / (x + amountInWithFee);
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        token0.safeTransferFrom(msg.sender, address(this), amountIn);
        token1.safeTransfer(to, amountOut);

        reserve0 = x + amountIn;
        reserve1 = y - amountOut;

        // Invariant check: new k must be >= old k (fees increase k)
        assert(reserve0 * reserve1 >= x * y);
    }

    // ---------------------------------------------------------- Liquidity

    /// @notice Add liquidity. Returns shares minted.
    function addLiquidity(uint256 amount0, uint256 amount1, address to)
        external
        returns (uint256 minted)
    {
        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);

        uint256 x = reserve0;
        uint256 y = reserve1;
        uint256 ts = totalShares;

        if (ts == 0) {
            // First deposit: geometric mean prevents share-price manipulation
            minted = Math.sqrt(amount0 * amount1);
        } else {
            // Proportional to smaller contribution
            minted = Math.min(
                (amount0 * ts) / x,
                (amount1 * ts) / y
            );
        }

        shares[to]   += minted;
        totalShares  += minted;
        reserve0      = x + amount0;
        reserve1      = y + amount1;
    }

    /// @notice Remove liquidity. Returns (amount0, amount1) returned to owner.
    function removeLiquidity(uint256 sharesToBurn, address to)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 ts = totalShares;
        amount0 = (sharesToBurn * reserve0) / ts;
        amount1 = (sharesToBurn * reserve1) / ts;

        shares[msg.sender] -= sharesToBurn;
        totalShares        -= sharesToBurn;
        reserve0           -= amount0;
        reserve1           -= amount1;

        token0.safeTransfer(to, amount0);
        token1.safeTransfer(to, amount1);
    }
}
```

---

### 1.2 Concentrated Liquidity Market Maker (CLMM)

#### Tick Math

The CLMM prices tokens using a geometric tick scale. Each tick `i` corresponds to a price:

```
P(i) = 1.0001^i
```

Taking the square root (because Uniswap v3 stores `sqrt(P)` for computational convenience):

```
sqrt_P(i) = 1.0001^(i/2)
```

The tick index for a given price P is:

```
i = floor(log(P) / log(1.0001))
```

Ticks are spaced in discrete increments defined by the fee tier (tick spacing 1 for 0.01%, 10 for 0.05%, 60 for 0.3%, 200 for 1%).

#### Liquidity and Virtual Reserves

A liquidity position in range `[tick_lower, tick_upper]` (equivalently `[sqrt_a, sqrt_b]` where `sqrt_a = sqrt_P(tick_lower)`, `sqrt_b = sqrt_P(tick_upper)`) contributes a quantity of liquidity `L`.

Given the current price `sqrt_P` within `[sqrt_a, sqrt_b]`, the **real reserves** backing the position are:

```
x_real = L * (sqrt_b - sqrt_P) / (sqrt_P * sqrt_b)
y_real = L * (sqrt_P - sqrt_a)
```

These formulas follow from solving:
```
L = sqrt(x * y)       (virtual constant product at center of range)
P = y / x             (price equals reserve ratio)
```

with the boundary conditions `x_real = 0` when `P = upper_bound` and `y_real = 0` when `P = lower_bound`.

#### Swap Within a Tick

A swap from token X to token Y within a single tick range changes `sqrt_P` without crossing a tick boundary. Given liquidity `L` and a desired output `dy`:

```
d(sqrt_P) = dy / L
sqrt_P_new = sqrt_P + dy / L
```

Given input `dx`:

```
d(1/sqrt_P) = dx / L
1/sqrt_P_new = 1/sqrt_P - dx/L
sqrt_P_new = sqrt_P * L / (L - dx * sqrt_P)
```

#### Tick Crossing

When a swap exhausts liquidity at the current tick, execution crosses to the next initialized tick. At each tick boundary, the pool updates:
- `liquidity += liquidityNet` (or `-= liquidityNet` depending on swap direction)
- `feeGrowthGlobal` accumulators update
- `sqrt_P` steps to the next tick

The full swap algorithm iterates across tick boundaries until the full input amount is consumed or `sqrt_P` reaches the limit.

#### Fee Accounting

Fees accrue per unit of liquidity per unit of `sqrt_P` traversed. The global fee accumulator `feeGrowthGlobal` increments on every swap:

```
feeGrowthGlobal += fee_amount / current_liquidity
```

Each position tracks `feeGrowthInsideLast` at the time of its last interaction. Fees owed to a position are:

```
fees_owed = L * (feeGrowthInside - feeGrowthInsideLast)
```

`feeGrowthInside` is derived by subtracting the fee growth outside the position's tick range from the global accumulator, using per-tick snapshots taken when each tick was last crossed.

#### CLMM Code Skeleton

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Illustrative skeleton. Full implementation requires TickMath, FullMath,
///      and the complete tick-crossing logic from Uniswap v3 Core.
contract CLMM {
    // Packed slot: sqrtPriceX96, tick, liquidity
    struct Slot0 {
        uint160 sqrtPriceX96;   // Current sqrt(P) in Q64.96 fixed point
        int24   tick;           // Current tick
        uint128 liquidity;      // Active liquidity
    }

    struct Position {
        uint128 liquidity;
        uint256 feeGrowthInside0Last; // Token0 fees per unit liquidity
        uint256 feeGrowthInside1Last;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    struct TickInfo {
        uint128 liquidityGross;   // Total liquidity referencing this tick
        int128  liquidityNet;     // Net liquidity change when tick is crossed
        uint256 feeGrowthOutside0;
        uint256 feeGrowthOutside1;
        bool    initialized;
    }

    Slot0                                         public slot0;
    mapping(bytes32 => Position)                  public positions;
    mapping(int24 => TickInfo)                    public ticks;
    uint256                                       public feeGrowthGlobal0;
    uint256                                       public feeGrowthGlobal1;
    int24                                         public immutable tickSpacing;
    uint24                                        public immutable fee;         // In hundredths of a bip

    bytes32 private constant POSITION_KEY_MASK = bytes32(uint256(0));

    function positionKey(address owner, int24 tickLower, int24 tickUpper)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(owner, tickLower, tickUpper));
    }

    // ---------------------------------------- Mint (add liquidity)

    /// @notice Add liquidity to a position in [tickLower, tickUpper].
    ///         Returns the token amounts required.
    function mint(
        address     recipient,
        int24       tickLower,
        int24       tickUpper,
        uint128     liquidityDelta,
        bytes calldata data
    )
        external
        returns (uint256 amount0, uint256 amount1)
    {
        require(tickLower < tickUpper, "TICK_ORDER");
        require(tickLower % tickSpacing == 0 && tickUpper % tickSpacing == 0, "TICK_SPACING");

        Slot0 memory _slot0 = slot0;

        // Compute required token amounts from liquidity delta and current price
        amount0 = _computeAmount0(liquidityDelta, _slot0.sqrtPriceX96, tickLower, tickUpper);
        amount1 = _computeAmount1(liquidityDelta, _slot0.sqrtPriceX96, tickLower, tickUpper);

        // Update ticks
        _updateTick(tickLower,  int128(liquidityDelta), false);
        _updateTick(tickUpper, -int128(liquidityDelta), true);

        // Update position
        bytes32 key = positionKey(recipient, tickLower, tickUpper);
        positions[key].liquidity += liquidityDelta;

        // If current tick is inside range, update active liquidity
        if (_slot0.tick >= tickLower && _slot0.tick < tickUpper) {
            slot0.liquidity += liquidityDelta;
        }

        // Pull tokens from caller (callback pattern)
        // IMintCallback(msg.sender).mintCallback(amount0, amount1, data);
    }

    // ---------------------------------------- Swap

    struct SwapState {
        uint256 amountRemaining;
        uint256 amountCalculated;
        uint160 sqrtPriceX96;
        int24   tick;
        uint256 feeGrowthGlobalX128;
        uint128 liquidity;
    }

    struct StepComputations {
        uint160 sqrtPriceStartX96;
        int24   tickNext;
        bool    initialized;
        uint160 sqrtPriceNextX96;
        uint256 amountIn;
        uint256 amountOut;
        uint256 feeAmount;
    }

    /// @notice Swap exactIn token0 for token1 (zeroForOne = true) or vice versa.
    function swap(
        address     recipient,
        bool        zeroForOne,
        int256      amountSpecified,
        uint160     sqrtPriceLimitX96,
        bytes calldata data
    )
        external
        returns (int256 amount0, int256 amount1)
    {
        Slot0 memory _slot0 = slot0;

        SwapState memory state = SwapState({
            amountRemaining:     uint256(amountSpecified > 0 ? amountSpecified : -amountSpecified),
            amountCalculated:    0,
            sqrtPriceX96:        _slot0.sqrtPriceX96,
            tick:                _slot0.tick,
            feeGrowthGlobalX128: zeroForOne ? feeGrowthGlobal0 : feeGrowthGlobal1,
            liquidity:           _slot0.liquidity
        });

        // Main swap loop: iterate across tick boundaries
        while (state.amountRemaining > 0 && state.sqrtPriceX96 != sqrtPriceLimitX96) {
            StepComputations memory step;
            step.sqrtPriceStartX96 = state.sqrtPriceX96;

            // Find next initialized tick in swap direction
            (step.tickNext, step.initialized) = _nextInitializedTick(state.tick, zeroForOne);
            step.sqrtPriceNextX96 = _tickToSqrtPrice(step.tickNext);

            // Compute swap within current tick range
            // (actual implementation uses SqrtPriceMath from Uniswap v3)
            (state.sqrtPriceX96, step.amountIn, step.amountOut, step.feeAmount) =
                _computeSwapStep(
                    state.sqrtPriceX96,
                    step.sqrtPriceNextX96,
                    state.liquidity,
                    state.amountRemaining,
                    fee
                );

            state.amountRemaining -= step.amountIn + step.feeAmount;
            state.amountCalculated += step.amountOut;

            // Accrue fee per unit liquidity
            if (state.liquidity > 0) {
                state.feeGrowthGlobalX128 +=
                    (step.feeAmount << 128) / state.liquidity;
            }

            // Cross tick if price reached boundary
            if (state.sqrtPriceX96 == step.sqrtPriceNextX96) {
                if (step.initialized) {
                    int128 liquidityNet = ticks[step.tickNext].liquidityNet;
                    state.liquidity = zeroForOne
                        ? uint128(int128(state.liquidity) - liquidityNet)
                        : uint128(int128(state.liquidity) + liquidityNet);
                }
                state.tick = zeroForOne ? step.tickNext - 1 : step.tickNext;
            } else {
                // Recompute tick from new price
                state.tick = _sqrtPriceToTick(state.sqrtPriceX96);
            }
        }

        // Write state
        slot0.sqrtPriceX96 = state.sqrtPriceX96;
        slot0.tick         = state.tick;
        slot0.liquidity    = state.liquidity;

        // Settle tokens (callback pattern)
        // ISwapCallback(msg.sender).swapCallback(amount0, amount1, data);
    }

    // Stubs for TickMath / SqrtPriceMath -- replaced by library calls in production
    function _tickToSqrtPrice(int24 tick) internal pure returns (uint160) { tick; return 0; }
    function _sqrtPriceToTick(uint160 sqrtPriceX96) internal pure returns (int24) { sqrtPriceX96; return 0; }
    function _nextInitializedTick(int24 tick, bool lte) internal view returns (int24, bool) { tick; lte; return (0, false); }
    function _computeSwapStep(uint160 a, uint160 b, uint128 L, uint256 rem, uint24 f)
        internal pure returns (uint160, uint256, uint256, uint256) { a; b; L; rem; f; return (0,0,0,0); }
    function _computeAmount0(uint128 L, uint160 sqrtP, int24 lo, int24 hi) internal pure returns (uint256) { L; sqrtP; lo; hi; return 0; }
    function _computeAmount1(uint128 L, uint160 sqrtP, int24 lo, int24 hi) internal pure returns (uint256) { L; sqrtP; lo; hi; return 0; }
    function _updateTick(int24 tick, int128 liquidityDelta, bool upper) internal { tick; liquidityDelta; upper; }
}
```

---

### 1.3 StableSwap (Curve Invariant)

#### Invariant Derivation

StableSwap generalizes between two extremes:

- **Constant sum** (`x + y = const`): zero price impact, breaks when one reserve depletes.
- **Constant product** (`x * y = k`): handles imbalance, high price impact near peg.

The StableSwap invariant interpolates between them using an amplification coefficient `A`:

```
A * n^n * sum(x_i) + D = A * D * n^n + D^(n+1) / (n^n * prod(x_i))
```

where:
- `n` = number of tokens (2 for a two-asset pool)
- `D` = total virtual liquidity (the invariant constant, analogous to `k` in CPMM)
- `A` = amplification coefficient (typically 50-2000 for stablecoin pairs)

**Interpretation of A.** Rewriting:

```
A * n^n * (sum(x_i) - D) = D^(n+1) / (n^n * prod(x_i)) - D

When A -> 0: D^(n+1) / (prod(x_i)) -> n^n * D, i.e., prod(x_i) = (D/n)^n (constant product)
When A -> inf: sum(x_i) = D (constant sum)
```

For large `A`, the pool behaves like a constant-sum market near the peg (very low slippage) and falls back to constant-product behavior only when reserves are severely imbalanced.

#### Computing D

Given reserves `x_0, x_1, ..., x_{n-1}`, solve for `D` iteratively (Newton's method):

```
D_{j+1} = (A * n^n * S + n * D_P) * D_j / ((A * n^n - 1) * D_j + (n + 1) * D_P)

where:
  S   = sum(x_i)
  D_P = D_j^(n+1) / (n^n * prod(x_i))
```

Convergence is fast (5-10 iterations for typical pool states). The iteration terminates when `|D_{j+1} - D_j| < 1`.

#### Swap Formula

To compute the output `y` given input `x_new` (with fee applied):

Solve the invariant for `y`:

```
A * n^n * (x_new + y + sum(other_x_i)) + D =
    A * D * n^n + D^(n+1) / (n^n * x_new * y * prod(other_x_i))
```

This is a quadratic in `y`:

```
y^2 + b * y - c = 0

where (for a two-asset pool):
  b = x_new + D / (A * n^n) - D
  c = D^3 / (n^2 * A * n^n * x_new)

y = (-b + sqrt(b^2 + 4*c)) / 2
```

Newton's method converges in 5-15 iterations.

#### StableSwap Code Skeleton

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice StableSwap for a 2-asset pool. Generalizes to n-asset via loop.
contract StableSwap {
    uint256 public constant N       = 2;
    uint256 public constant ANN_MAX = 1_000_000; // A * N^N limit
    uint256 public constant FEE_DENOM = 10**10;
    uint256 public constant PRECISION = 10**18;

    uint256[N] public balances;    // Stored in 18-decimal units
    uint256    public A;           // Amplification coefficient
    uint256    public fee;         // Fee in FEE_DENOM units (e.g., 4e6 = 0.04%)
    address[N] public coins;

    error SlippageExceeded(uint256 received, uint256 minReceived);

    // ---------------------------------------- Invariant

    /// @notice Compute D for current balances.
    function getD(uint256[N] memory xp) public view returns (uint256 D) {
        uint256 S = xp[0] + xp[1];
        if (S == 0) return 0;

        uint256 Ann  = A * N * N; // A * n^n for n=2
        uint256 Dprev;
        D = S;

        for (uint256 i; i < 256;) {
            uint256 D_P = D;
            for (uint256 j; j < N;) {
                // D_P = D_P * D / (xp[j] * N)
                D_P = D_P * D / (xp[j] * N);
                unchecked { ++j; }
            }
            Dprev = D;
            // D = (Ann * S + D_P * N) * D / ((Ann - 1) * D + (N + 1) * D_P)
            D = (Ann * S + D_P * N) * D / ((Ann - 1) * D + (N + 1) * D_P);
            if (D > Dprev) {
                if (D - Dprev <= 1) break;
            } else {
                if (Dprev - D <= 1) break;
            }
            unchecked { ++i; }
        }
    }

    /// @notice Compute output balance y for a swap that sets x[i] = x.
    /// @param i Index of input token.
    /// @param j Index of output token.
    /// @param x New balance of token i (after fee-adjusted input is added).
    /// @return y New balance of token j (amount out = old_balance_j - y).
    function getY(uint256 i, uint256 j, uint256 x, uint256[N] memory xp)
        public
        view
        returns (uint256 y)
    {
        uint256 D    = getD(xp);
        uint256 Ann  = A * N * N;
        uint256 c    = D;
        uint256 S_;
        uint256 _x;
        uint256 y_prev;

        for (uint256 k; k < N;) {
            if      (k == i) { _x = x; }
            else if (k != j) { _x = xp[k]; }
            else {
                unchecked { ++k; }
                continue;
            }
            S_ += _x;
            c   = c * D / (_x * N);
            unchecked { ++k; }
        }

        // c = c * D / (Ann * N^N)   -- note Ann already = A*N*N for n=2
        c = c * D / (Ann * N);
        uint256 b = S_ + D / Ann;

        y = D;
        for (uint256 k; k < 256;) {
            y_prev = y;
            // y = (y^2 + c) / (2*y + b - D)
            y = (y * y + c) / (2 * y + b - D);
            if (y > y_prev) {
                if (y - y_prev <= 1) break;
            } else {
                if (y_prev - y <= 1) break;
            }
            unchecked { ++k; }
        }
    }

    // ---------------------------------------- Swap

    /// @notice Exchange token i for token j.
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy)
        external
        returns (uint256 dy)
    {
        uint256[N] memory xp = balances;

        uint256 dx_with_fee = dx * (FEE_DENOM - fee) / FEE_DENOM;
        uint256 x = xp[i] + dx_with_fee;

        uint256 y_new = getY(i, j, x, xp);
        dy = xp[j] - y_new;

        if (dy < min_dy) revert SlippageExceeded(dy, min_dy);

        balances[i] = xp[i] + dx;        // Include full dx (fee stays in pool)
        balances[j] = y_new;

        // IERC20(coins[i]).safeTransferFrom(msg.sender, address(this), dx);
        // IERC20(coins[j]).safeTransfer(msg.sender, dy);
    }
}
```

---

## Part II: Central Limit Order Book (CLOB)

### 2.1 Data Structure

A CLOB maintains two sorted lists of price levels:

- **Bids** (buy orders): sorted descending by price. Best bid = highest price.
- **Asks** (sell orders): sorted ascending by price. Best ask = lowest price.

At each price level, orders are stored in a FIFO queue (price-time priority).

```
Bids (descending)         Asks (ascending)
-----------------         ----------------
$1,000 [500, 200]         $1,001 [300]
 $999  [100, 400, 50]     $1,002 [700, 150]
 $998  [250]              $1,005 [1000]
```

The **spread** is `best_ask - best_bid`. The **mid price** is `(best_ask + best_bid) / 2`.

**Data structure choices:**

| Structure | Insert | Delete | Iterate | Notes |
|---|---|---|---|---|
| Sorted linked list | O(n) | O(1) with pointer | O(1) step | Simple; slow insert for deep books |
| Red-black tree | O(log n) | O(log n) | O(log n) step | Correct choice for production CLOBs |
| Skip list | O(log n) avg | O(log n) avg | O(1) step | Cache-friendly; good for in-memory matching |
| Mapping + doubly linked list | O(1) per level | O(1) per level | O(1) step | Best for on-chain (no tree traversal) |

For on-chain CLOBs, a mapping from price to level metadata plus a doubly-linked list of active price levels gives O(1) insert/delete at a known price and O(1) iteration to the next level.

### 2.2 Price-Time Priority

**Rule:** Among all resting orders on the same side, the order with the best price executes first. Among orders at the same price level, the order that arrived first executes first (FIFO).

```solidity
struct Order {
    uint256 id;
    address maker;
    uint256 price;      // In token1 per token0, scaled by PRICE_PRECISION
    uint256 quantity;   // In token0 units
    uint256 filled;     // Filled so far (for partial fills)
    uint64  timestamp;  // Block timestamp at submission
    bool    isBid;
}

struct PriceLevel {
    uint256 price;
    uint256 totalQuantity;   // Sum of open order quantities at this level
    uint256 headOrderId;     // FIFO: oldest order
    uint256 tailOrderId;     // FIFO: newest order
    uint256 prevPrice;       // Linked list: next-worse price
    uint256 nextPrice;       // Linked list: next-better price
}
```

**Matching algorithm:**

```
function match(incoming_order):
    while incoming_order.quantity > 0:
        best_level = get_best_opposing_level()
        if best_level is None or not crosses(incoming_order, best_level):
            break
        for order in best_level.orders (FIFO):
            trade_qty = min(incoming_order.remaining, order.remaining)
            execute_trade(incoming_order, order, best_level.price, trade_qty)
            if order is fully filled:
                remove_order(order)
            if incoming_order is fully filled:
                return
        if best_level is empty:
            remove_level(best_level)
    if incoming_order.remaining > 0 and is_limit_order:
        rest_order(incoming_order)
```

### 2.3 Partial Fills

A partial fill occurs when a resting order is matched against an incoming order whose quantity is smaller than the resting order's remaining quantity.

```solidity
contract CLOB {
    mapping(uint256 => Order) public orders;
    uint256 public nextOrderId;

    event OrderPlaced(uint256 indexed orderId, address maker, bool isBid, uint256 price, uint256 quantity);
    event Trade(uint256 indexed makerOrderId, uint256 indexed takerOrderId, uint256 price, uint256 quantity);
    event OrderCancelled(uint256 indexed orderId, uint256 quantityRemaining);

    function placeOrder(bool isBid, uint256 price, uint256 quantity)
        external
        returns (uint256 orderId)
    {
        orderId = nextOrderId++;
        orders[orderId] = Order({
            id:        orderId,
            maker:     msg.sender,
            price:     price,
            quantity:  quantity,
            filled:    0,
            timestamp: uint64(block.timestamp),
            isBid:     isBid
        });
        emit OrderPlaced(orderId, msg.sender, isBid, price, quantity);
        _match(orderId);
    }

    function _executeTrade(uint256 makerOrderId, uint256 takerOrderId, uint256 tradeQty)
        internal
    {
        Order storage maker = orders[makerOrderId];
        Order storage taker = orders[takerOrderId];

        maker.filled += tradeQty;
        taker.filled += tradeQty;

        emit Trade(makerOrderId, takerOrderId, maker.price, tradeQty);

        // Settle tokens: taker pays price * qty in token1; receives qty in token0
        // (settlement logic omitted; depends on collateral model)
    }
}
```

### 2.4 Cancellation Patterns

**Active cancellation (immediate removal):**

```solidity
function cancelOrder(uint256 orderId) external {
    Order storage order = orders[orderId];
    require(order.maker == msg.sender, NotYourOrder());
    uint256 remaining = order.quantity - order.filled;
    require(remaining > 0, AlreadyFilled());

    _removeFromBook(orderId);
    emit OrderCancelled(orderId, remaining);

    // Return collateral for remaining quantity
    // _releaseCollateral(msg.sender, remaining);

    delete orders[orderId];
}
```

**Lazy cancellation (mark and skip):**

Lazy cancellation avoids the O(log n) tree deletion cost by marking the order as cancelled. The order is physically removed from the book the next time it would be matched.

```solidity
mapping(uint256 => bool) public cancelled;

function cancelOrder(uint256 orderId) external {
    require(orders[orderId].maker == msg.sender, NotYourOrder());
    cancelled[orderId] = true;
    emit OrderCancelled(orderId, orders[orderId].quantity - orders[orderId].filled);
    // Collateral released immediately despite deferred removal
    // _releaseCollateral(msg.sender, remaining);
}

// In matching loop:
function _nextValidOrder(uint256 levelHead) internal view returns (uint256) {
    uint256 id = levelHead;
    while (id != 0 && (cancelled[id] || orders[id].filled >= orders[id].quantity)) {
        id = orderNext[id]; // Linked list traversal
    }
    return id;
}
```

**Gas cost comparison (on-chain):**

| Operation | Active removal | Lazy cancellation |
|---|---|---|
| `cancelOrder` | ~40,000 gas (tree rebalance) | ~5,000 gas (single SSTORE) |
| Next match step | ~5,000 gas (direct) | ~8,000 gas (skip cancelled nodes) |
| Best for | Low cancellation rate | High-frequency cancellation |

**Cancel-on-fill (IOC / FOK).** Immediate-or-cancel orders never rest in the book: any unfilled quantity is cancelled at the end of the matching step. Fill-or-kill orders revert if not fully filled in a single pass.

---

## Part III: The Verifiability Axis

### 3.1 The Spectrum

Every trading system occupies a position on the axis from pure centralization to pure on-chain execution:

```
Fully Centralized                                         Fully On-chain
      |                                                        |
   [CEX]                                                    [AMM]
   Fast, opaque, custodial             Slow, transparent, non-custodial
   <1 us matching latency              Latency = block time (12s on L1)
   No on-chain verifiability           Every fill verifiable by any observer
   Single point of failure             Censorship-resistant
```

The challenge for DeFi protocols is recovering CEX-grade performance without sacrificing the verifiability and self-custody properties that differentiate a DEX.

### 3.2 Vela's Architecture (SSRN 6579199)

*Arya Somu, "Vela: A High-Performance Verifiable Spot Exchange," April 2026.*

Vela positions its exchange engine at a specific point on this axis: CEX-grade matching latency with DEX-grade verifiability guarantees. The core mechanism is **optimistic execution with ZK-provable dispute resolution**.

#### Optimistic Execution Model

All state transitions (order placement, matching, settlement) are processed off-chain by a matching engine. The engine produces signed state root commitments that are posted to an on-chain contract at regular intervals. The system assumes commitments are correct by default.

A **seven-day challenge window** allows any participant to submit a cryptographic proof that a state transition was executed incorrectly. During the challenge window, withdrawals are subject to a delay. If no valid challenge is submitted, the commitment is finalized.

This model recovers the throughput of a centralized exchange because the critical path (order matching) runs entirely off-chain, while preserving verifiability because any incorrect execution can be detected and proven on-chain.

```
         Off-chain                         On-chain
         ---------                         --------
  [Matching Engine]                   [Settlement Contract]
       |                                      |
  Place order --> match --> fill         State root posted
       |                                      |
  State transition                    7-day challenge window
       |                                      |
  Signed state root -----------------> Root finalized (if no challenge)
                                             |
                                    [Challenge Contract]
                                             |
                              ZK proof of incorrect transition
                                    --> State root rejected
                                    --> Prior root restored
```

#### Fast-Finality Path

Users who require immediate settlement (rather than waiting for the 7-day window) can use the **fast-finality path**: the matching engine countersigns a settlement proof, and the on-chain contract releases funds immediately against that countersignature. This path introduces a trust assumption in the matching engine's liveness; the optimistic path is the fallback.

```
Normal path:  order filled --> wait 7 days --> withdraw
Fast path:    order filled --> engine countersigns --> withdraw immediately
```

#### Forced Inclusion via Delayed Inbox

To prevent censorship by the matching engine, Vela includes a **forced inclusion mechanism** modeled on Arbitrum's delayed inbox. If a user's order is not included by the matching engine within a deadline (e.g., 24 hours), the user can submit it directly to an on-chain inbox contract. The matching engine must incorporate delayed inbox transactions in the correct position in the state sequence or its next commitment will fail the validity check.

```solidity
interface IDelayedInbox {
    /// @notice Submit an order directly on-chain if the engine has ignored it.
    /// @param order    The signed order to force-include.
    /// @param deadline Block number after which the engine must have included this order.
    function forceInclude(bytes calldata order, uint256 deadline) external;
}
```

### 3.3 Market-Maker Credit System

A novel feature in Vela's design is a **market-maker credit system** that enables capital-efficient cross-market quoting without requiring full collateralization of each order individually.

In a traditional DEX, every resting order must be fully collateralized at placement time. A market maker quoting bid/ask across 50 pairs must hold 100 separate collateral deposits. This severely limits capital efficiency compared to a CEX, where market makers operate on a portfolio margin basis.

Vela's credit system implements a credit line within the matching engine's state transition function. A market maker registers a credit limit (backed by collateral held in the settlement contract). The engine allows the market maker to rest orders up to the credit limit across all pairs without individual order collateral, enforcing atomic collateral checks at the moment of fill.

```
MM registers: $1M credit limit (backed by $1M USDC in settlement contract)
MM quotes:    50 pairs, each with $200K of open orders = $10M nominal
              (possible because only one side executes at a time)

On fill:
  Matched order notional < remaining credit limit --> fill proceeds
  Matched order notional >= remaining credit limit --> fill rejected, credit insufficient
```

The credit limit is enforced within the state transition function, making violation detectable and provable via the ZK challenge mechanism.

### 3.4 Private L3 Market Data Feeds

Standard on-chain order books expose all resting orders to all participants. A sophisticated observer can infer a market maker's inventory position and trading intentions from the order book state, and trade against them (adverse selection).

Vela addresses this with **private L3 market data feeds**: each market maker subscribes to a feed authenticated via a **server-issued nonce challenge and wallet signature**. The feed delivers the full order book state encrypted to the market maker's key. Other participants see only the aggregated best bid/ask (L1 data) on-chain.

```
Authentication flow:
  1. Market maker sends GET /l3-feed with wallet address
  2. Server responds with nonce: { nonce: "0xabc...123", expires: T+30s }
  3. Market maker signs: keccak256(abi.encodePacked(address, nonce))
  4. Server verifies signature, opens authenticated WebSocket stream
  5. Stream delivers full order book updates encrypted to maker's session key
```

This substantially reduces adverse selection costs for market makers, enabling tighter spreads and deeper liquidity without the information leakage inherent in fully public on-chain order books.

### 3.5 Delta Elimination

The paper identifies **Delta elimination** as the single most impactful performance optimization in the matching engine, reducing p99.9 tail latency by 73%.

In a naive matching implementation, each fill event triggers a cascade of downstream state updates: position delta computation, fee accrual, event emission, state root update. Under high order flow, these deltas queue and contribute disproportionately to tail latency.

Delta elimination batches these updates: instead of computing and applying each delta immediately, the engine accumulates deltas in a write-ahead buffer and flushes them in a single pass at the end of each matching cycle. This converts O(fills) state writes per cycle into O(1) flush operations.

```
Without Delta elimination:
  Fill 1 --> update position --> update fees --> update state root
  Fill 2 --> update position --> update fees --> update state root
  Fill N --> update position --> update fees --> update state root
  (N * 3 state writes per cycle)

With Delta elimination:
  Fill 1 --> accumulate delta
  Fill 2 --> accumulate delta
  Fill N --> accumulate delta
  Flush  --> single pass: apply all deltas, update state root once
  (N accumulations + 1 flush per cycle)
```

At 100,000 fills per cycle, this reduces p99.9 write pressure by approximately the N factor, eliminating the primary source of tail latency spikes.

---

## Part IV: Trade-off Analysis

### 4.1 Capital Efficiency

Capital efficiency measures how much trading volume a given amount of locked capital supports.

| Design | Capital efficiency | Notes |
|---|---|---|
| CPMM (Uniswap v2) | Low | Liquidity distributed uniformly across all prices; most is never used |
| CLMM (Uniswap v3) | High (up to 4000x vs v2 in tight ranges) | LP must actively manage position; risk of out-of-range |
| StableSwap | Very high near peg | Degrades to CPMM far from peg; excellent for correlated pairs |
| CLOB (on-chain) | Moderate | Collateral locked per order; no portfolio margin |
| CLOB (hybrid, with credit) | Very high | Portfolio margin reduces required collateral by 5-20x |

**CPMM inefficiency illustrated:**
For a pool with $10M in reserves at ETH/USDC and 95% of trading occurring within +-5% of the current price, approximately $9.5M of capital earns zero fees (it is at prices never reached during normal trading).

**CLMM concentration:**
An LP providing liquidity in the range `[P*0.99, P*1.01]` in Uniswap v3 provides approximately 50x more depth per dollar than the same capital in v2 at the current price. The tradeoff: the position earns zero fees when price exits the range, and the LP holds entirely one asset (impermanent loss crystallized) at range boundaries.

### 4.2 Price Impact Curves

Price impact as a function of trade size relative to pool depth:

**CPMM:**

```
impact(dx) = dx / (x + dx)   (before fees)

At dx = 0.1% of x:  impact = 0.10%
At dx = 1%   of x:  impact = 0.99%
At dx = 10%  of x:  impact = 9.09%
```

**StableSwap (A = 100, near peg):**

```
For trades within +- 1% of peg, price impact < 0.01% for A = 100
Price impact grows rapidly as reserves become imbalanced beyond A's effective range
```

**CLOB:**

Price impact is determined by resting order book depth, not a formula. A thin book at the best level produces step-function impact as levels are consumed.

```
Trade 0   units:  fills at $1,000 (best ask)
Trade 300 units:  fills at $1,000 (exhausts first level)
Trade 301 units:  fills 300 at $1,000 + 1 at $1,001 = blended $1,000.003
Trade 700 units:  fills 300 at $1,000 + 400 at $1,001 = blended $1,000.57
```

The CLOB's step-function impact is preferable when resting liquidity is deep; the AMM's smooth curve is preferable when the book is thin.

### 4.3 MEV Surface

| Design | MEV type | Mechanism | Severity |
|---|---|---|---|
| CPMM | Sandwich | Observe pending swap, front/backrun | High |
| CPMM | Arbitrage | React to AMM price diverging from external markets | Always present (benign) |
| CLMM | JIT liquidity | Add concentrated liquidity immediately before large swap | High for LPs |
| CLMM | LP sniping | Remove liquidity when position goes out of range before LP does | Medium |
| StableSwap | Sandwich | Same as CPMM; lower impact due to lower slippage near peg | Low-medium |
| CLOB (on-chain) | Frontrunning | Observe pending order, front-run before inclusion | High |
| CLOB (hybrid, private feed) | Adverse selection | Reduced by private L3 feeds; residual from L1 data | Low-medium |
| CLOB (optimistic) | Forced inclusion abuse | Spam delayed inbox to disrupt engine ordering | Low (rate-limited) |

**MEV extraction estimate for CPMM:**

```
Sandwich profit = 2 * slippage * trade_size * (1 - fee)^2
               ~= 2 * (trade_size / pool_depth) * trade_size

For a $100K trade in a $10M pool (fee = 0.3%):
profit ~= 2 * 0.01 * 100,000 = $2,000
```

### 4.4 Gas Cost Per Fill

On-chain gas cost is a first-order constraint for order-book-based protocols. Every resting-order fill requires at minimum: state reads (SLOAD), state writes (SSTORE), and event emission.

| Fill type | Approximate gas | Cost at 20 gwei, ETH = $3,000 |
|---|---|---|
| CPMM swap (Uniswap v2) | ~80,000 gas | $4.80 |
| CLMM swap, in-range (Uniswap v3) | ~120,000 gas | $7.20 |
| CLMM swap, cross-tick (Uniswap v3) | ~150,000 gas per tick | $9.00 per tick |
| StableSwap (Curve, 2-asset) | ~150,000 gas | $9.00 |
| CLOB fill, single resting order | ~200,000 gas | $12.00 |
| CLOB fill, 5 resting orders (partial) | ~500,000 gas | $30.00 |
| Hybrid CLOB fill (off-chain match, on-chain settle) | ~50,000 gas | $3.00 |

The hybrid model's settlement-only on-chain footprint is the key gas advantage: the expensive matching logic runs off-chain, and only the final settlement state is written on-chain.

**Implications for design selection:**

- High-frequency, small-order protocols (perps with sub-$1K positions) cannot afford on-chain CLOB fills at mainnet gas prices. Hybrid or optimistic execution is required.
- Large, infrequent swaps ($100K+) can absorb on-chain CLOB costs; the tighter spreads often justify the gas premium.
- AMMs are the correct default for long-tail assets with unpredictable liquidity, where a CLOB would have an empty book most of the time.

---

## Quick Reference

### AMM Selection

| Asset pair | Recommended design | Rationale |
|---|---|---|
| Volatile pairs (ETH/USDC) | CLMM | Capital efficiency; accepts active LP management |
| Stablecoin pairs (USDC/USDT) | StableSwap | Near-zero slippage near peg; optimized for correlation |
| Long-tail, illiquid pairs | CPMM | Simple; bootstrap with low capital; survives low volume |
| Perpetuals (synthetic) | VLP pool (global AMM) or CLOB | Global pool absorbs all positions; CLOB for price discovery |

### Design Invariants

| Design | Core invariant | Breaks when |
|---|---|---|
| CPMM | `x * y = k` | A reserve reaches zero |
| CLMM | Piecewise `x * y = L^2` per range | Price exits all initialized ranges |
| StableSwap | `A*n^n*S + D = A*D*n^n + D^(n+1)/(n^n*P)` | One asset depegs severely (A becomes ineffective) |
| CLOB | `best_bid < best_ask` (no locked-in cross) | Matching engine failure (on-chain) or censorship (hybrid) |
| Optimistic hybrid | State root matches correct execution | Matching engine equivocates; caught in challenge window |

### Vela Architecture Summary

| Component | Mechanism |
|---|---|
| Execution | Off-chain matching engine |
| Verifiability | Optimistic state roots + ZK challenge proofs |
| Finality | 7-day window (standard) or countersigned fast path |
| Censorship resistance | Forced inclusion via delayed inbox |
| MM capital efficiency | Credit system with atomic collateral enforcement |
| Adverse selection protection | Private L3 feeds with nonce-challenge authentication |
| Tail latency | Delta elimination (-73% p99.9) |
