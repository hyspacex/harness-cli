#!/usr/bin/env node
import { appendEvent } from '../src/events.mjs';
import { currentState } from '../src/state.mjs';
import { readEvents } from '../src/events.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseIntStrict(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value)) fail(`${label} must be an integer, got "${raw}"`);
  return value;
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'add': {
    const [name, qtyRaw] = args;
    if (!name || qtyRaw === undefined) fail('usage: ledger add <name> <qty>');
    const qty = parseIntStrict(qtyRaw, 'qty');
    if (qty <= 0) fail('qty must be positive');
    if (currentState()[name]) fail(`item already exists: ${name}`);
    appendEvent('add', { name, qty });
    console.log(`added ${name} (${qty})`);
    break;
  }
  case 'adjust': {
    const [name, deltaRaw] = args;
    if (!name || deltaRaw === undefined) fail('usage: ledger adjust <name> <delta>');
    const delta = parseIntStrict(deltaRaw, 'delta');
    if (delta === 0) fail('delta must be non-zero');
    appendEvent('adjust', { name, delta });
    console.log(`adjusted ${name} by ${delta}`);
    break;
  }
  case 'remove': {
    const [name] = args;
    if (!name) fail('usage: ledger remove <name>');
    if (!currentState()[name]) fail(`no such item: ${name}`);
    appendEvent('remove', { name });
    console.log(`removed ${name}`);
    break;
  }
  case 'state': {
    console.log(JSON.stringify(currentState(), null, 2));
    break;
  }
  case 'history': {
    for (const event of readEvents()) {
      const detail = event.type === 'adjust' ? event.delta : event.type === 'add' ? event.qty : '';
      console.log(`${event.seq} ${event.type} ${event.name ?? ''} ${detail}`.trim());
    }
    break;
  }
  default:
    fail(`unknown command: ${command || '(none)'}\ncommands: add, adjust, remove, state, history`);
}
