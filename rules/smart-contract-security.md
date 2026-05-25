# Smart Contract Security

Mandatory constraints for every Solidity contract in this repository. These rules apply at authorship, at pre-merge review, and at pre-deployment. No exception requires approval from the protocol's security council and must be documented in the relevant pull request.

---

## Static Analysis

**Slither must pass with no High or Critical findings before any merge.**

Run:
```bash
slither . --json .audit/slither-report.json
```

A finding classified as `High` or `Critical` by Slither's impact field blocks the merge. Medium findings must be triaged and either fixed or acknowledged with a written justification in the pull request. Informational findings are recorded but do not block.

A Slither run that errors due to compilation failure is treated as a Critical finding. Fix the compilation error first.

**Aderyn must pass with no High findings before any merge.**

Run:
```bash
aderyn --output .audit/aderyn-report.json .
```

Aderyn High findings block the merge. Low findings are triaged equivalently to Slither Mediums.

Do not suppress findings with `// slither-disable` or equivalent annotations without a written justification committed alongside the suppression. Suppressions without justification are treated as unresolved findings.

---

## Test Requirements

**Fuzz tests must exist for every external function with non-trivial state changes.**

A function has non-trivial state changes if it modifies any storage variable that affects: token balances, position sizes, protocol parameters, access control assignments, or oracle configuration. Pure computations and view functions are exempt.

Each fuzz test must:
- Use `bound` to constrain inputs to the realistic operational range.
- Assert at least one meaningful property of the output. A fuzz test with no assertion is not a test.
- Run a minimum of 256 iterations (configured in `foundry.toml` under `fuzz_runs`). High-value contracts require 1024 iterations minimum; see `defi-testing` rule for thresholds.

**Invariant tests must exist for every protocol-level invariant.**

A protocol-level invariant is any property that must hold across all possible sequences of valid user interactions. Examples:
- `totalSupply == sum of all balances`
- `totalAssets >= sum of all user claims`
- `no position is simultaneously long and short`

Each invariant test must use a handler contract that constrains the fuzzer to valid operation sequences. An invariant test without a handler that achieves at least a 50% call success rate (measured by `forge test --verbosity 4`) is considered misconfigured and must be corrected before merge.

---

## External Call Discipline

**No unchecked external calls.**

Every `call`, `delegatecall`, `staticcall`, `send`, and token transfer must have its return value checked and acted upon. Specifically:

- Low-level `call` returns `(bool success, bytes memory data)`. If `success` is false and the code proceeds as if the call succeeded, this is a blocking defect.
- ERC-20 `transfer` and `transferFrom` must use `SafeERC20` (`safeTransfer`, `safeTransferFrom`). Direct calls to `transfer` are prohibited.
- `send` is prohibited. Use `call{value: amount}("")` with return value check.
- `.transfer()` is prohibited. Use `call{value: amount}("")` with return value check.

**All external calls must follow Checks-Effects-Interactions (CEI).**

Within any function containing an external call:
1. All require / revert conditions are evaluated first (Checks).
2. All storage state updates are applied before any external call (Effects).
3. External calls occur last (Interactions).

A function that updates storage after an external call is a reentrancy vulnerability unless a `nonReentrant` guard is applied and the deviation from CEI is documented in a NatSpec `@dev` comment explaining why CEI cannot be satisfied structurally.

---

## Access Control

**Every privileged function must have an access control modifier.**

A function is privileged if it can: change protocol parameters, upgrade implementation addresses, pause or unpause the system, mint tokens beyond the initial supply, withdraw fees, modify oracle configuration, or change access control assignments. Every such function must have one of the following:

- `onlyOwner` (or equivalent single-role check)
- `onlyRole(ROLE_NAME)` from OpenZeppelin `AccessControl`
- A custom modifier whose body contains an explicit caller check

A function with no access modifier whose name implies privileged behavior (`setFee`, `pause`, `upgrade`, `withdrawEth`, `grantRole`) is a blocking defect.

**Two-step ownership transfer is required.**

Single-step `transferOwnership` is prohibited. The protocol must use `Ownable2Step` from OpenZeppelin or an equivalent pattern that requires the new owner to call `acceptOwnership` before the transfer completes.

If the protocol uses `AccessControl` rather than `Ownable`, the `DEFAULT_ADMIN_ROLE` must be held by a multi-signature wallet or timelock contract, not an EOA, on mainnet deployments.

**Role separation is required for high-risk roles.**

A single address must not simultaneously hold the roles of: upgrader, pauser, fee recipient, and oracle configurator. At minimum, the upgrader role must be distinct from all other roles and must require a timelock of at least 48 hours on mainnet.

---

## Pausability

**Safety-critical protocols must implement a pause mechanism.**

A protocol is safety-critical if a compromised or malfunctioning component (oracle failure, external protocol exploit, unexpected price movement) can cause irreversible loss of user funds. All lending protocols, vaults, and protocols with liquidation mechanics are safety-critical by definition.

Pause requirements:
- A `pause()` function callable by a designated guardian role (not the owner role, to allow rapid response).
- A `unpause()` function callable by the owner or a governance multisig with a higher threshold than the guardian.
- All state-mutating user functions must revert with a descriptive custom error when paused.
- The pause state must be queryable via a `paused()` view function.

Use `Pausable` from OpenZeppelin as the base implementation. Do not implement a custom pause mechanism unless the OpenZeppelin implementation has a documented incompatibility with the protocol's architecture.

---

## Pre-Merge Checklist

Before opening a pull request, the author must confirm all of the following:

- [ ] `slither .` produces no High or Critical findings, or all such findings have written justifications.
- [ ] `aderyn .` produces no High findings, or all such findings have written justifications.
- [ ] Every new or modified external function with non-trivial state changes has a corresponding fuzz test.
- [ ] Protocol-level invariants are covered by invariant tests with handlers.
- [ ] No `transfer()`, `send()`, or unchecked `call` return values are present.
- [ ] All external calls follow CEI, or deviations are guarded by `nonReentrant` and documented.
- [ ] Every privileged function has an access control modifier.
- [ ] `Ownable2Step` (or equivalent) is used for any ownership transfer.
- [ ] Pausability is implemented if the contract is safety-critical.
- [ ] `forge test` passes with zero failures.
- [ ] `forge build` produces no compiler errors and no warnings classified as High by the compiler.

---

## Pre-Deployment Checklist

Before deploying to mainnet, the deployer must confirm all of the following, in addition to the pre-merge checklist above:

- [ ] An external audit has been completed and all Critical and High findings are resolved.
- [ ] `forge snapshot` has been committed and the CI gas gate passes.
- [ ] All constructor arguments have been verified against the deployment parameters document.
- [ ] Proxy initialization: `_disableInitializers()` is called in the implementation constructor, and `initialize()` has been called exactly once on the proxy.
- [ ] The upgrader role is held by a timelock with at least 48 hours delay.
- [ ] The guardian (pauser) role is held by a multisig reachable within 30 minutes.
- [ ] Oracle feeds are verified to be live, with correct addresses and staleness windows confirmed against Chainlink documentation.
- [ ] Chainlink Sequencer Uptime Feed is configured if deployed on Arbitrum, Optimism, or Base.
- [ ] The deployment transaction has been reviewed by a second engineer who did not write the deployment script.
- [ ] A post-deployment verification script confirms all constructor and initialization parameters match the specification.
