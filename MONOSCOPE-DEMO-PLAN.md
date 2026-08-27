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
| 3 | This plan document | `[x]` |
| 4 | Source → cluster build/deploy pipeline | `[x]` chart upgraded + build workflow |
| 5 | Monoscope instrumentation per service (payload capture) | `[x]` frontend API surface; `[ ]` backends |
| 6 | Browser SDK: sessions, user/tenant, replay | `[x]` verified end to end |
| 7 | Load generator drives real browser sessions | `[x]` verified end to end |
| 8 | Metric exemplars reaching the demo project | `[x]` generated and resolving 8/8 |
| 9 | Repo linking → source in stack traces | `[x]` verified |
| 10 | Monoscope-as-code config sync from this repo | `[x]` verified both directions |

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

### Chart upgraded to 0.41.0 (app 3.0.0) — DONE

The cluster ran chart `0.40.7` / app `2.2.0` while our source tree had moved to 3.0.0.
Rather than backport onto a frontend and load generator that no longer exist in our
source, the cluster was upgraded so cluster ↔ source ↔ chart agree. This also ships the
**k6 + headless-Chromium load generator** that §7 needs, with `K6_BROWSER_ENABLED=true`
already set by the chart.

**The trap that made this dangerous:** 0.41.0 renamed every exporter the overlay re-lists
verbatim — `otlp/jaeger` → `otlp_grpc/jaeger`, `spanmetrics` → `span_metrics`,
`otlphttp/prometheus` → `otlp_http/prometheus`. Applying the old overlay would have
produced a collector config referencing exporters that do not exist, the collector would
have refused to start, and **all demo telemetry would have stopped**. The overlay now pins
the chart version and says why at the top.

Also: `agent`, `chatbot` and `mcp` (the new LLM services) are disabled — `agent` needs an
`OPENAI_API_KEY` we do not hold, and three crash-looping pods on nodes already at 56-64%
memory is not "realistic demo errors".

Sequence used: rewrite overlay → `helm template` and grep the rendered collector config
and image tags → save rollback values → `helm upgrade --version 0.41.0 --reset-values`.

**Result:** converged in 80 seconds, 32/32 pods Running, no collector config errors,
telemetry uninterrupted (900–1500 events per 5s bin immediately after), new services
`astronomy-db` and `opamp-server` reporting, dead `llm` / `product-reviews` gone.
Rollback: `helm rollback otel-demo 18`, values saved at
`monoscope-k8s/rollback/otel-demo-values-rev18-chart0.40.7.yaml`.

### Image pipeline — BUILT

`.github/workflows/monoscope-build-images.yml`: manual dispatch, explicit service list,
defaults to `frontend,load-generator`, pushes `ghcr.io/monoscope-tech/demo:<sha>-<service>`,
amd64 only, gha layer cache per service. Upstream's own workflow is fork-guarded and
builds all ~20 services, so it is neither usable nor wanted here.

Image tags and the browser RUM key go in `monoscope-k8s/otel-demo-images.yaml` —
**gitignored**, with `otel-demo-images.example.yaml` committed as the template. Applied as
a second `-f` alongside the overlay; `--reset-values` clears values from *previous*
releases, not ones passed in the same command.

### Still open

- [ ] Stamp the git sha into `service.version` / `vcs.repository.ref.revision` at build
      time so §9's source links resolve against the commit that actually threw. Until
      then the code mappings pin an explicit ref.
- [ ] Re-sync `values-agent.yaml`'s hardcoded `filelog.exclude` list — it still names
      `llm` and `product-reviews`, which no longer exist, and does not name the services
      3.0.0 added. Per its own in-file note, a service that starts emitting OTLP logs and
      is not excluded gets its logs counted twice.
- [ ] Watch event volume: k6 at `LOAD_GENERATOR_VUS=5` versus the old Locust rate is an
      unknown, and the demo project has a live Stripe subscription (§3.7). Baseline
      before the upgrade was **87.9k events/hr**.

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

## 5. Payload capture — DONE for the frontend API surface; backends are the long tail

**Shipped: every `/api/*` route on the frontend is wrapped by the Monoscope Next SDK**, so
spans carry the payload contract the server actually decodes. Verified live: **342 spans
with `body.request_body` and `body.response_body` populated** — that `body` column is what
the Req/Resp Body tabs read, and it is what the earlier hand-rolled hook never produced.

