#!/usr/bin/env node
/**
 * Verification for the new multi-select gestures, same CDP-touch technique
 * as scripts/mobile-smoke.mjs:
 *  touch: long-press felt → release = table menu; long-press → drag = marquee
 *  touch: plain drag still pans; card long-press → card menu
 *  mouse: left-drag on felt = marquee; space+drag = pan
 */
import { chromium } from 'playwright';

const BASE = process.env.PLAYMAT_URL ?? 'http://localhost:5173';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();

async function setupRoom(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(BASE);
  await page.getByPlaceholder('Your display name').fill('GestureBot');
  await page.getByRole('button', { name: 'Create a room' }).click();
  await page.getByRole('heading', { name: 'Choose a deck' }).waitFor({ timeout: 10_000 });
  await page.locator('textarea').fill('12 Forest\n1 Ruin Crab');
  await page.getByRole('button', { name: 'Resolve decklist' }).click();
  const chooseBtn = page.getByRole('button', { name: /Choose this deck/ });
  const keepBtn = page.getByRole('button', { name: /^Keep/ });
  await chooseBtn.or(keepBtn).first().waitFor({ timeout: 25_000 });
  if (await chooseBtn.isVisible().catch(() => false)) await chooseBtn.click();
  await keepBtn.click({ timeout: 15_000 });
  await page.locator('.hand-card').first().waitFor();
  return { page, errors };
}

// ---------------- Touch (phone) ----------------
{
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const { page, errors } = await setupRoom(ctx);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });

  async function touchDrag(from, to, steps = 14) {
    await touch('touchStart', [from]);
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', [
        { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps },
      ]);
      await page.waitForTimeout(25);
    }
    await touch('touchEnd', []);
  }
  const center = async (locator) => {
    const b = await locator.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  // Two cards on the battlefield to select.
  const lib = page.locator('.hud.pos-bottom .pile[data-drop^="library"]');
  await page.locator('.hud.collapsed').tap();
  await touchDrag(await center(lib), { x: 170, y: 400 });
  await page.waitForTimeout(400);
  await touchDrag(await center(lib), { x: 250, y: 430 });
  await page.waitForTimeout(400);
  check('setup: two cards on battlefield', (await page.locator('.tcard').count()) === 2);

  // Plain background drag still pans.
  const before = await page.evaluate(() => document.querySelector('.world').style.transform);
  await touchDrag({ x: 200, y: 250 }, { x: 300, y: 330 });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => document.querySelector('.world').style.transform);
  check('touch drag on felt still pans', before !== after);

  // Long-press on felt, release without moving → table menu.
  await touch('touchStart', [{ x: 210, y: 260 }]);
  await page.waitForTimeout(750);
  const armed = (await page.locator('.press-armed').count()) === 1;
  await touch('touchEnd', []);
  await page.locator('.ctx-menu').waitFor({ timeout: 2000 }).catch(() => {});
  const menuUp = (await page.locator('.ctx-menu').count()) === 1;
  const hasUntap = menuUp && (await page.getByText('Untap all').count()) > 0;
  check('long-press arms (ring cue shows)', armed);
  check('release after long-press opens table menu', menuUp && hasUntap);
  // Menu must not close itself instantly; dismiss it with a tap elsewhere.
  await page.waitForTimeout(300);
  check('menu survives its own opening tap', (await page.locator('.ctx-menu').count()) === 1);
  await page.touchscreen.tap(210, 700);
  await page.waitForTimeout(300);
  check('tap elsewhere closes the menu', (await page.locator('.ctx-menu').count()) === 0);

  // Long-press then drag → marquee selects the two cards, no menu.
  const boxes = [];
  for (const el of await page.locator('.tcard').all()) boxes.push(await el.boundingBox());
  const x0 = Math.min(...boxes.map((b) => b.x)) - 20;
  const y0 = Math.min(...boxes.map((b) => b.y)) - 20;
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)) + 20;
  const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + 20;
  await touch('touchStart', [{ x: x0, y: y0 }]);
  await page.waitForTimeout(750);
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }]);
    await page.waitForTimeout(30);
  }
  const rectShown = (await page.locator('.marquee-rect').count()) === 1;
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  const selCount = await page.locator('.tcard.selected').count();
  check('long-press + drag shows marquee rect', rectShown);
  check('marquee selected both cards', selCount === 2, `selected=${selCount}`);
  check('no menu after marquee', (await page.locator('.ctx-menu').count()) === 0);

  // Long-press a card → its crucible menu opens (drag abandoned).
  const cardPos = await center(page.locator('.tcard').first());
  await touch('touchStart', [cardPos]);
  await page.waitForTimeout(750);
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
  const cardMenu = await page.locator('.mtg-card-menu').count();
  check('long-press on card opens card menu', cardMenu >= 1, `menus=${cardMenu}`);

  check('touch: no console or page errors', errors.length === 0, errors[0]);
  await ctx.close();
}

