---
name: aegis-oracle-integration
description: Oracle integration patterns for Solidity. Chainlink Data Feeds with staleness and sequencer checks, Pyth pull-based consumption, Uniswap v3 TWAP construction, manipulation resistance, selection guidance, and a catalog of common implementation mistakes.
origin: Aegis
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
---

# Oracle Integration

Secure oracle consumption patterns for EVM protocols. Every oracle read is a trust boundary: the protocol trusts an external party to provide a price. Implement each boundary with the same rigor applied to user input validation.

## When to Use

- Implementing a price feed for a lending protocol, AMM, or derivatives system.
- Auditing an existing oracle integration for correctness.
- Selecting the appropriate oracle type for a given asset and chain.
- Constructing a TWAP or fallback mechanism.

## Scope Boundaries

This skill covers oracle consumption patterns. It does not cover:
- Economic analysis of oracle dependency risk (see `defi-economist` agent)
- Security audit of the broader protocol (see `solidity-reviewer` agent, `audit-finder` agent)
- Gas optimization of oracle calls (see `gas-optimization`)

---

## Core Concepts

**Push vs. pull oracles.** Push oracles (Chainlink) update on-chain state proactively when price deviates beyond a threshold or a heartbeat elapses. Pull oracles (Pyth) require the consumer to submit a signed price update alongside the transaction that consumes it. Push oracles have simpler consumption code; pull oracles have lower latency and lower gas cost for the oracle operator.

**TWAP.** A time-weighted average price averages the price over a window of time, making single-block manipulation expensive. The cost to manipulate a TWAP is proportional to the window length and the pool's liquidity. TWAPs are derived from on-chain AMM state and do not rely on an external operator.

**Heartbeat and deviation threshold.** Chainlink feeds update when the price moves beyond the deviation threshold (typically 0.5% for major pairs) or when the heartbeat elapses (typically 1 hour for majors, 24 hours for minors). A staleness check must use the heartbeat, not the deviation threshold, as its reference.

**Sequencer uptime (L2).** On optimistic rollups (Arbitrum, Optimism, Base), the L2 sequencer can go offline. During an outage, Chainlink feeds do not update because there is no sequencer to post transactions. When the sequencer comes back online, prices may be stale by the entire outage duration. Protocols on L2 must check the Chainlink Sequencer Uptime Feed before trusting any price.

---

## Chainlink Price Feeds

### Interface

```solidity
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
}
```

### Correct Consumption Pattern (Mainnet)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AggregatorV3Interface } from
    "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

contract PriceFeed {
    error StalePrice(uint256 updatedAt, uint256 maxAge);
    error InvalidPrice(int256 answer);
    error IncompleteRound(uint80 answeredInRound, uint80 roundId);

    /// @dev Set to 110% of the feed's documented heartbeat.
    ///      ETH/USD heartbeat = 3600s; maxStaleness = 3960s.
    ///      BTC/USD heartbeat = 3600s; maxStaleness = 3960s.
    ///      Exotic pairs with 86400s heartbeat: maxStaleness = 86400s + buffer.
    uint256 public immutable maxStaleness;
    AggregatorV3Interface public immutable feed;

    constructor(address _feed, uint256 _maxStaleness) {
        feed         = AggregatorV3Interface(_feed);
        maxStaleness = _maxStaleness;
    }

    /// @notice Returns the latest price, reverts on any validation failure.
    /// @return price The price in the feed's native denomination (check decimals()).
    function getPrice() public view returns (uint256 price) {
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = feed.latestRoundData();

        // 1. Price must be positive
        if (answer <= 0) revert InvalidPrice(answer);

        // 2. Round must be complete (answeredInRound >= roundId)
        //    answeredInRound < roundId means the round started but no answer was posted.
        if (answeredInRound < roundId) revert IncompleteRound(answeredInRound, roundId);

        // 3. Price must not be stale
        if (block.timestamp - updatedAt > maxStaleness) {
            revert StalePrice(updatedAt, maxStaleness);
        }

        price = uint256(answer);
    }
}
```

### Sequencer Uptime Check (L2: Arbitrum, Optimism, Base)

On L2, add the sequencer uptime check before any price consumption. The sequencer feed address is chain-specific; consult the Chainlink documentation for each deployment target.

```solidity
import { AggregatorV3Interface } from
    "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

