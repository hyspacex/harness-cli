import { readEvents } from './events.mjs';

/** Replay events in seq order to derive current inventory state. */
export function replay(events) {
  const ordered = [...events].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  const items = {};
  for (const event of ordered) {
    applyEvent(items, event);
  }
  return items;
}

export function applyEvent(items, event) {
  if (event.type === 'add') {
    items[event.name] = { qty: event.qty };
  } else if (event.type === 'adjust') {
    const item = items[event.name] || { qty: 0 };
    item.qty += event.delta;
    items[event.name] = item;
  } else if (event.type === 'remove') {
    delete items[event.name];
  }
  return items;
}

export function currentState() {
  return replay(readEvents());
}
