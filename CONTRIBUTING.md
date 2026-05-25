# Contributing to Aegis

Aegis is part of the Monolith Blockchain Research series. Contributions are
held to the same institutional standard as Monolith Systematic research
publications. Read this document in full before opening a pull request.

---

## Maintenance Cadence

Aegis is a research-division product maintained on a fixed budget of
**two hours per week**. Response times and review cycles reflect this:

- Pull requests receive an initial review within **seven days** of opening.
- Issues are triaged within **seven days**; resolution timelines depend on
  severity and fit with the research agenda.
- Do not expect same-day or next-day turnaround on any contribution.
- For time-sensitive security disclosures, contact the author directly at
  arya@monolithsystematic.com rather than opening a public issue.

Contributions that require extended back-and-forth to reach merge readiness
will be closed after 30 days of inactivity and may be re-opened when ready.

---

## Prerequisites

- Familiarity with the ECC plugin structure (github.com/affaan-m/ECC). Aegis
  inherits ECC harness conventions for frontmatter, plugin manifests, and
  directory layout.
- A working Foundry installation (`forge`, `cast`, `anvil`) for dogfooding
  components against the Vela Exchange codebase.
- Understanding of the Aegis component inventory and the v0.1 hard cap of 15
  components (see `CLAUDE.md`).
- Node.js 20+ for running `npm run validate` locally.

---

## Component Hard Cap

Version 0.1 is capped at **15 components total** across all types. This cap
is binding. A pull request adding a net-new component will not be merged
unless a component is simultaneously removed or the version is incremented to
v0.2. The rationale is focus: every component in Aegis must be substantive
enough to displace an existing one.

---

## Quality Gate

Every component (agent, skill, rule, or command) must satisfy all three
of the following before merge:

1. **Dogfooded on Vela Exchange.** Run the component against the Vela Exchange
   codebase and document the results in the pull request description. Include
   the specific file or function targeted, the output produced, and whether
   the output was correct and useful.

2. **No regressions.** Running `/audit` and `/gas-snapshot` against the Vela
   Exchange codebase after your change must produce results consistent with or
   better than the pre-merge baseline. Document this in the pull request.

3. **Style guide compliance.** See the Style Guide section below. Non-compliant
   pull requests will be returned without merge.

---

## Style Guide

The following rules apply to every file in this repository.

**Prohibited:**
- Em dashes (Unicode U+2014). Use `--` as a separator only when a separator
  is genuinely necessary. Prefer restructuring the sentence.
- Casual or colloquial register.
- First-person singular constructions ("I think", "I suggest", "I recommend").
- Bullet points as a substitute for analytical prose in agent body sections.

**Required:**
- Formal, institutional register. Model each document against a Monolith
  Systematic research memo.
- Declarative, imperative, or analytical sentence constructions.
- Technical precision. Specify the exact opcode, ERC number, function selector,
  or storage slot when the claim warrants it.
- Oxford comma.

Run the em dash check before opening a pull request:

```bash
grep -rn $'\xe2\x80\x94' agents/ skills/ rules/ commands/ docs/ README.md \
  CLAUDE.md CONTRIBUTING.md CHANGELOG.md 2>/dev/null && echo "FAIL: em dashes found" \
  || echo "PASS: no em dashes"
```

---

## Adding a New Agent

Follow this sequence exactly. Deviating from it is the most common reason
contributions are returned.

**Step 1 -- Confirm capacity.** Run `npm run validate:count`. If total is 15,
a component must be removed before a new agent can be added.

**Step 2 -- Study existing agents.** Read `agents/solidity-reviewer.md` and
`agents/audit-finder.md` in full. Understand the prompt defense baseline,
the structured output format, and the scope boundaries.

**Step 3 -- Write the agent file** at `agents/<kebab-name>.md`. Use this
frontmatter:

```yaml
---
name: kebab-case-identifier
description: Single declarative sentence. Trigger condition stated explicitly.
tools: ["Read", "Grep", "Glob", "Bash"]
model: sonnet
---
```

The body must include, in order:

1. **Prompt Defense Baseline** (copy verbatim from an existing agent)
2. **Startup Sequence** (numbered steps: read relevant files, build context,
   run tools)
