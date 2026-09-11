/**
 * tsc emits only JavaScript, and the runtime image copies just dist/ — so any
 * data file the server reads at runtime has to be placed there explicitly.
 * Without this, src/features.json never reaches production and scene placement
 * silently falls back to random bearings.
 */
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const ASSETS = ['features.json', 'roads.json', 'aerodromes.json', 'hospitals.json', 'hospital-airports.json'];
mkdirSync('dist', { recursive: true });
for (const f of ASSETS) {
  const from = path.join('src', f);
  if (!existsSync(from)) {
    const how = f === 'roads.json' ? 'prebake:roads' : 'prebake:features';
    console.warn(`[copy-assets] ${from} missing — run "npm run ${how}"`);
    continue;
  }
  copyFileSync(from, path.join('dist', f));
  console.log(`[copy-assets] ${f}`);
}
