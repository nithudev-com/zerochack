# Retained offline HTML browser evidence

T25–T28 now have explicit-consent v2 workflows for a **saved standalone staging HTML document**. They do not execute uploaded scripts or test arbitrary URLs, customer test suites, CMS operations, checkout or a complete dynamic application. Original wider purposes remain in `proposedPurpose`.

| Tool | Actual result |
| --- | --- |
| T25 | Render one selected page in disposable Chromium; retain source binding, renderer, viewport, structural findings and completion evidence; close the context/browser. There is no interactive remote browser URL. |
| T26 | Browser accessibility snapshot after private-region removal and ARIA-reference cleanup. This is not a full WCAG audit. |
| T27 | Fixed viewport PNG, opaque black masks, sanitized image metadata, SHA-256, renderer and source provenance. |
| T28 | Registered `static-document-v1` journey: title, language, main landmark, primary heading, horizontal overflow and the first visible native disclosure's Enter-key toggle. A failed check remains an explicit finding, not a successful repair claim. |

## Customer use

1. Open an active **staging** repair, source-review or text-workspace job and expand **Offline HTML browser tools**.
2. Select the current saved source/candidate or eligible `.html`/`.htm` bundle file, a check and a viewport. Unsupported dynamic files are not offered.
3. Enter private-region element IDs when needed. Each must select exactly one body-content element; nested/overlapping, duplicate and missing selections are rejected. Review the rest of the page for private information; masking is not automatic personal-data detection.
4. Approve the exact displayed source, tool, viewport and private regions, then run. Any selection/source change invalidates UI consent. No AI invocation or provider charge occurs.
5. Reopen **Retained browser history** after closing/reloading. Reports and screenshots are read from encrypted storage. Changed flags and closed jobs prevent new runs but do not delete evidence. A lost response can be checked in history; an interrupted request is never automatically replayed. A fresh run needs fresh consent.

Viewport profiles are 390×844, 768×1024 and 1280×900 at device scale 1, light theme, en-US, UTC and reduced motion. Captures cover the viewport only. Redacted content is removed before accessibility extraction and masked in screenshots. Other copied labels/text outside selected regions remain the reviewer's responsibility. Saved screenshot IDs can be used wherever the existing T29 same-job comparison authorization permits it; manually uploaded images still have weaker capture provenance.

## Runtime and rollout

- Apply all migrations, including additive `20260928010000_care_browser`. Deploy matching API and web code. No existing history is removed or rewritten.
- `CARE_BROWSER_ENABLED=false` is the default. Enabling it requires `CARE_ENABLED=true`, the selected source workflow flag (`CARE_REPAIR_ENABLED` or `CARE_REVIEW_ENABLED`), and a distinct persistent `CARE_ARTIFACT_KEY` in production.
- API runtime dependency: **Playwright 1.62.1** and its matching Chromium, installed with `npx playwright install --with-deps chromium`. Playwright stays external to the API bundle. The optional `infrastructure/docker/Dockerfile.api-browser` supplies a Debian-based image; the default Alpine image is not a supported browser runtime. The optional image has not itself been deployed or certified by these fixture tests.
- Run `npm run care:browser-preflight` from a full checkout **as the non-root Linux service identity** in the actual deployment. It launches the production adapter with a fixed public fixture, checks sandbox startup/rendering and closes it. In the built browser image, use `node apps/api/dist/scripts/care-browser-preflight.js`. It requires no database, customer source, account or provider. A root process, absent browser or failed sandbox blocks execution. There is no production option to disable the sandbox and no fallback browser executable input.
- Validate host/container isolation separately: resource-limited service, bounded PID/memory/CPU/disk use, minimal filesystem permissions, no host or container-control socket mounts, and an egress policy suitable for the API and its restricted browser children. Do not disable host security controls to make the sandbox pass. Keep the browser flag off on unsupported hosts.
- Fresh contexts are offline, scripts disabled, service workers blocked, downloads denied, no permissions granted, all routes aborted. Only sanitized saved HTML is rendered; navigation, active embeds, forms, external CSS/fonts/images and arbitrary scripts are not accepted. Browser child environment is a fixed minimal allowlist without API/database/provider credentials.
- Source limit 200 KB/10,000 nodes; at most 20 raster images, 4 million pixels each / 8 million total. One browser process at a time per API process and one active run per website; 30 attempts/hour/site. Launch timeout 10 seconds, context deadline 20 seconds, durable run expiry 60 seconds. Reports ≤200 KB; screenshots ≤4 MB. Existing artifact quota rejects new writes instead of evicting history.

`GET /jobs/:id/browser-options` returns eligible source selections plus cursor-paginated history (20/page). `POST /jobs/:id/browser-runs` records exact authorization before rendering. `GET /jobs/:id/browser-runs/:runId` returns authorized retained evidence; no public artifact URL is created. These routes require current website-management authority. Session, membership, website, current revision/artifact digest, environment, job state and execution lease are rechecked before successful evidence is committed. Retries with the same key do not re-render; changed inputs/actors conflict. Run, report and screenshot scope is tenant/site/job. Completion and failures are audited.

## Verification boundaries

`npm run test:care-browser` uses real Chromium with **fixed synthetic fixtures** to check rendering, private-text removal, actual masked pixels, viewport dimensions, disclosure interaction, overflow detection and context cleanup. These fixtures can use Playwright's test browser; they do not establish that the deployment's production sandbox works. The optional `CARE_CHROMIUM_EXECUTABLE` test-runner setting is only for these synthetic tests and Care UI tests; the production launcher never reads it.

Database integration tests inject a deterministic renderer and test real authentication, consent, scope rejection, source/session cancellation races, encrypted retention, pagination, duplicate handling and interrupted outcomes. Care UI tests cover approval binding, accessible controls, history reload and disabled-execution reads. Production activation still requires the actual non-root sandbox preflight and operational evaluation. No live customer rendering or production rollout is claimed.

தமிழில்: staging job-இல் **Offline HTML browser tools** திறந்து HTML version, tool, viewport, மறைக்க வேண்டிய element IDs ஆகியவற்றைத் தேர்வு செய்யுங்கள். Privacy review மற்றும் அனுமதியை உறுதிப்படுத்தி இயக்குங்கள். மீண்டும் திறந்தால் **Retained browser history** வழியாக பழைய முடிவுகளைக் காணலாம். இவை standalone HTML சோதனைகள்; முழு application செயல்பாட்டிற்கான உத்தரவாதம் அல்ல.
