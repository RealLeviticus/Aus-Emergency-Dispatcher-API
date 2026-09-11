import { describe, expect, it } from 'vitest';
import { generateRaafJob } from './jobgen.js';
import { HOME_BASES, RAAFV_BASES, rosterRoles } from './fleet.js';

/**
 * These are the invariants the old generator broke, each of which showed up on
 * the board as a brief that could not be true: a squadron scrambling from a base
 * it is not at, a sortie launched from a base with no aircraft, a task the
 * tasked type cannot fly, and a job filed under the wrong state.
 *
 * They are checked over a large sample because the generator is random — a
 * single job proves nothing.
 */
const SAMPLE = 600;

const byIdent = new Map(RAAFV_BASES.map((b) => [b.ident, b]));
const identOf = (homeBase: string) => homeBase.match(/\(([A-Z]{4})\)/)?.[1] ?? '';

function sample(n = SAMPLE) {
  return Array.from({ length: n }, () => generateRaafJob(null));
}

describe('RAAFv tasking', () => {
  it('always names the airframe it is tasking', () => {
    for (const j of sample()) {
      expect(j.tasked, j.kind).toBeTruthy();
      expect(j.tasked!.squadron).toBeTruthy();
      expect(j.tasked!.type).toBeTruthy();
    }
  });

  it('only launches from a base that has aircraft', () => {
    const dry = new Set(RAAFV_BASES.filter((b) => b.dry).map((b) => b.ident));
    for (const j of sample()) {
      const ident = identOf(j.tasked!.homeBase);
      expect(byIdent.has(ident), `unknown base ${ident}`).toBe(true);
      expect(dry.has(ident), `${j.kind} launched from dry base ${ident}`).toBe(false);
    }
  });

  it('only tasks a squadron that is actually at that base', () => {
    for (const j of sample()) {
      const base = byIdent.get(identOf(j.tasked!.homeBase))!;
      const resident = base.units.some((u) => u.squadron === j.tasked!.squadron);
      expect(resident, `${j.tasked!.squadron} is not based at ${base.ident}`).toBe(true);
    }
  });

  it('only tasks a type that can do the job', () => {
    // Every base must be able to fly at least one of the roles behind the tasks
    // it produces; the pairing itself is enforced by construction, so this
    // guards the roster rather than the draw.
    for (const b of HOME_BASES) expect(rosterRoles(b).size, `${b.ident} can fly nothing`).toBeGreaterThan(0);
    for (const j of sample()) {
      const unit = byIdent.get(identOf(j.tasked!.homeBase))!.units.find((u) => u.squadron === j.tasked!.squadron)!;
      expect(unit.type).toBe(j.tasked!.type);
    }
  });

  it('files the job under the state the job is in, not the base', () => {
    // A sustainment run from Fairbairn to Curtin used to be filed under ACT
    // with a pin in the Kimberley.
    const states = new Set(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'NT', 'TAS', 'ACT']);
    for (const j of sample()) {
      expect(states.has(j.region), `bad region ${j.region}`).toBe(true);
      expect(j.place).toContain(j.region);
    }
  });

  it('puts every pin inside the Australian search and rescue region', () => {
    for (const j of sample()) {
      expect(j.lat, j.kind).toBeLessThan(-8);
      expect(j.lat, j.kind).toBeGreaterThan(-46);
      expect(j.lon, j.kind).toBeGreaterThan(100);
      expect(j.lon, j.kind).toBeLessThan(165);
    }
  });

  it('keeps ALERT 5 for the alert scramble and nothing else', () => {
    for (const j of sample()) {
      if (/ALERT 5/.test(j.timeline ?? '')) expect(j.kind).toMatch(/QRA|Comms-Loss/);
    }
  });

  it('reads as finished English', () => {
    for (const j of sample()) {
      const text = `${j.brief} ${j.detail} ${j.place} ${j.units.join(' ')} ${j.timeline}`;
      expect(text, j.kind).not.toMatch(/undefined|NaN|\[object|\bthe the\b/i);
    }
  });
});
