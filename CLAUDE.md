# Aegis

> Encoded discipline for onchain development.

**Project:** Aegis Claude Code Plugin  
**Author:** Arya Somu, Founder and Chief Investment Officer, Monolith Systematic LLC  
**License:** MIT  
**Series:** Monolith Blockchain Research, Vol. 3  
**Companion:** Complementary to ECC (github.com/affaan-m/ECC); assumes ECC conventions as the baseline harness standard  
**Version:** 0.1 (component-capped)

---

## Purpose

Aegis is a Claude Code plugin purpose-built for smart contract and onchain development workflows. It encodes institutional discipline into the development loop: security review, gas accounting, DeFi economic reasoning, and protocol design patterns are not afterthoughts but first-class primitives invoked at the point of authorship.

The plugin targets Solidity engineers, protocol researchers, and quantitative DeFi builders who require a structured, auditable, and reproducible development environment. Every component is calibrated against production-grade codebases before merge. The canonical dogfooding surface is the Vela Exchange codebase.

---

## Repository Structure

```
aegis/
├── CLAUDE.md                        # This file
├── .claude-plugin/
│   ├── plugin.json                  # Claude Code plugin manifest
│   └── marketplace.json             # Registry entry
├── agents/
│   ├── solidity-reviewer.md
│   ├── audit-finder.md
│   ├── gas-optimizer.md
│   └── defi-economist.md
├── skills/
│   ├── solidity-patterns/SKILL.md
│   ├── foundry-workflow/SKILL.md
│   ├── evm-security/SKILL.md
│   ├── gas-optimization/SKILL.md
│   ├── oracle-integration/SKILL.md
│   ├── erc-standards/SKILL.md
│   └── amm-orderbook-design/SKILL.md
├── rules/
│   ├── smart-contract-security.md
│   └── defi-testing.md
└── commands/
    ├── audit.md
    └── gas-snapshot.md
```

---

## Component Inventory (v0.1 Hard Cap: 15)

The v0.1 release is deliberately constrained to 15 components. No new components may be added without removing an existing one or incrementing the version to v0.2.

| Type | Count | Components |
|------|-------|------------|
| Agents | 4 | solidity-reviewer, audit-finder, gas-optimizer, defi-economist |
| Skills | 7 | solidity-patterns, foundry-workflow, evm-security, gas-optimization, oracle-integration, erc-standards, amm-orderbook-design |
| Rules | 2 | smart-contract-security, defi-testing |
| Commands | 2 | /audit, /gas-snapshot |
| **Total** | **15** | |

---

## Component Specifications

### Agents

Agents are defined as Markdown files under `agents/` with YAML frontmatter. The harness auto-discovers them by convention; no `"agents"` field is added to `plugin.json`.

**Frontmatter schema:**
```yaml
---
name: kebab-case-identifier
description: Single declarative sentence. Trigger condition stated explicitly.
tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"]
model: sonnet
---
```

**Agent roster:**

- `solidity-reviewer` -- Performs line-by-line review of Solidity contracts for correctness, upgrade safety, access control, and invariant preservation. Invoked after any contract file is written or modified.
- `audit-finder` -- Identifies known vulnerability classes (reentrancy, oracle manipulation, flash loan vectors, price impact, access control misconfiguration) by cross-referencing the contract against indexed audit databases and pattern libraries. Invoked on demand or pre-commit.
- `gas-optimizer` -- Profiles gas consumption across functions, identifies inefficient patterns (storage reads in loops, redundant SLOADs, suboptimal data packing), and proposes concrete refactors with expected savings quantified. Invoked after foundry gas snapshots or on demand.
- `defi-economist` -- Evaluates economic security: incentive alignment, liquidity assumptions, fee structure sustainability, MEV exposure, and liquidation mechanics. Invoked during protocol design review or when tokenomics or fee logic is modified.

### Skills

Skills are defined as `SKILL.md` files within named subdirectories under `skills/`. Each skill is self-contained and independently invocable.

**Frontmatter schema:**
```yaml
---
name: kebab-case-identifier
description: One-line capability description for trigger matching.
origin: Aegis
tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
---
```

**Skill roster:**