contract L2PriceFeed {
    error SequencerDown();
    error GracePeriodNotElapsed(uint256 elapsed, uint256 required);
    error StalePrice(uint256 updatedAt, uint256 maxAge);
    error InvalidPrice(int256 answer);

    /// @dev Chainlink recommends a 3600s (1 hour) grace period after sequencer restart.
    ///      During this period, prices may still reflect pre-outage state.
    uint256 public constant GRACE_PERIOD = 3600;

    AggregatorV3Interface public immutable sequencerFeed;
    AggregatorV3Interface public immutable priceFeed;
    uint256               public immutable maxStaleness;

    constructor(
        address _sequencerFeed,
        address _priceFeed,
        uint256 _maxStaleness
    ) {
        sequencerFeed = AggregatorV3Interface(_sequencerFeed);
        priceFeed     = AggregatorV3Interface(_priceFeed);
        maxStaleness  = _maxStaleness;
    }

    function getPrice() public view returns (uint256 price) {
        // Step 1: Verify the sequencer is online and the grace period has elapsed.
        (
            ,
            int256 sequencerAnswer, // 0 = online, 1 = offline
            uint256 sequencerStartedAt,
            ,
        ) = sequencerFeed.latestRoundData();

        if (sequencerAnswer != 0) revert SequencerDown();

        uint256 elapsed = block.timestamp - sequencerStartedAt;
        if (elapsed < GRACE_PERIOD) {
            revert GracePeriodNotElapsed(elapsed, GRACE_PERIOD);
        }

        // Step 2: Consume the price feed with full validation.
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = priceFeed.latestRoundData();

        if (answer <= 0) revert InvalidPrice(answer);
        if (answeredInRound < roundId) revert IncompleteRound(answeredInRound, roundId);
        if (block.timestamp - updatedAt > maxStaleness) {
            revert StalePrice(updatedAt, maxStaleness);
        }

        price = uint256(answer);
    }
}
```

**L2 sequencer feed addresses (as of Cancun):**

| Network | Sequencer Feed |
|---|---|
| Arbitrum One | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` |
| Optimism | `0x371EAD81c9102C9BF4874A9075FFFf170F2D5BD7` |
| Base | `0xBCF85224fc0756B9Fa45aA7892F65f895b6d1c1b` |

Verify these addresses against the Chainlink documentation before deployment. Feed addresses change with network upgrades.

### Fallback Handling

A protocol that hard-reverts when the primary oracle is stale has no degraded-mode operation. Implement a fallback oracle where price staleness matters more than latency, and a circuit breaker where safety matters more than availability.

```solidity
contract PriceFeedWithFallback {
    AggregatorV3Interface public immutable primary;
    AggregatorV3Interface public immutable fallback_;
    uint256               public immutable primaryMaxStaleness;
    uint256               public immutable fallbackMaxStaleness;

    function getPrice() public view returns (uint256 price, bool isFallback) {
        // Attempt primary
        try this._getPriceFrom(primary, primaryMaxStaleness) returns (uint256 p) {
            return (p, false);
        } catch {
            // Primary failed; attempt fallback
        }

        // Attempt fallback
        try this._getPriceFrom(fallback_, fallbackMaxStaleness) returns (uint256 p) {
            return (p, true);
        } catch {
            revert NoPriceAvailable();
        }
    }

    /// @dev External so it can be called inside try/catch. Not intended for direct use.
    function _getPriceFrom(
        AggregatorV3Interface feed_,
        uint256 maxStaleness_
    ) external view returns (uint256 price) {
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = feed_.latestRoundData();

        if (answer <= 0)               revert InvalidPrice(answer);
        if (answeredInRound < roundId) revert IncompleteRound(answeredInRound, roundId);
        if (block.timestamp - updatedAt > maxStaleness_) revert StalePrice(updatedAt, maxStaleness_);

        price = uint256(answer);
    }
}
```

**Circuit breaker pattern.** Rather than falling back to a potentially unreliable secondary source, some protocols pause when the primary oracle is stale. This is safer when a stale fallback would create exploitable price discrepancies.