Response bodies contain real payloads (76 distinct variants: product catalog, cart
contents). **Request bodies currently arrive as `{}`** — see the SDK defects below; the
published SDK does not capture them on a Pages Router app. Nothing sensitive is exposed by
this (the bodies are empty), but request payloads are not yet part of the demo.

### The frontend now uses the native SDK

`utils/telemetry/InstrumentationMiddleware.ts` wraps every `/api` route with
**`withMonoscopePagesRouter`** from `@monoscopetech/next`, with `captureRequestBody` /
`captureResponseBody` on and JSONPath redaction.

This replaced a hand-rolled hook, and the reason is a correctness one rather than taste.
Monoscope only lifts bodies out of a span and into the **Req/Resp Body tabs** when:

1. the span is one of its own — `sdkSpanNames = ["apitoolkit-http-span", "monoscope.http"]`
   (`Telemetry.hs:967`), checked as `isOurSdkSpan` in `OtlpServer.hs:1266`; and
2. the body attribute is **base64**, which `extractBody` runs through `b64ToJson`.

The hand-rolled version set `http.request.body` to raw JSON on the ambient span. The
attributes were searchable, but the panel that exists to show payloads stayed empty — which
reads as the feature being broken. The SDK emits exactly the contract the server decodes.

It composes rather than replaces: the SDK takes no exporter configuration and writes to the
ambient tracer, so the demo's own OTel bootstrap and collector routing are untouched.

