import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { PresenceInput, ServerMessage, SimObject, SimObjectInput } from './types.js';

export interface Peer {
  clientId: string;
  name?: string;
  send(msg: ServerMessage): void;
}

type Room = {
  id: string;
  objects: Map<string, SimObject>;
  peers: Map<string, Peer>;
  /** owners with a pending "clear my objects" timer after they dropped */
  expiring: Map<string, NodeJS.Timeout>;
};

/**
 * In-memory authoritative store of injected objects, grouped by session ("room").
 * Objects are ephemeral by design — the same as the standalone tool, which clears
 * everything on sim disconnect. Persistent GM-placed targets can move to Postgres
 * later without changing this contract.
 */
export class SyncHub {
  private rooms = new Map<string, Room>();

  private room(sessionId: string): Room {
    let room = this.rooms.get(sessionId);
    if (!room) {
      room = { id: sessionId, objects: new Map(), peers: new Map(), expiring: new Map() };
      this.rooms.set(sessionId, room);
    }
    return room;
  }

  private broadcast(room: Room, msg: ServerMessage, exceptClientId?: string): void {
    for (const peer of room.peers.values()) {
      if (peer.clientId === exceptClientId) continue;
      peer.send(msg);
    }
  }

  /** Is a client with this id already connected to the session? */
  hasPeer(sessionId: string, clientId: string): boolean {
    return this.rooms.get(sessionId)?.peers.has(clientId) ?? false;
  }

  /** Ids of every peer currently in the session (for logging/diagnostics). */
  peerIds(sessionId: string): string[] {
    return [...(this.rooms.get(sessionId)?.peers.keys() ?? [])];
  }

  /** A peer (re)joins a session. Returns the current object snapshot. */
  join(sessionId: string, peer: Peer): SimObject[] {
    const room = this.room(sessionId);

    // Reconnect within the grace window: cancel the pending purge of their objects.
    const pending = room.expiring.get(peer.clientId);
    if (pending) {
      clearTimeout(pending);
      room.expiring.delete(peer.clientId);
    }

    room.peers.set(peer.clientId, peer);
    this.broadcast(
      room,
      { type: 'peer.joined', clientId: peer.clientId, name: peer.name, count: room.peers.size },
      peer.clientId,
    );
    return [...room.objects.values()];
  }

  /** A peer disconnects. Their objects are purged after OWNER_GRACE_MS unless they return. */
  leave(sessionId: string, clientId: string): void {
    const room = this.rooms.get(sessionId);
    if (!room) return;
    room.peers.delete(clientId);
    this.broadcast(room, { type: 'peer.left', clientId, count: room.peers.size });

    const hasObjects = [...room.objects.values()].some((o) => o.ownerId === clientId);
    if (hasObjects && config.OWNER_GRACE_MS > 0) {
      const timer = setTimeout(() => {
        room.expiring.delete(clientId);
        this.removeByOwner(sessionId, clientId);
      }, config.OWNER_GRACE_MS);
      timer.unref?.();
      room.expiring.set(clientId, timer);
    } else if (hasObjects) {
      this.removeByOwner(sessionId, clientId);
    }

    if (room.peers.size === 0 && room.objects.size === 0 && room.expiring.size === 0) {
      this.rooms.delete(sessionId);
    }
  }

  create(sessionId: string, ownerId: string, input: SimObjectInput): { object: SimObject } | { error: string } {
    const room = this.room(sessionId);
    if (room.objects.size >= config.MAX_OBJECTS_PER_SESSION) {
      return { error: `Session object limit reached (${config.MAX_OBJECTS_PER_SESSION}).` };
    }
    const now = Date.now();
    const object: SimObject = {
      id: randomUUID(),
      ownerId,
      kind: input.kind,
      title: input.title,
      fallbacks: input.fallbacks,
      lat: input.lat,
      lon: input.lon,
      altFt: input.altFt,
      headingDeg: input.headingDeg,
      onGround: input.onGround,
      meta: input.meta,
      createdAt: now,
      updatedAt: now,
    };
    room.objects.set(object.id, object);
    this.broadcast(room, { type: 'object.created', tempId: input.tempId, object });
    return { object };
  }

  update(
    sessionId: string,
    clientId: string,
    id: string,
    patch: Partial<Pick<SimObject, 'lat' | 'lon' | 'altFt' | 'headingDeg' | 'onGround'>>,
  ): { object: SimObject } | { error: string } {
    const room = this.rooms.get(sessionId);
    const object = room?.objects.get(id);
    if (!room || !object) return { error: 'Unknown object.' };
    if (object.ownerId !== clientId) return { error: 'Not the owner of this object.' };
    Object.assign(object, patch, { updatedAt: Date.now() });
    this.broadcast(room, { type: 'object.updated', object });
    return { object };
  }

  remove(sessionId: string, clientId: string, id: string): { ok: true } | { error: string } {
    const room = this.rooms.get(sessionId);
    const object = room?.objects.get(id);
    if (!room || !object) return { error: 'Unknown object.' };
    if (object.ownerId !== clientId) return { error: 'Not the owner of this object.' };
    room.objects.delete(id);
    this.broadcast(room, { type: 'object.removed', id });
    return { ok: true };
  }

  removeByOwner(sessionId: string, ownerId: string): number {
    const room = this.rooms.get(sessionId);
    if (!room) return 0;
    let n = 0;
    for (const [id, object] of room.objects) {
      if (object.ownerId !== ownerId) continue;
      room.objects.delete(id);
      this.broadcast(room, { type: 'object.removed', id });
      n += 1;
    }
    return n;
  }

  /** Relay a peer's aircraft position to everyone else in the session. Not stored. */
  presence(sessionId: string, clientId: string, p: PresenceInput): void {
    const room = this.rooms.get(sessionId);
    if (!room) return;
    this.broadcast(room, { type: 'peer.presence', clientId, at: Date.now(), ...p }, clientId);
  }

  snapshot(sessionId: string): SimObject[] {
    return [...(this.rooms.get(sessionId)?.objects.values() ?? [])];
  }

  stats() {
    let objects = 0;
    let peers = 0;
    for (const room of this.rooms.values()) {
      objects += room.objects.size;
      peers += room.peers.size;
    }
    return { sessions: this.rooms.size, objects, peers };
  }
}

export const hub = new SyncHub();