- `solidity-patterns` -- Canonical Solidity design patterns: checks-effects-interactions, pull payment, proxy upgrade patterns (Transparent, UUPS, Beacon), factory patterns, and storage layout discipline.
- `foundry-workflow` -- Foundry project lifecycle: forge init, test organization, fuzz configuration, differential testing, invariant test harnesses, snapshot workflows, and deployment scripting with `forge script`.
- `evm-security` -- EVM-level security primitives: call depth limits, delegatecall hazards, storage collision in proxies, assembly safety, signature malleability, and low-level call return value handling.
- `gas-optimization` -- Solidity gas reduction techniques: storage packing, `uint256` preference, `unchecked` arithmetic scoping, calldata vs. memory, custom errors over require strings, and loop unrolling heuristics.
- `oracle-integration` -- Oracle integration patterns: Chainlink Data Feeds (staleness checks, circuit breakers), TWAPs (Uniswap v2/v3), push vs. pull oracles, multi-source aggregation, and oracle manipulation resistance.
- `erc-standards` -- Canonical ERC implementations and their deviation risks: ERC-20 (fee-on-transfer, rebasing), ERC-721 (reentrancy via `onERC721Received`), ERC-1155, ERC-4626 (vault share inflation), ERC-2612 (permit), and EIP-712 (structured data signing).
- `amm-orderbook-design` -- AMM and orderbook protocol design: constant product and concentrated liquidity mechanics, fee tier selection, tick math, position management, hybrid orderbook-AMM architectures, and perp funding rate mechanics as implemented in protocols such as Vela Exchange.

### Rules

Rules are always-on constraints loaded into every session. They are defined under `rules/` and are not invocable as skills; they operate as standing instructions.

- `smart-contract-security` -- Enforces a non-negotiable security checklist on all Solidity writes: reentrancy guards on external calls, access control on privileged functions, input validation at contract boundaries, no `tx.origin` for authorization, and mandatory event emission on state changes.
- `defi-testing` -- Enforces testing discipline: fuzz tests required for all arithmetic-heavy functions, invariant tests required for all stateful protocol contracts, integration tests must run against forked mainnet state, no mocking of external protocol interfaces.

### Commands

Commands are user-invocable slash commands defined under `commands/`.

- `/audit` -- Orchestrates a full security pass: runs `audit-finder` against all modified contracts, cross-references findings against the `evm-security` and `solidity-patterns` skills, and produces a structured findings report with severity classification (Critical, High, Medium, Low, Informational).
- `/gas-snapshot` -- Runs `forge snapshot`, diffs against the baseline, invokes `gas-optimizer` on any function whose gas cost increased, and reports net gas delta with a function-level breakdown.

---

## Plugin Manifest Conventions

Following ECC conventions exactly:

- `version` is mandatory in `plugin.json`
- `commands` and `skills` must be arrays
- Do not add an `"agents"` field; agents are auto-discovered
- Do not add a `"hooks"` field; `hooks/hooks.json` is auto-loaded
- Keep `"mcpServers": {}` to prevent MCP tool name length issues

---

## Style Guide

These rules apply to every file in this repository without exception.

**Prohibited:**
- Em dashes (`--` is acceptable as a separator; restructure sentences to avoid the need for dashes where possible)
- Casual or colloquial language
- First-person singular ("I think", "I suggest")
- Bullet points as a substitute for analytical prose in agent bodies

**Required:**
- Formal, institutional register consistent with Monolith Systematic research publications
- Declarative, imperative, or analytical sentence constructions
- Technical precision: name the exact opcode, ERC number, function selector, or storage slot when specificity is warranted
- Oxford comma throughout

**Tone reference:** Monolith Systematic research publications. If a sentence would appear anomalous in a quantitative research memo, revise it before committing.

---

## Quality Gate

Every component must satisfy all three conditions before merge:

1. **Dogfooded on Vela Exchange** -- The component must have been exercised against the Vela Exchange codebase and produced correct, useful output. Record the test case in the component's PR description.
2. **No regressions on prior components** -- Running `/audit` and `/gas-snapshot` against the Vela Exchange codebase must produce results consistent with or better than the pre-merge baseline.
3. **Style guide compliance** -- No em dashes, no casual register, no prohibited patterns. Automated linting preferred; manual review required if linting is not available.

---

## Development Protocol

**Do not build components without reading this section.**

1. Study the ECC repository (github.com/affaan-m/ECC) before writing any new component. Aegis inherits its harness conventions, frontmatter schemas, and plugin manifest patterns from ECC. Diverge only when the onchain domain requires it.
2. Write agents and skills as dense, specific instruction sets. Generic advice belongs in documentation, not in agent bodies. An agent that could apply to any software project is not an Aegis agent.
3. Test every component against the Vela Exchange codebase before opening a pull request. Record findings in the PR description with sufficient detail to reproduce them.
4. The 15-component cap is binding for v0.1. If a new component is compelling enough to add, remove one or increment the version.
5. Do not modify `CLAUDE.md` to accommodate a component that does not meet the quality gate. Modify the component.

---

## Licensing

MIT License. Copyright 2026 Arya Somu, Monolith Systematic LLC.
