# Monoscope demo-project improvement plan

Working document and notepad. Started 2026-08-27. Update status inline as work lands.

**Goal:** make the public Monoscope demo project (`00000000-0000-0000-0000-000000000000`)
a convincing showcase — full-payload instrumentation across every demo service, real
browser sessions with session replay, metric exemplars, source-linked stack traces, and
alerts/dashboards synced from this repo.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked / needs a decision

---

## 0. Status board

| # | Item | Status |
|---|------|--------|
| 1 | Cluster back to 3/3 healthy, images pruned | `[x]` |
| 2 | Fork synced with upstream (252 commits) + pushed | `[x]` |
| 3 | This plan document | `[~]` |
| 4 | Source → cluster build/deploy pipeline | `[ ]` |
| 5 | Monoscope instrumentation per service (payload capture) | `[ ]` |
| 6 | Browser SDK: sessions, user/tenant, replay | `[ ]` |
| 7 | Load generator drives real browser sessions | `[ ]` |
| 8 | Metric exemplars reaching the demo project | `[ ]` |
| 9 | Repo linking → source in stack traces | `[ ]` |
| 10 | Monoscope-as-code config sync from this repo | `[ ]` |

---

## 1. Cluster health — DONE

Three-node k3s cluster (all control-plane + etcd):

| Node | IP | Role |
|---|---|---|
| vps-708640dc | 51.210.5.40 | control-plane, etcd |
| vps-ca6245f8 | 51.210.6.164 | control-plane, etcd — **was NotReady for 24 days** |
| vps-d6d7e318 | 51.210.7.31 | control-plane, etcd |

### What was actually wrong (two independent faults, stacked)

**Fault A — stale IPv6 loopback in the generated kubeconfigs.** This is the root cause and
it had nothing to do with etcd. Every file in `/var/lib/rancher/k3s/server/cred/*.kubeconfig`
on vps-ca6245f8 pointed at `https://[::1]:6444`, while `kube-apiserver` on that node runs
with `--bind-address=127.0.0.1 --secure-port=6444` and therefore listens on IPv4 loopback
only. The healthy nodes' identical files say `https://127.0.0.1:6444`.

So on every boot: apiserver came up fine → controller-manager read `controller.kubeconfig`,
dialled `[::1]:6444`, got connection refused, printed its usage text and exited → k3s
treated that as a shutdown request → systemd restarted it 5s later. **127,765 consecutive
restarts** between 2026-08-03 and 2026-08-27.

The give-away that this is deterministic rather than a startup race: 127k identical
failures. A race wins occasionally.

> **k3s does not regenerate these kubeconfigs.** Deleting them does not help — k3s fails
> with `stat …/scheduler.kubeconfig: no such file or directory`. They must be edited in
> place. Cluster CIDRs on the node are plain IPv4 (`10.42.0.0/16` / `10.43.0.0/16`), so
> nothing in the live config explains the `[::1]`; the files were simply written wrong at
> some point and never rewritten.

**Fault B — aggregated-API bootstrap deadlock.** With Fault A masked, a second blocker
sat behind it: the local aggregator must fetch the discovery doc for
`v1beta1.metrics.k8s.io` by dialling metrics-server's pod IP, which needs flannel on this
node, which waits on the node becoming ready, which waits on `/readyz`, which was blocked
by `[-]poststarthook/apiservice-discovery-controller failed`. Temporarily deleting the
APIService breaks the cycle. It is recreated by k3s's packaged-manifest addon controller
on server start.

### Repair sequence used

1. Snapshot etcd on a healthy node (`k3s etcd-snapshot save --name pre-node-rejoin`).
2. Stop + disable k3s on the broken node, run `k3s-killall.sh`.
3. `kubectl delete node vps-ca6245f8` — k3s's etcd controller removes the member
   ("Removing etcd member from cluster due to node delete"). This also cleared 14 pods
   stuck `Terminating`. Quorum is 2/2 during this window — do not leave it half-done.
4. Move `server/db` aside, write `/etc/rancher/k3s/config.yaml` with an explicit
   `server:` + `token:` (all three nodes run a bare `k3s server` with no config file, so
   without this the node would have bootstrapped a **new solo cluster** instead of
   rejoining), re-enable and start. It rejoined as an etcd learner.
