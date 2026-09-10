import { describe, expect, it, vi } from 'vitest';
import { SyncHub, type Peer } from './sync.js';
import type { ServerMessage, SimObjectInput } from './types.js';

function makePeer(clientId: string): Peer & { messages: ServerMessage[] } {
  const messages: ServerMessage[] = [];
  return { clientId, send: (m) => messages.push(m), messages };
}

const baseObject: SimObjectInput = {
  tempId: 't1',
  kind: 'vehicle',
  title: 'Container_Barrel',
  lat: -33.86,
  lon: 151.21,
  altFt: 0,
  headingDeg: 90,
  onGround: true,
};

describe('SyncHub', () => {
  it('broadcasts a created object to peers and returns it in later snapshots', () => {
    const hub = new SyncHub();
    const a = makePeer('a');
    const b = makePeer('b');
    hub.join('s1', a);
    hub.join('s1', b);

    const res = hub.create('s1', 'a', baseObject);
    expect('object' in res).toBe(true);

    const created = b.messages.find((m) => m.type === 'object.created');
    expect(created).toBeTruthy();

    const c = makePeer('c');
    const snapshot = hub.join('s1', c);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.title).toBe('Container_Barrel');
  });

  it('rejects updates and removes from a non-owner', () => {
    const hub = new SyncHub();
    hub.join('s1', makePeer('a'));
    hub.join('s1', makePeer('b'));
    const res = hub.create('s1', 'a', baseObject);
    const id = 'object' in res ? res.object.id : '';

    expect(hub.update('s1', 'b', id, { lat: 0 })).toEqual({ error: 'Not the owner of this object.' });
    expect(hub.remove('s1', 'b', id)).toEqual({ error: 'Not the owner of this object.' });
    expect(hub.update('s1', 'a', id, { lat: 1 })).toHaveProperty('object');
  });

  it('purges an owner’s objects after the grace window, but not if they reconnect first', () => {
    vi.useFakeTimers();
    try {
      const hub = new SyncHub();
      hub.join('s1', makePeer('a'));
      hub.create('s1', 'a', baseObject);

      hub.leave('s1', 'a');
      hub.join('s1', makePeer('a')); // reconnect before the timer fires
      vi.advanceTimersByTime(120_000);
      expect(hub.snapshot('s1')).toHaveLength(1);

      hub.leave('s1', 'a');
      vi.advanceTimersByTime(120_000);
      expect(hub.snapshot('s1')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
