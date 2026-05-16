import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const runtimeImportPattern = /from\s+['"](?:\.\.\/|\.)?(?:harness|prompts|types)\.js['"]|from\s+['"](?:\.\.\/|\.)?providers\//;
const auditRuntimeImportPattern = /from\s+['"]\.\/(?:harness|prompts|types)\.js['"]|from\s+['"]\.\/providers\//;

async function listSourceFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(fullPath));
    } else if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

test('artifact schema and readers do not import runtime internals', async () => {
  const files = await listSourceFiles(path.resolve('src/artifacts'));
  assert.ok(files.length >= 2);

  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      runtimeImportPattern,
      `${path.relative(process.cwd(), file)} must stay independent from runtime internals`,
    );
  }
});

test('eval packet builder reads artifacts instead of runtime state', async () => {
  const source = await fs.readFile(path.resolve('src/evals.ts'), 'utf8');

  assert.doesNotMatch(source, auditRuntimeImportPattern);
  assert.doesNotMatch(source, /\bRunState\b/);
  assert.match(source, /readRunArtifactBundle/);
});

test('matrix report module does not import runtime execution internals', async () => {
  const source = await fs.readFile(path.resolve('src/matrix/report.ts'), 'utf8');

  assert.doesNotMatch(source, /from\s+['"]\.\.\/harness\.js['"]/);
  assert.doesNotMatch(source, /from\s+['"]\.\.\/prompts\.js['"]/);
  assert.doesNotMatch(source, /from\s+['"]\.\.\/providers\//);
});

test('eval-matrix wrapper lazy-loads runtime execution', async () => {
  const source = await fs.readFile(path.resolve('src/eval-matrix.ts'), 'utf8');

  assert.doesNotMatch(source, /from\s+['"]\.\/matrix\/execute\.js['"]/);
  assert.match(source, /import\(['"]\.\/matrix\/execute\.js['"]\)/);
});
