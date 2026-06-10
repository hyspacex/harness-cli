import fs from 'node:fs';

export function ledgerFile() {
  return process.env.LEDGER_FILE || 'ledger.jsonl';
}

export function readEvents() {
  const file = ledgerFile();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function appendEvent(type, payload) {
  const events = readEvents();
  const event = {
    seq: String(events.length + 1),
    ts: new Date().toISOString(),
    type,
    ...payload,
  };
  fs.appendFileSync(ledgerFile(), `${JSON.stringify(event)}\n`);
  return event;
}
