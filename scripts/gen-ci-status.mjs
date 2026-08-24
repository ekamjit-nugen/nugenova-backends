#!/usr/bin/env node
/**
 * Generate `ci-status.json` — the per-module test status the super-admin
 * playbook viewer reads (see admin-playbooks.service). Runs the unit + e2e
 * suites with `--json`, tallies pass/fail per module (by the `modules/<name>/`
 * segment of each test file path), and writes a map keyed by module:
 *
 *   { "<module>": { status, passed, failed, total, ranAt, runUrl } }
 *
 * Run locally (`node scripts/gen-ci-status.mjs`, needs DATABASE_URL for e2e) or
 * in CI after the suites pass. Exits 0 even if tests failed — the point is to
 * RECORD the outcome, not gate on it (the CI jobs gate).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ci-status-'));

function runJest(extraArgs, outFile) {
  try {
    execFileSync(
      'npx',
      ['jest', ...extraArgs, '--json', `--outputFile=${outFile}`],
      { stdio: 'ignore', env: process.env },
    );
  } catch {
    // Jest exits non-zero when a test fails, but still writes the JSON report.
  }
  try {
    return JSON.parse(readFileSync(outFile, 'utf8'));
  } catch {
    return { testResults: [] };
  }
}

function moduleOf(filePath) {
  const m = (filePath || '').match(/modules[/\\]([^/\\]+)[/\\]/);
  return m ? m[1] : null;
}

const perModule = {}; // module -> { passed, failed }
function tally(report) {
  for (const tr of report.testResults || []) {
    const mod = moduleOf(tr.testFilePath || tr.name || '');
    if (!mod) continue;
    perModule[mod] ??= { passed: 0, failed: 0 };
    for (const a of tr.assertionResults || []) {
      if (a.status === 'passed') perModule[mod].passed += 1;
      else if (a.status === 'failed') perModule[mod].failed += 1;
    }
  }
}

tally(runJest([], join(tmp, 'unit.json')));
tally(runJest(['--config', 'jest.e2e.config.js'], join(tmp, 'e2e.json')));

const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
const ranAt = new Date().toISOString();

const out = {};
for (const [mod, { passed, failed }] of Object.entries(perModule)) {
  const total = passed + failed;
  out[mod] = {
    status: failed > 0 ? 'failing' : total > 0 ? 'passing' : 'unknown',
    passed,
    failed,
    total,
    ranAt,
    runUrl,
  };
}

writeFileSync('ci-status.json', JSON.stringify(out, null, 2) + '\n');
console.log('Wrote ci-status.json:', JSON.stringify(out, null, 2));
