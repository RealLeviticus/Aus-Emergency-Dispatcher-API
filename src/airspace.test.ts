import { describe, expect, it } from 'vitest';
import { AAR_ANCHORS, REFUELLING_TRACKS } from './airspace.js';
import { generateRaafJob } from './jobgen.js';

/**
 * The airspace data is transcribed from a PDF, so the risk is not that the code
 * is wrong but that a coordinate is. These check the things a bad transcription
 * would break: a point outside Australia, a track whose named points are not on
 * it, a degrees/minutes mix-up (which shows up as an absurd leg length), and
 * refuelling tasking that quietly stops using the published tracks at all.
 */

const FIR = (lat: number, lon: number) => lat < -8 && lat > -46 && lon > 108 && lon < 165;

function nm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const dLat = (b.lat - a.lat) * 60;
  const dLon = (b.lon - a.lon) * 60 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

describe('published airspace (FIHA 2609)', () => {
  it('has every refuelling track point inside the Australian FIR', () => {
    for (const t of REFUELLING_TRACKS) {
      expect(t.points.length, t.name).toBeGreaterThanOrEqual(4);
      for (const p of t.points) {
        expect(FIR(p.lat, p.lon), `${t.name} ${p.id} ${p.lat},${p.lon}`).toBe(true);
      }
    }
  });

  it('names join, control, check and exit points that are actually on the track', () => {
    for (const t of REFUELLING_TRACKS) {
      const ids = t.points.map((p) => p.id);
      for (const id of [t.rvip, t.rvcp, t.navChk, t.exit]) {
        expect(ids, `${t.name} is missing ${id}`).toContain(id);
      }
      // the track is flown from the join point toward the exit
      expect(ids.indexOf(t.rvip), t.name).toBeLessThan(ids.indexOf(t.exit));
    }
  });

  it('has plausible leg lengths — a DMS slip would show up here', () => {
    for (const t of REFUELLING_TRACKS) {
      for (let i = 1; i < t.points.length; i++) {
        const d = nm(t.points[i - 1]!, t.points[i]!);
        expect(d, `${t.name} ${t.points[i - 1]!.id}->${t.points[i]!.id} is ${d.toFixed(0)} NM`).toBeGreaterThan(20);
        expect(d, `${t.name} ${t.points[i - 1]!.id}->${t.points[i]!.id} is ${d.toFixed(0)} NM`).toBeLessThan(400);
      }
    }
  });

  it('keeps each base’s anchor waypoints near that base', () => {
    const bases: Record<string, { lat: number; lon: number }> = {
      Amberley: { lat: -27.64, lon: 152.71 },
      Darwin: { lat: -12.42, lon: 130.89 },
      EAXA: { lat: -36.5, lon: 151.0 },
      Edinburgh: { lat: -34.7, lon: 138.62 },
      Tindal: { lat: -14.52, lon: 132.38 },
      Townsville: { lat: -19.25, lon: 146.77 },
      Williamtown: { lat: -32.8, lon: 151.83 },
    };
    for (const [name, pts] of Object.entries(AAR_ANCHORS)) {
      expect(pts.length, name).toBeGreaterThan(0);
      const ref = bases[name];
      expect(ref, `unknown anchor set ${name}`).toBeTruthy();
      for (const p of pts) {
        expect(FIR(p.lat, p.lon), `${name} ${p.id}`).toBe(true);
        expect(nm(ref!, p), `${name} ${p.id} is ${nm(ref!, p).toFixed(0)} NM from base`).toBeLessThan(700);
      }
    }
  });
});

describe('refuelling tasking', () => {
  const jobs = (kind: string, n = 4000) => {
    const out = [];
    for (let i = 0; i < n && out.length < 25; i++) {
      const j = generateRaafJob(null);
      if (j.kind === kind) out.push(j);
    }
    return out;
  };

  it('always puts the tanker on a published track', () => {
    const found = jobs('Air-To-Air Refuelling - Towline');
    expect(found.length).toBeGreaterThan(0);
    const names = REFUELLING_TRACKS.map((t) => t.name);
    for (const j of found) {
      const named = names.find((n) => j.detail.includes(n));
      expect(named, `no published track named in: ${j.detail.slice(0, 120)}`).toBeTruthy();
      const track = REFUELLING_TRACKS.find((t) => t.name === named)!;
      // the job sits at the rendezvous control point of that same track
      const rvcp = track.points.find((p) => p.id === track.rvcp)!;
      expect(nm(rvcp, { lat: j.lat, lon: j.lon })).toBeLessThan(1);
      // and the brief quotes that track's own points and block
      expect(j.detail).toContain(track.rvip);
      expect(j.detail).toContain(track.exit);
      expect(j.detail).toContain(track.altitudes);
      expect(j.detail).toContain(track.freq);
    }
  });

  it('anchors the AEW&C orbit on a published waypoint', () => {
    const found = jobs('ISR Orbit - Recognised Air Picture');
    expect(found.length).toBeGreaterThan(0);
    const all = Object.values(AAR_ANCHORS).flat();
    for (const j of found) {
      const id = j.detail.match(/anchored on ([A-Z0-9]+)/)?.[1];
      if (!id) continue; // a base with no published anchor airspace falls back
      const w = all.find((p) => p.id === id);
      expect(w, `${id} is not a published anchor waypoint`).toBeTruthy();
      expect(nm(w!, { lat: j.lat, lon: j.lon })).toBeLessThan(1);
    }
  });
});
