---
name: aegis-evm-security
description: EVM vulnerability reference aligned with the SWC registry. Each entry covers explanation, vulnerable code, exploit scenario, and fix pattern for reentrancy, integer issues, unchecked calls, ordering dependencies, oracle manipulation, signatures, approval frontrunning, hook abuse, fee-on-transfer, and donation attacks.
origin: Aegis
tools:
  - Read
  - Grep
  - Glob
---

# EVM Security

Vulnerability reference for EVM smart contracts. Each entry follows the format: explanation, vulnerable code, exploit scenario, and fix. Cross-referenced with the Smart Contract Weakness Classification registry (swcregistry.io).

## When to Use

- Reviewing a contract for known vulnerability classes before or after audit.
- Identifying the correct fix pattern for a flagged vulnerability.
- Constructing a proof-of-concept exploit scenario in a test to confirm a finding.
- Writing security-aware code by referencing the fix patterns during authorship.

## Scope Boundaries

This skill covers known vulnerability classes and their canonical remediations. It does not cover:
- Gas profiling or optimization (see `gas-optimization`)
- Economic design vulnerabilities (see `defi-economist` agent)
- Static analysis tooling (see `audit-finder` agent)
- ERC standard deviations (see `erc-standards`)

---

## SWC-107: Reentrancy

**Explanation.** A reentrancy vulnerability occurs when a contract makes an external call before completing its own state updates, allowing the callee to re-enter the calling function (or a related function) and observe or modify inconsistent state. Three variants exist: single-function, cross-function, and cross-contract.

**Vulnerable code -- single-function:**

```solidity
contract Vault {
    mapping(address => uint256) public balances;

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount);
        // State not yet updated -- attacker re-enters here
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok);
        balances[msg.sender] -= amount; // Too late
    }
}
```

**Exploit scenario.** An attacker deploys a contract with a `receive()` function that calls `withdraw` again. When the vault sends ETH, execution transfers to the attacker's `receive()`. The attacker's balance has not been decremented yet, so the `require` passes. The attacker drains the vault recursively until its ETH balance is zero. Cost: one transaction.

**Vulnerable code -- cross-function:**

```solidity
contract Token {
    mapping(address => uint256) public balances;

    // Attacker re-enters transfer() during withdraw()
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok);
        balances[msg.sender] = 0;
    }

    function transfer(address to, uint256 amount) external {
        require(balances[msg.sender] >= amount);
        balances[msg.sender] -= amount;
        balances[to] += amount;
    }
}
```

**Exploit scenario.** During `withdraw`, before the balance is zeroed, the attacker re-enters `transfer` and moves their balance to a second address. After `withdraw` completes, the transferred balance is still intact -- the attacker has both the ETH and the token credit.

**Vulnerable code -- read-only reentrancy:**

```solidity
// Protocol A uses Protocol B's share price during a callback
contract ProtocolB {
    uint256 public totalSupply;
    uint256 public totalAssets;

    function redeem(uint256 shares) external {
        uint256 assets = (shares * totalAssets) / totalSupply;
        totalSupply -= shares; // Updated
        // totalAssets not yet updated -- price is transiently wrong
        token.safeTransfer(msg.sender, assets); // Callback opportunity
        totalAssets -= assets; // Updated after callback
    }

    function sharePrice() external view returns (uint256) {
        return (totalAssets * 1e18) / totalSupply;
    }
}
```

**Fix:**

```solidity
// Pattern 1: Checks-Effects-Interactions
function withdraw(uint256 amount) external {
    uint256 bal = balances[msg.sender];
    require(bal >= amount, InsufficientBalance());
    balances[msg.sender] = bal - amount; // Effect before interaction
    (bool ok,) = msg.sender.call{value: amount}("");
    require(ok, TransferFailed());
}

// Pattern 2: ReentrancyGuard (use when CEI cannot be satisfied structurally)
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract Vault is ReentrancyGuard {
    function withdraw(uint256 amount) external nonReentrant {
        // Order is less critical under the lock, but CEI still preferred
        balances[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, TransferFailed());
    }
}
```

---

## SWC-101: Integer Overflow and Underflow

