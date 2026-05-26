---
name: aegis-erc-standards
description: Interface reference, common pitfalls, and audit checklists for ERC-20 (including FoT and rebasing), ERC-721, ERC-1155, ERC-4626 (including share inflation and donation attacks), and ERC-4337 (account abstraction).
origin: Aegis
tools:
  - Read
  - Grep
  - Glob
---

# ERC Standards

Reference for the five ERC standards most commonly implemented or integrated in DeFi protocols. Each entry covers the canonical interface, deviations and edge cases that break integrations, and an audit checklist.

## When to Use

- Implementing a new ERC-compliant token or vault contract.
- Auditing a contract that claims to implement an ERC standard.
- Integrating a protocol with an unknown ERC-20 token.
- Reviewing ERC-4626 vault share accounting.

## Scope Boundaries

This skill covers the standards themselves and their common failure modes. It does not cover:
- Gas optimization of token operations (see `gas-optimization`)
- Reentrancy in token callbacks (see `evm-security`)
- Oracle integration for token pricing (see `oracle-integration`)

---

## ERC-20

### Canonical Interface

```solidity
interface IERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply()                                          external view returns (uint256);
    function balanceOf(address account)                             external view returns (uint256);
    function transfer(address to, uint256 amount)                   external returns (bool);
    function allowance(address owner, address spender)              external view returns (uint256);
    function approve(address spender, uint256 amount)               external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
```

The standard specifies that `transfer`, `approve`, and `transferFrom` MUST return a `bool`. In practice, many deployed tokens (notably USDT on Ethereum mainnet) return nothing, causing a call expecting a return value to revert. Use `SafeERC20` for all token interactions.

### Deviations and Edge Cases

**Non-returning transfer (USDT pattern).** The token `transfer` function does not return a value. A caller that expects `bool` and uses `abi.decode` will revert. `SafeERC20.safeTransfer` handles this by checking the return data length before decoding.

```solidity
// Breaks on USDT and other non-returning tokens
bool success = IERC20(token).transfer(to, amount);

// Safe on all ERC-20 tokens
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
using SafeERC20 for IERC20;
IERC20(token).safeTransfer(to, amount);
```

**Fee-on-transfer (FoT) tokens.** `transferFrom(from, to, amount)` delivers less than `amount` to `to` because the token contract deducts a fee. The `amount` parameter describes the debit from `from`, not the credit to `to`.

```solidity
// Wrong: credits stated amount, not received amount
function deposit(address token, uint256 amount) external {
    IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    balances[msg.sender] += amount; // Overstated if FoT token
}

// Correct: measure the balance delta
function deposit(address token, uint256 amount) external {
    uint256 before = IERC20(token).balanceOf(address(this));
    IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    uint256 received = IERC20(token).balanceOf(address(this)) - before;
    balances[msg.sender] += received;
}
```

**Rebasing tokens (stETH, aTokens).** Rebasing tokens change `balanceOf` without emitting a `Transfer` event. A protocol that stores user balances at deposit time and uses them at withdrawal will be out of sync with the actual token balance. Two patterns exist:

- **Shares-based accounting** (preferred): convert the deposited token amount to an internal share amount at deposit time, using the rebase ratio. On withdrawal, convert shares back to tokens at the current ratio. This is what Lido's `stETH` does internally with `wstETH`.
- **Snapshot accounting**: take a snapshot of the balance at each interaction and compute deltas. More complex; prone to race conditions.

```solidity
// Shares-based accounting for a rebasing token
uint256 public totalShares;
mapping(address => uint256) public sharesOf;

function deposit(uint256 amount) external {
    uint256 tokenBalance = rebasingToken.balanceOf(address(this));
    uint256 sharesToMint;
    if (totalShares == 0 || tokenBalance == 0) {
        sharesToMint = amount;
    } else {
        sharesToMint = (amount * totalShares) / tokenBalance;
    }
    rebasingToken.safeTransferFrom(msg.sender, address(this), amount);
    sharesOf[msg.sender] += sharesToMint;
    totalShares += sharesToMint;
}

function tokensOf(address account) public view returns (uint256) {
    if (totalShares == 0) return 0;
    return (sharesOf[account] * rebasingToken.balanceOf(address(this))) / totalShares;
}
```