5. `kubectl delete apiservice v1beta1.metrics.k8s.io` (Fault B).
6. Rewrite `[::1]` → `127.0.0.1` in the six `server/cred/*.kubeconfig` files (Fault A).
   Node went Ready in ~20s after 24 days down.
7. Restore the APIService; confirmed `Available=True` and `kubectl top nodes` works with
   the node up — proving Fault A was the real root cause, not Fault B.

### Mistake made during the repair, and its cleanup

Step 6 was first attempted as a recursive `grep -rl '\[::1\]' … | xargs sed -i` over
`/var/lib/rancher/k3s/server/cred/` **and** `/var/lib/rancher/k3s/agent/`. The agent path
contains containerd's overlayfs snapshots, so `sed` rewrote 83 files **inside container
image layers** — vendored PHP sources, `next` server JS, a `.pyc`, and several actual
binaries (`coredns`, `flagd-build`, `nodejs/bin/node`, the `checkout` binary). Replacing a
5-byte string with 9 bytes corrupts every one of those.

Cleanup: stopped k3s, `rm -rf /var/lib/rancher/k3s/agent/containerd` (17 GB), restarted.
Everything re-pulls clean on demand. This incidentally satisfied the "delete non-demo
images" ask for that node.

**Lesson for next time: never point a recursive `sed` at `/var/lib/rancher/k3s/agent/`.**
Scope it to `server/cred/` and enumerate the files explicitly.

### Image prune

`crictl rmi --prune` on all three nodes (removes only images no container references):

| Node | Before | After | Images |
|---|---|---|---|
| vps-708640dc | 37G (52%) | 34G (48%) | 71 → 21 |
| vps-d6d7e318 | 20G (28%) | 19G (27%) | 20 → 18 |
| vps-ca6245f8 | 18G (26%) | 18G (26%) | fresh store → 2 |

Node 1 was carrying 7 `ghcr.io/monoscope-tech/timefusion:*` builds and the entire
superseded `ghcr.io/open-telemetry/demo:2.1.3-*` set. A few deletes hit a containerd
`DeadlineExceeded`; harmless, re-run the prune to finish them.

Final state: **3/3 Ready, no pod outside `Running`/`Completed`, `kubectl top` working.**

Backup of the metrics APIService kept at
`monoscope/scripts/local/demo-cluster/metrics-apiservice-backup.yaml`.

---

## 2. Fork sync — DONE

- `origin` = `git@github.com:monoscope-tech/opentelemetry-demo.git`
- `upstream` = `git@github.com:open-telemetry/opentelemetry-demo.git`

The two uncommitted files (`monoscope-k8s/otel-demo-overlay.yaml`,
`monoscope-k8s/values-agent.yaml`) were deliberate, well-documented ops changes already
reflecting live cluster state — Prometheus and bundled-collector memory limits, plus
forwarding OTLP logs to the monoscope agent with a matching `filelog` exclusion list so
nothing double-counts. **Committed**, not gitignored: they are fork-only files under
`monoscope-k8s/` that upstream does not have, so they carry no merge risk and they are the
only record of why those limits are what they are.

Then merged `upstream/main` (252 commits) — **zero conflicts**, since our three commits
touch only `monoscope-k8s/`. Pushed to `origin/main` as `6d1adfc8`. Now 0 behind upstream.

Our commits on top of upstream:

```
5c66ef0c Raise prometheus/collector memory limits; forward OTLP logs to monoscope
ee2d9782 Wire bundled otel-collector to monoscope via in-cluster agent
0d49bdfb Add Monoscope k8s collector Helm values for docs validation
```

Note: upstream's merge brought a version bump past `2.2.0` and deleted the whole
`test/tracetesting/` tree. The cluster still runs `ghcr.io/open-telemetry/demo:2.2.0-*`
images — see §4, the deployed tags and the source tree are no longer in step.

---

## 3. Monoscope platform facts that constrain the rest of this plan

Researched from the monoscope / monoscope-web / monoscope-skills repos. These are the
non-obvious ones that change what we build.

### 3.1 Browser SDK — `@monoscopetech/browser`

Repo: `monoscope-web`. Current version **0.11.6**.
CDN: `https://unpkg.com/@monoscopetech/browser@0.11.6/dist/monoscope.min.js`.

It is a **class**, not an `init()` function, and the global differs per bundle:

- `dist/monoscope.min.js` (IIFE) → `new Monoscope({...})`
- `dist/monoscope.umd.js` (UMD) → `new Monoscope.default({...})`