**Explanation.** Prior to Solidity 0.8, arithmetic silently wraps on overflow and underflow. A `uint256` at its maximum value incremented by 1 wraps to 0. A `uint256` at 0 decremented by 1 wraps to `type(uint256).max`. Solidity 0.8+ reverts on overflow by default, but `unchecked` blocks restore wrap-around behavior.

**Vulnerable code (pre-0.8 pattern, or post-0.8 inside `unchecked`):**

```solidity
// Pre-0.8: silent wrap
function transfer(address to, uint256 amount) external {
    balances[msg.sender] -= amount; // Wraps if amount > balance
    balances[to] += amount;
}

// Post-0.8 but unchecked too broadly
function accumulateFees(uint256 fee) external {
    unchecked {
        totalFees += fee; // Safe if fee is bounded
        userBalance -= fee; // UNSAFE if userBalance < fee
    }
}
```

**Exploit scenario.** In the pre-0.8 example, an attacker with zero balance calls `transfer(recipient, 1)`. `balances[attacker]` underflows to `type(uint256).max`, and the attacker receives unlimited apparent credit. In the `unchecked` post-0.8 example, if `userBalance < fee`, the subtraction underflows to a large number.

**Fix:**

```solidity
// Post-0.8: default checked arithmetic -- no action needed for most cases.
// Use unchecked only for provably safe operations.

function accumulateFees(uint256 fee) external {
    require(userBalance >= fee, InsufficientBalance());
    unchecked {
        totalFees   += fee; // Safe: fee is bounded by userBalance
        userBalance -= fee; // Safe: check above guarantees no underflow
    }
}

// For pre-0.8 code: use OpenZeppelin SafeMath (legacy only)
import { SafeMath } from "@openzeppelin/contracts/utils/math/SafeMath.sol";
```

**Unchecked block discipline.** The safety argument for every expression inside an `unchecked` block must be stateable in one sentence. If it cannot, the block is not safe.

---

## SWC-104: Unchecked Call Return Value

**Explanation.** Low-level calls (`call`, `delegatecall`, `staticcall`, `send`) return a `bool` indicating success. Ignoring this return value and proceeding as if the call succeeded silently swallows failures. `.transfer()` and `.send()` forward only 2300 gas and revert or return false if the recipient is a contract with a non-trivial `receive()`.

**Vulnerable code:**

```solidity
function distributeFees(address[] calldata recipients, uint256 share) external {
    for (uint256 i; i < recipients.length; ++i) {
        // Return value ignored: if recipient is a contract that reverts, fee is lost
        recipients[i].call{value: share}("");
    }
}

function refund(address user, uint256 amount) external {
    user.transfer(amount); // Reverts if user is a contract with >2300 gas receive()
}
```

**Exploit scenario.** A malicious recipient deploys a contract that always reverts in `receive()`. The fee distribution loop silently fails for that recipient without affecting others -- in this case, the fee is permanently lost rather than distributed. In a pull-payment pattern with no retry mechanism, the recipient is effectively griefed.

**Fix:**

```solidity
// Check the return value on every low-level call
function distributeToRecipient(address recipient, uint256 amount) internal {
    (bool ok,) = recipient.call{value: amount}("");
    if (!ok) revert TransferFailed(recipient, amount);
}

// For ERC-20 tokens, use SafeERC20 which checks return values and handles
// non-standard tokens that return nothing
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract Distributor {
    using SafeERC20 for IERC20;

    function distribute(IERC20 token, address[] calldata recipients, uint256 share) external {
        for (uint256 i; i < recipients.length; ++i) {
            token.safeTransfer(recipients[i], share);
        }
    }
}
```

**Pull over push.** Where possible, implement a pull payment pattern: record what each recipient is owed and let them claim it rather than pushing it to them. This eliminates the failure-mode coupling between the distributor's success and the recipient's willingness to receive.

---

## SWC-114: Transaction Order Dependence (Frontrunning)

**Explanation.** The order of transactions in a block is determined by the block proposer, who can observe the mempool and reorder transactions for profit. Any protocol action whose profitability is observable before inclusion is vulnerable to frontrunning.

**Vulnerable code -- ERC-20 approval race:**

```solidity
// User approves 100 tokens, then calls approve(spender, 200) to increase
// Spender can frontrun the second approve to spend the first 100,
// then spend the new 200 after the second approve confirms: 300 total spent
function approve(address spender, uint256 amount) external returns (bool) {
    _allowances[msg.sender][spender] = amount;
    emit Approval(msg.sender, spender, amount);
    return true;
}
```