**Approval race condition.** Changing a non-zero allowance to another non-zero value with `approve` has a known race condition (see `evm-security`, SWC-114). Integrators should use `increaseAllowance` / `decreaseAllowance` where the token supports them, or the EIP-2612 `permit` pattern.

**EIP-2612 Permit.** Many modern ERC-20 tokens extend the standard with `permit`, which allows setting an allowance via a signed message without a prior `approve` transaction. Integrators should check for permit support and use it to reduce user transaction count.

```solidity
function depositWithPermit(
    uint256 amount,
    uint256 deadline,
    uint8 v, bytes32 r, bytes32 s
) external {
    IERC20Permit(token).permit(msg.sender, address(this), amount, deadline, v, r, s);
    IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    balances[msg.sender] += amount;
}
```

### ERC-20 Audit Checklist

- [ ] All token transfers use `SafeERC20` (`safeTransfer`, `safeTransferFrom`).
- [ ] Deposited amounts are verified via balance delta, not the `amount` parameter.
- [ ] Rebasing tokens are handled with shares-based accounting or explicitly rejected.
- [ ] `approve` race condition is mitigated or documented as accepted.
- [ ] `transfer` to `address(0)` is guarded (burns must be explicit).
- [ ] `transferFrom` with `allowance == type(uint256).max` skips decrement (gas optimization; verify intentional).
- [ ] Events are emitted on every state change.
- [ ] `totalSupply` is consistent with sum of all `balanceOf` values (no hidden minting).

---

## ERC-721

### Canonical Interface

```solidity
interface IERC721 {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function balanceOf(address owner)                               external view returns (uint256);
    function ownerOf(uint256 tokenId)                               external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId)                   external;
    function setApprovalForAll(address operator, bool approved)     external;
    function getApproved(uint256 tokenId)                           external view returns (address);
    function isApprovedForAll(address owner, address operator)      external view returns (bool);
}

interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}
```

### Deviations and Edge Cases

**Reentrancy via `safeTransferFrom`.** `safeTransferFrom` calls `onERC721Received` on the recipient contract. If the recipient is a malicious contract, it can reenter the caller during this callback. Apply CEI before any `safeTransferFrom` call.

```solidity
// Wrong: state updated after callback opportunity
function sell(uint256 tokenId) external {
    address buyer = pendingBuyer[tokenId];
    nft.safeTransferFrom(address(this), buyer, tokenId); // Callback here
    delete pendingBuyer[tokenId]; // Too late
}

// Correct: clear state before transfer
function sell(uint256 tokenId) external {
    address buyer = pendingBuyer[tokenId];
    delete pendingBuyer[tokenId]; // Effect before interaction
    nft.safeTransferFrom(address(this), buyer, tokenId);
}
```

**`transferFrom` vs `safeTransferFrom`.** `transferFrom` does not call `onERC721Received`. If the recipient is a contract that does not implement `IERC721Receiver`, the token is permanently locked. Use `safeTransferFrom` when the recipient address could be a contract; use `transferFrom` only when the recipient is a known EOA or when the callback check is deliberately bypassed (e.g., gas optimization in a known-safe internal transfer).

**`ownerOf` reverts on non-existent tokenId.** The standard specifies that `ownerOf` MUST revert for non-existent tokens. Do not use `ownerOf` in a try/catch to check existence; use `_exists` (internal OpenZeppelin helper) or check before calling.

**`approve` vs `setApprovalForAll`.** `approve` grants permission for a single token. `setApprovalForAll` grants permission for all tokens owned by the caller, now and in the future. A compromised or malicious operator with `setApprovalForAll` can drain all NFTs. Audit uses of `setApprovalForAll` in protocol code.

