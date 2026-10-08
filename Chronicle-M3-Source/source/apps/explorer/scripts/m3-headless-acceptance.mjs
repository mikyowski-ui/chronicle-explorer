#!/usr/bin/env node
// Run the real built Atlas using a local Chromium installation. No package install,
// browser download, remote service, app hook or mock rendering occurs here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import os from 'node:os';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const out = resolve(option('--out', join(app, 'verification/m3/headless')));
const renderer = option('--renderer', 'canvas');
assert.ok(['canvas', 'maplibre'].includes(renderer), '--renderer must be canvas or maplibre');
await mkdir(out, { recursive: true });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const receipt = {
  schemaVersion: 1, status: 'NOT RUN', startedAt: new Date().toISOString(),
  command: ['node', 'scripts/m3-headless-acceptance.mjs', '--renderer', renderer],
  runner: { node: process.version, platform: process.platform, arch: process.arch, kernel: os.release(),
    cpus: os.cpus().length, memoryBytes: os.totalmem(), scriptSHA256: sha256(await readFile(fileURLToPath(import.meta.url))) },
  build: null, requestedRenderer: renderer, browser: null,
  isolation: { servedFrom: 'ephemeral 127.0.0.1 port', externalRequests: 'abort all non-local page requests; service workers blocked', externalAttempts: [] },
  gates: { responsive375: { status: 'NOT RUN' }, interactiveSaveReopen: { status: 'NOT RUN' }, original200Plus200: { status: 'NOT RUN' } },
  screenshots: [], artifacts: [], pageErrors: [], consoleErrors: [],
  interpretation: 'Actual headless browser, DOM and Canvas/software rendering only. No physical mobile, hardware GPU, scanout, or OS preference certification.',
  physicalGPU: 'NOT RUN', physicalMobile: 'NOT RUN', scanout: 'NOT MEASURED',
};
let server, browser, context;
let activeGate = null;
class EnvironmentBlocked extends Error {}
async function writeJSON(name, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  await writeFile(join(out, name), bytes);
  receipt.artifacts.push({ file: name, sha256: sha256(bytes) });
}
async function gate(name, action) {
  activeGate = name;
  try { receipt.gates[name] = { status: 'PASS', ...await action() }; }
  catch (error) { receipt.gates[name] = { status: 'FAIL', message: error.message }; }
  finally { activeGate = null; }
}
async function screenshot(page, name) {
  const bytes = await page.screenshot({ path: join(out, name), fullPage: true });
  receipt.screenshots.push({ file: name, sha256: sha256(bytes), width: page.viewportSize().width, height: page.viewportSize().height });
}
async function expand(page, selector) {
  const details = page.locator(selector);
  if (!(await details.getAttribute('open') !== null)) await details.locator(':scope > summary').click();
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#research-status')?.dataset.status === 'ready', undefined, { timeout: 30_000 });
}
async function openPilot(page, title) {
  await expand(page, '.research-query');
  await page.getByRole('button', { name: title, exact: true }).click();
  await ready(page);
}
async function downloadReplay(page, name) {
  await expand(page, '.research-replay');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save replay JSON', exact: true }).click();
  const download = await pending;
  assert.equal(await download.failure(), null);
  const path = join(out, name);
  await download.saveAs(path);
  const bytes = await readFile(path);
  receipt.artifacts.push({ file: name, sha256: sha256(bytes) });
  return { path, replay: JSON.parse(bytes.toString('utf8')) };
}
async function layout(page) {
  return page.evaluate(() => {
    const rect = element => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom };
    };
    const panel = document.querySelector('.research-workspace');
    const timeline = document.querySelector('.workspace > .transport');
    const table = document.querySelector('.research-table-scroll');
    const controls = [...panel.querySelectorAll('button,input,select,textarea,summary')]
      .filter(element => element.getClientRects().length && !element.closest('.research-table-scroll'))
      .map(element => ({ label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 100) || element.tagName, ...rect(element) }));
    return { viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth,
      panel: rect(panel), panelClientWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth,
      timeline: timeline ? rect(timeline) : null,
      table: { clientWidth: table.clientWidth, scrollWidth: table.scrollWidth, overflowX: getComputedStyle(table).overflowX },
      controlsOutsidePanel: controls.filter(control => control.x < rect(panel).x - 1 || control.right > rect(panel).right + 1),
      title: panel.querySelector('.research-result > h3')?.textContent,
      renderer: document.querySelector('#renderer-status')?.textContent,
      activeAnimations: panel.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length,
    };
  });
}
function assertLayout(result) {
  assert.deepEqual(result.viewport, [375, 812]);
  assert.ok(result.documentWidth <= 375, 'document must not overflow horizontally');
  assert.ok(result.panel.x >= 0 && result.panel.right <= 375, 'research panel must fit viewport');
  assert.ok(result.panel.width > 300 && result.panel.height > 100, 'research panel must have usable area');
  assert.ok(result.panelScrollWidth <= result.panelClientWidth + 1, 'only inner table may scroll horizontally');
  assert.equal(result.controlsOutsidePanel.length, 0, JSON.stringify(result.controlsOutsidePanel));
  assert.ok(result.timeline, 'historical timeline dock must be present');
  assert.ok(result.timeline.height > 0 && result.timeline.y >= 0 && result.timeline.bottom <= 813, 'timeline dock must remain visible in viewport');
  assert.ok(result.panel.bottom <= result.timeline.y + 1, 'research panel must leave timeline dock visible');
  assert.ok(['auto', 'scroll'].includes(result.table.overflowX), 'table has a bounded horizontal scroll surface');
  assert.equal(result.activeAnimations, 0, 'emulated reduced motion must stop research animations');
}
try {
  try { receipt.build = JSON.parse(await readFile(join(app, 'dist/build-info.json'), 'utf8')); }
  catch { throw new EnvironmentBlocked('Built app missing. Run corepack pnpm run build first.'); }
  const require = createRequire(import.meta.url);
  const candidates = [process.env.CHRONICLE_PLAYWRIGHT_MODULE, 'playwright', process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES && join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright')].filter(Boolean);
  let playwright;
  for (const candidate of candidates) { try { playwright = require(candidate); break; } catch {} }
  if (!playwright?.chromium) throw new EnvironmentBlocked('Playwright module not installed. Supply CHRONICLE_PLAYWRIGHT_MODULE pointing at an existing installation.');
  const executable = process.env.CHRONICLE_CHROMIUM_EXECUTABLE || playwright.chromium.executablePath();
  receipt.runner.chromiumExecutable = executable;
  try { await access(executable, constants.X_OK); }
  catch { throw new EnvironmentBlocked('Chromium executable missing. Supply CHRONICLE_CHROMIUM_EXECUTABLE or provision the pinned Playwright browser before this offline test. No browser download was attempted by this runner.'); }
  receipt.runner.chromiumSHA256 = sha256(await readFile(executable));
  server = spawn(process.execPath, ['serve.mjs'], { cwd: app, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  const base = await new Promise((resolveURL, reject) => {
    const timer = setTimeout(() => reject(new Error('Local app server did not start')), 10_000);
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Local server exited: ${code}`)); });
    server.stderr.on('data', data => { serverLog += data.toString(); });
    server.stdout.on('data', data => {
      serverLog += data.toString();
      const match = serverLog.match(/http:\/\/localhost:(\d+)\//);
      if (match) { clearTimeout(timer); resolveURL(`http://127.0.0.1:${match[1]}`); }
    });
  });
  const response = await fetch(`${base}/build-info.json`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), receipt.build);
  browser = await playwright.chromium.launch({ executablePath: executable, headless: true });
  receipt.browser = { version: browser.version(), engine: 'Chromium', headless: true };
  context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, reducedMotion: 'reduce', acceptDownloads: true, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    receipt.isolation.externalAttempts.push({ origin: url.origin, resourceType: route.request().resourceType(), action: 'aborted' });
    return route.abort('blockedbyclient');
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  page.on('pageerror', error => receipt.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') receipt.consoleErrors.push(message.text()); });
  await page.goto(`${base}/?verify=1${renderer === 'canvas' ? '&renderer=canvas' : ''}`, { waitUntil: 'load', timeout: 30_000 });
  await page.locator('#research-toggle').click();
  await ready(page);
  if (renderer === 'canvas') assert.match(await page.locator('#renderer-status').textContent(), /Canvas 2D/);
  else assert.match(await page.locator('#renderer-status').textContent(), /MapLibre/);
  await gate('responsive375', async () => {
    await expand(page, '.research-table-section');
    const modern = await layout(page);
    await page.locator('.research-heading').scrollIntoViewIfNeeded();
    await screenshot(page, 'responsive-375-modern.png');
    assertLayout(modern);
    await openPilot(page, 'Premodern exchange accounts');
    await expand(page, '.research-table-section');
    const qualitative = await layout(page);
    await page.locator('.research-heading').scrollIntoViewIfNeeded();
    await screenshot(page, 'responsive-375-premodern.png');
    assertLayout(qualitative);
    await page.getByRole('button', { name: 'Collapse research panel to see the map' }).click();
    assert.equal(await page.getByRole('button', { name: 'Collapse research panel to see the map' }).getAttribute('aria-pressed'), 'true');
    await screenshot(page, 'responsive-375-map-mode.png');
    await page.getByRole('button', { name: 'Collapse research panel to see the map' }).click();
    return { modern, qualitative, mapModeToggle: 'PASS', reducedMotion: 'browser emulation only' };
  });
  await gate('interactiveSaveReopen', async () => {
    await openPilot(page, 'Four Mexican urban centres');
    await expand(page, '.research-table-section');
    await page.locator('.research-table-scroll button[data-research-observation]').first().click();
    const selected = await page.locator('#research-evidence').getAttribute('data-observation-id');
    assert.ok(selected, 'table click selects actual evidence');
    const initial = await downloadReplay(page, 'saved-replay.json');
    await openPilot(page, 'Premodern exchange accounts');
    await expand(page, '.research-replay');
    await page.getByLabel('Choose a saved research replay').setInputFiles(initial.path);
    await page.getByText('File read. Select Reopen pinned result to validate it.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Reopen pinned result', exact: true }).click();
    await page.getByText('Reopened against matching local source records.', { exact: true }).waitFor();
    await ready(page);
    const reopened = await downloadReplay(page, 'reopened-replay.json');
    assert.deepEqual(reopened.replay, initial.replay, 'saved/reopened archive is identical including revision ancestry, views, cursor and selection');
    assert.equal(await page.locator('#research-evidence').getAttribute('data-observation-id'), selected);
    await screenshot(page, 'interactive-file-reopen.png');
    return { input: 'real browser download, pilot switch, file upload, reopen button, second download', archiveEqual: true, selectedObservation: selected, archiveKind: initial.replay.kind };
  });
  await gate('original200Plus200', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openPilot(page, 'Four Mexican urban centres');
    await page.getByRole('button', { name: 'Focus study area', exact: true }).click();
    await expand(page, '.research-verification');
    await page.getByRole('button', { name: 'Measure 200 selections, 200 combined updates + lifecycle', exact: true }).click();
    await page.waitForFunction(() => {
      try { const result = JSON.parse(document.querySelector('#research-verification-result')?.textContent || ''); return ['PASS', 'FAIL'].includes(result.status); } catch { return false; }
    }, undefined, { timeout: 180_000 });
    const benchmark = JSON.parse(await page.locator('#research-verification-result').textContent());
    await writeJSON('original-200-plus-200.json', benchmark);
    await screenshot(page, 'original-200-plus-200.png');
    assert.equal(benchmark.status, 'PASS', JSON.stringify({ failures: benchmark.failures, error: benchmark.error, selection: benchmark.phases?.selectionOnly.p95Ms, combined: benchmark.phases?.selectionAndCursor.p95Ms }));
    assert.deepEqual(benchmark.build, receipt.build);
    assert.equal(benchmark.workload.observations, 44); assert.equal(benchmark.workload.entities, 4);
    assert.equal(benchmark.phases.selectionOnly.interactionCount, 200); assert.equal(benchmark.phases.selectionAndCursor.interactionCount, 200);
    assert.equal(benchmark.phases.selectionOnly.targetP95Ms, 50); assert.equal(benchmark.phases.selectionAndCursor.targetP95Ms, 100);
    assert.equal(benchmark.phases.selectionOnly.samplesMs.length, 200); assert.equal(benchmark.phases.selectionAndCursor.samplesMs.length, 200);
    assert.equal(benchmark.workload.replaceCloseCycles, 20); assert.equal(benchmark.workload.mountDisposeCycles, 20);
    assert.ok(benchmark.hostSurface.sameCanvasObject);
    return { receipt: 'original-200-plus-200.json', observations: 44, entities: 4, selectionP95Ms: benchmark.phases.selectionOnly.p95Ms, combinedP95Ms: benchmark.phases.selectionAndCursor.p95Ms, selectionTargetMs: 50, combinedTargetMs: 100, selectionSamples: 200, combinedSamples: 200, closeReopenCycles: 20, mountDisposeCycles: 20 };
  });
  assert.equal(receipt.pageErrors.length, 0, JSON.stringify(receipt.pageErrors));
  receipt.status = Object.values(receipt.gates).every(gate => gate.status === 'PASS') ? 'PASS' : 'FAIL';
  if (receipt.status === 'FAIL') process.exitCode = 1;
} catch (error) {
  receipt.status = error instanceof EnvironmentBlocked ? 'BLOCKED' : 'FAIL';
  receipt.error = { name: error.name, message: error.message };
  if (activeGate) receipt.gates[activeGate] = { status: 'FAIL', message: error.message };
  if (receipt.status === 'BLOCKED') for (const gate of Object.values(receipt.gates)) { gate.status = 'BLOCKED'; gate.reason = error.message; }
  process.exitCode = receipt.status === 'BLOCKED' ? 2 : 1;
} finally {
  if (context) {
    try {
      const path = join(out, 'headless-trace.zip');
      await context.tracing.stop({ path });
      receipt.artifacts.push({ file: 'headless-trace.zip', sha256: sha256(await readFile(path)) });
    } catch {}
  }
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    const timeout = setTimeout(() => server.kill('SIGKILL'), 1000);
    await once(server, 'exit'); clearTimeout(timeout);
  }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'acceptance.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ status: receipt.status, build: receipt.build?.build_id, gates: receipt.gates, error: receipt.error, receipt: join(out, 'acceptance.json') }, null, 2));
}