```solidity
bool public paused;
address public guardian;

modifier requireFreshPrice() {
    (, , , uint256 updatedAt, ) = priceFeed.latestRoundData();
    if (block.timestamp - updatedAt > maxStaleness) {
        if (!paused) {
            paused = true;
            emit OracleStalePauseTriggered(updatedAt);
        }
        revert ContractPaused();
    }
    _;
}
```

### Price Normalization

Chainlink feeds return prices with feed-specific decimal precision. Normalize before arithmetic.

```solidity
/// @dev Normalizes a Chainlink price to 18 decimal places.
function normalizePrice(
    AggregatorV3Interface feed_,
    uint256 rawPrice
) internal view returns (uint256) {
    uint8 feedDecimals = feed_.decimals(); // e.g., 8 for USD pairs
    if (feedDecimals < 18) {
        return rawPrice * (10 ** (18 - feedDecimals));
    } else if (feedDecimals > 18) {
        return rawPrice / (10 ** (feedDecimals - 18));
    }
    return rawPrice;
}
```

**Common decimal values:**
- USD pairs (ETH/USD, BTC/USD): 8 decimals
- ETH pairs (LINK/ETH): 18 decimals
- Normalize all prices to 18 decimals before any arithmetic to avoid precision errors.

---

## Pyth Network (Pull Oracle)

### Mechanism

Pyth prices are published off-chain by data providers and made available via a cross-chain messaging protocol. The consumer submits a signed price update with their transaction. The Pyth contract verifies the signature and stores the price for use within the same transaction.

The key distinction from Chainlink: Pyth does not proactively push prices on-chain. The price is only as fresh as the update submitted by the caller.

### Interface and Consumption Pattern

```solidity
import { IPyth }       from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import { PythStructs } from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

contract PythConsumer {
    error StalePrice(uint256 publishTime, uint256 maxAge);
    error InvalidPrice(int64 price, uint64 conf);
    error NegativeExponent(int32 expo);

    IPyth   public immutable pyth;
    bytes32 public immutable priceId;   // e.g., ETH/USD price feed ID on Pyth
    uint256 public immutable maxAge;    // Maximum acceptable price age in seconds

    constructor(address _pyth, bytes32 _priceId, uint256 _maxAge) {
        pyth    = IPyth(_pyth);
        priceId = _priceId;
        maxAge  = _maxAge;
    }

    /// @notice Update price and consume it in one call.
    /// @param priceUpdateData Signed price update data from Pyth's price service API.
    function updateAndGetPrice(bytes[] calldata priceUpdateData)
        external
        payable
        returns (uint256 price)
    {
        // Pay the update fee (returned by getPythFee; typically very small)
        uint256 fee = pyth.getUpdateFee(priceUpdateData);
        pyth.updatePriceFeeds{value: fee}(priceUpdateData);

        price = _getValidatedPrice();
    }

    function _getValidatedPrice() internal view returns (uint256 price) {
        // Use getPriceNoOlderThan to enforce freshness at the Pyth level
        PythStructs.Price memory p = pyth.getPriceNoOlderThan(priceId, maxAge);

        // Pyth returns a signed price with a confidence interval.
        // A non-positive price or negative exponent indicates a malformed feed.
        if (p.price <= 0) revert InvalidPrice(p.price, p.conf);

        // Reject negative exponents (should not occur for well-formed feeds)
        if (p.expo > 0) revert NegativeExponent(p.expo);

        // Convert: price * 10^expo -> normalize to 18 decimals
        // expo is negative (e.g., -8 for USD pairs)
        uint256 absExpo = uint256(int256(-p.expo));
        price = uint256(int256(p.price)) * (10 ** (18 - absExpo));
    }

    /// @notice Confidence interval check. Reject if confidence > threshold.
    /// @dev    A wide confidence interval indicates high price uncertainty.
    ///         Threshold of 1% (100 bps) is a reasonable starting point.
    function _validateConfidence(PythStructs.Price memory p, uint256 maxConfBps) internal pure {
        // conf / price > maxConfBps / 10000 means confidence is too wide
        if (uint64(p.price) > 0) {
            uint256 confBps = (uint256(p.conf) * 10_000) / uint256(int256(p.price));
            if (confBps > maxConfBps) revert ConfidenceTooWide(p.conf, p.price, maxConfBps);
        }
    }
}
```