**Exploit scenario.** Alice approves Bob for 100 tokens. Alice then submits `approve(Bob, 200)`. Bob observes the pending transaction, frontruns it with `transferFrom(Alice, Bob, 100)`, draining the first allowance. Alice's transaction confirms, setting allowance to 200. Bob drains the second allowance. Net result: 300 tokens transferred against an intended maximum of 200.

**Vulnerable code -- on-chain order submission:**

```solidity
// Order visible in mempool; anyone can frontrun with a matching order
function submitOrder(uint256 price, uint256 size) external {
    orders.push(Order(msg.sender, price, size));
    _match();
}
```

**Fix:**

```solidity
// ERC-20: use increaseAllowance / decreaseAllowance instead of approve
function increaseAllowance(address spender, uint256 delta) external returns (bool) {
    _allowances[msg.sender][spender] += delta;
    emit Approval(msg.sender, spender, _allowances[msg.sender][spender]);
    return true;
}

// Or: require current allowance to equal expected before overwriting
function safeApprove(address spender, uint256 expected, uint256 newAmount) external {
    if (_allowances[msg.sender][spender] != expected) revert AllowanceMismatch();
    _allowances[msg.sender][spender] = newAmount;
}

// Order submission: commit-reveal to hide intent until committed
mapping(bytes32 => bool) public commitments;

function commitOrder(bytes32 commitment) external {
    commitments[commitment] = true;
}

function revealOrder(uint256 price, uint256 size, bytes32 salt) external {
    bytes32 commitment = keccak256(abi.encodePacked(msg.sender, price, size, salt));
    require(commitments[commitment], InvalidCommitment());
    delete commitments[commitment];
    orders.push(Order(msg.sender, price, size));
    _match();
}
```

---

## SWC-116: Block Timestamp Dependence

**Explanation.** `block.timestamp` is set by the block proposer and can be manipulated within a range (the Ethereum protocol allows a timestamp up to approximately 15 seconds into the future relative to the parent block). Protocols that use `block.timestamp` for randomness or as a precise timing mechanism are vulnerable to proposer manipulation.

**Vulnerable code:**

```solidity
// "Random" outcome determined by timestamp -- manipulable by proposer
function drawWinner() external {
    require(block.timestamp >= drawTime);
    uint256 winner = uint256(keccak256(abi.encodePacked(block.timestamp))) % participants.length;
    _payout(participants[winner]);
}

// Fee tier switching based on timestamp -- proposer can choose favorable tier
function getFeeRate() public view returns (uint256) {
    if (block.timestamp % 2 == 0) return lowFee;
    return highFee;
}
```

**Exploit scenario.** A block proposer participating in the lottery can select a timestamp that makes themselves the winner. For the fee tier example, a proposer processing a large trade can choose a timestamp in the low-fee range.

**Fix:**

```solidity
// For randomness: use a verifiable random function (Chainlink VRF)
// or a commit-reveal scheme where the seed is not known at commitment time.

// For timing: block.timestamp is acceptable for coarse timing (hours or days).
// Document the acceptable drift and ensure the protocol is not sensitive to
// a 15-second manipulation.

// Acceptable: vesting schedule with day-level granularity
uint256 public constant VESTING_DURATION = 365 days;

function vestedAmount() public view returns (uint256) {
    if (block.timestamp < vestStart) return 0;
    uint256 elapsed = block.timestamp - vestStart;
    if (elapsed >= VESTING_DURATION) return totalAllocation;
    return (totalAllocation * elapsed) / VESTING_DURATION;
}
```

---

## SWC-128: DoS with Block Gas Limit

**Explanation.** A loop that iterates over an unbounded array or mapping will eventually exceed the block gas limit as the collection grows. The transaction reverts, permanently bricking the function. This affects functions that iterate over all depositors, all open positions, or all pending rewards.

**Vulnerable code:**

```solidity
address[] public depositors;

// Fails when depositors.length is large enough that the loop exceeds gas limit
function distributeRewards() external {
    uint256 reward = totalRewards / depositors.length;
    for (uint256 i; i < depositors.length; ++i) {
        token.safeTransfer(depositors[i], reward);
    }
}
```