**Metadata extension is optional.** `IERC721Metadata` (`name`, `symbol`, `tokenURI`) is an extension. A contract may implement `IERC721` without `IERC721Metadata`. Do not assume metadata functions exist on an unknown ERC-721 contract.

### ERC-721 Audit Checklist

- [ ] `safeTransferFrom` is used for transfers to unknown addresses; reentrancy guard applied.
- [ ] `onERC721Received` return value checked to equal `IERC721Receiver.onERC721Received.selector`.
- [ ] State cleared before any `safeTransferFrom` call (CEI enforced).
- [ ] `ownerOf` calls are guarded against non-existent tokens.
- [ ] `setApprovalForAll` usage is scoped and revocable.
- [ ] `tokenId` enumeration does not rely on sequential IDs if the contract uses non-sequential minting.
- [ ] `Transfer` events are emitted on mint (from `address(0)`) and burn (to `address(0)`).

---

## ERC-1155

### Canonical Interface

```solidity
interface IERC1155 {
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);

    function balanceOf(address account, uint256 id)                 external view returns (uint256);
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory);
    function setApprovalForAll(address operator, bool approved)     external;
    function isApprovedForAll(address account, address operator)    external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external;
}

interface IERC1155Receiver {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data) external returns (bytes4);
    function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external returns (bytes4);
}
```

### Deviations and Edge Cases

**Reentrancy via `onERC1155Received`.** Like ERC-721, ERC-1155 calls `onERC1155Received` on the recipient contract during transfer. This is a reentrancy vector. Apply CEI and `nonReentrant` on functions that transfer ERC-1155 tokens to caller-supplied addresses.

**Batch transfers: length mismatch.** `safeBatchTransferFrom` takes parallel `ids` and `amounts` arrays. If the arrays are different lengths, the behavior is undefined in some implementations. The standard requires them to be the same length; callers must validate.

```solidity
// Guard against mismatched arrays in protocol code that constructs batch calls
function batchDeposit(uint256[] calldata ids, uint256[] calldata amounts) external {
    if (ids.length != amounts.length) revert LengthMismatch();
    token1155.safeBatchTransferFrom(msg.sender, address(this), ids, amounts, "");
}
```

**ID space is not standardized.** ERC-1155 does not define what token IDs represent. Some implementations use IDs as sequential integers; others use IDs as packed bit fields encoding type and serial number. Do not assume an ID scheme without consulting the specific implementation.

**`setApprovalForAll` scope.** As with ERC-721, `setApprovalForAll` grants the operator permission over all token IDs. There is no per-ID approval mechanism in ERC-1155. Operator access must be carefully scoped.

**Fungibility is per-ID.** Within a single ID, all tokens are fungible. Across IDs, tokens are distinct. A contract that treats different IDs as equivalent will produce incorrect accounting.

### ERC-1155 Audit Checklist

- [ ] `onERC1155Received` and `onERC1155BatchReceived` return values checked against their respective selectors.
- [ ] Reentrancy guard applied to all functions calling `safeTransferFrom` to unknown addresses.
- [ ] Batch operations validate `ids.length == amounts.length` before use.
- [ ] `setApprovalForAll` is revocable and limited to necessary operators.
- [ ] `TransferSingle` and `TransferBatch` events match actual token movements.
- [ ] `URI` event emitted when a token URI changes.

---

## ERC-4626

### Canonical Interface

ERC-4626 standardizes yield-bearing vaults. A vault accepts deposits of an `asset` (ERC-20) and issues `shares` (itself, an ERC-20). All share-to-asset conversions use the following relationship: `assets = shares * totalAssets / totalSupply`.

