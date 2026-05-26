# Changelog

All notable changes to Aegis are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

No unreleased changes at this time.

---

## [0.2.0] -- 2026-05-26

Cross-harness support. Aegis now generates Cursor and Codex outputs from
the canonical Claude Code source via an idempotent sync script. Cursor and
Codex integrations are labeled [BETA] and documented with explicit
known-limitations sections. CI enforces sync consistency via a drift-check
step that fails on any discrepancy between canonical source and generated
outputs.

### Added

**Cross-harness sync**

- `scripts/sync-harnesses.js` -- Idempotent Node.js sync script generating
  all Cursor and Codex outputs from canonical Claude Code source. Flags:
  `--check` (dry-run drift detection; exits 1 on any drift; used in CI),
  `--harness=cursor|codex|all` (default: all). Hard-rejects em dash
  characters in generated content before writing. Uses a two-pass YAML
  parser: js-yaml first, with a line-by-line fallback for frontmatter values
  that contain bracket characters (e.g., `argument-hint` in command files).
- `npm run sync` -- Regenerates all harness outputs from canonical source.
- `npm run sync:check` -- Dry-run drift check; exits 1 if any generated
  output would change. Enforced in CI at workflow step 6.

**Cursor [BETA]**

- `.cursor/agents/aegis-{name}.md` (4 files) -- Agent definitions with the
  `aegis-` namespace prefix applied. Claude Code-specific frontmatter (the
  `model` field) is stripped; `name`, `description`, and `tools` (serialized
  as a YAML list) are preserved alongside the full agent body.
- `.cursor/skills/aegis-{name}/SKILL.md` (7 files) -- Skill definitions with
  the `aegis-` namespace prefix applied to the `name` frontmatter field; all
  other frontmatter fields and body content are preserved unchanged.
- `.cursor/aegis-commands.md` -- Reference document for `/aegis:audit` and
  `/aegis:gas-snapshot` as Cursor Composer task prompts, including argument
  documentation and invocation instructions for each command phase.
- `.cursorrules` -- Both Aegis rules (`smart-contract-security`,
  `defi-testing`) concatenated with section headers for always-on session
  enforcement in Cursor.

**Codex [BETA]**

- `AGENTS.md` -- Single-file aggregation of all 15 Aegis components in
  top-to-bottom reading order: identity (from `.claude-plugin/plugin.json`),
  agents (4), skills (7), rules (2), commands (2). Structured for Codex
  project context loading via `codex --project-doc AGENTS.md` or upload to
  the Codex web app workspace.

**CI and validation**

- `.github/workflows/test.yml` step 6 -- `npm run sync:check`: harness drift
  detection; fails CI if any generated output is inconsistent with canonical
  source.
- `.github/workflows/test.yml` step 7 -- `npm run validate:harness`:
  structural assertions: `.cursorrules` exists, `AGENTS.md` exists,
  `.cursor/agents/` contains exactly 4 `.md` files, `.cursor/skills/`
  contains exactly 7 subdirectories.
- `scripts/validate.js` check 6 (`harness`) -- Mirrors step 7 above for
  local runs. Invocable via `npm run validate:harness` or as part of
  `npm run validate`.
- `scripts/validate.js` check 1 (`md`) -- Markdown lint extended to cover
  the `.cursor/` tree and `AGENTS.md`. Two-pass implementation: canonical
  source files receive the full rule set; generated aggregation files run
  with `MD025` disabled (multiple H1 headings are structural in aggregation
  documents, not a style defect).
- `npm run validate:harness` -- Local harness structure check; mirrors CI
  step 7.

**Documentation**

- `README.md` -- New "Supported Harnesses" section between Installation and
  Components: harness maturity table, manual install steps for Cursor and
  Codex, and Known Limitations subsections for each beta harness. New
  "Cross-harness sync" subsection in Contributing documenting the
  canonical-source discipline and the CI enforcement mechanism.
