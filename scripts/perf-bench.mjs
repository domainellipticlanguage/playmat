#!/usr/bin/env node
/**
 * Busy-table render benchmark. Two players; ~60 cards on the battlefield.
 * Drives pan, zoom, card drag, hover sweeps, and peer cursor/drag traffic,
 * and reports React commit count + time (dev Profiler hook in main.tsx) and
 * long frames per scenario.
 *
 * Prereq: dev servers running (`npm run dev`).
 * Usage:  node scripts/perf-bench.mjs [--headed]
 */
import { chromium } from 'playwright';

const BASE = process.env.PLAYMAT_URL ?? 'http://localhost:5173';
const DECK = `1 Sol Ring
1 Arcane Signet
1 Command Tower
1 Llanowar Elves
1 Elvish Mystic
1 Birds of Paradise
1 Lightning Bolt
1 Counterspell
1 Swords to Plowshares
1 Path to Exile
1 Cultivate
1 Kodama's Reach
1 Rampant Growth
1 Grizzly Bears
1 Serra Angel
1 Shivan Dragon
1 Llanowar Wastes
1 Wrath of God
1 Doom Blade
1 Giant Growth
1 Ponder
1 Preordain
1 Brainstorm
1 Opt
1 Mind Stone
1 Thought Vessel
1 Fellwar Stone
1 Talisman of Progress
1 Eternal Witness
1 Solemn Simulacrum
1 Wood Elves
1 Farhaven Elf
1 Sakura-Tribe Elder
1 Beast Within
1 Chaos Warp
1 Reliquary Tower
1 Rhystic Study
1 Mystic Remora
1 Smothering Tithe
1 Esper Sentinel
1 Cyclonic Rift
1 Craterhoof Behemoth
1 Avenger of Zendikar
1 Primeval Titan
1 Grave Titan
1 Sun Titan
1 Frost Titan
1 Inferno Titan
1 Baneslayer Angel
1 Wurmcoil Engine
1 Steel Hellkite
1 Lotus Petal
1 Mana Crypt
1 Chrome Mox
1 Mox Diamond
1 Exotic Orchard
1 Path of Ancestry
1 Evolving Wilds
1 Terramorphic Expanse
1 Myriad Landscape
30 Forest`;

const headed = process.argv.includes('--headed');
const browser = await chromium.launch({ headless: !headed });

async function seat(name, roomCode) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, String(e)));
  await page.goto(BASE);
  await page.getByPlaceholder('Your display name').fill(name);
  if (roomCode) {
    await page.getByPlaceholder('Code or link').fill(roomCode);
    await page.getByRole('button', { name: 'Join' }).click();
  } else {
    await page.getByRole('button', { name: 'Create a room' }).click();
  }
  await page.getByRole('heading', { name: 'Choose a deck' }).waitFor({ timeout: 10_000 });
  await page.locator('textarea').fill(DECK);
  await page.getByRole('button', { name: 'Resolve decklist' }).click();
  const chooseBtn = page.getByRole('button', { name: /Choose this deck/ });
  const keepBtn = page.getByRole('button', { name: /^Keep/ });
  await chooseBtn.or(keepBtn).first().waitFor({ timeout: 60_000 });
  if (await chooseBtn.isVisible().catch(() => false)) await chooseBtn.click();
  await keepBtn.click({ timeout: 15_000 });
  await page.waitForFunction(() => !!window.__playmat);
  return page;
}

/** Draw n and play them all to my own mat via the auto-placement. */
async function fillBoard(page, n) {
  await page.evaluate(async (n) => {
    const { useGame, actions } = window.__playmat;
    actions.drawCards(n);
    for (const g of [...useGame.getState().hidden.hand]) {
      const p = actions.autoPlayPosition(g);
      actions.playFromHand(g, p.x, p.y, false);
      await new Promise((r) => setTimeout(r, 5));
    }
  }, n);
}