```solidity
interface IERC4626 is IERC20 {
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);

    function asset()                                                external view returns (address);
    function totalAssets()                                          external view returns (uint256);
    function convertToShares(uint256 assets)                        external view returns (uint256);
    function convertToAssets(uint256 shares)                        external view returns (uint256);
    function maxDeposit(address receiver)                           external view returns (uint256);
    function previewDeposit(uint256 assets)                         external view returns (uint256);
    function deposit(uint256 assets, address receiver)              external returns (uint256 shares);
    function maxMint(address receiver)                              external view returns (uint256);
    function previewMint(uint256 shares)                            external view returns (uint256);
    function mint(uint256 shares, address receiver)                 external returns (uint256 assets);
    function maxWithdraw(address owner)                             external view returns (uint256);
    function previewWithdraw(uint256 assets)                        external view returns (uint256);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function maxRedeem(address owner)                               external view returns (uint256);
    function previewRedeem(uint256 shares)                          external view returns (uint256);
    function redeem(uint256 shares, address receiver, address owner)   external returns (uint256 assets);
}
```

### Rounding Semantics

The standard defines rounding direction for each function to protect the vault from principal leakage:

| Function | Rounding | Protects |
|---|---|---|
| `convertToShares` | Down | Vault (depositor gets fewer shares) |
| `convertToAssets` | Down | Vault (redeemer gets fewer assets) |
| `previewDeposit` | Down | Vault |
| `previewMint` | Up | Depositor (caller pays at most this) |
| `previewWithdraw` | Up | Vault (caller burns at least this many shares) |
| `previewRedeem` | Down | Vault |

Incorrect rounding direction is an exploitable vulnerability. A vault that rounds shares up on deposit allows an attacker to extract small amounts of value on every deposit.

### Share Inflation Attack (First Depositor)

**Mechanism.** When `totalSupply == 0` and `totalAssets == 0`, the share price is undefined. A malicious first depositor can:
1. Deposit 1 wei of assets to receive 1 share.
2. Donate a large amount of assets directly to the vault (bypassing `deposit`), inflating `totalAssets` without minting shares.
3. The share price is now `totalAssets / 1 = very large`.
4. A subsequent depositor's assets round down to 0 shares; their assets accrue to the attacker.

**Donation attack variant.** Even after multiple depositors exist, an attacker with a significant share position can donate assets to inflate the share price, causing small subsequent depositors to receive 0 shares and lose their assets.

**Mitigations:**

```solidity
// Mitigation 1: Virtual shares (OpenZeppelin ERC-4626 v5 default)
// Adds virtual offset to both numerator and denominator, making the
// share-to-asset ratio well-defined and manipulation-resistant even at zero supply.

uint8 private immutable _decimalsOffset; // Set to a positive value (e.g., 3) to increase offset

function _convertToShares(uint256 assets, Math.Rounding rounding)
    internal view virtual override returns (uint256)
{
    return assets.mulDiv(
        totalSupply() + 10 ** _decimalsOffset(),
        totalAssets() + 1,
        rounding
    );
}

function _convertToAssets(uint256 shares, Math.Rounding rounding)
    internal view virtual override returns (uint256)
{
    return shares.mulDiv(
        totalAssets() + 1,
        totalSupply() + 10 ** _decimalsOffset(),
        rounding
    );
}

// Mitigation 2: Internal asset accounting (ignore direct token donations)
uint256 private _totalTrackedAssets;

function deposit(uint256 assets, address receiver) public override returns (uint256 shares) {
    _totalTrackedAssets += assets;
    return super.deposit(assets, receiver);
}

function withdraw(uint256 assets, address receiver, address owner)
    public override returns (uint256 shares)
{
    _totalTrackedAssets -= assets;
    return super.withdraw(assets, receiver, owner);
}

function totalAssets() public view override returns (uint256) {
    return _totalTrackedAssets; // Donations are invisible
}

// Mitigation 3: Minimum initial deposit with dead shares
// Protocol mints dead shares to address(1) at deployment, establishing a
// non-zero totalSupply before any user interacts.
constructor() {
    _mint(address(1), 1000); // Dead shares; address(1) cannot redeem
    _deposit(address(this), address(1), MINIMUM_INITIAL_ASSETS, 1000);
}
```