- `CLAUDE.md` -- Version updated to 0.2.0. New "Cross-harness Support"
  section: harness maturity table, single-source-of-truth principle and hard
  rule against direct edits to generated files, adapter patterns following
  ECC conventions (`aegis-` namespace prefix for Cursor, flat `AGENTS.md`
  for Codex), beta harness requirements (explicit `[BETA]` label and
  known-limitations sections in all user-facing documentation), and
  maintenance discipline (every component change requires `npm run sync` and
  CI blocks on drift). Development Protocol updated: step 5 added (mandatory
  `npm run sync` before opening a pull request), prior step 5 renumbered to
  step 6. Repository structure diagram updated to reflect `.cursor/`,
  `AGENTS.md`, and `scripts/sync-harnesses.js`.
- `CHANGELOG.md` -- This entry.

### Changed

- `.gitignore` -- Blanket `.cursor/` ignore replaced with `.cursor/*` plus
  explicit negations for `agents/`, `skills/`, and `aegis-commands.md`.
  Cursor IDE local files remain ignored; Aegis-generated cross-harness
  outputs are now tracked by git.
- `package.json` -- Added scripts: `validate:harness`, `sync`, `sync:check`.

---

## [0.1.0] -- 2026-05-24

Initial release. Fifteen components across four types, calibrated against the
Vela Exchange codebase (SSRN 6579199). Hard cap: 15 components for v0.1.

### Added

**Plugin scaffold**

- Plugin manifest (`.claude-plugin/plugin.json`) and marketplace entry
  (`.claude-plugin/marketplace.json`) following ECC harness conventions
  (auto-discovered agents, auto-loaded hooks, no `agents` or `hooks` fields
  in the manifest)
- Directory structure: `agents/`, `skills/`, `rules/`, `commands/`,
  `examples/`, `docs/`, `scripts/`
- `CLAUDE.md` with comprehensive project specification, 15-component
  inventory, style guide (em dash prohibition, institutional register
  requirement), and quality gate (Vela Exchange dogfood, no regressions,
  style compliance)
- `README.md` with badge row, component inventory, quick-start guide,
  demo output, and Monolith Research context
- `LICENSE` (MIT, Copyright 2026 Arya Somu, Monolith Systematic LLC)
- `CONTRIBUTING.md` with PR template, component templates (agent, skill),
  frontmatter requirements, and maintenance cadence
- `CHANGELOG.md` (this file)
- `.gitignore` covering Node.js, Python, IDE, OS, and environment artifacts

**CI and validation**

- `.github/workflows/lint.yml` -- em dash prohibition across all markdown
  files, plugin manifest field validation (no `agents`/`hooks` keys, arrays
  for `skills`/`commands`), SKILL.md presence check, 15-component count
  enforcement
- `.github/workflows/test.yml` -- five named steps: markdown lint
  (markdownlint 0.38+, micromark parser, zero CVEs), agent frontmatter schema
  validation (name, description, tools, model), skill frontmatter schema
  validation (name, description), plugin manifest validation, component count
  enforcement
- `scripts/validate.js` -- Node.js script mirroring all five CI checks,
  invocable per-check via `npm run validate:<check>` or in full via
  `npm run validate`
- `package.json` with validate scripts; `package-lock.json` committed for
  reproducible `npm ci` in CI
- `.markdownlint.json` disabling MD013, MD024, MD031, MD032, MD033, MD034,
  MD037, MD040, MD041 (rules that produce false positives in technical
  instructional documents)

**Agents (4)**

- `solidity-reviewer` -- Line-by-line Solidity review covering nine
  categories: Reentrancy (three variants), Access Control, Integer Issues,
  Proxy Patterns, External Call Hygiene, MEV Exposure, Oracle Manipulation,
  Storage Layout, and Modern Solidity Idioms. Invoked automatically after
  any contract write or modification. Output format: SEVERITY / Location /
  Description / Fix / Example (vulnerable + fixed). Approval disposition:
  Block / Conditional / Approve.