**Exploit scenario.** A griefing attacker makes many small deposits from different addresses, bloating `depositors`. When the legitimate reward distribution is called, the loop exceeds the block gas limit and reverts. Rewards cannot be distributed; the function is permanently broken (unless an owner can drain the array).

**Fix:**

```solidity
// Pattern 1: Pull payment -- let each depositor claim their own reward
mapping(address => uint256) public pendingRewards;

function accrueReward(address depositor, uint256 amount) internal {
    pendingRewards[depositor] += amount;
}

function claimReward() external {
    uint256 reward = pendingRewards[msg.sender];
    if (reward == 0) revert NoReward();
    pendingRewards[msg.sender] = 0;
    token.safeTransfer(msg.sender, reward);
}

// Pattern 2: Paginated distribution with a cursor
uint256 public distributionCursor;

function distributeRewardsBatch(uint256 batchSize) external {
    uint256 start = distributionCursor;
    uint256 end   = start + batchSize;
    if (end > depositors.length) end = depositors.length;
    uint256 reward = rewardPerDepositor;
    for (uint256 i = start; i < end; ++i) {
        token.safeTransfer(depositors[i], reward);
    }
    distributionCursor = end;
}
```

---

## Oracle Manipulation: Price Manipulation and Flash Loan Attacks

**Explanation.** Protocols that read prices from on-chain AMM spot prices (instantaneous reserve ratios) are vulnerable to price manipulation within a single transaction using flash loans. A flash loan allows an attacker to borrow a large amount of an asset, manipulate the pool price, exploit the protocol at the manipulated price, and repay the loan -- all atomically.

**Vulnerable code:**

```solidity
// Using Uniswap v2 spot price as a collateral oracle
function getPrice(address token) public view returns (uint256) {
    (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(pair).getReserves();
    return (uint256(reserve1) * 1e18) / uint256(reserve0);
}

function borrow(address collateral, uint256 amount) external {
    uint256 price = getPrice(collateral);
    uint256 collateralValue = (collateralBalance[msg.sender] * price) / 1e18;
    require(collateralValue >= amount * MIN_COLLATERAL_RATIO / 100);
    _disburseLoan(msg.sender, amount);
}
```

**Exploit scenario.** The attacker flash-borrows a large amount of `token0` from another pool. They dump it into the Uniswap v2 pair, crashing `reserve0` and inflating `reserve1` (the collateral price). The lending protocol reads the inflated price and approves an oversized loan. The attacker repays the flash loan, keeping the excess loan proceeds. All in one transaction.

**Fix:**

```solidity
// Option 1: Chainlink Data Feed with staleness check
import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

uint256 public constant MAX_STALENESS = 3600; // 1 hour

function getPrice(AggregatorV3Interface feed) public view returns (uint256) {
    (
        uint80 roundId,
        int256 answer,
        ,
        uint256 updatedAt,
        uint80 answeredInRound
    ) = feed.latestRoundData();

    if (answer <= 0) revert InvalidPrice();
    if (updatedAt < block.timestamp - MAX_STALENESS) revert StalePrice();
    if (answeredInRound < roundId) revert IncompleteRound();

    return uint256(answer);
}

// Option 2: Uniswap v3 TWAP (minimum 30-minute window)
function getTWAP(address pool, uint32 secondsAgo) public view returns (uint256 price) {
    require(secondsAgo >= 1800, WindowTooShort()); // 30-minute minimum
    uint32[] memory secondsAgos = new uint32[](2);
    secondsAgos[0] = secondsAgo;
    secondsAgos[1] = 0;
    (int56[] memory tickCumulatives,) = IUniswapV3Pool(pool).observe(secondsAgos);
    int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
    int24 arithmeticMeanTick = int24(tickDelta / int56(uint56(secondsAgo)));
    price = OracleLibrary.getQuoteAtTick(arithmeticMeanTick, 1e18, token0, token1);
}
```

---

## Signature Replay

**Explanation.** A valid signature produced by a private key for one message can be reused to authorize the same action multiple times, or to authorize the same action on a different chain, if the signed message does not include a nonce, expiry, or chain ID.

**Vulnerable code:**