### Fee-on-Transfer Asset Compatibility

If the vault's underlying asset is a FoT token, `totalAssets()` based on `balanceOf` will over-report assets (because the vault received less than deposited). Use the balance-delta pattern in `deposit` and track internally.

### ERC-4626 Deviations

**Non-standard `totalAssets`.** Some vaults include pending yield, claimable rewards, or illiquid positions in `totalAssets`. This inflates the share price and can be manipulated if yield is accrued in a single transaction. A vault that claims 1 year of yield in one block has its share price jump in that block.

**`maxDeposit` ignoring pauses.** A paused vault should return `maxDeposit == 0`. If a vault returns `type(uint256).max` from `maxDeposit` but reverts on `deposit`, integrators that check `maxDeposit` before depositing will be misled.

**Callback-based yield strategies.** Vaults that call out to strategies during `totalAssets()` are view functions that make external calls. This violates the typical read-only expectation for view functions and can cause unexpected behavior in contexts that assume view functions are pure.

### ERC-4626 Audit Checklist

- [ ] Rounding direction correct for all eight share/asset conversion functions.
- [ ] Share inflation attack mitigated: virtual shares, dead shares, or internal asset tracking.
- [ ] `totalAssets()` does not include unclaimable or illiquid values.
- [ ] `maxDeposit` / `maxWithdraw` / `maxMint` / `maxRedeem` return 0 when the vault is paused.
- [ ] `previewDeposit(previewWithdraw(assets)) <= assets` (round-trip invariant).
- [ ] FoT asset handling: balance delta used in deposit if asset is FoT.
- [ ] `Deposit` and `Withdraw` events emitted with all four fields.
- [ ] `asset()` returns a valid ERC-20 contract address.
- [ ] Reentrancy guard on `deposit`, `mint`, `withdraw`, `redeem`.
- [ ] `convertToShares` and `convertToAssets` are consistent with `preview*` functions.

---

## ERC-4337 (Account Abstraction)

### Overview

ERC-4337 implements account abstraction without requiring consensus layer changes. It introduces a new transaction type -- the `UserOperation` -- that is submitted to a dedicated mempool and processed by a permissioned bundler that aggregates and submits `UserOperations` to an `EntryPoint` contract on-chain.

The key actors:
- **EntryPoint**: The canonical singleton contract that processes all `UserOperations`. Audited and immutable once deployed.
- **Account** (Smart Contract Wallet): The user's wallet; implements `IAccount.validateUserOp`.
- **Paymaster** (optional): A contract that sponsors gas fees for specific `UserOperations`.
- **Bundler**: An off-chain node that collects `UserOperations` and submits them on-chain.

### Core Interface

```solidity
struct UserOperation {
    address sender;           // Smart contract wallet address
    uint256 nonce;
    bytes   initCode;         // Factory calldata for first-time wallet deployment
    bytes   callData;         // The actual call to execute
    uint256 callGasLimit;
    uint256 verificationGasLimit;
    uint256 preVerificationGas;
    uint256 maxFeePerGas;
    uint256 maxPriorityFeePerGas;
    bytes   paymasterAndData; // Optional: paymaster address + data
    bytes   signature;
}

interface IAccount {
    /// @notice Validate the UserOperation's signature and nonce.
    /// @return validationData Packed: sigFailed (1 bit) | validUntil (48 bits) | validAfter (48 bits)
    function validateUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData);
}

interface IPaymaster {
    function validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 validationData);

    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost
    ) external;
}
```

### Common Pitfalls