/** Run fn while sampling rAF frames + React commits on `page`. */
async function measure(page, label, fn) {
  await page.evaluate(() => {
    const p = window.__playmat.perf;
    window.__bench = { c0: p.commits, ms0: p.ms, frames: [], run: true };
    let last = performance.now();
    const tick = (t) => {
      if (!window.__bench.run) return;
      window.__bench.frames.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  await fn();
  const wall = Date.now() - t0;
  const r = await page.evaluate(() => {
    const b = window.__bench;
    b.run = false;
    const p = window.__playmat.perf;
    const f = b.frames.slice(1).sort((a, z) => a - z);
    return {
      commits: p.commits - b.c0,
      reactMs: p.ms - b.ms0,
      frames: f.length,
      p95: f[Math.floor(f.length * 0.95)] ?? 0,
      long: f.filter((x) => x > 34).length,
    };
  });
  console.log(
    `${label.padEnd(26)} commits ${String(r.commits).padStart(5)}  react ${r.reactMs.toFixed(0).padStart(6)}ms` +
      `  (${(r.reactMs / Math.max(1, r.commits)).toFixed(2)}ms/commit)` +
      `  frames ${r.frames}  p95 ${r.p95.toFixed(1)}ms  long ${r.long}  wall ${wall}ms`
  );
  return r;
}

try {
  const a = await seat('Alice');
  const code = new URL(a.url()).searchParams.get('room');
  const b = await seat('Bob', code);
  await fillBoard(a, 40);
  await fillBoard(b, 25);
  // Cursor sharing is off by default; a busy real table often has it on.
  await b.evaluate(() => {
    const { useGame } = window.__playmat;
    useGame.setState({ prefs: { ...useGame.getState().prefs, shareCursor: true } });
  });
  await a.waitForTimeout(1500);
  const n = await a.evaluate(
    () => Object.values(window.__playmat.useGame.getState().cards).filter((c) => c.zone === 'battlefield').length
  );
  console.log(`battlefield cards on Alice's screen: ${n}\n`);

  const vp = await a.locator('.battlefield-viewport').boundingBox();
  const cx = vp.x + vp.width / 2;
  const cy = vp.y + vp.height / 2;

  await measure(a, 'idle', () => a.waitForTimeout(2000));

  await measure(a, 'peer cursor sweep', async () => {
    for (let i = 0; i < 80; i++) {
      await b.mouse.move(cx - 300 + i * 7, cy - 100 + (i % 10) * 15);
      await b.waitForTimeout(25);
    }
  });

  await measure(a, 'pan (middle-drag)', async () => {
    await a.mouse.move(cx, cy);
    await a.mouse.down({ button: 'middle' });
    for (let i = 0; i < 60; i++) {
      await a.mouse.move(cx + Math.sin(i / 6) * 200, cy + Math.cos(i / 6) * 120);
      await a.waitForTimeout(16);
    }
    await a.mouse.up({ button: 'middle' });
  });

  await measure(a, 'wheel zoom', async () => {
    await a.mouse.move(cx, cy);
    for (let i = 0; i < 40; i++) {
      await a.mouse.wheel(0, i < 20 ? -40 : 40);
      await a.waitForTimeout(16);
    }
  });

  // Own card drag: grab the first of my battlefield cards.
  const box = await a.locator('.world .tcard').first().boundingBox();
  await measure(a, 'drag own card', async () => {
    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    await a.mouse.move(sx, sy);
    await a.mouse.down();
    for (let i = 0; i < 60; i++) {
      await a.mouse.move(sx + i * 4, sy - i * 2);
      await a.waitForTimeout(16);
    }
    await a.mouse.up();
  });

  // Peer drags one of their cards while Alice watches.
  const bbox = await b.locator('.world .tcard').last().boundingBox();
  await measure(a, 'peer drags a card', async () => {
    const sx = bbox.x + bbox.width / 2;
    const sy = bbox.y + bbox.height / 2;
    await b.mouse.move(sx, sy);
    await b.mouse.down();
    for (let i = 0; i < 60; i++) {
      await b.mouse.move(sx + i * 4, sy - i * 2);
      await b.waitForTimeout(16);
    }
    await b.mouse.up();
    await a.waitForTimeout(400);
  });

  await measure(a, 'hover sweep', async () => {
    for (let i = 0; i < 80; i++) {
      await a.mouse.move(vp.x + 100 + i * ((vp.width - 200) / 80), vp.y + vp.height * 0.8);
      await a.waitForTimeout(16);
    }
  });

  await measure(a, 'tap 10 cards', async () => {
    const cards = a.locator('.world .tcard');
    for (let i = 0; i < 10; i++) {
      const bb = await cards.nth(i).boundingBox();
      await a.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await a.waitForTimeout(60);
    }
  });

  await measure(a, 'marquee select', async () => {
    await a.mouse.move(vp.x + 40, vp.y + vp.height * 0.5);
    await a.mouse.down();
    for (let i = 0; i < 40; i++) {
      await a.mouse.move(vp.x + 40 + i * 25, vp.y + vp.height * 0.5 + i * 8);
      await a.waitForTimeout(16);
    }
    await a.mouse.up();
  });
} finally {
  await browser.close();
}
