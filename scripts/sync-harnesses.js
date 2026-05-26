#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error('ERROR: js-yaml not installed. Run: npm install');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv       = process.argv.slice(2);
const CHECK      = argv.includes('--check');
const harnessRaw = (argv.find(a => a.startsWith('--harness=')) || '').split('=')[1] || 'all';

if (!['cursor', 'codex', 'all'].includes(harnessRaw)) {
  console.error('ERROR: --harness must be one of: cursor, codex, all');
  process.exit(1);
}

const RUN_CURSOR = harnessRaw === 'all' || harnessRaw === 'cursor';
const RUN_CODEX  = harnessRaw === 'all' || harnessRaw === 'codex';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let driftDetected = false;

// ---------------------------------------------------------------------------
// Logging and error handling
// ---------------------------------------------------------------------------

function log(msg)   { console.log(msg); }
function fatal(msg) { console.error(`\nERROR: ${msg}`); process.exit(1); }

// ---------------------------------------------------------------------------
// Output writer (handles --check, idempotency, and em dash rejection)
// ---------------------------------------------------------------------------

function writeOutput(filePath, content) {
  if (content.includes('—')) {
    fatal(
      `Em dash detected in generated output for ${path.relative(ROOT, filePath)}. ` +
      'Fix the canonical source to remove em dashes before running sync.'
    );
  }

  const rel = path.relative(ROOT, filePath);

  if (CHECK) {
    if (!fs.existsSync(filePath)) {
      log(`  DRIFT    ${rel}  (would be created)`);
      driftDetected = true;
    } else if (fs.readFileSync(filePath, 'utf8') !== content) {
      log(`  DRIFT    ${rel}  (content would change)`);
      driftDetected = true;
    } else {
      log(`  OK       ${rel}`);
    }
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (existing === content) {
    log(`  SKIP     ${rel}  (unchanged)`);
  } else {
    fs.writeFileSync(filePath, content, 'utf8');
    log(`  WRITE    ${rel}`);
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

// Captures frontmatter between opening and closing --- delimiters, plus body.
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

// Line-by-line fallback for frontmatter whose values contain characters that
// js-yaml interprets as flow sequences (e.g. argument-hint: [--flag] [--other]).
function parseYamlLenient(yamlStr, filePath) {
  try {
    const parsed = yaml.load(yamlStr);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {
    // Fall through to line parser.
  }

  const result = {};
  for (const line of yamlStr.split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s+(.+)$/);
    if (m) result[m[1].trim()] = m[2].trim();
  }

  if (Object.keys(result).length === 0) {
    fatal(`Malformed frontmatter in ${path.relative(ROOT, filePath)}: neither YAML nor key: value pairs could be extracted`);
  }

  return result;
}

function parseMd(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    fatal(`Cannot read ${path.relative(ROOT, filePath)}: ${e.message}`);
  }

  const m = raw.match(FM_RE);
  if (!m) return { fm: null, body: raw };

  const fm = parseYamlLenient(m[1], filePath);
  return { fm, body: m[2] };
}

function requireFields(fm, fields, filePath) {
  for (const field of fields) {
    if (fm[field] === undefined || fm[field] === null || fm[field] === '') {
      fatal(`Missing required frontmatter field '${field}' in ${path.relative(ROOT, filePath)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Source loaders
// ---------------------------------------------------------------------------

function loadPlugin() {
  const p = path.join(ROOT, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(p)) fatal('.claude-plugin/plugin.json not found');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fatal(`.claude-plugin/plugin.json is not valid JSON: ${e.message}`);
  }
}

function loadAgents() {
  const dir = path.join(ROOT, 'agents');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => {
      const fp     = path.join(dir, f);
      const { fm, body } = parseMd(fp);
      if (!fm) fatal(`Agent file agents/${f} has no YAML frontmatter`);
      requireFields(fm, ['name', 'description', 'tools', 'model'], fp);
      if (!Array.isArray(fm.tools)) fatal(`'tools' must be a YAML array in agents/${f}`);
      return { fm, body, file: f };
    });
}

function loadSkills() {
  const dir = path.join(ROOT, 'skills');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => {
      const fp = path.join(dir, e.name, 'SKILL.md');
      if (!fs.existsSync(fp)) fatal(`Missing SKILL.md in skills/${e.name}`);
      const { fm, body } = parseMd(fp);
      if (!fm) fatal(`skills/${e.name}/SKILL.md has no YAML frontmatter`);
      requireFields(fm, ['name', 'description'], fp);
      return { fm, body, dir: e.name };
    });
}

function loadRules() {
  const dir = path.join(ROOT, 'rules');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => {
      const fp          = path.join(dir, f);
      const { fm, body } = parseMd(fp);
      // Rules may lack frontmatter; parseMd returns body === raw content in that case.
      return { fm, body, file: f, name: path.basename(f, '.md') };
    });
}

function loadCommands() {
  const dir = path.join(ROOT, 'commands');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => {
      const fp          = path.join(dir, f);
      const { fm, body } = parseMd(fp);
      // Command name is derived from filename; commands do not have a 'name' frontmatter field.
      return { fm, body, file: f, name: path.basename(f, '.md') };
    });
}

// ---------------------------------------------------------------------------
// Cursor content builders
// ---------------------------------------------------------------------------

function yamlList(items) {
  return items.map(i => `  - ${i}`).join('\n');
}

function aegisPrefix(name) {
  return name.startsWith('aegis-') ? name : `aegis-${name}`;
}

function buildCursorAgentContent(agent) {
  const name = aegisPrefix(agent.fm.name);
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${agent.fm.description}`,
    'tools:',
    yamlList(agent.fm.tools),
    '---',
  ].join('\n');
  return fm + '\n\n' + agent.body.trimStart();
}

function buildCursorSkillContent(skill) {
  const name    = aegisPrefix(skill.fm.name);
  const lines   = ['---', `name: ${name}`, `description: ${skill.fm.description}`];
  if (skill.fm.origin) lines.push(`origin: ${skill.fm.origin}`);
  if (skill.fm.tools) {
    if (Array.isArray(skill.fm.tools)) {
      lines.push('tools:');
      for (const t of skill.fm.tools) lines.push(`  - ${t}`);
    } else {
      lines.push(`tools: ${skill.fm.tools}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n\n' + skill.body.trimStart();
}

function buildCursorCommandsContent(commands) {
  const lines = [
    '# Aegis Commands -- Cursor Reference',
    '',
    'Cursor does not support native slash commands. The following documents each Aegis command protocol and how to invoke it as a Cursor Composer task.',
    '',
    '---',
    '',
  ];

  for (const cmd of commands) {
    lines.push(`## /aegis:${cmd.name}`);
    lines.push('');
    if (cmd.fm && cmd.fm.description) {
      lines.push(cmd.fm.description);
      lines.push('');
    }
    if (cmd.fm && cmd.fm['argument-hint']) {
      lines.push(`**Arguments:** \`${cmd.fm['argument-hint']}\``);
      lines.push('');
    }
    lines.push(
      '**Invocation:** Open the Composer, attach the relevant Aegis agent via `@Aegis`, ' +
      'and submit the command body below as the task prompt.'
    );
    lines.push('');
    lines.push(cmd.body.trimStart().trimEnd());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function buildCursorRulesContent(rules) {
  const lines = [
    '# Aegis Rules',
    '',
    'Mandatory constraints for all Solidity authorship, review, and testing in this repository.',
    '',
  ];

  for (const rule of rules) {
    lines.push('---');
    lines.push('');
    lines.push(rule.body.trimStart().trimEnd());
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Codex content builder
// ---------------------------------------------------------------------------

function buildCodexContent(plugin, agents, skills, rules, commands) {
  const lines = [];

  // Identity section
  lines.push('# Aegis');
  lines.push('');
  lines.push(`> ${plugin.description}`);
  lines.push('');
  lines.push(`**Version:** ${plugin.version}  `);
  lines.push(`**Author:** ${plugin.author.name}  `);
  lines.push(`**License:** ${plugin.license}  `);
  lines.push(`**Repository:** ${plugin.repository}`);
  lines.push('');
  lines.push(
    'This file is generated by `scripts/sync-harnesses.js` from the canonical Claude Code ' +
    'source in `agents/`, `skills/`, `rules/`, and `commands/`. ' +
    'Do not edit directly -- run `npm run sync` after any canonical change.'
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  // Agents section
  lines.push('## Agents');
  lines.push('');
  lines.push(
    'The following agents are available for invocation. Each defines its trigger condition, ' +
    'scope, and output format.'
  );
  lines.push('');
  for (const agent of agents) {
    lines.push(`### ${agent.fm.name}`);
    lines.push('');
    lines.push(`**Description:** ${agent.fm.description}  `);
    lines.push(`**Tools:** ${agent.fm.tools.join(', ')}`);
    lines.push('');
    lines.push(agent.body.trimStart().trimEnd());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Skills section
  lines.push('## Skills');
  lines.push('');
  lines.push(
    'Skills are reference knowledge modules invoked by name. ' +
    'Each is self-contained and independently applicable.'
  );
  lines.push('');
  for (const skill of skills) {
    lines.push(`### ${skill.fm.name}`);
    lines.push('');
    lines.push(`**Description:** ${skill.fm.description}`);
    if (skill.fm.tools) {
      const toolList = Array.isArray(skill.fm.tools)
        ? skill.fm.tools.join(', ')
        : skill.fm.tools;
      lines.push(`**Tools:** ${toolList}`);
    }
    lines.push('');
    lines.push(skill.body.trimStart().trimEnd());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Rules section
  lines.push('## Rules');
  lines.push('');
  lines.push(
    'These constraints are mandatory and apply to all Solidity authorship, review, and ' +
    'testing in this repository.'
  );
  lines.push('');
  for (const rule of rules) {
    lines.push(`### ${rule.name}`);
    lines.push('');
    lines.push(rule.body.trimStart().trimEnd());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Commands section
  lines.push('## Commands');
  lines.push('');
  lines.push(
    'Commands are orchestration protocols. Provide the command name and flags as the task description.'
  );
  lines.push('');
  for (const cmd of commands) {
    lines.push(`### /${cmd.name}`);
    lines.push('');
    if (cmd.fm && cmd.fm.description) {
      lines.push(cmd.fm.description);
      lines.push('');
    }
    if (cmd.fm && cmd.fm['argument-hint']) {
      lines.push(`**Arguments:** \`${cmd.fm['argument-hint']}\``);
      lines.push('');
    }
    lines.push(cmd.body.trimStart().trimEnd());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sync runners
// ---------------------------------------------------------------------------

function syncCursor(agents, skills, rules, commands) {
  log('\n[Cursor: agents]');
  for (const agent of agents) {
    const name = aegisPrefix(agent.fm.name);
    writeOutput(
      path.join(ROOT, '.cursor', 'agents', `${name}.md`),
      buildCursorAgentContent(agent)
    );
  }

  log('\n[Cursor: skills]');
  for (const skill of skills) {
    const name = aegisPrefix(skill.fm.name);
    writeOutput(
      path.join(ROOT, '.cursor', 'skills', name, 'SKILL.md'),
      buildCursorSkillContent(skill)
    );
  }

  log('\n[Cursor: commands]');
  writeOutput(
    path.join(ROOT, '.cursor', 'aegis-commands.md'),
    buildCursorCommandsContent(commands)
  );

  log('\n[Cursor: rules]');
  writeOutput(
    path.join(ROOT, '.cursorrules'),
    buildCursorRulesContent(rules)
  );
}

function syncCodex(plugin, agents, skills, rules, commands) {
  log('\n[Codex: AGENTS.md]');
  writeOutput(
    path.join(ROOT, 'AGENTS.md'),
    buildCodexContent(plugin, agents, skills, rules, commands)
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  log(`aegis sync-harnesses  harness=${harnessRaw}${CHECK ? '  [--check]' : ''}`);

  log('\n[Loading canonical source]');
  const plugin   = loadPlugin();
  log(`  plugin     ${plugin.name} v${plugin.version}`);
  const agents   = loadAgents();
  log(`  agents     ${agents.length}`);
  const skills   = loadSkills();
  log(`  skills     ${skills.length}`);
  const rules    = loadRules();
  log(`  rules      ${rules.length}`);
  const commands = loadCommands();
  log(`  commands   ${commands.length}`);

  if (RUN_CURSOR) syncCursor(agents, skills, rules, commands);
  if (RUN_CODEX)  syncCodex(plugin, agents, skills, rules, commands);

  if (CHECK) {
    if (driftDetected) {
      log('\nDrift detected. Run `npm run sync` to bring generated outputs up to date.');
      process.exit(1);
    }
    log('\nNo drift detected. All generated outputs are current.');
  } else {
    log('\nSync complete.');
  }
}

main();