Key options: `apiKey` (required), `serviceName`, `exporterEndpoint`,
`metricsExporterEndpoint`, `replayEventsBaseUrl`, `user`, `tenant`, `sampleRate`,
`replaySampleRate`, `enabled`, `enableUserInteraction` (default **true**),
`captureWebVitals` (default true), `captureLongAnimationFrames` (default true),
`captureResourceTiming` / `captureLongTasks` (default false).

Runtime API: `setUser()`, `setTenant()`, `getSessionId()`, `getTabId()`, `startSpan()`,
`recordEvent()`. React bindings exist (`@monoscopetech/browser/react`).

> **There is no session-replay on/off flag.** Replay is configured unconditionally;
> `replaySampleRate: 0` is the only working way to turn it off. (Monoscope's own app
> passes a `sessionReplay:` option that the SDK silently ignores.)

Session/tab/pageview ids are stamped automatically on every span as `session.id`,
`tab.id`, `pageview.id`, `page.url`, `page.title`, `page.referrer`. `setUser({id, email,
full_name})` becomes `user.id` / `user.email` / `user.full_name` span attributes —
exactly the keys the server derives sessions from. Session id lives in `sessionStorage`
(`monoscope-session-id`), rotates after 30 min idle, and is **always a UUID**.

### 3.2 What makes a replay actually appear in the UI

`POST /api/v1/rrweb` (api-key auth) with `{events, sessionId, timestamp}`. Then:

1. `sessionId` **must be a UUID**.
2. **The same UUID must also be the `session.id` attribute on that project's spans.** The
   sessions list looks up which of the page's session ids exist in
   `projects.replay_sessions` and only then shows the replay affordance. Sessions
   *derived* from `user.id`/`user.email` (the fallback for SDKs that emit no `session.id`)
   can never have a recording.

The SDK satisfies this by construction — same `sessionId` for the replay upload and the
span attribute. **Any custom integration must preserve that identity.**

Server-side, the POST only republishes to Kafka topic `rrweb-client`; the consumer is
gated on **`ENABLE_REPLAY_SERVICE`**. Without it the POST still returns 200 and nothing is
ever written to S3. Verify this is on for the environment the demo reports to *before*
concluding the browser side is broken.

> Known contract drift (upstream bug, not ours): the SDK sends nested `user` / `tenant`
> objects, but the server expects flat `userId` / `userEmail` / `userName`, so
> `replay_sessions` user metadata is always null and the player shows no user label. The
> span attributes are unaffected. Worth reporting; not a blocker for the demo.

### 3.3 Sessions, users, tenants

Session key is
`COALESCE(NULLIF(session.id,''), NULLIF(user.id,''), NULLIF(user.email,''))`.

Recognised identity attributes include `session.id`, `user.id`, `user.email`, `user.name`,
`user.full_name`, `enduser.*`, `tenant.id`, `tenant.name`, `organization.id`,
`account.id`, `workspace.id`, `customer.id`.

> **`tenant.*` is display/filter-only** — it has no promoted column and plays no part in
> session derivation. Demo tenants will show in the detail panel and be filterable, but
> won't group sessions.

### 3.4 Exemplars

Requirements, in order of what usually goes wrong:

1. Metric datapoints must carry OTLP exemplars with a **non-empty `trace_id`** — anything
   else is dropped at ingest.
2. The measurement must be recorded **inside a sampled span**, with the SDK's exemplar
   filter on (`trace_based` is the OTel default).
3. **Collector-scraped and Prometheus-scraped metrics never carry exemplars.** This is the
   important one for us: the demo's metrics currently flow through the bundled collector's
   `spanmetrics` connector and Prometheus. Those paths cannot produce exemplars — the
   exemplar filter has to be set in the *emitting application's* SDK, and the metric has to
   be recorded in application code inside a sampled span.

So §8 is not a collector-config change. It needs at least one service emitting a real
application metric (a histogram on a request path is the natural choice) with exemplars
enabled, exported over OTLP to the monoscope agent.

### 3.5 Repo linking — three separate things

| Table | What it is |
|---|---|
| `projects.git_credentials` | a grant over an org/account; many per project |
| `projects.code_mappings` | stack-frame path → repo path; the source-in-errors feature |
| `projects.git_sync` | the one repo a project keeps its dashboard YAML in |