> **Both redaction lists carry the same paths on purpose.** `@monoscopetech/next@1.1.1`
> redacts the *response* body with `redactRequestBody` — `redactResponseBody` is accepted
> and then ignored. Listing the checkout paths only under the response key would ship
> addresses and card fields in the clear. Fixed upstream in
> [monoscope-js#31](https://github.com/monoscope-tech/monoscope-js/pull/31); the duplicate
> can go once that ships.

### The backends: what a native SDK can and cannot reach

The honest answer is that **most of the demo cannot take a native SDK at all**, because the
SDKs are HTTP-framework middlewares and most demo services speak gRPC.

| service | language | transport | native SDK? |
|---|---|---|---|
| frontend | Next.js | HTTP | **yes — shipped** (`@monoscopetech/next`) |
| quote | PHP / Slim | HTTP | SDK exists, **blocked** — see below |
| email | Ruby / Sinatra | HTTP | no SDK |
| shipping | Rust / actix-web | HTTP | no SDK |
| flagd-ui | Elixir / Phoenix | HTTP | no SDK |
| image-provider, telemetry-docs | nginx | HTTP | no SDK (module config only) |
| frontend-proxy | Envoy | HTTP | no SDK (native tracer only) |
| checkout, product-catalog | Go | **gRPC** | SDK is `net/http` middleware only |
| cart, accounting | .NET | **gRPC** / Kafka | n/a |
| ad, fraud-detection | Java / Kotlin | **gRPC** / Kafka | n/a |
| recommendation | Python | **gRPC** | n/a |
| payment | Node | **gRPC** | n/a |
| currency | C++ | **gRPC** | n/a |

`monoscope-go` was checked directly: it ships `chi`, `echo`, `fiber`, `gin`, `gorilla` and
`native` middlewares and contains **no gRPC support at all** — so the two Go services are
out of reach even though a Go SDK exists.

**`quote` is blocked on a dependency conflict, not on effort.** `apitoolkit/apitoolkit-slim`
v2.0.4 emits the right contract (it builds an OTel span literally named
`apitoolkit-http-span`), but its `composer.json` requires `php-di/php-di: ^6.4` while the
demo pins `7.1.1` — and `php-di/slim-bridge 3.4.1` needs the 7.x line. The SDK's own source
does not reference php-di anywhere, so this is a stale constraint: relaxing it to
`^6.4 || ^7.0` upstream unblocks the service. That one-line change is the next step for the
backends, not a rewrite.

**For everything with no SDK, the path is the contract, not a package**: emit a span named
`monoscope.http` (or `apitoolkit-http-span`) carrying base64 `http.request.body` /
`http.response.body`, with redaction applied before encoding. That is all the server keys
off, and it is what the frontend now gets for free from the SDK.

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

## 8. Exemplars — VERIFIED WORKING, with one real defect

**Exemplars are already flowing to the demo project.** No build or config change was
needed to get them; `src/cart/src/Program.cs` already calls
`SetExemplarFilter(ExemplarFilterType.TraceBased)` and the k8s path forwards OTLP metrics
through to monoscope intact.

Confirmed live against `00000000-…`:

```
GET /p/00000000-…/metrics/details/<metric>/exemplars?since=1h
  http.server.request.duration -> 100 exemplars (page cap)
  http.client.request.duration -> 100
  rpc.server.duration          ->  88
  quotes                       ->   0   (plain counter, no exemplar filter)
```

Each carries a real `trace_id`, `span_id`, `value` and a deep link to the trace.

### Defect: ~87% of exemplars link to a trace that isn't stored

Sampled 8 most-recent exemplars from each of two metrics and resolved each trace id:
**1/8 and 1/8**. Re-tested minutes later with an identical result, so this is **not**
ingestion lag. A known-good app trace round-trips fine (`count=3`), so the query is sound.

Cause — look at who actually emits these metrics:

| metric | datapoints by service (30m) |
|---|---|
| `http.server.request.duration` | **otelcol-contrib 282**, **jaeger 179**, flagd 120, cart 120 |
| `rpc.server.duration` | **otelcol-contrib 1704**, **jaeger 180**, product-catalog 120, checkout 60, ad 30 |

The exemplar list is dominated by **collector and Jaeger self-telemetry**. Those services'
metrics are forwarded to monoscope but their **traces are not**, so their exemplars point
at trace ids that were never ingested. The ~19% of datapoints from real app services
matches the ~12% resolution rate observed.

So the feature works; the demo experience is polluted. Fix options:

- **(preferred)** drop infra self-telemetry from the metrics forwarded to monoscope — add
  a `filter` processor on the bundled collector's metrics pipeline excluding
  `service.name` in `{otelcol-contrib, jaeger}`. Keeps volume (and billing, §3.7) down and
  leaves the exemplar list all-app.
- (alternative) also forward those services' traces so the links resolve — but that adds
  event volume on a project with a live Stripe subscription.

- [ ] Implement the filter in `otel-demo-overlay.yaml`. **Careful:** `make
      k8s-apply-otel-demo-overlay` runs `--reset-values` and the chart *replaces* pipeline
      arrays rather than merging, so the processor list must be re-listed in full.
      Diff the live release values before applying — a botched apply takes the demo down.

Do **not** try to get exemplars out of `spanmetrics` or Prometheus — §3.4, those paths
structurally cannot produce them.

## 9. Repo linking — DONE AND VERIFIED

`monoscope-bot` (app id 2478362) was **already installed** on the `monoscope-tech` org as
installation `152960927`, already covering `monoscope-tech/opentelemetry-demo`. No new
install was needed — only a record of it against the demo project.

### Two obstacles worth writing down

**1. `/github/callback` is not covered by the demo auth bypass.** The Guest-session bypass
only matches `/p/<pid>/…` URLs, so hitting the callback directly redirects to Auth0. The
route that *is* under `/p/:pid` — `POST /p/:pid/settings/git-sync/select` — calls
`recordInstallation` itself, so pointing that at the installation both configured dashboard
sync **and** wrote the `git_credentials` row. One request, both features.

**2. A project can only ever read source from its alphabetically-first credential.**
`codeContextCredential` takes `cred : _` from a query ordered `ORDER BY account`. The demo
project had a stray credential for an unrelated org, `Helios-Flores-Empire-LLC` (installed
2026-08-11, zero code mappings), which sorts before `monoscope-tech` and therefore masked
it completely — the settings page kept offering Helios repos even after ours was recorded.
Deleted the stray row; the page immediately switched to `monoscope-tech`.

> This is a **product limitation worth reporting**: a project with two credentials can
> never use the second one, and the UI gives no indication that the account shown is a
> silent pick from several.

### Which ref to map against

The cluster runs **upstream `demo:2.2.0-*` images**, while our `main` has moved 252 commits
past that. Mapping to `main` would resolve wrong lines or `LineOutOfRange`. Checked file by
file:

| file | at `2.2.0` | at `main` |
|---|---|---|
| `src/recommendation/recommendation_server.py` | yes | yes |
| `src/quote/app/routes.php` | yes | yes |
| `src/product-reviews/product_reviews_server.py` | yes | **no** (deleted upstream) |
| `src/load-generator/locustfile.py` | yes | **no** (rewritten to k6) |

So all four mappings use **`ref: 2.2.0`**, which is exactly the code the running binaries
were built from. The tag exists on the fork (`b74a7bc7`). **When §4 ships sha-stamped fork
images, these refs should move to the sha** — at that point `service.version` on the spans
takes precedence anyway (§3.5).

### What was created

Four services emit `code.file.path` (the correct modern attribute, not the legacy
`code.filepath` — so no instrumentation fix was needed). Mappings were created through the
form's **derive** path — pass `samplePath` and leave the path fields blank:

| service | path_prefix | source_root |
|---|---|---|
| recommendation | `/app/` | `src/recommendation` |
| product-reviews | `/app/` | `src/product-reviews` |
| quote | `/var/www/` | `src/quote` |
| load-generator | `/usr/src/app/` | `src/load-generator` |

### Verified

`GET /p/00000000-…/code_context?file=…&line=…&service=…` returns real source, correctly
centred on the requested line, for recommendation, load-generator and product-reviews.

> Note on quote: its observed frames are mostly `/var/www/vendor/**`, which is not in git,
> so those stay plain text by design. Application frames under `/var/www/app/**` resolve.

## 10. Monoscope-as-code config sync — DONE AND VERIFIED BOTH DIRECTIONS

Configured against branch **`monoscope-config`** of this repo, path prefix `monoscope`, so
dashboards live at `monoscope/dashboards/`. The GitHub App **configures the webhook
automatically** — no manual webhook setup was needed, which answers the one open question
that would otherwise have silently broken the pull direction.

### Verified

**Push (monoscope → git).** Selecting the repo enqueued `GitSyncPushAllDashboards`, which
committed the project's three existing dashboards to the branch:

```
1c1d7132 Sync dashboard:
ea9d5ba5 Sync dashboard: ffg
4509a6ca Sync dashboard: Test
```

**Pull (git → monoscope).** Edited `monoscope/dashboards/test.yaml` on the branch via the
GitHub API — a real push event, hence a real webhook — changing `title: Test` to
`title: Test SYNC-PULL-OK`. The dashboard title in the project changed **within 10
seconds**. This is the GitOps path working end to end.

**Monitors via CLI.** Git sync cannot carry monitors at all, so they take the CLI path.
Three monitors written to `monoscope/monitors/` and applied:

```
monoscope monitors apply monoscope/monitors/
```

| monitor | shape |
|---|---|
| Demo — recommendation service errors | error count > 5 in 15m |
| Demo — ad service errors | error count > 8 in 15m (flag-driven failures) |
| Demo — checkout throughput dropped | `trigger_less_than`, count < 5 in 30m |

Queries were validated against live demo data **before** committing — note the demo's
`status_code` values are `ERROR` / `UNSET`, **not** `STATUS_CODE_ERROR`. All three now
evaluate with `current_status: normal`, and the KQL compiled to real SQL.

**Idempotency confirmed**: re-running `apply` left 3 monitors, not 6 (upsert by `title`).

### Left as-is deliberately

The demo project's three pre-existing dashboards are empty test junk (`Test`, `ffg`, and
one with a **blank title**). The blank one round-trips to a file literally named `.yaml` —
a dotfile — which is a small bug worth reporting. Replacing these with real demo dashboards
is worthwhile but is content work, not a test of the feature, and the feature is proven.

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

