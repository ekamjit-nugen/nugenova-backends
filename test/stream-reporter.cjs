/**
 * Jest reporter that emits one JSON line per test case as it finishes, prefixed
 * with a marker so the caller can pick our events out of jest's normal stdout.
 * Used by the super-admin playbook viewer's live test runner (admin-playbooks
 * spawns jest with `--reporters ./test/stream-reporter.cjs` and streams these to
 * the browser).
 */
const path = require('path');
const MARKER = 'NUGENOVA_EVT ';
// Strip ANSI colour sequences (ESC [ … m) from jest's failure messages.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

class StreamReporter {
  _emit(obj) {
    process.stdout.write(MARKER + JSON.stringify(obj) + '\n');
  }

  onRunStart() {
    this._emit({ type: 'run-start' });
  }

  onTestCaseResult(test, tc) {
    this._emit({
      type: 'test',
      title: tc.title,
      fullName: tc.fullName,
      status: tc.status, // passed | failed | skipped | pending | todo
      duration: tc.duration || 0,
      file: path.basename(test.path),
      failureMessages: (tc.failureMessages || []).map((m) =>
        String(m).replace(ANSI, '').split('\n').slice(0, 8).join('\n'),
      ),
    });
  }

  onRunComplete(_contexts, results) {
    this._emit({
      type: 'suite-complete',
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      total: results.numTotalTests,
      success: results.success,
    });
  }
}

module.exports = StreamReporter;
