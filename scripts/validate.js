#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

let yaml, markdownlintSync;
try { yaml = require('js-yaml'); } catch {
  console.error('ERROR: js-yaml not installed. Run: npm install');
  process.exit(1);
}
try { markdownlintSync = require('markdownlint/sync').lint; } catch {
  console.error('ERROR: markdownlint not installed. Run: npm install');
  process.exit(1);
}

const ROOT   = path.resolve(__dirname, '..');
const CHECKS = ['md', 'agents', 'skills', 'manifest', 'count'];
const arg    = process.argv[2] || 'all';

if (arg !== 'all' && !CHECKS.includes(arg)) {
  console.error(`Unknown check: ${arg}. Valid: all, ${CHECKS.join(', ')}`);
  process.exit(1);
}

const toRun = arg === 'all' ? CHECKS : [arg];
let totalErrors = 0;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function findMdFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findMdFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function parseFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match   = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try { return yaml.load(match[1]); } catch { return null; }
}

function rel(p)      { return path.relative(ROOT, p); }
function fail(msg)   { console.error(`  FAIL  ${msg}`); totalErrors++; }
function pass(msg)   { console.log(`  PASS  ${msg}`); }
function section(n)  { console.log(`\n[${n}]`); }

// ---------------------------------------------------------------------------
// Check 1: Markdown lint
// ---------------------------------------------------------------------------

function checkMd() {
  section('1. Markdown lint');

  const files = [
    ...findMdFiles(path.join(ROOT, 'agents')),
    ...findMdFiles(path.join(ROOT, 'skills')),
    ...findMdFiles(path.join(ROOT, 'rules')),
    ...findMdFiles(path.join(ROOT, 'commands')),
    ...['README.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'CHANGELOG.md']
      .map(f => path.join(ROOT, f))
      .filter(f => fs.existsSync(f)),
  ];

  const configPath = path.join(ROOT, '.markdownlint.json');
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : { default: true, MD013: false, MD024: false, MD033: false, MD034: false, MD041: false };

  const results = markdownlintSync({
    files,
    config,
    frontMatter: /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
  });

  let count = 0;
  for (const [file, issues] of Object.entries(results)) {
    for (const issue of issues) {
      const detail = issue.errorDetail ? `: ${issue.errorDetail}` : '';
      fail(`${rel(file)}:${issue.lineNumber}  [${issue.ruleNames[0]}]  ${issue.ruleDescription}${detail}`);
      count++;
    }
  }
  if (count === 0) pass(`${files.length} file(s) pass markdownlint`);
}

// ---------------------------------------------------------------------------
// Check 2: Agent frontmatter schema
// ---------------------------------------------------------------------------

function checkAgents() {
  section('2. Agent frontmatter schema');

  const files = findMdFiles(path.join(ROOT, 'agents'));
  if (files.length === 0) { pass('No agent files found (skip)'); return; }

  let errors = 0;
  for (const file of files) {
    const fm = parseFrontmatter(file);
    if (!fm) { fail(`${rel(file)}  no YAML frontmatter found`); errors++; continue; }

    for (const field of ['name', 'description', 'tools', 'model']) {
      if (fm[field] === undefined || fm[field] === null || fm[field] === '') {
        fail(`${rel(file)}  missing required field: ${field}`);
        errors++;
      }
    }
    if (fm.tools !== undefined && !Array.isArray(fm.tools)) {
      fail(`${rel(file)}  'tools' must be an array`);
      errors++;
    }
    if (fm.model !== undefined && !['sonnet', 'opus'].includes(fm.model)) {
      fail(`${rel(file)}  'model' must be 'sonnet' or 'opus', got: ${fm.model}`);
      errors++;
    }
  }
  if (errors === 0) pass(`${files.length} agent(s) have valid frontmatter`);
}

// ---------------------------------------------------------------------------
// Check 3: Skill frontmatter schema
// ---------------------------------------------------------------------------

function checkSkills() {
  section('3. Skill frontmatter schema');

  const skillsDir = path.join(ROOT, 'skills');
  if (!fs.existsSync(skillsDir)) { pass('No skills directory found (skip)'); return; }

  const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(skillsDir, e.name));

  if (skillDirs.length === 0) { pass('No skill subdirectories found (skip)'); return; }

  let errors = 0;
  for (const dir of skillDirs) {
    const skillFile = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      fail(`${rel(dir)}  missing SKILL.md`);
      errors++;
      continue;
    }
    const fm = parseFrontmatter(skillFile);
    if (!fm) { fail(`${rel(skillFile)}  no YAML frontmatter found`); errors++; continue; }

    for (const field of ['name', 'description']) {
      if (fm[field] === undefined || fm[field] === null || fm[field] === '') {
        fail(`${rel(skillFile)}  missing required field: ${field}`);
        errors++;
      }
    }
  }
  if (errors === 0) pass(`${skillDirs.length} skill(s) have valid frontmatter`);
}

// ---------------------------------------------------------------------------
// Check 4: Plugin manifest validation
// ---------------------------------------------------------------------------

function checkManifest() {
  section('4. Plugin manifest validation');

  const manifestPath = path.join(ROOT, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    fail('.claude-plugin/plugin.json not found');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail(`.claude-plugin/plugin.json is not valid JSON: ${e.message}`);
    return;
  }

  let errors = 0;
  for (const field of ['name', 'version', 'description', 'author', 'license', 'skills', 'commands']) {
    if (manifest[field] === undefined) {
      fail(`plugin.json  missing required field: ${field}`);
      errors++;
    }
  }
  if (manifest.skills !== undefined && !Array.isArray(manifest.skills)) {
    fail("plugin.json  'skills' must be an array");
    errors++;
  }
  if (manifest.commands !== undefined && !Array.isArray(manifest.commands)) {
    fail("plugin.json  'commands' must be an array");
    errors++;
  }
  if ('agents' in manifest) {
    fail("plugin.json  'agents' field must not be present (auto-discovered)");
    errors++;
  }
  if ('hooks' in manifest) {
    fail("plugin.json  'hooks' field must not be present (auto-loaded)");
    errors++;
  }
  if (errors === 0) pass('plugin.json is valid');
}

// ---------------------------------------------------------------------------
// Check 5: Component count enforcement (v0.1 cap: 15)
// ---------------------------------------------------------------------------

function checkCount() {
  section('5. Component count  (v0.1 cap: 15)');

  const agentCount   = findMdFiles(path.join(ROOT, 'agents')).length;
  const skillsDir    = path.join(ROOT, 'skills');
  const skillCount   = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory()).length
    : 0;
  const ruleCount    = findMdFiles(path.join(ROOT, 'rules')).length;
  const commandCount = findMdFiles(path.join(ROOT, 'commands')).length;
  const total        = agentCount + skillCount + ruleCount + commandCount;

  console.log(`  Agents: ${agentCount}  Skills: ${skillCount}  Rules: ${ruleCount}  Commands: ${commandCount}  Total: ${total}/15`);

  if (total > 15) {
    fail(`component count (${total}) exceeds the v0.1 hard cap of 15`);
  } else {
    pass('component count is within the v0.1 cap');
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const checkMap = { md: checkMd, agents: checkAgents, skills: checkSkills, manifest: checkManifest, count: checkCount };
for (const c of toRun) checkMap[c]();

console.log(totalErrors === 0
  ? '\nAll checks passed.'
  : `\n${totalErrors} error(s) found.`);
process.exit(totalErrors === 0 ? 0 : 1);