```solidity
function executeWithSignature(
    address to,
    uint256 amount,
    bytes calldata sig
) external {
    bytes32 hash = keccak256(abi.encodePacked(to, amount));
    address signer = ECDSA.recover(hash, sig);
    require(signer == owner, InvalidSigner());
    token.safeTransfer(to, amount);
    // Nonce not incremented -- same sig works again
}
```

**Exploit scenario.** The owner signs a transfer of 1000 tokens to a recipient. The recipient submits the transaction. Because no nonce is consumed, the recipient submits the same transaction again. The owner's signature is replayed indefinitely until the contract is drained. On a cross-chain deployment, the same signature works on all chains where the contract is deployed.

**Fix:**

```solidity
import { ECDSA }      from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 }     from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract SecureVault is EIP712 {
    using ECDSA for bytes32;

    bytes32 private constant TRANSFER_TYPEHASH = keccak256(
        "Transfer(address to,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    mapping(address => uint256) public nonces;

    constructor() EIP712("SecureVault", "1") {}

    function executeWithSignature(
        address to,
        uint256 amount,
        uint256 deadline,
        bytes calldata sig
    ) external {
        if (block.timestamp > deadline) revert Expired();

        bytes32 structHash = keccak256(abi.encode(
            TRANSFER_TYPEHASH,
            to,
            amount,
            nonces[owner]++, // Consumed on use
            deadline
        ));
        address signer = _hashTypedDataV4(structHash).recover(sig);
        if (signer != owner) revert InvalidSigner();

        token.safeTransfer(to, amount);
    }
}
```

---

## EIP-712 Implementation Mistakes

**Explanation.** EIP-712 defines structured data signing for human-readable wallet prompts. Common implementation errors include: incorrect domain separator construction, incorrect struct hash encoding, missing fields in the type string, and failing to include the chain ID (enabling cross-chain replay).

**Vulnerable code:**

```solidity
// Mistake 1: struct hash includes a dynamic type without hashing it
bytes32 structHash = keccak256(abi.encode(
    PERMIT_TYPEHASH,
    owner,
    spender,
    value,
    nonce,
    deadline,
    someString // Dynamic types must be hashed: keccak256(bytes(someString))
));

// Mistake 2: type string uses wrong canonical form
// Wrong: space after comma in tuple
bytes32 constant TYPEHASH = keccak256("Permit(address owner, address spender,uint256 value)");
// Correct: no spaces after commas
bytes32 constant TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value)");

// Mistake 3: domain separator omits chainId -- replay across chains
bytes32 domainSeparator = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,string version)"),
    keccak256(bytes(name)),
    keccak256(bytes(version))
    // Missing: chainId, verifyingContract
));
```

**Fix:**

```solidity
// Use OpenZeppelin's EIP712 base contract, which handles domain separator
// construction correctly including chainId and verifyingContract.
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

// For dynamic types (string, bytes, arrays, structs), hash the encoded value:
bytes32 structHash = keccak256(abi.encode(
    TYPEHASH,
    owner,
    spender,
    value,
    nonce,
    deadline,
    keccak256(bytes(someString)) // Hash the dynamic type
));

// Type string format: no spaces after commas, exact Solidity type names
// Reference: https://eips.ethereum.org/EIPS/eip-712#definition-of-encodetype
bytes32 constant PERMIT_TYPEHASH = keccak256(
    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
);
```

---

## ERC-20 Approval Frontrunning

**Explanation.** Described under SWC-114 from the mechanism perspective. The ERC-20 `approve` function has a known race condition when changing a non-zero allowance to another non-zero allowance. A spender who observes the pending `approve` call can spend the existing allowance before the new one is set.

**Fix patterns (supplement to SWC-114):**

```solidity
// Pattern 1: Set to zero first, then to new value (two transactions)
token.approve(spender, 0);
token.approve(spender, newAmount);

// Pattern 2: Use OpenZeppelin SafeERC20's forceApprove
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
// forceApprove sets to 0 first on tokens that revert on non-zero -> non-zero approve

// Pattern 3: Use ERC-20 Permit (EIP-2612) to bypass approve entirely
// Permit signs off-chain; the spender submits a single transaction with the signature.
// No two-step race condition.
token.permit(owner, spender, amount, deadline, v, r, s);
token.transferFrom(owner, recipient, amount);
```

---

