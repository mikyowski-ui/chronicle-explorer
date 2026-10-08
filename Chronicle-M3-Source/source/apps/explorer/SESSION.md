# Chronicle M3 continuation — 2026-10-07

M3 is complete under the user's explicitly approved application-level sandbox and virtual DOM acceptance profile. Accepted parent: chronicle-8d0829ebd21b4bd21dda135ae9b0da09eb32d2df93f696f1fdd01de7484c4311. Protected baseline unchanged; no Git metadata/commit exists.

Implemented Worker + vm fixed-operation sandbox, strict staging/result validation and authoritative row matching, bounded V8 heap/lifecycle/output, latest-wins cancellation and teardown. Reviewed synthetic fixtures only. Provider connection is now wired through the production controller with explicit config, credential presence, budgets and field consent; absent config/keys/budgets returns PROVIDER_UNAVAILABLE. All modelProcessing:false restrictions remain. No live service, arbitrary generated execution, real-data sandbox staging, publication or deployment.

Final suite: 445/445 PASS, including all 386 original tests (49 original files byte-identical); no skips/cancellations. TypeScript/build PASS. 2,282 protected files unchanged; 2,368 source inputs match build; seven HTTP files exact plus range206; both pilot lineage checks PASS. 19 application checks + A–B–A + 20 cycles PASS. All three virtual DOM gates / 12 checks PASS: actual CSS 375px policy with mock geometry, both pilot interactive replay, actual 200+200 function with simulated RAF and mock host. Source and self-contained offline verification kit pass. Real layout/rendering/latency/GPU are not certified.

Build: chronicle-78185328c2969b9946da16c06d07f1115015e6330a188f51d99cf2b9c79b6ce0
Source fingerprint: 0c28ea1cb251dd28a765e9730a78db4b19c6767fd1f58402dd6478f1d144f7c6

Receipts: apps/explorer/verification/m3. Read docs/research-workspace/M3-ACCEPTANCE.md for scope, negative results and commands; M3-RUNTIME-IMPLEMENTATION.md and M3-PROVIDER-CONNECTION.md for APIs. Original OS sandbox bootstrap is unavailable (empty-root errno1); real Chromium is absent. Both attempts are retained, nonblocking under the revised user criteria. Worker/vm is not an OS or arbitrary-hostile-code boundary; memory limits cover V8 heap, not aggregate RSS. Stronger original threat model preserved.

Runnable: node serve.mjs -> http://localhost:4173/. Offline checks: node --experimental-transform-types runtime-isolation/application-acceptance.ts; node virtual-acceptance/scripts/m3-virtual-dom-acceptance.mjs --offline. Source: corepack pnpm test; corepack pnpm run build; python3 scripts/verify-m3.py. Separate happy-dom 20.14.5 verification package is pinned; protected main manifest/lock unchanged. Runnable needs Node >=22.13 and no dependency install for its bundled checks.

Next independently authorized work: real browser/physical renderer certification or stronger enforcing host; actual provider service only after explicit activation/processing authorization. Do not treat M3 fallback acceptance as permission to enable arbitrary generated code, live models or M4 publication.