### Pyth Feed IDs

Feed IDs are 32-byte identifiers specific to each asset pair and network cluster. Fetch the correct ID from the Pyth documentation or the price service API before deployment. Do not hardcode feed IDs from another network; they differ across Pythnet and Hermes.

### Pyth vs. Chainlink Selection

| Criterion | Chainlink | Pyth |
|---|---|---|
| Update model | Push (on-chain, autonomous) | Pull (caller-submitted) |
| Latency | 1s - 1 hour (heartbeat-dependent) | Sub-second (at time of submission) |
| Gas cost (oracle side) | Paid by Chainlink node operators | Paid by protocol's users or keeper |
| Confidence interval | Not exposed in standard interface | Exposed; allows uncertainty rejection |
| Asset coverage | Wide for majors on mainnet | Wide for majors and exotics across chains |
| L2 sequencer risk | Requires uptime check | Less relevant (no on-chain state to go stale) |

---

## Uniswap v3 TWAP

### Mechanism

Uniswap v3 accumulates a tick-based price oracle in each pool. The cumulative tick sum divided by the time window produces the geometric mean tick for that period. Converting the mean tick to a price yields the TWAP.

TWAPs are manipulation-resistant because an attacker must sustain a manipulated price for the entire window duration, paying the full cost of the price impact on every block.

### Construction Pattern

```solidity
import { IUniswapV3Pool }    from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TickMath }          from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { FullMath }          from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { OracleLibrary }     from "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";

contract UniswapV3TWAP {
    error WindowTooShort(uint32 window, uint32 minimum);
    error InsufficientObservations();

    IUniswapV3Pool public immutable pool;
    address        public immutable baseToken;
    address        public immutable quoteToken;
    uint32         public immutable windowSeconds;

    uint32 public constant MINIMUM_WINDOW = 1800; // 30 minutes

    constructor(
        address _pool,
        address _baseToken,
        address _quoteToken,
        uint32  _windowSeconds
    ) {
        if (_windowSeconds < MINIMUM_WINDOW) {
            revert WindowTooShort(_windowSeconds, MINIMUM_WINDOW);
        }
        pool         = IUniswapV3Pool(_pool);
        baseToken    = _baseToken;
        quoteToken   = _quoteToken;
        windowSeconds = _windowSeconds;
    }

    /// @notice Returns the TWAP price of baseToken denominated in quoteToken.
    /// @return price Price of 1 unit (1e18) of baseToken in quoteToken's decimals.
    function getTWAP() external view returns (uint256 price) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = windowSeconds;
        secondsAgos[1] = 0;

        // observe() reverts if the oldest observation is not old enough
        // Wrap in try/catch and surface as InsufficientObservations
        int56[] memory tickCumulatives;
        try pool.observe(secondsAgos) returns (
            int56[] memory _tickCumulatives,
            uint160[] memory
        ) {
            tickCumulatives = _tickCumulatives;
        } catch {
            revert InsufficientObservations();
        }

        int56  tickDelta         = tickCumulatives[1] - tickCumulatives[0];
        int24  arithmeticMeanTick = int24(tickDelta / int56(uint56(windowSeconds)));

        // Round toward negative infinity (correct for geometric mean)
        if (tickDelta < 0 && (tickDelta % int56(uint56(windowSeconds)) != 0)) {
            arithmeticMeanTick--;
        }

        price = OracleLibrary.getQuoteAtTick(
            arithmeticMeanTick,
            1e18,         // 1 unit of baseToken in its own decimals
            baseToken,
            quoteToken
        );
    }

    /// @notice Checks whether the pool has enough observation history for the window.
    function hasEnoughHistory() external view returns (bool) {
        (, , uint16 observationIndex, uint16 observationCardinality, , , ) =
            pool.slot0();
        (uint32 oldestTimestamp, , , bool initialized) =
            pool.observations((observationIndex + 1) % observationCardinality);
        if (!initialized) {
            (oldestTimestamp, , , ) = pool.observations(0);
        }
        return block.timestamp - oldestTimestamp >= windowSeconds;
    }
}
```

### Cardinality Initialization