**`validateUserOp` calling external state.** During validation, the EntryPoint restricts `SLOAD` access to specific storage slots (the account's own storage and a few enumerated external slots). An `validateUserOp` that reads arbitrary external state will be rejected by a compliant bundler. All validation logic must operate on the account's own storage plus the `UserOperation` fields.

**Signature malleability in `validateUserOp`.** If `validateUserOp` accepts a malleable signature (one where the same signed message has two valid signatures), an attacker can replay a modified-signature operation. Use OpenZeppelin's `ECDSA.recover` which rejects malleable signatures, or implement EIP-712 structured signatures.

```solidity
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

function validateUserOp(
    UserOperation calldata userOp,
    bytes32 userOpHash,
    uint256 missingAccountFunds
) external override returns (uint256 validationData) {
    // userOpHash is computed by EntryPoint; do not recompute it
    address recovered = ECDSA.recover(
        ECDSA.toEthSignedMessageHash(userOpHash),
        userOp.signature
    );

    // Pack validationData: 0 = valid sig, 1 = invalid sig
    // validUntil and validAfter default to 0 (no time restriction)
    bool sigFailed = (recovered != owner);
    return sigFailed ? 1 : 0;
}
```

**Paymaster griefing.** A paymaster that does not validate the `UserOperation` content before sponsoring it will pay for arbitrary user operations. The paymaster's `validatePaymasterUserOp` must restrict which operations it sponsors (by caller, by callData prefix, by stake, etc.).

**`initCode` re-entrancy.** When a wallet is deployed for the first time, `initCode` contains the factory address and calldata. If the factory calls back into the EntryPoint or the account during deployment, it can interfere with the ongoing `handleOps` call. The EntryPoint is designed to prevent this; wallet factories must not make callbacks into the EntryPoint.

**Nonce management.** The EntryPoint tracks nonces per account in a 2D space: a `key` (192 bits) and a `sequence` (64 bits). The default nonce key is 0, producing sequential nonces. Parallel nonce keys allow concurrent non-sequential operations. Do not assume nonces are sequential if parallel keys are used.

**Gas estimation differs from execution.** `verificationGasLimit` covers `validateUserOp`; `callGasLimit` covers the actual call. Underestimating either causes the operation to revert at the bundler level (not on-chain). The preVerification gas accounts for bundler overhead. Rely on the EntryPoint's `simulateHandleOp` for accurate estimation; do not hardcode gas limits.

### ERC-4337 Audit Checklist

- [ ] `validateUserOp` does not access external state beyond the account's storage.
- [ ] `validateUserOp` uses non-malleable signature verification (OZ `ECDSA`).
- [ ] `validateUserOp` returns the correctly packed `validationData` (0 for valid, 1 for invalid; time bounds if applicable).
- [ ] Paymaster's `validatePaymasterUserOp` restricts sponsorship to intended operations.
- [ ] Paymaster's `postOp` handles all three `PostOpMode` values (`opSucceeded`, `opReverted`, `postOpReverted`).
- [ ] Factory (`initCode`) does not call back into EntryPoint during wallet deployment.
- [ ] Nonce scheme documented: sequential or parallel keys.
- [ ] Gas limits are not hardcoded; estimation uses `simulateHandleOp`.
- [ ] Wallet upgrade path (if upgradeable) is access-controlled and time-locked.
- [ ] `owner` change in the wallet emits an event and is protected by multi-sig or timelock.

---

## Quick Reference

| Standard | Key invariant | Most common integration failure |
|---|---|---|
| ERC-20 | `sum(balanceOf) == totalSupply` | Not using `SafeERC20`; ignoring FoT |
| ERC-721 | `ownerOf(id)` is unique and non-zero for minted tokens | Reentrancy via `onERC721Received` |
| ERC-1155 | `balanceOf(account, id)` consistent with transfers | Mismatched `ids` / `amounts` arrays |
| ERC-4626 | `totalAssets / totalSupply` monotonically increases without donations | Share inflation on first deposit |
| ERC-4337 | `validateUserOp` runs within storage access restrictions | External SLOAD in validation; rejected by bundler |