- `audit-finder` -- Static analysis orchestration for Slither, Aderyn, and
  Mythril (conditional on `--deep`). Execution order: Aderyn, Slither, forge
  test/snapshot, Mythril. Three-rule deduplication protocol; `Confidence:
  Corroborated` tag for multi-tool findings. Severity-exploitability matrix
  mapping to P0-P3. 22-entry SWC registry reference table. Minimal-diff fix
  proposals (unified diff) for P0 and P1 findings.
- `gas-optimizer` -- Per-function gas profiling against `forge snapshot`
  baseline. Five optimization tiers by impact: Storage (Tier 1), Calldata/
  Memory (Tier 2), Function Attributes (Tier 3), Arithmetic (Tier 4), Loop
  Patterns (Tier 5). Hard assembly gate: refusal unless savings exceed 200
  gas per hot-path call AND an audited precedent exists. Required SAFETY /
  PRECEDENT / AUDIT comment block for any approved assembly. Incremental
  application with forge build + forge test + forge snapshot --check after
  each batch.
- `defi-economist` -- Economic security review for eight categories:
  Slippage and Price Impact, Oracle Dependency Graph, Liquidation Parameters,
  Fee Structures, MEV Surface, Composability Risk, Bootstrap Dynamics, and
  Token Economics. Model: opus (only agent using opus). Reads design
  documents, whitepapers, and README files; does not read or modify source
  code. Includes Positive Design Observations section.

**Skills (7)**

- `solidity-patterns` -- Modern Solidity 0.8.20+ idioms with code examples:
  custom errors (selector computation, ABI encoding), immutable variables
  (deployment-gas implications), transient storage reentrancy guard
  (EIP-1153, tload/tstore), named returns (stack depth reduction), modifier
  discipline, NatSpec, file organization, and import discipline. Quick
  reference table: 9 rows covering idiom, gas impact, minimum version.
- `foundry-workflow` -- Foundry project lifecycle: unit/fuzz/invariant/fork
  test organization, fuzz configuration with `bound` requirements, complete
  `VaultHandler` with `useActor` modifier and ghost variables, complete
  `VaultInvariantTest` with `targetContract`, `vm.prank` pitfall (consumed
  by intermediate view calls), `vm.expectRevert` pitfall, coverage thresholds
  (95% line, 85% branch, 100% function), cheatcode quick reference.
- `evm-security` -- 13 vulnerability entries aligned to the SWC registry:
  reentrancy (three variants), delegatecall hazards, storage collision in
  proxy upgrades, assembly safety, signature malleability and replay, integer
  arithmetic (with overflow table), access control misconfiguration, flash
  loan attack surfaces, ERC-4626 donation attacks (with virtual shares
  mitigation code), oracle manipulation, ERC-4337 validation context
  constraints, and call depth limits.
- `gas-optimization` -- Gas reduction reference with opcode cost table:
  SLOAD cold 2,100, SLOAD warm 100, SSTORE new slot 20,000, SSTORE dirty
  2,900, TSTORE 100, TLOAD 100. 16-row savings summary. Before/after code
  examples for: storage packing, calldata vs. memory, `uint256` preference,
  `unchecked` arithmetic scoping, custom errors, loop variable caching, and
  bitmap usage. Pitfall note: whole-struct caching when only one field is
  needed.
- `oracle-integration` -- Chainlink integration: all five `latestRoundData`
  return fields, staleness window calculation, L2 Sequencer Uptime Feed
  check (with code for sequencer downtime and grace period). Uniswap v3
  TWAP: full construction with the negative-tick rounding correction that
  most implementations miss. Pyth pull model. 14-item audit checklist.
  7-row oracle selection guide. Feed selection matrix.
- `erc-standards` -- ERC-20 (fee-on-transfer, rebasing, permit), ERC-721
  (reentrancy via `onERC721Received`, safe transfer requirements), ERC-1155
  (batch arrays, transfer hooks), ERC-4626 (rounding direction table for
  all 8 conversion functions, donation attack, virtual shares), ERC-4337
  (validateUserOp with packed validationData, forbidden opcodes in
  validation context), EIP-712 (structured data signing, domain separator).
  Quick reference: 5-row table with key invariant and most common
  integration failure per standard.
