#!/usr/bin/env node
// Create a self-contained, Node-only virtual acceptance kit. No fetch/install.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--out');
const out = resolve(index < 0 ? join(app, 'verification/m3/virtual-offline') : process.argv[index + 1]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
const esbuildName = (await readdir(join(app, 'node_modules/.pnpm'))).find(name => /^esbuild@/.test(name));
assert.ok(esbuildName);
const esbuild = require(join(app, 'node_modules/.pnpm', esbuildName, 'node_modules/esbuild'));
const appRequire = createRequire(join(app, 'package.json'));
const viteRequire = createRequire(appRequire.resolve('vite/package.json'));
const toolsRequire = createRequire(join(app, 'verification-tools/package.json'));
await mkdir(join(out, 'runtime'), { recursive: true });
const options = { bundle: true, platform: 'node', target: 'es2022', metafile: true, logLevel: 'silent' };
const happyVersion = JSON.parse(await readFile(join(app, 'verification-tools/node_modules/happy-dom/package.json'), 'utf8')).version;
const parserVersion = viteRequire('postcss/package.json').version;
const bundles = [];
bundles.push(await esbuild.build({ ...options, absWorkingDir: app, entryPoints: ['src/research/view.ts'], outfile: join(out, 'runtime/compiled-workspace.mjs'), format: 'esm', loader: { '.css': 'empty' }, define: { 'import.meta.env.DEV': 'false' } }));
bundles.push(await esbuild.build({ ...options, stdin: { contents: `export { Window } from ${JSON.stringify(toolsRequire.resolve('happy-dom'))}; export const happyDOMVersion = ${JSON.stringify(happyVersion)};`, resolveDir: app }, outfile: join(out, 'runtime/happy-dom-runtime.mjs'), format: 'esm', banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } }));
bundles.push(await esbuild.build({ ...options, stdin: { contents: `module.exports = { postcss: require(${JSON.stringify(viteRequire.resolve('postcss'))}), version: ${JSON.stringify(parserVersion)} };`, resolveDir: app }, outfile: join(out, 'runtime/postcss-runtime.cjs'), format: 'cjs' }));
const copied = [
  'scripts/m3-virtual-dom-acceptance.mjs', 'scripts/m3-virtual-layout-policy.mjs',
  'src/glass-shell.css', 'src/research/research.css', 'src/research/semantic-view.css',
  'src/research/pilot-data.json', 'research-semantic/premodern-pilot.json', 'dist/build-info.json',
];
const copiedInputs = [];
for (const file of copied) { const bytes = await readFile(join(app, file)); await mkdir(dirname(join(out, file)), { recursive: true }); await writeFile(join(out, file), bytes); copiedInputs.push({ path: file, sha256: hash(bytes) }); }
const sources = [];
for (const name of Object.keys(bundles[0].metafile.inputs).sort()) {
  if (name.includes('node_modules')) continue;
  sources.push({ path: name, sha256: hash(await readFile(resolve(app, name))) });
}
for (const name of copied.filter(file => file.startsWith('scripts/'))) sources.push({ path: name, sha256: hash(await readFile(join(app, name))) });
const build = JSON.parse(await readFile(join(app, 'dist/build-info.json'), 'utf8'));
const packageRoots = new Set();
for (const bundle of bundles) for (const input of Object.keys(bundle.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  const absolute = resolve(app, input), last = absolute.lastIndexOf('/node_modules/');
  const suffix = absolute.slice(last + 14).split('/');
  packageRoots.add(absolute.slice(0, last + 14) + suffix.slice(0, suffix[0].startsWith('@') ? 2 : 1).join('/'));
}
const licenses = [];
await mkdir(join(out, 'licenses'), { recursive: true });
for (const root of [...packageRoots].sort()) {
  const packageData = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const filenames = (await readdir(root)).filter(name => /^(license|copying|notice)(\.|$|-)/i.test(name));
  const files = [];
  for (const filename of filenames) {
    const name = `${packageData.name.replaceAll('/', '__')}-${packageData.version}-${filename}`;
    const bytes = await readFile(join(root, filename)); await writeFile(join(out, 'licenses', name), bytes); files.push(`licenses/${name}`);
  }
  licenses.push({ name: packageData.name, version: packageData.version, license: packageData.license, licenseFiles: files });
}
await writeFile(join(out, 'licenses/dependencies.json'), JSON.stringify(licenses, null, 2) + '\n');
const runtimes = [];
for (const path of ['runtime/compiled-workspace.mjs', 'runtime/happy-dom-runtime.mjs', 'runtime/postcss-runtime.cjs']) { const bytes = await readFile(join(out, path)); runtimes.push({ path, bytes: bytes.length, sha256: hash(bytes) }); }
const manifest = { schemaVersion: 1, buildId: build.build_id, compiledSHA256: runtimes[0].sha256, compiler: `esbuild ${esbuild.version}`, dependencies: { happyDOM: happyVersion, postcss: parserVersion }, sources, copiedInputs, runtimes, licenses: 'licenses/dependencies.json', interpretation: 'Actual research view compiled from source; user-approved virtual DOM adapter, not browser rendering or actual Atlas renderer performance.' };
await writeFile(join(out, 'runtime/source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(out, 'README.txt'), 'Chronicle M3 virtual DOM acceptance kit\n\nRequires Node >=22.13. No install, browser or network needed.\nRun: node scripts/m3-virtual-dom-acceptance.mjs --offline\nOutput: verification/m3/virtual-dom/acceptance.json\n\nActual research view/controller behavior is tested. Layout geometry, map host, browser file APIs and animation clock are simulated. PASS is not real browser rendering, hardware GPU, physical mobile or real performance certification. Original50/100ms targets remain asserted as a contract; synthetic33.333/35.333ms timings result from the stated mock clock.\n\nSource/build hashes: runtime/source-manifest.json\nBundled dependency licenses: licenses/dependencies.json and accompanying files.\n');
console.log(JSON.stringify({ status: 'PASS', out, build: build.build_id, runtimes, dependencies: licenses.length }, null, 2));
