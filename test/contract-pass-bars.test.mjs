import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveContractPassBarOverrides,
  getFailingScores,
  resolvePass,
} from '../dist/utils.js';

const evalCriteria = {
  universalCriteria: {
    conceptAlignment: { passBar: 4 },
    completeness: { passBar: 4 },
    craft: { passBar: 3 },
    intentionality: { passBar: 3 },
  },
  projectCriteria: [
    {
      id: 'ticketLifecycleCoverage',
      passBar: 4,
      rubric: {},
    },
    {
      id: 'seedDataPresence',
      passBar: 4,
      rubric: {},
    },
    {
      id: 'smokeTestReadiness',
      passBar: 5,
      rubric: {},
    },
    {
      id: 'visualDesignAndLayout',
      passBar: 3,
      rubric: {},
    },
    {
      id: 'filterAndSearch',
      passBar: 3,
      rubric: {},
    },
  ],
};

const contract = {
  version: 1,
  sprint: 1,
  feature: { id: 'F01', title: 'Seeded queue dashboard' },
  inScope: [],
  outOfScope: [],
  doneMeans: [],
  verificationSteps: [],
  hardThresholds: [
    'conceptAlignment >= 4',
    'completeness >= 4',
    'craft >= 3',
    'intentionality >= 3',
    'ticketLifecycleCoverage >= 2',
    'seedDataPresence >= 4',
    'smokeTestReadiness >= 4',
    'visualDesignAndLayout >= 3',
    'filterAndSearch >= 1',
  ],
  risksNotes: [],
  passBarOverrides: {
    ticketLifecycleCoverage: 2,
    filterAndSearch: 1,
  },
  sourceMarkdownPath: '/tmp/contract-01.md',
};

test('deriveContractPassBarOverrides merges lowered hardThresholds with explicit overrides', () => {
  const overrides = deriveContractPassBarOverrides(contract, evalCriteria);

  assert.deepEqual(overrides, {
    ticketLifecycleCoverage: 2,
    smokeTestReadiness: 4,
    filterAndSearch: 1,
  });
});

test('resolvePass uses thresholds derived from the canonical contract hard-threshold list', () => {
  const overrides = deriveContractPassBarOverrides(contract, evalCriteria);
  const parsedEval = {
    scores: {
      conceptAlignment: 4,
      completeness: 4,
      craft: 4,
      intentionality: 4,
      ticketLifecycleCoverage: 2,
      seedDataPresence: 4,
      smokeTestReadiness: 4,
      visualDesignAndLayout: 4,
      filterAndSearch: 1,
    },
  };

  assert.equal(resolvePass(parsedEval, evalCriteria, overrides), true);
  assert.deepEqual(getFailingScores(parsedEval, evalCriteria, overrides), []);
});