- `amm-orderbook-design` -- 1,136 lines. CPMM derivation (x*y=k, price
  impact formula, LP fee mechanics), StableSwap Newton's method for D,
  CLMM real reserves formula and tick math, CLOB price-time priority, partial
  fills, active vs. lazy cancellation. Vela Exchange architecture (SSRN
  6579199 by Arya Somu): optimistic ZK proving, 7-day challenge window,
  fast-finality path, forced inclusion via delayed inbox, market-maker credit
  system, private L3 market data feeds (nonce challenge + wallet signature),
  Delta elimination (-73% p99.9 tail latency). Gas cost per fill table at
  20 gwei/ETH=$3,000.

**Rules (2)**

- `smart-contract-security` -- Mandatory session constraints: no unchecked
  external calls, SafeERC20 for all ERC-20 transfers (`send` and `.transfer()`
  prohibited), CEI discipline (deviations require `nonReentrant` and NatSpec
  justification), access control modifier on every privileged function,
  `Ownable2Step` required (single-step `transferOwnership` prohibited),
  role separation for high-risk roles (upgrader role must be distinct,
  48-hour timelock on mainnet), `Pausable` for safety-critical protocols.
  Pre-merge checklist (11 items) and pre-deployment checklist (10 items).
- `defi-testing` -- Testing standards enforced in CI: 90% line coverage,
  85% branch coverage, 100% function coverage. Fuzz runs: 256 standard,
  1,024 for high-value contracts (holds >$500k TVL, liquidation mechanics,
  or custom cryptographic verification). `bound` required on all numeric
  fuzz inputs. Invariant runs: 256 minimum, depth 15. Handler contracts
  required (50% call success rate minimum). Ghost variables required for
  accounting invariants. Required invariants by contract type (ERC-4626,
  Lending, AMM, Token, Access-controlled). Fork test requirements: pinned
  block number, `MAINNET_RPC_URL` from environment, tests in
  `test/integration/`. Gas snapshot committed to version control;
  `forge snapshot --check` in CI.

**Commands (2)**

- `/audit` -- Full audit pipeline across 10 phases: flag parsing
  (`--deep`, `--target <file>`, `--fix`), environment check, forge build,
  Aderyn, Slither, Mythril (conditional on `--deep`), forge test/snapshot,
  deduplication and prioritization, dated report to
  `audit-reports/YYYY-MM-DD-audit.md`, fix proposals appended (conditional
  on `--fix`). Exits 0 on clean; blocking message if P0 or P1 findings
  present. 10-scenario edge cases table.
- `/gas-snapshot` -- Gas comparison pipeline across 8 phases: flag parsing
  (`--update`, `--threshold <n>`), baseline existence check, forge build,
  forge test --gas-report + forge snapshot to temp, diff parsing
  (regressions/improvements/new/removed functions), threshold enforcement
  (exits 1 on violation for CI integration), markdown report to
  `/tmp/gas-snapshot-report.md`, baseline update stages (does not commit).
  10-scenario edge cases table.

**Examples**

- `examples/toy-vault/` -- Minimal ERC-4626-style vault (`src/ToyVault.sol`,
  310 lines, standalone -- no external imports) with three planted defects:
  share inflation attack (no virtual shares), missing Chainlink staleness
  check, and sub-optimal storage layout (6 slots where 4 suffice). Forge
  test suite (`test/ToyVault.t.sol`, 6 tests, all passing): two inflation
  attack demonstrations, stale oracle acceptance proof, storage layout gas
  overhead isolation, happy path, and 256-run fuzz round-trip. Audit-finder
  agent identified all three planted defects plus 15 additional independent
  findings (4 P0, 3 P1, 3 P2, 3 P3, 5 GAS) on first pass. Used as the
  launch thread demonstration and plugin quality gate dogfood surface.
