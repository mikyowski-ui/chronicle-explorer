Chronicle M3 — editable source package

Start in source/apps/explorer. Requires Node >=22.13 and the frozen
application, research-semantic and verification-tools dependencies.
Provision those separate dependency boundaries with pnpm install
--frozen-lockfile (and --ignore-scripts for the two isolated packages).
Then run:
corepack pnpm test
corepack pnpm run build
python3 scripts/verify-m3.py
node serve.mjs

The separate Runnable archive includes the prebuilt dashboard and requires
no dependency installation. This source also contains the self-contained
offline virtual verification kit under verification/m3/virtual-offline:
node verification/m3/virtual-offline/scripts/m3-virtual-dom-acceptance.mjs --offline
Application sandbox verification uses Node built-ins:
node --experimental-transform-types runtime-isolation/application-acceptance.ts

Read source/SESSION.md and source/docs/research-workspace/M3-ACCEPTANCE.md.
The approved M3 profile uses fixed reviewed Worker/VM fixtures and virtual
DOM substitutes; it does not certify OS isolation or real browser rendering.
Live models and arbitrary generated execution remain disabled.