## ERC-777 Hook Abuse

**Explanation.** ERC-777 tokens implement `tokensReceived` and `tokensToSend` hooks that call into the recipient or sender before and after transfers. These hooks create reentrancy vectors that do not exist with plain ERC-20 tokens. Protocols that assume ERC-20 semantics (no callbacks) and accept ERC-777 tokens are vulnerable.

**Vulnerable code:**

```solidity
// Lending protocol that treats all tokens as ERC-20
function repay(address token, uint256 amount) external {
    IERC20(token).transferFrom(msg.sender, address(this), amount);
    // If token is ERC-777, tokensReceived fires BEFORE this line
    debt[msg.sender] -= amount; // State not yet updated during callback
}
```

**Exploit scenario.** The attacker uses an ERC-777 token as collateral. During the `repay` call, `tokensReceived` fires before `debt` is decremented. The attacker's hook re-enters `borrow`, observing a falsely inflated borrowing capacity. The attacker borrows additional funds, then the original repay completes and decrements the debt. Net result: extra funds extracted.

**Fix:**

```solidity
// Option 1: Explicit whitelist -- only allow tokens you have reviewed
mapping(address => bool) public supportedTokens;

function repay(address token, uint256 amount) external {
    require(supportedTokens[token], UnsupportedToken());
    // ...
}

// Option 2: Apply CEI and ReentrancyGuard regardless of token type
function repay(address token, uint256 amount) external nonReentrant {
    debt[msg.sender] -= amount;                                   // Effect first
    IERC20(token).transferFrom(msg.sender, address(this), amount); // Interaction last
}

// Option 3: Register as ERC-777 recipient with a guard hook
// Implement IERC777Recipient and revert in tokensReceived unless in an expected call
```

---

## Fee-on-Transfer (FoT) Token Compatibility

**Explanation.** Some ERC-20 tokens (and certain stablecoin configurations) deduct a fee from the transferred amount at the token contract level. `transferFrom(sender, recipient, 100e18)` delivers fewer than 100e18 tokens to the recipient. Protocols that credit the stated amount rather than the received amount create phantom balances that cannot be withdrawn, or enable exploitable accounting discrepancies.

**Vulnerable code:**

```solidity
function deposit(address token, uint256 amount) external {
    IERC20(token).transferFrom(msg.sender, address(this), amount);
    balances[msg.sender][token] += amount; // Credits stated amount, not received amount
}
```

**Exploit scenario.** A token with a 1% transfer fee is used. The user deposits 1000 tokens; the protocol receives 990. The user's balance is credited as 1000. The user withdraws 1000; the protocol attempts to transfer 1000 but only holds 990. The last user to withdraw cannot, and the protocol is short by 10 tokens per deposit cycle.

**Fix:**

```solidity
// Measure the balance before and after transfer to determine received amount
function deposit(address token, uint256 amount) external {
    uint256 balanceBefore = IERC20(token).balanceOf(address(this));
    IERC20(token).transferFrom(msg.sender, address(this), amount);
    uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
    if (received == 0) revert ZeroReceived();
    balances[msg.sender][token] += received; // Credit received amount, not stated amount
}
```

**Documentation requirement.** If the protocol explicitly does not support FoT tokens, document this in the NatSpec of every deposit function and in the protocol's public specification. Undocumented incompatibility is a vulnerability; documented incompatibility is a supported design choice.

---

## Donation Attacks on Share-Based Vaults

**Explanation.** Share-based vaults (following ERC-4626 or similar) compute share prices as `totalAssets / totalSupply`. An attacker can donate tokens directly to the vault contract (bypassing the deposit function) to artificially inflate `totalAssets` without minting shares. This inflates the share price and causes the next depositor to receive zero or nearly zero shares if their deposit is smaller than the donation.

**Vulnerable code:**

```solidity
contract Vault is ERC4626 {
    // totalAssets() reads the token balance directly
    function totalAssets() public view override returns (uint256) {
        return underlying.balanceOf(address(this));
    }

    // When totalSupply == 0 and totalAssets == 0:
    // First depositor receives shares = assets (correct)
    //
    // Attack: donate 1e18 tokens before first depositor.
    // totalAssets = 1e18, totalSupply = 0.
    // First depositor deposits 1e18, receives: (1e18 * 0) / 1e18 = 0 shares.
}
```