---

## 11. Deployed state, and how to change it

Cluster runs helm release `otel-demo` at chart **0.41.0** (app 3.0.0), revision 23.

| component | image |
|---|---|
| frontend | `ghcr.io/monoscope-tech/demo:deb441b-frontend` (fork: RUM + payload capture) |
| load-generator | `ghcr.io/monoscope-tech/demo:0d0f95d-load-generator` (fork: browser journeys) |
| everything else | `ghcr.io/open-telemetry/demo:3.0.0-*` (upstream) |

To ship a change to either fork-built service:

```sh
# 1. build (amd64, manual dispatch, tag defaults to the short sha)
gh workflow run monoscope-build-images.yml \
  -R monoscope-tech/opentelemetry-demo --ref main -f services=frontend

# 2. point the values file at the new tag
#    monoscope-k8s/otel-demo-images.yaml  (gitignored)

# 3. apply BOTH values files together
helm upgrade otel-demo open-telemetry/opentelemetry-demo \
  --version 0.41.0 --reset-values \
  -f monoscope-k8s/otel-demo-overlay.yaml \
  -f monoscope-k8s/otel-demo-images.yaml
```

Rollback to the pre-upgrade state: `helm rollback otel-demo 18`.

### Two traps that cost real time here

1. **`useDefault.env: true` does not merge the chart's component env.** Supplying `env`
   for a component *replaces* that component's list outright. The first render dropped all
   eight backend gRPC addresses from the frontend; had it been applied, the frontend would
   have reached nothing and it would have looked like a bad build. Every chart default is
   now repeated verbatim in `otel-demo-images.yaml`, with a comment saying why. **Always
   `helm template` and count the env vars before applying.**