// ---------------- Mouse (desktop) ----------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const { page, errors } = await setupRoom(ctx);

  // Two cards out via mouse drag from the library pile.
  const lib = page.locator('.hud.pos-bottom .pile[data-drop^="library"]');
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++)
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
    await page.mouse.up();
  };
  const center = async (locator) => {
    const b = await locator.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  await drag(await center(lib), { x: 560, y: 380 });
  await page.waitForTimeout(400);
  await drag(await center(lib), { x: 680, y: 420 });
  await page.waitForTimeout(400);
  check('setup: two cards on battlefield', (await page.locator('.tcard').count()) === 2);

  // Left-drag on empty felt draws marquee and selects both.
  const boxes = [];
  for (const el of await page.locator('.tcard').all()) boxes.push(await el.boundingBox());
  const x0 = Math.min(...boxes.map((b) => b.x)) - 30;
  const y0 = Math.min(...boxes.map((b) => b.y)) - 30;
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)) + 30;
  const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + 30;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2);
  const rectShown = (await page.locator('.marquee-rect').count()) === 1;
  await page.mouse.move(x1, y1);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const selCount = await page.locator('.tcard.selected').count();
  check('mouse left-drag on felt shows marquee', rectShown);
  check('mouse marquee selected both cards', selCount === 2, `selected=${selCount}`);

  const t0 = await page.evaluate(() => document.querySelector('.world').style.transform);
  // Plain left-drag must NOT pan any more...
  check('left-drag no longer pans', t0 === (await page.evaluate(() => document.querySelector('.world').style.transform)));
  // ...but space+drag does.
  await page.keyboard.down('Space');
  await drag({ x: 400, y: 300 }, { x: 520, y: 380 });
  await page.keyboard.up('Space');
  const t1 = await page.evaluate(() => document.querySelector('.world').style.transform);
  check('space+drag pans', t0 !== t1, `${t0} → ${t1}`);

  // Marquee click-through: a plain click on the felt clears the selection.
  await page.mouse.click(400, 250);
  await page.waitForTimeout(200);
  check('plain click clears selection', (await page.locator('.tcard.selected').count()) === 0);

  // Right-click on the felt still opens the table menu.
  await page.mouse.click(500, 300, { button: 'right' });
  await page.waitForTimeout(300);
  check('right-click still opens table menu', (await page.locator('.ctx-menu').count()) === 1);
  await page.keyboard.press('Escape');

  // ---- dragPansTable pref: plain drag pans again, shift+drag marquees ----
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('playmat') || '{}');
    s.prefs = { ...(s.prefs || {}), dragPansTable: true };
    localStorage.setItem('playmat', JSON.stringify(s));
  });
  await page.reload();
  await page.locator('.tcard').first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  const p0 = await page.evaluate(() => document.querySelector('.world').style.transform);
  await drag({ x: 420, y: 260 }, { x: 540, y: 340 });
  await page.waitForTimeout(200);
  const p1 = await page.evaluate(() => document.querySelector('.world').style.transform);
  check('pref: plain drag pans again', p0 !== p1);
  const boxes2 = [];
  for (const el of await page.locator('.tcard').all()) boxes2.push(await el.boundingBox());
  const sx0 = Math.min(...boxes2.map((b) => b.x)) - 30;
  const sy0 = Math.min(...boxes2.map((b) => b.y)) - 30;
  const sx1 = Math.max(...boxes2.map((b) => b.x + b.width)) + 30;
  const sy1 = Math.max(...boxes2.map((b) => b.y + b.height)) + 30;
  await page.keyboard.down('Shift');
  await drag({ x: sx0, y: sy0 }, { x: sx1, y: sy1 });
  await page.keyboard.up('Shift');
  await page.waitForTimeout(200);
  check(
    'pref: shift+drag marquees',
    (await page.locator('.tcard.selected').count()) === 2,
    `selected=${await page.locator('.tcard.selected').count()}`
  );

  check('mouse: no console or page errors', errors.length === 0, errors[0]);
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll gesture checks passed');
process.exit(failed ? 1 : 0);
