import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function freshLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  return path.join(dir, 'ledger.jsonl');
}

function run(file, args) {
  return execFileSync('node', ['bin/ledger.mjs', ...args], {
    env: { ...process.env, LEDGER_FILE: file },
    encoding: 'utf8',
  });
}

function runExpectFail(file, args) {
  try {
    execFileSync('node', ['bin/ledger.mjs', ...args], {
      env: { ...process.env, LEDGER_FILE: file },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    return { code: error.status, stderr: String(error.stderr) };
  }
  throw new Error(`expected failure: ledger ${args.join(' ')}`);
}

test('add then state shows the item', () => {
  const file = freshLedger();
  run(file, ['add', 'widget', '5']);
  const state = JSON.parse(run(file, ['state']));
  assert.deepEqual(state, { widget: { qty: 5 } });
});

test('adjust changes quantity of an existing item', () => {
  const file = freshLedger();
  run(file, ['add', 'widget', '5']);
  run(file, ['adjust', 'widget', '-2']);
  const state = JSON.parse(run(file, ['state']));
  assert.equal(state.widget.qty, 3);
});

test('remove deletes the item from state but keeps history', () => {
  const file = freshLedger();
  run(file, ['add', 'widget', '5']);
  run(file, ['remove', 'widget']);
  const state = JSON.parse(run(file, ['state']));
  assert.deepEqual(state, {});
  assert.match(run(file, ['history']), /1 add widget 5/);
  assert.match(run(file, ['history']), /2 remove widget/);
});

test('duplicate add fails with non-zero exit', () => {
  const file = freshLedger();
  run(file, ['add', 'widget', '5']);
  const failure = runExpectFail(file, ['add', 'widget', '2']);
  assert.notEqual(failure.code, 0);
  assert.match(failure.stderr, /already exists/);
});

test('unknown command fails with non-zero exit', () => {
  const failure = runExpectFail(freshLedger(), ['frobnicate']);
  assert.notEqual(failure.code, 0);
  assert.match(failure.stderr, /unknown command/);
});