2. **Never regenerate the frontend lockfile on macOS.** `npm install` on arm64 silently
   dropped the top-level `@emnapi/core` / `@emnapi/runtime` entries, which are only
   reachable on linux. Nothing local noticed; the image build failed with
   `Missing: @emnapi/runtime@1.11.3 from lock file`. Regenerate inside the node image the
   Dockerfile uses:

   ```sh
   docker run --rm -v "$PWD/src/frontend":/app -w /app node:25.9.0-slim \
     npm install --package-lock-only
   ```

---

## 12. Open items, in priority order

1. **Payload capture on the backend services (§5).** Reuse `PayloadCapture.ts`'s redaction
   rules; `checkout` and `cart` first.
2. **Stamp the git sha** into `service.version` at build time so code mappings follow the
   deployed commit instead of a pinned tag (§9).
3. **Git-sync pull is intermittent — the most important open item.** Roughly every other
   push is silently not processed: the webhook returns 200 and is logged as accepted, but
   `projects.git_sync.last_revision` does not advance and no dashboard changes apply. The
   next push that *does* run sweeps up everything the missed ones left, so nothing is
   lost — it just arrives late and unpredictably. Observed 5 pushes: 3 synced in under
   20s, 2 never synced at all until a later push. Reproduce by pushing twice in a row and
   watching `last_revision`.
4. **Event volume roughly tripled — decide if that is acceptable.** 87.9k events/hr before
   this work, **~264k/hr after**, on a project with a live Stripe subscription. No single
   runaway service; it is the 3.0.0 upgrade's extra services, browser RUM (~23k/hr), and
   the kafka logs that were previously being dropped entirely (~5k/hr). Levers, cheapest
   first: `LOAD_GENERATOR_VUS` (chart default 5), the browser scenario's VU count, and
   `MONOSCOPE_REPLAY_SAMPLE_RATE` (currently 1 = record everything).

## 13. Monoscope product defects found while doing this

Each is a real bug in the product, found by using it rather than by reading it:

1. **`@monoscopetech/browser@0.11.6` cannot be imported by Node at all.** Published with
   `"type": "module"` but `dist/index.js` uses extensionless relative imports, which is
   invalid ESM. Any SSR framework fails at build time, not just at runtime.
2. **The published SDK has no tenant support** — no `tenant` config option, no
   `setTenant()` — though both exist in the monoscope-web source. The npm release is
   behind.
3. **A project can only ever read source from its alphabetically-first git credential.**
   `codeContextCredential` takes the head of a list ordered by account name. A stray
   credential for an unrelated org silently masked ours, and the UI gave no indication the
   account shown was one pick from several.
4. **The git-sync settings page claims syncing "happens on a schedule or can be triggered
   manually".** Neither exists — a push webhook is the only pull trigger.
5. **Git-sync pull silently skips pushes** (see open item 3) — intermittent, ~40% miss
   rate, webhook accepted with 200 each time.
6. **Replay payload contract drift.** The SDK sends nested `user`/`tenant` objects; the
   server expects flat `userId`/`userEmail`/`userName`, so replay user metadata is
   permanently null and the player shows no user label.
7. **A dashboard with an empty title round-trips to a file literally named `.yaml`.**
8. **The demo project's API auth bypass permits anonymous writes**, not just reads — an
   `X-Project-Id` header skips the `Authorization` check for the whole `/api/v1` surface.
