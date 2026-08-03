#!/usr/bin/env node
/**
 * Phone-viewport smoke test with REAL touch input.
 *
 * Drives headless Chromium at Pixel dimensions and dispatches CDP touch
 * events, so Chrome runs its genuine gesture arbitration (touch-action,
 * pointercancel, scroll claiming). A drag that only works with a mouse
 * FAILS here — the class of bug desktop testing structurally cannot catch.
 *
 * Prereq: dev servers running (`npm run dev`).
 * Usage:  node scripts/mobile-smoke.mjs   [PLAYMAT_URL=... to override]
 */
import { chromium } from 'playwright';

const BASE = process.env.PLAYMAT_URL ?? 'http://localhost:5173';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 }, // Pixel 7-ish
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const cdp = await ctx.newCDPSession(page);
/** One finger, pressed down, dragged, released — via the browser's own input pipeline. */
async function touchDrag(from, to, steps = 14) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps },
      ],
    });
    await page.waitForTimeout(25);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const center = async (locator) => {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

try {
  // ---- Lobby → room ----
  await page.goto(BASE);
  await page.getByPlaceholder('Your display name').fill('SmokeBot');
  await page.getByRole('button', { name: 'Create a room' }).tap();

  // ---- Deck picker auto-opens; paste a small deck ----
  await page.getByRole('heading', { name: 'Choose a deck' }).waitFor({ timeout: 10_000 });
  await page.locator('textarea').fill('12 Forest\n1 Ruin Crab');
  await page.getByRole('button', { name: 'Resolve decklist' }).tap();
  const chooseBtn = page.getByRole('button', { name: /Choose this deck/ });
  const keepBtn = page.getByRole('button', { name: /^Keep/ });
  await chooseBtn.or(keepBtn).first().waitFor({ timeout: 25_000 });
  if (await chooseBtn.isVisible().catch(() => false)) await chooseBtn.tap();

  // ---- Opening hand → keep ----
  await keepBtn.tap({ timeout: 15_000 });
  await page.locator('.hand-card').first().waitFor();
  check('create room, choose deck, keep hand — all by touch', true);

  // ---- Layout: the page must fit the phone exactly ----
  const fit = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  check('no horizontal page overflow', fit.x <= 0, `${fit.x}px over`);
  check('no vertical page overflow', fit.y <= 0, `${fit.y}px over`);

  // ---- Tray: collapsed by default; expandable; chevron reachable ----
  const collapsed = page.locator('.hud.collapsed');
  check('tray starts collapsed on a phone', (await collapsed.count()) === 1);
  await collapsed.tap();
  const chev = page.locator('.hud.pos-bottom .hud-collapse');
  await chev.waitFor();
  const cb = await chev.boundingBox();
  const vp = page.viewportSize();
  check(
    'expanded tray keeps its collapse chevron on-screen',
    !!cb && cb.x >= 0 && cb.y >= 0 && cb.x + cb.width <= vp.width && cb.y + cb.height <= vp.height,
    JSON.stringify(cb)
  );
  // Playwright refuses to tap a covered element, so this also proves the
  // hand strip no longer eats the chevron's clicks.
  await chev.tap();
  check('chevron tap collapses the tray', (await collapsed.count()) === 1);
  await collapsed.tap();
  await page.locator('.hud .name').tap();
  check('header tap collapses the tray', (await collapsed.count()) === 1);
  await collapsed.tap(); // leave expanded: piles must be visible to drag from

  // ---- Touch drags out of piles and hand ----
  const lib = page.locator('.hud.pos-bottom .pile[data-drop^="library"]');
  const before = await page.locator('.tcard').count();
  await touchDrag(await center(lib), { x: 206, y: 420 });
  await page.waitForTimeout(500);
  check('touch-drag library → battlefield', (await page.locator('.tcard').count()) === before + 1);

  await touchDrag(await center(page.locator('.hand-card').first()), { x: 270, y: 420 });
  await page.waitForTimeout(500);
  check('touch-drag hand → battlefield', (await page.locator('.tcard').count()) === before + 2);

  check('no console or page errors', errors.length === 0, errors[0]);
} catch (e) {
  check(`aborted: ${String(e.message ?? e).split('\n')[0]}`, false);
  await page.screenshot({ path: 'mobile-smoke-failure.png' }).catch(() => {});
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll mobile checks passed');
process.exit(failed ? 1 : 0);