Uniswap v3 pools store a fixed-size ring buffer of price observations. New pools default to a cardinality of 1, which cannot support a TWAP window longer than the block time. Before using a TWAP, increase the cardinality.

```solidity
// Call once to expand the observation buffer.
// A cardinality of 180 supports a 30-minute TWAP at 10s block time.
pool.increaseObservationCardinalityNext(180);
```

This call is gas-intensive (it initializes each new slot) and should be made by the protocol deployer, not the user. The pool fills new slots lazily over time; `hasEnoughHistory()` should be checked before the TWAP is relied upon.

### Manipulation Cost Estimation

The cost to move a Uniswap v3 TWAP by P% over a window W seconds in a pool with liquidity L (in the denominated asset) is approximately:

```
Manipulation cost = (P / 100) * L * (W / block_time) * fee_tier
```

For a 30-minute window, a 0.3% fee tier pool, and $10M in liquidity:
- Cost to move price 1% = 1% * $10M * (1800/12) * 0.3% = approximately $450,000 per manipulation attempt.

This is a rough estimate; actual cost depends on concentrated liquidity distribution. Thin pools with narrow tick ranges are cheaper to manipulate. Always verify pool depth before relying on its TWAP.

---

## Oracle Selection Guide

| Scenario | Recommended oracle | Rationale |
|---|---|---|
| Major asset pair on Ethereum mainnet (ETH/USD, BTC/USD, LINK/USD) | Chainlink Data Feed | Highest liquidity, established track record, multiple node operators |
| Major asset pair on Arbitrum / Optimism / Base | Chainlink + Sequencer Feed | Same reliability with mandatory L2 uptime check |
| Long-tail asset with Chainlink coverage | Chainlink with 24h staleness window | Chainlink covers it; verify heartbeat before setting maxStaleness |
| Long-tail asset without Chainlink coverage | Uniswap v3 TWAP (30min+) | On-chain derivation; requires deep pool |
| High-frequency derivatives (sub-second latency) | Pyth pull | Chainlink heartbeat too slow; Pyth updated on every caller submission |
| Protocol needs both freshness and manipulation resistance | Chainlink primary + TWAP circuit breaker | Chainlink for normal operation; TWAP to detect anomalous deviations |
| Cross-chain price consumption | Pyth (native cross-chain) | Chainlink requires per-chain feed; Pyth is designed for multi-chain |

**Multi-oracle pattern (primary + deviation check):**

```solidity
/// @dev Uses Chainlink as the primary source. If the Chainlink price deviates
///      more than MAX_DEVIATION_BPS from the TWAP, something is anomalous --
///      either the Chainlink feed was manipulated (unlikely) or the TWAP
///      is stale/manipulated. Either way, revert until governance investigates.
uint256 public constant MAX_DEVIATION_BPS = 500; // 5%

function getValidatedPrice() external view returns (uint256 price) {
    uint256 chainlinkPrice = chainlinkFeed.getPrice();
    uint256 twapPrice      = twap.getTWAP();

    uint256 deviation;
    if (chainlinkPrice >= twapPrice) {
        deviation = ((chainlinkPrice - twapPrice) * 10_000) / twapPrice;
    } else {
        deviation = ((twapPrice - chainlinkPrice) * 10_000) / chainlinkPrice;
    }

    if (deviation > MAX_DEVIATION_BPS) {
        revert OracleDeviationExceeded(chainlinkPrice, twapPrice, deviation);
    }

    return chainlinkPrice; // Use Chainlink as canonical; TWAP was the sanity check
}
```

---

## Common Mistakes

### Mistake 1: No Staleness Check

```solidity
// Wrong: uses whatever price is stored, regardless of age
function getPrice() external view returns (uint256) {
    (, int256 answer, , , ) = feed.latestRoundData();
    return uint256(answer);
}

// Correct: validate updatedAt against maxStaleness
function getPrice() external view returns (uint256) {
    (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
    if (block.timestamp - updatedAt > maxStaleness) revert StalePrice(updatedAt, maxStaleness);
    return uint256(answer);
}
```

### Mistake 2: Ignoring `answeredInRound`

```solidity
// Wrong: does not verify the round has an answer
(uint80 roundId, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();

// Correct: answeredInRound must be >= roundId
(uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) =
    feed.latestRoundData();
if (answeredInRound < roundId) revert IncompleteRound(answeredInRound, roundId);
```