3. **Analysis Protocol** (the domain-specific checklist, categorized by
   severity or topic)
4. **Output Format** (the exact schema the agent must produce)
5. **Scope Boundaries** (explicit list of what the agent does not do)

**Step 4 -- Dogfood against Vela Exchange.** Run the agent against at least
one Vela Exchange contract. Record the output.

**Step 5 -- Run validation.** `npm run validate` must pass with zero errors.

**Step 6 -- Open the pull request** using the PR template below.

---

## Adding a New Skill

**Step 1 -- Confirm capacity.** Same as for agents.

**Step 2 -- Study existing skills.** Read `skills/oracle-integration/SKILL.md`
and `skills/evm-security/SKILL.md`. Each skill is a reference document, not
an instruction set. It must be independently useful to a reader without
additional context.

**Step 3 -- Create the skill directory and file:**

```
skills/<kebab-name>/SKILL.md
```

Use this frontmatter:

```yaml
---
name: kebab-case-identifier
description: One-line capability description for trigger matching.
origin: Aegis
tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
---
```

The body must include these sections in order:

1. `## When to Use` -- specific trigger conditions, not generic advice
2. `## Scope Boundaries` -- explicit list of what is out of scope
3. `## Core Concepts` -- foundational theory with precise definitions
4. `## How It Works` -- mechanics, with code examples for every major point
5. `## Common Patterns` -- canonical implementations with before/after diffs
6. `## Quick Reference` -- table of rules, idioms, or checklist items

**Step 4 -- Dogfood, validate, and open the pull request.**

---

## Frontmatter Requirements

### Agent frontmatter (required fields)

```yaml
---
name: kebab-case-identifier
description: Single declarative sentence. Trigger condition stated explicitly.
tools: ["Read", "Grep", "Glob", "Bash"]
model: sonnet
---
```

`model` must be `sonnet` or `opus`. Use `opus` only for agents that perform
extended multi-step economic or protocol-level reasoning (`defi-economist` is
the sole current example).

### Skill frontmatter (required fields)

```yaml
---
name: kebab-case-identifier
description: One-line capability description for trigger matching.
origin: Aegis
tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
---
```

---

## Plugin Manifest Conventions

- `version` is mandatory in `plugin.json`.
- `skills` and `commands` must be arrays.
- Do not add an `"agents"` field. Agents are auto-discovered by the harness.
- Do not add a `"hooks"` field. `hooks/hooks.json` is auto-loaded.
- `"mcpServers": {}` must remain as an empty object.

---

## Pull Request Template

Copy the template below into your pull request body. Replace every bracketed
field. Pull requests that omit required fields will be returned without review.

```markdown
## Summary

<!-- One or two sentences. What does this change do and why? -->

## Component

**Type:** [Agent | Skill | Rule | Command | Infrastructure]
**Name:** [component name]
**Replaces (if any):** [component being removed, or "none -- within cap"]

## Dogfood Evidence

**Target codebase:** Vela Exchange
**File(s) examined:** [list of files]
**Input given:** [the prompt or command used]
**Output summary:** [what the component produced]
**Assessment:** [Pass / Fail / Partial -- explain if not Pass]

## Regression Check

- [ ] `/audit` against Vela Exchange: [same | improved | N/A]
- [ ] `/gas-snapshot` against Vela Exchange: [same | improved | N/A]
- [ ] `npm run validate` passes with zero errors

## Style Compliance

- [ ] No em dashes (`grep -rn $'\xe2\x80\x94'` returns no matches)
- [ ] Institutional register maintained throughout
- [ ] No first-person singular constructions
- [ ] Oxford comma used consistently
- [ ] Code examples included for every major claim

## Checklist

- [ ] Frontmatter fields are complete and valid
- [ ] Component count is within the v0.1 cap of 15 (or version is incremented)
- [ ] CHANGELOG.md updated under [Unreleased]
- [ ] Commit message follows Conventional Commits (`type(scope): description`)
```

---

## Questions and Discussion

Open a GitHub Discussion or contact the author at arya@monolithsystematic.com.