**Exploit scenario.** The attacker is the vault's first depositor. They deposit a minimal amount (1 wei) to receive 1 share. They then donate a large amount of tokens directly to the vault contract, inflating `totalAssets`. The share price is now `totalAssets / 1 = very large`. The next depositor deposits 1000 tokens; the share calculation rounds down to 0 shares. The depositor loses their funds, which accrue to the attacker's single share.

**Fix:**

```solidity
// Fix 1: Virtual shares (OpenZeppelin ERC-4626 default as of v5)
// Add a virtual offset to both totalAssets and totalShares so that the
// first-deposit ratio is always 1:1 regardless of donations.
function _convertToShares(uint256 assets, Math.Rounding rounding)
    internal
    view
    virtual
    override
    returns (uint256)
{
    return assets.mulDiv(
        totalSupply() + 10 ** _decimalsOffset(), // Virtual shares
        totalAssets() + 1,                        // Virtual assets
        rounding
    );
}

// Fix 2: Minimum initial deposit requirement
// Require the first depositor to deposit above a minimum to make
// the attack capital-intensive
uint256 public constant MINIMUM_FIRST_DEPOSIT = 1000e18;

function deposit(uint256 assets, address receiver)
    public
    override
    returns (uint256 shares)
{
    if (totalSupply() == 0 && assets < MINIMUM_FIRST_DEPOSIT) {
        revert InitialDepositTooSmall(assets, MINIMUM_FIRST_DEPOSIT);
    }
    return super.deposit(assets, receiver);
}

// Fix 3: Internal accounting (do not use balanceOf as the source of truth)
uint256 internal _totalAssets;

function deposit(uint256 assets, address receiver) public override returns (uint256 shares) {
    _totalAssets += assets; // Track internally; not affected by donations
    return super.deposit(assets, receiver);
}

function totalAssets() public view override returns (uint256) {
    return _totalAssets; // Ignores donated tokens
}
```

---

## Common Patterns

**Pattern: CEI is load-bearing, not stylistic.** Checks-Effects-Interactions is not a code style convention. It is a correctness invariant. Violations are not "technical debt"; they are vulnerabilities. Enforce it at authorship time.

**Pattern: Never assume token behavior.** ERC-20 has no enforcement of the standard. Tokens can: charge fees on transfer, return `false` instead of reverting, reenter on transfer, rebase balances, or pause at any time. Design around the weakest possible token behavior for every token you accept.

**Pattern: Sign with intent, not identity.** A signature proves the signer produced a specific message. It does not prove intent unless the message encodes the specific action, target, amount, nonce, deadline, and chain. Omit any field and the signature can be replayed in an unintended context.

**Pattern: Oracle reads are trust boundaries.** Every oracle consumption is a boundary where the protocol trusts an external party. Apply the same rigor to oracle validation as to user input validation: check for zero values, staleness, deviation bounds, and sequencer liveness on L2s.

---

## Quick Reference

| SWC | Title | Primary Fix |
|---|---|---|
| SWC-101 | Integer Overflow / Underflow | Use Solidity 0.8+; audit `unchecked` blocks |
| SWC-104 | Unchecked Call Return Value | Check `bool success`; use `SafeERC20` |
| SWC-107 | Reentrancy | CEI pattern; `nonReentrant` where CEI insufficient |
| SWC-114 | Transaction Order Dependence | Commit-reveal; `increaseAllowance` |
| SWC-116 | Timestamp Dependence | Acceptable for coarse timing; avoid for randomness |
| SWC-128 | DoS with Block Gas Limit | Pull payment; paginated iteration |
| N/A | Oracle Manipulation | Chainlink feeds; TWAP >= 30 min |
| N/A | Signature Replay | Nonce + deadline + chainId in signed message |
| N/A | EIP-712 Mistakes | Use OZ EIP712 base; hash dynamic types |
| N/A | ERC-20 Approval Race | Zero first; `safeApprove`; EIP-2612 permit |
| N/A | ERC-777 Hook Abuse | Whitelist tokens; `nonReentrant`; CEI |
| N/A | Fee-on-Transfer | Balance-delta accounting; document incompatibility |
| N/A | Donation Attack | Virtual shares (OZ v5); internal accounting |