An incomplete round (where `answeredInRound < roundId`) indicates the aggregator started a new round but no answer has been posted yet. Consuming the answer from the previous round without this check means using a potentially outdated price in a new round context.

### Mistake 3: Using `latestAnswer()` Instead of `latestRoundData()`

`latestAnswer()` is deprecated and returns only the price with no round, timestamp, or completeness information. It cannot be validated for staleness or completeness.

```solidity
// Wrong: deprecated, no staleness or completeness data
int256 price = feed.latestAnswer();

// Correct: full round data with validation
(uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) =
    feed.latestRoundData();
```

### Mistake 4: No L2 Sequencer Check

Any Chainlink consumption on Arbitrum, Optimism, or Base that omits the sequencer uptime check will accept stale prices after a sequencer outage. See the L2 section above.

### Mistake 5: Maxstaleness Set to Feed's Deviation Threshold Window

The staleness window should reference the heartbeat, not the deviation threshold. A feed with a 1% deviation threshold and a 24-hour heartbeat may not update for 23 hours if the price is stable. Setting `maxStaleness` to 1 hour would cause spurious reverts during stable market conditions.

```
maxStaleness = heartbeat * 1.1  // 10% buffer above heartbeat
```

### Mistake 6: TWAP Window Below 30 Minutes

A TWAP window shorter than 30 minutes is manipulable at plausible cost on most pools. Manipulation cost scales linearly with the window.

### Mistake 7: TWAP on Illiquid Pool

A $500K TVL pool can be manipulated for a fraction of the cost of a $50M pool. Always verify that the pool's liquidity is sufficient before relying on its TWAP. Use `hasEnoughHistory()` and independently verify TVL via an off-chain oracle or hardcode a minimum pool depth check.

### Mistake 8: Not Normalizing Decimals Before Arithmetic

Chainlink returns prices in feed-specific decimals (usually 8 for USD pairs). Using raw values in arithmetic with `1e18`-scaled token amounts produces silent precision errors or extreme under/over-valuation.

```solidity
// Wrong: 8-decimal price compared directly to 18-decimal token amount
uint256 collateralValue = (tokenAmount * rawPrice);  // Off by 1e10

// Correct: normalize to 18 decimals first
uint256 normalizedPrice = rawPrice * 1e10; // 8 -> 18 decimals
uint256 collateralValue = (tokenAmount * normalizedPrice) / 1e18;
```

---

## Audit Checklist

- [ ] `answer` checked for `> 0` before use.
- [ ] `answeredInRound >= roundId` checked.
- [ ] `updatedAt` checked against `block.timestamp - maxStaleness`.
- [ ] `maxStaleness` set to the feed's heartbeat plus a buffer (not the deviation threshold).
- [ ] On L2: Sequencer Uptime Feed consumed before any price feed.
- [ ] On L2: Grace period (3600s) enforced after sequencer restart.
- [ ] Chainlink feed decimals retrieved and used for normalization.
- [ ] TWAP window is at least 1800 seconds (30 minutes).
- [ ] TWAP pool cardinality is sufficient for the window; `hasEnoughHistory()` verified at deployment.
- [ ] Pyth: fee paid via `getUpdateFee`, not hardcoded.
- [ ] Pyth: `getPriceNoOlderThan` used, not `getPrice` (which may return an arbitrarily old price).
- [ ] Pyth: exponent sign handled correctly; negative exponent expected for USD pairs.
- [ ] Multi-oracle deviation check implemented for high-value protocols.
- [ ] `latestAnswer()` is not used anywhere.
- [ ] Fallback or circuit breaker defined for oracle failure.

---

## Quick Reference

| Oracle | Gas cost | Latency | Manipulation resistance | Best for |
|---|---|---|---|---|
| Chainlink push | ~2,100 gas (SLOAD) | 1s - 24h | High (external operators) | Mainnet majors |
| Pyth pull | ~50,000 gas (update) | Sub-second | High (signed attestations) | High-freq / cross-chain |
| Uniswap v3 TWAP | ~10,000 gas | 30min+ | Window-dependent | On-chain derivation |
| Spot price | ~3,000 gas | Instant | None | Never for critical paths |