Code mappings are what §9 needs. A mapping is `(credential, owner, repo, ref, service,
pathPrefix, sourceRoot)`; longest `pathPrefix` wins, scoped to its `service`. The settings
form can **derive** `pathPrefix`/`sourceRoot` from a pasted stack-trace line by matching it
against the repo's file tree — use that rather than hand-computing prefixes.

> **Attribute-name trap:** monoscope reads `code.file.path`, `code.line.number`,
> `code.function.name`. It reads **`code.filepath` / `code.lineno` nowhere.**
> Instrumentation on the older OTel convention will silently never resolve source.

Revision precedence for picking which commit to show: `service.version` →
`vcs.repository.ref.revision` → `git.commit.sha`, and the value must look like a sha
(7–40 hex chars), so a semver `service.version` is correctly ignored. **If we stamp the
demo images with the git sha in one of those resource attributes, stack traces resolve
against the exact commit that threw.** Worth doing as part of §4.

Source is fetched at read time and never stored.

### 3.6 Monoscope-as-code — two disjoint mechanisms

This matters for §10, because picking the wrong one wastes the night.

**A. Server-side git sync.** Repo configured per project; monoscope reads
`<pathPrefix>/dashboards/*.yaml`. File format is a **bare** `Dashboard` object.
- **Dashboards only** — there is no `monitors/` directory and no monitor sync from git.
- **Webhook push events are the only pull trigger.** The in-app copy claiming "syncing
  happens on a schedule or can be triggered manually" is false — there is no cron and no
  manual trigger. A webhook must be configured on the repo or nothing ever syncs.

**B. CLI `monoscope <resource> apply`.** Covers monitors *and* dashboards, idempotent
(monitors upsert by `title`, dashboards by `file_path`). Dashboard YAML here is a
**different shape** — nested under `schema:`. The two formats are **not interchangeable**.

Plan for §10: use **both, for what each is good at** — git sync to prove the webhook path
works end to end for dashboards, and a CI job running `monoscope apply` for monitors,
since git sync cannot carry them. Keep the two file sets in separate directories so the
incompatible schemas never collide.

### 3.7 Demo project auth

`00000000-0000-0000-0000-000000000000`, seeded in migration `0001`. Two bypasses: the web
UI auto-provisions a Guest session for any `/p/00000000-…` URL, and the API accepts an
`X-Project-Id: 00000000-…` header **instead of** an `Authorization` header.

> That API bypass is a **write** hole, not just a read convenience — it exposes the whole
> `/api/v1` surface including `/api/v1/rrweb` to anonymous callers. Flagging it; it is a
> product decision, not something to change as part of this work. It does mean the demo's
> browser SDK does not strictly need a real api key, but we should still use one so the
> demo mirrors what a customer would do.

Also: the demo project has a **live Stripe subscription**, and its event volume meters as
billable. Ramping load-generator volume for a better demo has a real cost — keep the
current rate unless there's a reason, and note any increase here.

---

## 4. Source → cluster pipeline — THE CRITICAL PATH

### The gap, stated plainly

**Today, nothing in this fork's `src/` reaches the cluster.** There are no demo manifests,
no kustomize base and no helm chart in this repo — the demo is installed from the
*upstream* `open-telemetry/opentelemetry-demo` chart, and `monoscope-k8s/otel-demo-overlay.yaml`
overrides **no image fields at all**. The cluster is running
`ghcr.io/open-telemetry/demo:2.2.0-*`, i.e. upstream binaries.

CI won't help either: `.github/workflows/build-images.yml` is guarded by
`if: ${{ !github.event.repository.fork }}`, so it never runs here.

The drift is already visible — the cluster still runs `llm` and `product-reviews` pods,
but upstream **deleted both services**, and the repo is now on `IMAGE_VERSION=3.0.0` while
the cluster is on 2.2.0.

### What has to be built

- [ ] Un-fork-guard (or replace) the image build workflow so the fork pushes to
      `ghcr.io/monoscope-tech/demo:<tag>-<service>`, mirroring upstream's tag shape.
      GitHub Actions gives free amd64 runners; the nodes are amd64 and a local Mac is
      arm64, so building locally means slow `buildx --platform linux/amd64` emulation.
- [ ] Add per-component `image.repository` / `image.tag` overrides to
      `otel-demo-overlay.yaml`. **`make k8s-apply-otel-demo-overlay` runs with
      `--reset-values`**, so the overlay must carry the complete set of user values —
      a partial overlay silently drops the memory limits and the monoscope exporter.
