# Aegis

**Encoded discipline for onchain development.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-green.svg)](.claude-plugin/plugin.json)
[![Monolith Research](https://img.shields.io/badge/Monolith-Blockchain%20Research%20Vol.%203-black.svg)](https://monolithsystematic.com)
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

## Supported Harnesses

| Harness | Status | Entry Point |
|---|---|---|
| Claude Code | GA (primary) | Plugin manager or manual clone |
| Cursor | [BETA] | `.cursor/` tree + `.cursorrules` |
| Codex | [BETA] | `AGENTS.md` |

### Claude Code (GA, primary)

Install via the plugin manager or manual clone as described above. All 15 components are natively supported: agents auto-invoke on trigger conditions, slash commands (`/audit`, `/gas-snapshot`) are invocable directly, rules activate in every session, and skills respond to invocation by name.

### Cursor [BETA]

Aegis does not publish a dedicated Cursor extension. Cross-harness outputs are generated from the canonical Claude Code source via `npm run sync` and committed to the repository alongside it.

**Manual install:**

1. Clone the Aegis repository:
   ```bash
   git clone https://github.com/aryasomu/aegis /tmp/aegis
   ```
2. Copy the Cursor outputs into your project root:
   ```bash
   cp -r /tmp/aegis/.cursor/agents .cursor/
   cp -r /tmp/aegis/.cursor/skills .cursor/
   cp /tmp/aegis/.cursor/aegis-commands.md .cursor/aegis-commands.md
   cp /tmp/aegis/.cursorrules .cursorrules
   ```
   If you maintain multiple Aegis-backed projects, clone once and symlink the `.cursor/` subdirectories.

**Known limitations (Cursor beta):**

- No native slash commands. `/audit` and `/gas-snapshot` are documented as Composer task prompts in `.cursor/aegis-commands.md`; open that file, copy the relevant command body, and submit it as a Composer task.
- Agents must be invoked explicitly via `@Aegis` or by pasting the agent instruction into the Composer context. There is no automatic invocation on Solidity file modification.
- Tool calls that shell out to `forge`, `slither`, or `aderyn` require Cursor's terminal integration to be active. Behavior is not guaranteed across all Cursor workspace configurations.

### Codex [BETA]

Aegis generates a single `AGENTS.md` file at the repository root. Point Codex at this file to load all 15 components as project context.

**CLI:**
```bash
codex --project-doc AGENTS.md
```

**App (OpenAI Codex web):** Upload `AGENTS.md` as a project file in the workspace. The identity, agents, skills, rules, and commands sections load in top-to-bottom order, matching the structure Codex expects.

**Known limitations (Codex beta):**

- All 15 Aegis components are concatenated into a single file. On sessions involving large codebases or extensive conversation history, `AGENTS.md` occupies significant context budget. The Claude Code installation is recommended for sustained production sessions.
- Agent delegation is not automatic. The `defi-economist` agent, for example, will not invoke when fee logic is modified; it must be referenced explicitly in the task prompt.

---

## Components

Aegis v0.2.0 ships exactly 15 components across four types. The component count is a hard constraint for this release.

### Agents

Agents are invoked automatically or on demand. They operate with full tool access and produce structured output.

| Agent | Description |
|---|---|
| `solidity-reviewer` | Expert Solidity reviewer covering reentrancy, access control, integer issues, storage layout, proxy patterns, oracle manipulation, MEV exposure, and external call hygiene. Invoked after any contract is written or modified. |
| `audit-finder` | Static analysis orchestrator. Runs Slither, Aderyn, and Mythril in sequence, deduplicates findings across tools, prioritizes by severity and exploitability, and produces a consolidated report with minimal-diff fixes. |
| `gas-optimizer` | Establishes a forge snapshot baseline, identifies optimization candidates across storage, calldata, visibility, arithmetic, and loop patterns, and reports per-function gas savings with minimal-diff change proposals. |
| `defi-economist` | Economic design reviewer. Analyzes slippage propagation, oracle dependency graphs, liquidation parameters, fee structures, MEV surface, composability assumptions, bootstrap dynamics, and token economics from design documents. Does not review code. |

### Skills

Skills are invocable knowledge modules. Each is self-contained and independently addressable.

| Skill | Description |
|---|---|
| `solidity-patterns` | Modern Solidity 0.8.20+ idioms: custom errors, `immutable` variables, transient storage (EIP-1153), named return values, modifier discipline, NatSpec, file organization, and import discipline. |
| `foundry-workflow` | TDD discipline for Solidity using Foundry: project layout, fuzz and invariant testing, cheatcodes, mainnet forking, coverage thresholds, and common forge pitfalls. |
| `evm-security` | SWC-aligned vulnerability reference. Each entry covers explanation, vulnerable code, exploit scenario, and fix pattern. Topics: reentrancy, integer issues, unchecked calls, ordering dependencies, oracle manipulation, signature replay, approval frontrunning, hook abuse, fee-on-transfer, and donation attacks. |
| `gas-optimization` | Before/after code patterns with measured gas savings. Covers storage packing, bitmaps, custom errors, `unchecked` blocks, calldata optimization, visibility, `immutable`/`constant`, increment style, and loop length caching. |
| `oracle-integration` | Chainlink Data Feeds with staleness and L2 sequencer checks, Pyth pull-based consumption, Uniswap v3 TWAP construction, manipulation resistance, oracle selection guidance, and a catalog of common implementation mistakes. |
| `erc-standards` | Interface reference, audit checklists, and pitfall catalog for ERC-20 (fee-on-transfer, rebasing), ERC-721, ERC-1155, ERC-4626 (share inflation, donation attacks), and ERC-4337 (account abstraction). |
| `amm-orderbook-design` | Mathematical derivations, code skeletons, and trade-off analysis for CPMM, CLMM, and StableSwap designs, CLOB construction with price-time priority, and the verifiability axis as realized in Vela Exchange (SSRN 6579199). |

### Rules

Rules are always-on session constraints. They are not invocable; they operate as standing instructions in every session.

| Rule | Description |
|---|---|
| `smart-contract-security` | Enforces a non-negotiable security checklist on all Solidity writes: reentrancy guards, access control on privileged functions, input validation, no `tx.origin` for authorization, mandatory event emission. |
| `defi-testing` | Enforces testing discipline: fuzz tests for arithmetic-heavy functions, invariant tests for stateful contracts, integration tests against forked mainnet state, no mocking of external protocol interfaces. |

### Commands

Commands are user-invocable slash commands.

| Command | Flags | Description |
|---|---|---|
| `/audit` | `--deep` `--target <file>` `--fix` | Runs Slither, Aderyn, and `forge test`; deduplicates and prioritizes findings; produces a dated report at `audit-reports/`. `--deep` adds Mythril symbolic execution; `--target` scopes to one contract; `--fix` appends minimal-diff fix proposals. |
| `/gas-snapshot` | `--update` `--threshold <n>` | Compares current `forge snapshot` against the committed baseline; reports regressions, improvements, and new or removed functions. `--update` overwrites the baseline; `--threshold <n>` fails if any regression exceeds n gas. |

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
| P0 | Unprotected pause controls (`setDepositsPaused`, `setWithdrawalsPaused`) | Slither, Aderyn |
| P0 | Unprotected fee drain (`collectFees`) | Slither, Aderyn |
| P1 | Chainlink staleness and round completeness unchecked | Aderyn, audit-finder |
| GAS | Storage layout: 6 slots where 4 suffice (~4,200 gas/call saved) | gas-optimizer |

The audit-finder agent identified all three planted defects plus additional findings from independent pattern analysis, including a CEI violation via ERC-777 callback in `redeem()` and unchecked `transfer` return values throughout. The toy-vault README documents each planted defect in detail with the full expected audit summary.

---

## Research Context

Aegis is the third volume in the **Monolith Blockchain Research** series, produced by [Monolith Systematic LLC](https://monolithsystematic.com).

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

### Cross-harness sync

The canonical source for all Aegis components is the Claude Code format: `agents/`, `skills/`, `rules/`, and `commands/`. The Cursor outputs in `.cursor/` and the Codex output `AGENTS.md` are generated artifacts produced by `scripts/sync-harnesses.js`.

Never edit `.cursor/` files or `AGENTS.md` directly. All changes must flow through the canonical source:

1. Modify the relevant file in `agents/`, `skills/`, `rules/`, or `commands/`.
2. Run `npm run sync` to regenerate all harness outputs.
3. Commit both the canonical change and the regenerated outputs together.

CI enforces consistency via `npm run sync:check`, which exits non-zero if any generated output drifts from what the canonical source would produce. Pull requests that modify canonical source without running sync will fail the check at step 6 of the test workflow.

---

## License

[MIT](LICENSE) -- Copyright 2026 Arya Somu, Monolith Systematic LLC.
