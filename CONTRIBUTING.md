# Contributing to Aegis

Aegis is part of the Monolith Blockchain Research series. Contributions are held to the same institutional standard as Monolith Systematic research publications. Read this document in full before opening a pull request.

---

## Prerequisites

- Familiarity with the ECC plugin structure (github.com/affaan-m/ECC). Aegis inherits ECC harness conventions for frontmatter, plugin manifests, and directory layout.
- A working Foundry installation (`forge`, `cast`, `anvil`) for dogfooding components against the Vela Exchange codebase.
- Understanding of the Aegis component inventory and the v0.1 hard cap of 15 components (see `CLAUDE.md`).

---

## Component Hard Cap

Version 0.1 is capped at **15 components total** across all types. This cap is binding. A pull request adding a net-new component will not be merged unless a component is simultaneously removed or the version is incremented to v0.2. The rationale is focus: every component in Aegis must be substantive enough to displace an existing one.

---

## Quality Gate

Every component (agent, skill, rule, or command) must satisfy all three of the following before merge:

1. **Dogfooded on Vela Exchange.** Run the component against the Vela Exchange codebase and document the results in the pull request description. Include the specific file or function targeted, the output produced, and whether the output was correct and useful.

2. **No regressions.** Running `/audit` and `/gas-snapshot` against the Vela Exchange codebase after your change must produce results consistent with or better than the pre-merge baseline. Document this in the pull request.

3. **Style guide compliance.** See the Style Guide section below. Non-compliant pull requests will be returned without merge.

---

## Style Guide

The following rules apply to every file in this repository.

**Prohibited:**
- Em dashes (`—`). Use `--` as a separator only when a separator is genuinely necessary. Prefer restructuring the sentence.
- Casual or colloquial register.
- First-person singular constructions ("I think", "I suggest", "I recommend").
- Bullet points as a substitute for analytical prose in agent body sections.

**Required:**
- Formal, institutional register. Model each document against a Monolith Systematic research memo.
- Declarative, imperative, or analytical sentence constructions.
- Technical precision. Specify the exact opcode, ERC number, function selector, or storage slot when the claim warrants it.
- Oxford comma.

---

## Frontmatter Requirements

### Agent frontmatter

```yaml
---
name: kebab-case-identifier
description: Single declarative sentence. Trigger condition stated explicitly.
tools: ["Read", "Grep", "Glob", "Bash"]
model: sonnet
---
```

### Skill frontmatter

```yaml
---
name: kebab-case-identifier
description: One-line capability description for trigger matching.
origin: Aegis
tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
---
```

### Required skill body sections (in order)

1. When to Use
2. Scope Boundaries
3. Core Concepts
4. How It Works
5. Common Patterns
6. Quick Reference

---

## Plugin Manifest Conventions

- `version` is mandatory in `plugin.json`.
- `skills` and `commands` must be arrays.
- Do not add an `"agents"` field. Agents are auto-discovered by the harness.
- Do not add a `"hooks"` field. `hooks/hooks.json` is auto-loaded.
- `"mcpServers": {}` must remain as an empty object.

---

## Pull Request Format

Pull request titles must follow the Conventional Commits specification:

```
type(scope): short description
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`.

The pull request body must include:

- **Component:** The name and type of the component being added or modified.
- **Dogfood evidence:** The Vela Exchange file or function targeted, the output produced, and a pass/fail assessment.
- **Regression check:** Confirmation that `/audit` and `/gas-snapshot` baselines are unchanged or improved.
- **Style compliance:** Confirmation that no em dashes are present and the institutional register is maintained.

---

## Questions and Discussion

Open a GitHub Discussion or contact the author at arya@monolithsystematic.com.