- [ ] Stamp the git sha into `service.version` / `vcs.repository.ref.revision` at build
      time so §9's source links resolve against the commit that actually threw.
- [ ] Decide whether to first upgrade the installed chart to the 3.0.0 line (removing the
      dead `llm`/`product-reviews` pods) or pin the overlay to the chart already installed.
      Upgrading is cleaner but is a bigger blast radius on a live demo — do it *after* the
      quick wins below, not before.

### Revised sequencing — quick wins first

The build pipeline is most of a night's work on its own, so the plan is reordered to put
**everything that needs no image rebuild first**. That way the demo is meaningfully better
even if the pipeline isn't finished.

| Order | Item | Needs an image rebuild? |
|---|---|---|
| 1 | §10 config sync (dashboards + monitors) | no — pure config + repo files |
| 2 | §9 repo linking | no — monoscope-side config |
| 3 | §8 exemplars | probably not — `cart` already sets `TraceBased` |
| 4 | §6 browser SDK + replay | **frontend only** |
| 5 | §7 browser-driven sessions | **load-generator only** |
| 6 | §5 payload capture across all services | every service — the long tail |

Items 4 and 5 are the highest *visual* demo value, and they need exactly **two** images
built, not twenty. That is the pipeline's first real job; the twenty-service payload work
rides the same rails afterwards.

---

## 5. Payload capture per service

Full inventory is in `scratchpad/otel-demo-reference.md`. Summary of what we're up against:

**No service captures request or response bodies today.** The `demo.*` attributes are
business scalars, not payloads, so this is genuinely additive everywhere. The insertion
point differs by how each service is wired:

| Wiring | Services | Where the hook goes |
|---|---|---|
| javaagent | ad, fraud-detection, kafka | env vars |
| .NET auto (`instrument.sh`) | accounting | env vars |
| `opentelemetry-instrument` | recommendation | env vars |
| `NODE_OPTIONS --require` | payment | env vars |
| PHP ext + autoloader | quote | env vars |
| declarative config | product-catalog | `otel-config.yml` |
| hand-written SDK bootstrap | checkout, cart, currency, email, shipping, flagd-ui, chatbot | that file |
| Next.js API routes | frontend | `utils/telemetry/InstrumentationMiddleware.ts` — already wraps every handler and has req+res in scope |
| nginx / Envoy | image-provider, telemetry-docs, frontend-proxy | module/filter config |

> **PII warning — read before enabling body capture on checkout.** The compose collector's
> `transform/redact_sensitive_data` redacts **by attribute key** (`demo.payment.card_cvv`,
> `demo.payment.card_number`, hashes `user.email`). A serialized request body is a single
> opaque blob those rules cannot see, so turning on payload capture over `/api/checkout`
> ships **card numbers, CVVs and addresses** to monoscope in the clear. Either add
> body-level redaction alongside, or exclude the checkout payment path. This is a blocker
> for that specific route, not for the feature.

## 6. Browser SDK — sessions, user/tenant, replay

Good news: the frontend already has most of the scaffolding.

- HTML root: `src/frontend/pages/_document.tsx` — already injects a `window.ENV` blob, so
  a script tag and its config both have a home.
- Client init: `src/frontend/pages/_app.tsx` already runs `FrontendTracer()` at module
  scope behind `typeof window !== 'undefined'`. The Monoscope SDK goes next to it.
- **`src/frontend/utils/telemetry/SessionIdProcessor.ts` already stamps `session.id` and
  `enduser.id` on every browser span**, from `SessionGateway.getSession().userId`.

> **The single most important integration detail:** per §3.2, a replay only surfaces if the
> replay `sessionId` is byte-identical to the `session.id` on the spans. So either point
> `SessionIdProcessor` at `monoscope.getSessionId()`, or feed the existing
> `SessionGateway` id into the SDK. **Do not let the two id sources diverge** — that is
> exactly the failure mode where replays land in S3 and never appear in the UI. Also
> confirm the existing id is a **UUID**; the server requires it.

Tenant: pick something demo-plausible and stable (the demo has no real tenancy) so the
tenant facet is populated. Remember §3.3 — tenant is display/filter-only.

New config must be added to the frontend's compose env block **and** surfaced through
`window.ENV`, or it is invisible in the browser.

