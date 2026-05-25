# Aegis

**Encoded discipline for onchain development.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](.claude-plugin/plugin.json)
[![Monolith Research](https://img.shields.io/badge/Monolith-Blockchain%20Research%20Vol.%203-black.svg)](https://monolithsystematic.com/research)
[![Install](https://img.shields.io/badge/claude%20plugin%20install-aegis-5C4EE5.svg)](#installation)

Aegis is a Claude Code plugin purpose-built for smart contract and onchain development. Security review, gas accounting, DeFi economic reasoning, and protocol design patterns are first-class primitives invoked at the point of authorship. Every component is calibrated against production-grade codebases before release.

Part of the **Monolith Blockchain Research** series, Vol. 3. Companion to [ECC](https://github.com/affaan-m/ECC).

---

## Installation

### Via Claude Code Plugin Manager

```bash
claude plugin install aegis
```

### Manual Installation

Clone the repository into your Claude Code plugins directory:

```bash
git clone https://github.com/aryasomu/aegis ~/.claude/plugins/aegis
```

Then register it in your project's `.claude/settings.json`:

```json
{
  "plugins": [
    "~/.claude/plugins/aegis"
  ]
}
```

Restart Claude Code to load the plugin.

---

## Components

Aegis v0.1 ships exactly 15 components across four types. The component count is a hard constraint for this version.

### Agents

Agents are invoked automatically or on demand. They operate with full tool access and produce structured output.

| Agent | Description |
|---|---|
| `solidity-reviewer` | Line-by-line Solidity review for correctness, upgrade safety, access control, and invariant preservation. Invoked after any contract is written or modified. |
| `audit-finder` | Identifies vulnerability classes (reentrancy, oracle manipulation, flash loan vectors, access control misconfiguration) against indexed pattern libraries. |
| `gas-optimizer` | Profiles gas consumption, identifies inefficient patterns (storage reads in loops, suboptimal packing), and proposes refactors with quantified savings. |
| `defi-economist` | Evaluates economic security: incentive alignment, liquidity assumptions, fee sustainability, MEV exposure, and liquidation mechanics. |

### Skills

Skills are invocable knowledge modules. Each is self-contained and independently addressable.

| Skill | Description |
|---|---|
| `solidity-patterns` | Canonical Solidity design patterns: checks-effects-interactions, pull payment, proxy upgrade patterns (Transparent, UUPS, Beacon), factory patterns, storage layout discipline. |
| `foundry-workflow` | Foundry project lifecycle: forge init, fuzz configuration, invariant test harnesses, snapshot workflows, and deployment scripting with `forge script`. |
| `evm-security` | EVM-level security primitives: call depth limits, delegatecall hazards, storage collision in proxies, assembly safety, signature malleability, low-level call return values. |
| `gas-optimization` | Gas reduction techniques: storage packing, `uint256` preference, `unchecked` arithmetic scoping, calldata vs. memory, custom errors, loop unrolling heuristics. |
| `oracle-integration` | Oracle patterns: Chainlink Data Feeds (staleness checks, circuit breakers), TWAPs (Uniswap v2/v3), push vs. pull oracles, multi-source aggregation, manipulation resistance. |
| `erc-standards` | Canonical ERC implementations and deviation risks: ERC-20 (fee-on-transfer, rebasing), ERC-721 (reentrancy via `onERC721Received`), ERC-4626, ERC-2612, EIP-712. |
| `amm-orderbook-design` | AMM and orderbook protocol design: constant product and concentrated liquidity mechanics, tick math, position management, hybrid architectures, perp funding rate mechanics. |

### Rules

Rules are always-on session constraints. They are not invocable; they operate as standing instructions in every session.

| Rule | Description |
|---|---|
| `smart-contract-security` | Enforces a non-negotiable security checklist on all Solidity writes: reentrancy guards, access control on privileged functions, input validation, no `tx.origin` for authorization, mandatory event emission. |
| `defi-testing` | Enforces testing discipline: fuzz tests for arithmetic-heavy functions, invariant tests for stateful contracts, integration tests against forked mainnet state, no mocking of external protocol interfaces. |

### Commands

Commands are user-invocable slash commands.

| Command | Description |
|---|---|
| `/audit` | Full security pass: runs `audit-finder` against modified contracts, cross-references with `evm-security` and `solidity-patterns`, and produces a findings report with severity classification. |
| `/gas-snapshot` | Runs `forge snapshot`, diffs against the baseline, invokes `gas-optimizer` on regressions, and reports net gas delta with a function-level breakdown. |

---

## Quick Start

After installation, open any Solidity project in Claude Code. The `smart-contract-security` and `defi-testing` rules activate immediately in every session.

To run a full audit of your modified contracts:

```
/audit
```

To profile gas and identify regressions after a change:

```
/gas-snapshot
```

To invoke an agent directly, reference it by name in your prompt:

```
Use solidity-reviewer on src/Vault.sol
```

To load a skill for a targeted task:

```
Use the oracle-integration skill to review my Chainlink feed implementation in src/PriceFeed.sol
```

---

## Demo

`examples/toy-vault/` contains a minimal ERC-4626 vault with three intentional defects. Running `/audit --target src/ToyVault.sol` from that directory produces the following:

```
/audit complete.

Report:    audit-reports/2026-05-24-audit-ToyVault.md
Findings:  4 P0  |  3 P1  |  3 P2  |  3 P3
Gas:       1 regression
Tests:     PASS (6/6)

ACTION REQUIRED: This codebase has blocking findings. Do not deploy until
all P0 and P1 findings are resolved.
```

Top findings surfaced:

| Priority | Finding | Source |
|---|---|---|
| P0 | ERC-4626 share inflation -- missing virtual shares | Aderyn, audit-finder |
| P0 | Unprotected oracle replacement (`setOracle`) | Slither, Aderyn |
| P0 | Unprotected pause controls (permanent fund lock) | Slither, Aderyn |
| P1 | Chainlink staleness and round completeness unchecked | Aderyn, audit-finder |
| GAS | Storage layout: 6 slots where 4 suffice (~4,200 gas/call saved) | gas-optimizer |

The audit-finder agent identified all three planted defects plus four additional findings from independent pattern analysis, including a CEI violation via ERC-777 callback in `redeem()` and unchecked `transfer` return values throughout. The toy-vault README documents the expected output in full.

---

## Research Context

Aegis is the third volume in the **Monolith Blockchain Research** series, produced by [Monolith Systematic LLC](https://monolithsystematic.com/research).

**Monolith Systematic LLC** is a quantitative research firm specializing in systematic onchain markets and verifiable financial infrastructure. The firm's research division produces formal treatments of DeFi protocol mechanics, EVM execution economics, and the intersection of cryptographic verification with institutional market structure. Monolith Blockchain Research volumes are applied outputs of that program: each volume encodes a body of analytical work into tooling that practitioners can use directly.

The Blockchain Research series:

| Volume | Title | Status |
|---|---|---|
| Vol. 1 | Quantitative DeFi research infrastructure | Released |
| Vol. 2 | Systematic signal generation for onchain markets | Released |
| Vol. 3 | Aegis -- encoded discipline for onchain development | This repository |

Aegis inherits structural conventions from [ECC](https://github.com/affaan-m/ECC) by Affaan Mustafa. Every component is calibrated against the Vela Exchange codebase (SSRN 6579199) before release. The `amm-orderbook-design` skill draws directly on the Vela architecture: optimistic ZK proving, Delta elimination for latency reduction, and the private L3 market data feed authentication model.

---

## Contributing

Contributions are welcome and held to the same standard as Monolith Systematic research publications. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

The short version: every component must be dogfooded on the Vela Exchange codebase, must not exceed the 15-component cap, must contain no em dashes, and must maintain the institutional register of the project.

---

## License

[MIT](LICENSE) -- Copyright 2026 Arya Somu, Monolith Systematic LLC.
