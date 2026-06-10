import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const CORE_DIR = path.resolve('src/core');
const LAB_DIR = path.resolve('src/lab');

// Matches static import/export-from and dynamic import() specifiers.
const specifierPattern = /(?:import|export)\s+[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
const labPathPattern = /(?:^|\/)lab\//;

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

function collectImportSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(specifierPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

test('src/core never imports from src/lab', async () => {
  const files = await listSourceFiles(CORE_DIR);
  assert.ok(files.length >= 10, 'expected the core tree to contain source files');

  const violations = [];
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    for (const specifier of collectImportSpecifiers(source)) {
      if (labPathPattern.test(specifier)) {
        violations.push(`${path.relative(process.cwd(), file)} -> ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, [], `core must not depend on lab:\n${violations.join('\n')}`);
});

test('src/lab exists and depends on core (lab -> core direction)', async () => {
  const stats = await fs.stat(LAB_DIR);
  assert.ok(stats.isDirectory(), 'src/lab must exist');

  const files = await listSourceFiles(LAB_DIR);
  assert.ok(files.length >= 4, 'expected the lab tree to contain source files');

  let labImportsCore = false;
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const specifiers = collectImportSpecifiers(source);
    if (specifiers.some((specifier) => /(?:^|\/)core\//.test(specifier))) {
      labImportsCore = true;
      break;
    }
  }

  assert.ok(labImportsCore, 'at least one lab file must import from ../core/');
});