## 7. Browser-driven sessions for good replays

Much better starting position than expected: **the load generator is already k6 v2 running
headless Chromium** (`grafana/k6:2.2.0-with-browser`), not Locust.

`src/load-generator/script.js` already has a `browserScenario` with two flows
(`changeCurrency`, `addProductToCartBrowser`), each wrapped in an OTel span and sending
`baggage: synthetic_request=true`.

What it lacks for a good replay:

- [ ] `vus: 1` → raise it (mind the billing note in §3.7)
- [ ] **No mouse movement at all** — only `page.click` / `page.selectOption`. Replays will
      show jump-cuts, not a cursor. Use k6 v2's browser mouse/hover API for real pointer
      motion, scrolling, and dwell time.
- [ ] More routes — a full browse → product → add to cart → view cart → checkout journey.

Do **not** add Playwright or Puppeteer. k6's browser module is the in-tree mechanism, and
it is Playwright-*like* but not Playwright (no `:has-text()`; selectors go straight to
`querySelectorAll`). Cypress exists in the repo but is e2e-test-only.

## 8. Exemplars

Likely much closer than expected: **`src/cart/src/Program.cs` already calls
`SetExemplarFilter(ExemplarFilterType.TraceBased)`** and exports metrics over OTLP. Per
§3.4 that is exactly the required shape — application metric, recorded in a sampled span,
OTLP-exported.

- [ ] Verify cart's OTLP metrics actually reach monoscope with exemplars attached. The
      k8s path forwards metrics from the bundled collector to the monoscope agent, so it
      should already work — **check before building anything.**
- [ ] If nothing shows: confirm sampling isn't dropping the parent spans, and confirm the
      metrics pipeline isn't losing exemplars in a processor.
- [ ] Do **not** try to get exemplars out of `spanmetrics` or Prometheus — §3.4, those
      paths structurally cannot produce them.

## 9. Repo linking

Monoscope-side config only; no image rebuild.

- [ ] Install the GitHub App on `monoscope-tech` (writes a `git_credentials` row).
- [ ] Add `code_mappings` for the demo services. Use the settings form's **derive** path —
      paste a real stack-trace line from a demo error and let it match against the repo
      tree rather than hand-computing `pathPrefix`/`sourceRoot`.
- [ ] Best candidates: `fraud-detection` (Kotlin, restarts constantly — 6523 restarts, so
      guaranteed stack traces) and `frontend` (TypeScript, `src/frontend/...`).
- [ ] Per §3.5, check whether the demo's spans carry `code.file.path` — if they only carry
      printed stack traces, that still works; if they carry the *old* `code.filepath`
      convention, source will never resolve and that's an instrumentation fix.

**Verify by opening a real error in the demo project and expanding a frame.**

## 10. Monoscope-as-code config sync

Per §3.6 these are two disjoint mechanisms; use each for what it can do.

- [ ] Branch in this repo (e.g. `monoscope-config`) holding:
  - `dashboards/*.yaml` — **bare `Dashboard`** shape, for server-side git sync
  - `monoscope/monitors/*.yaml` — `MonitorInput` shape, for `monoscope monitors apply`
  - kept in **separate directories** so the two incompatible dashboard schemas can never
    be fed to the wrong consumer
- [ ] Configure git sync on the demo project pointing at that repo/branch.
- [ ] **Configure the webhook** — this is the step that is easy to skip and fatal to skip.
      Webhook push events are the *only* pull trigger; the UI's claim about scheduled or
      manual sync is false.
- [ ] CI job (or a manual run) doing `monoscope monitors apply monoscope/monitors/` since
      git sync cannot carry monitors at all.
- [ ] **Verify by pushing a change and watching it land**, then by rendering the dashboard
      server-side rather than re-reading the YAML.

---

## Appendix: things found that are worth reporting separately

1. Replay payload contract drift — SDK sends `user`/`tenant` objects, server expects flat
   `userId`/`userEmail`/`userName`. Replay user metadata is permanently null.
2. `sessionReplay:` is not a real SDK option; `enableSessionReplay=False` does not stop
   monoscope's own pages recording.
3. Git-sync UI copy about scheduled/manual sync is false.
4. Landing-page browser SDK docs are stale vs 0.11.6, and document
   `enableUserInteraction`'s default inverted.
5. The demo-project API auth bypass permits anonymous writes.
