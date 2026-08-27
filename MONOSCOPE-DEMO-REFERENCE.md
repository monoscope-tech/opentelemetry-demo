# OpenTelemetry Demo fork — factual reference

Pinned to `/Users/tonyalaribe/Projects/opentelemetry-demo` @ **`6d1adfc8`**, working tree clean.

## 0. IMPORTANT — the repo changed during this research

The task brief described "252 upstream commits to sync" + "3 local commits" + "2 uncommitted files".
**All three of those are now stale.** During this session another process merged upstream and committed:

- `git rev-list --count HEAD..upstream/main` = **0**. Step (a) of the plan is DONE.
- Local-only commits are now **5**: `0d49bdfb`, `ee2d9782`, `1534b78d` (merge), `5c66ef0c`, `6d1adfc8` (merge).
- The two formerly-uncommitted `monoscope-k8s/` files were committed as `5c66ef0c`.

Consequences for the plan:
- `src/llm` and `src/product-reviews` **no longer exist** (removed upstream).
- `src/opamp-server` is **new**; `firepit` (profiles backend) is new as an external image.
- `src/load-generator` was **rewritten from Locust to k6 v2 + headless Chromium**. It already drives a real browser.
- `src/flagd-ui` was rewritten from Next.js to **Elixir/Phoenix**.

## 1. Service inventory

Ports come from `.env`. "Body capture" = does anything put request/response payloads on spans today.

| Service | Language / runtime | Framework | Proto & port | OTel wiring | Bootstrap file |
|---|---|---|---|---|---|
| accounting | C# / .NET 10 (sdk 10.0.400 / aspnet 10.0.11) | console + Confluent.Kafka + EF Core | none (Kafka consumer) | **auto** (.NET auto-instrumentation) | `src/accounting/Dockerfile` → `ENTRYPOINT ["./instrument.sh","dotnet","Accounting.dll"]`; manual `ActivitySource("Accounting.Consumer")` in `src/accounting/Consumer.cs` |
| ad | Java 24 (eclipse-temurin 24.0.2_12), Gradle | grpc-java + Prometheus java client | **gRPC 9555**, HTTP `/metrics` 9465 | **auto** (javaagent 2.31.1) | `src/ad/Dockerfile` → `ENV JAVA_TOOL_OPTIONS="-javaagent:/usr/src/app/opentelemetry-javaagent.jar -Xmx200m"`; `GlobalOpenTelemetry` + `@WithSpan` in `src/ad/src/main/java/oteldemo/AdService.java` |
| agent | Python 3.14 | FastAPI + LangGraph | **HTTP 8010** (`POST /prompt`) | manual, via **Traceloop** | `src/agent/run.py` — `Traceloop.init(...)`, `FastAPIInstrumentor.instrument_app`, `HTTPXClientInstrumentor` |
| cart | C# / .NET 10 (sdk 10.0.400 / runtime-deps 10.0.11-alpine3.23) | ASP.NET Core + Grpc.AspNetCore + StackExchange.Redis | **gRPC 7070** | **manual SDK** | `src/cart/src/Program.cs` — `AddOpenTelemetry().WithTracing(...).WithMetrics(...)`, `SetExemplarFilter(TraceBased)` |
| chatbot | Python 3.14 | Gradio | **HTTP 7860** | manual SDK (traces only) | `src/chatbot/run.py` — `_configure_tracing()` builds `TracerProvider` + `BatchSpanProcessor(OTLPSpanExporter())` |
| checkout | Go (golang:1.27.0-bookworm builder) | grpc-go + `otelgrpc` StatsHandler; `otelhttp` client; Kafka producer | **gRPC 5050** | **manual SDK** | `src/checkout/main.go` — `initTracerProvider` / `initMeterProvider` / `initLoggerProvider` |
| currency | C++17, otel-cpp 1.27.0 | gRPC C++ | **gRPC 7001** | **manual SDK** | `src/currency/src/tracer_common.h` (`initTracer()`), `meter_common.h`, `logger_common.h`; manual server spans + `GrpcServerCarrier` in `src/currency/src/server.cpp` |
| email | Ruby 4.0 | Sinatra on Puma | **HTTP 6060** (`POST /send_order_confirmation`), OTLP over **4318** | manual SDK enabling Ruby autoinstr. | `src/email/email_server.rb` — `OpenTelemetry::SDK.configure { c.use "…Sinatra" }` |
| flagd | prebuilt `ghcr.io/open-feature/flagd:v0.16.0` | flagd | **gRPC 8013** + OFREP **HTTP 8016** | built into binary, env-driven (`FLAGD_OTEL_COLLECTOR_URI`) | none in repo; only `src/flagd/demo.flagd.json` |
| flagd-ui | **Elixir 1.20 / OTP 28** | Phoenix + LiveView on Bandit | **HTTP 4000**, OTLP over 4318 | manual (declarative + start hook) | `src/flagd-ui/lib/flagd_ui/application.ex` (`OpentelemetryBandit.setup()`, `OpentelemetryPhoenix.setup(adapter: :bandit)`) + `src/flagd-ui/config/runtime.exs` |
| fraud-detection | Kotlin / JVM 17 (gradle:9.7.1-jdk17) | plain `KafkaConsumer` | none | **auto** (javaagent) | `src/fraud-detection/Dockerfile` → `JAVA_TOOL_OPTIONS=-javaagent:…`; no OTel API calls in `main.kt` |
| frontend | TypeScript, **Next.js 16.3.2**, React 19.2.8 | Next Pages Router; `@grpc/grpc-js` **client** | **HTTP 8080** (server); gRPC client only | **two** manual bootstraps | server: `src/frontend/utils/telemetry/Instrumentation.js` (loaded by `CMD ["--require=./Instrumentation.js","server.js"]`); browser: `src/frontend/utils/telemetry/FrontendTracer.ts` |
| frontend-proxy | Envoy v1.39.0 | Envoy HCM (edge gateway) | **HTTP 8080** (published), admin 10000 | config-only: native `envoy.tracers.opentelemetry` + `envoy.access_loggers.open_telemetry` | `src/frontend-proxy/envoy.tmpl.yaml` |
| image-provider | nginx 1.29.3-alpine3.22-otel | nginx static | **HTTP 8081** | **auto** `ngx_otel_module` | `src/image-provider/nginx.conf.template` |
| kafka | `apache/kafka` (KRaft) | broker | Kafka 9092 | **auto** javaagent + JMX gatherer | `src/kafka/Dockerfile` → `KAFKA_OPTS="-javaagent:… -Dotel.jmx.target.system=kafka-broker"` |
| load-generator | **k6 v2.1.0 custom xk6 build on `grafana/k6:2.2.0-with-browser` (headless Chromium)** | k6 scenarios (`k6/http` + `k6/browser`) | HTTP client only | **custom xk6-otel extension** (`k6/x/otel`) + k6 native OTel metrics output | `src/load-generator/script.js`, `src/load-generator/entrypoint.sh`, `src/load-generator/xk6-otel/` |
| mcp | Python 3.14 | FastMCP (HTTP transport) | **HTTP 8011** | manual, via **Traceloop** | `src/mcp/run.py` |
| opamp-server | Go (`open-telemetry/opamp-go` reference server) | OpAMP + minimal HTML UI at `/opamp/` | HTTP | n/a (control plane) | `src/opamp-server/Dockerfile`, README |
| payment | JS / Node (builder node:26.4.0-slim, runtime distroless nodejs22) | `@grpc/grpc-js` | **gRPC 50051** | **auto** via `NODE_OPTIONS` | no bootstrap file — `compose.yaml:474` `NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register`; API-only use in `src/payment/charge.js` |
| product-catalog | Go (golang:1.27.0-bookworm builder) | grpc-go + `otelgrpc.NewServerHandler()`, `database/sql` → Postgres | **gRPC 3550** | **declarative config** (`otelconf`) | `src/product-catalog/main.go` → `otelconf.NewSDK(...)`; config file is repo-root `otel-config.yml` (`OTEL_CONFIG_FILE=/otel-config.yml`) |
| quote | PHP 8.5.9 + native `opentelemetry` ext | Slim 4 on ReactPHP | **HTTP 8090** (`POST /getquote`), OTLP over 4318 | **auto** (ext + SDK autoloader, `OTEL_PHP_AUTOLOAD_ENABLED=true`) + manual flush shim | `src/quote/public/index.php` (periodic `forceFlush` for the ReactPHP loop); manual spans in `src/quote/app/routes.php` |
| recommendation | Python 3.14.7 | grpcio server | **gRPC 9001** | **auto** (`opentelemetry-instrument`) + manual logger provider | `src/recommendation/Dockerfile` → `ENTRYPOINT ["/venv/bin/opentelemetry-instrument", …]`; `src/recommendation/recommendation_server.py` builds `LoggerProvider` |
| shipping | Rust (rust:1.98.0 builder), otel 0.32 | **actix-web 4** (+ `opentelemetry-instrumentation-actix-web`) | **HTTP 50050** (port number is a gRPC leftover) | **manual SDK** | `src/shipping/src/telemetry_conf.rs`; wired in `src/shipping/src/main.rs` |
| telemetry-docs | weaver v0.25.1 → MkDocs → nginx 1.31.2-alpine3.23-otel | static site | **HTTP 8000** | **auto** `ngx_otel_module` | `src/telemetry-docs/nginx.conf.template` |
| react-native-app | RN 0.86 / Expo 57 | Expo Router | HTTP client only, **not a compose service** | manual web-style SDK | `src/react-native-app/hooks/useTracer.ts` + `utils/SessionIdProcessor.ts` |
| grafana / jaeger / prometheus / opensearch / postgresql | prebuilt images | — | 3000 / 16686+4317 / 9090 / 9200 / 5432 | n/a (backends) | config only |
| shared | — | — | — | not a service: `src/shared/tools.py` is COPY'd into the agent and mcp images | — |

### Wiring mechanism summary

- **javaagent**: ad, fraud-detection, kafka
- **.NET auto (`instrument.sh`)**: accounting
- **`opentelemetry-instrument` (Python)**: recommendation
- **`NODE_OPTIONS --require .../register`**: payment
- **`--require` of a hand-written file**: frontend (server)
- **PHP ext + SDK autoloader**: quote
- **nginx `ngx_otel_module`**: image-provider, telemetry-docs
- **Envoy native tracer**: frontend-proxy
- **Declarative config (`otelconf` + `otel-config.yml`)**: product-catalog
- **Hand-written SDK bootstrap**: checkout, cart, currency, email, shipping, flagd-ui, chatbot, frontend (browser), react-native-app
- **Traceloop**: agent, mcp
- **Vendor binary**: flagd
- **Custom xk6 extension**: load-generator

### Body capture today

**No service captures HTTP/gRPC request or response bodies.** The `demo.*` attributes across ad, currency, quote, recommendation, checkout, product-catalog and the frontend are business scalars (ids, counts, totals, enum names), not payloads. The nearest things:

- **agent** and **mcp** (Traceloop): `TRACELOOP_TRACE_CONTENT` is unset ⇒ defaults true, so LLM prompts/completions and tool input/output land on spans.
- **cart**: `SetVerboseDatabaseStatements = true` emits Redis `db.statement` — commands, not HTTP bodies.
- The collector actively **redacts** what little sensitive data exists — see §5.

This means Monoscope payload capture is genuinely additive everywhere; there is no existing body-capture hook to reuse.

## 2. Telemetry configuration

### Docker Compose

**There is no `x-default-env` anchor.** `compose.yaml` has exactly one YAML anchor, `x-default-logging: &logging` (`compose.yaml:15`). Every service lists its OTel env inline. Two idioms:

- **inherit the `.env` gRPC value** (bare `- OTEL_EXPORTER_OTLP_ENDPOINT`, → `otel-collector:4317`): cart (`:99`), currency (`:195`), frontend (`:272`), payment (`:475`), product-catalog (`:523`), recommendation (`:608`)
- **override to OTLP/HTTP 4318** (`- OTEL_EXPORTER_OTLP_ENDPOINT=http://${OTEL_COLLECTOR_HOST}:${OTEL_COLLECTOR_PORT_HTTP}`): ad (`:55`), checkout (`:140`), email (`:231`), load-generator (`:425`), quote (`:568`), shipping (`:650`), flagd (`:685`), flagd-ui (`:718`); plus accounting (`compose.full.yaml:28`), fraud-detection (`:66`), kafka (`:106`), chatbot (`compose.agent.yaml:115`)
- **agent and mcp set no `OTEL_EXPORTER_OTLP_ENDPOINT` at all** — they use `TRACELOOP_BASE_URL=http://${OTEL_COLLECTOR_HOST}:${OTEL_COLLECTOR_PORT_HTTP}` (`compose.agent.yaml:32,78`; `.env`)

Per-service they add `OTEL_SERVICE_NAME=<name>` and `OTEL_RESOURCE_ATTRIBUTES=${OTEL_RESOURCE_ATTRIBUTES},service.criticality=<low|medium|high|critical>`.

Base values in `.env`:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://${OTEL_COLLECTOR_HOST}:${OTEL_COLLECTOR_PORT_GRPC}   # otel-collector:4317
PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:8080/otlp-http/v1/traces
OTEL_SERVICE_NAMESPACE=opentelemetry-demo
OTEL_RESOURCE_ATTRIBUTES=service.namespace=${OTEL_SERVICE_NAMESPACE},service.version=${IMAGE_VERSION}
IMAGE_VERSION=3.0.0  IMAGE_NAME=ghcr.io/open-telemetry/demo  DEMO_VERSION=latest
```

`.env.override` is the fork-safe override seam (gitignored intent; currently only LLM knobs, commented out). `make` passes `--env-file .env --env-file .env.override`.

Browser traffic path: `PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` → `localhost:8080/otlp-http/…` → Envoy route `- match: { prefix: "/otlp-http/" }` → cluster `opentelemetry_collector_http` (collector :4318, which has permissive CORS `http://*` / `https://*`).

### Compose layers

`compose.yaml` (core) + `compose.full.yaml` (Kafka, accounting, fraud-detection) + `compose.observability.yaml` (Jaeger/Prometheus/OpenSearch/Grafana) + `compose.agent.yaml` (agent/mcp/chatbot) + `compose.profiling.yaml` + `compose.extras.yaml` (always last, intentionally empty vendor seam) + `compose.tests.yaml`.

### Kubernetes

**There are no demo manifests, kustomize bases, or a helm chart in this repo.** The demo is installed from the upstream chart `open-telemetry/opentelemetry-demo` (published from `opentelemetry-helm-charts`; `README.md:48` links the k8s deployment doc, and `.github/workflows/label-pr.yml` adds a `helm-update-required` label when `.env`, `compose*.yaml`, or `src/{flagd,grafana,jaeger,otel-collector,postgresql,prometheus}` change — i.e. chart updates happen in the *other* repo).

The only k8s YAML here is `monoscope-k8s/`, three **Helm values files**, applied by Makefile targets (`Makefile:391–435`):

**`monoscope-k8s/values-agent.yaml`** — values for `open-telemetry/opentelemetry-collector`, released as `monoscope-agent`:
- `mode: daemonset`, collector-k8s image `0.149.0`
- `service.enabled: true` + `internalTrafficPolicy: Local` (daemonset mode skips a Service by default; needed so other pods can OTLP to a stable DNS name and stay on-node)
- `resources.limits.memory: 512Mi` — required, else the chart's GOMEMLIMIT helper is silently disabled
- presets: `logsCollection`, `kubeletMetrics`, `kubernetesAttributes`
- `MONOSCOPE_API_KEY` from secret `monoscope-secrets` key `api-key`
- pipelines: traces `[otlp]`, metrics `[otlp, kubeletstats]`, logs `[otlp, filelog]`; all with `[k8sattributes, memory_limiter, batch, resource]` and exporter `otlp_grpc → otelcol.monoscope.tech:4317`
- `resource` processor upserts attribute `x-api-key: ${env:MONOSCOPE_API_KEY}` — this is where auth lives
- **`filelog.exclude`**: a hardcoded list of `/var/log/pods/default_<service>-*/…` globs for the 16 services that also emit OTLP logs, so their stdout isn't double-counted. Namespace `default` is hardcoded; the list must be re-synced when a service starts/stops emitting OTLP logs.

**`monoscope-k8s/values-cluster.yaml`** — same chart, released as `monoscope-cluster`:
- `mode: deployment`, `replicaCount: 1` (must stay 1 — `k8s_events`/`k8s_cluster` don't leader-elect)
- presets `clusterMetrics`, `kubernetesEvents`, `kubernetesAttributes`
- pipelines: metrics `[k8s_cluster]`, logs `[k8s_events]` → same `otlp_grpc` + `x-api-key` resource processor

**`monoscope-k8s/otel-demo-overlay.yaml`** — values for the **upstream otel-demo chart**, applied with `--reset-values`:
- `prometheus.server.resources` raised to 512Mi/1536Mi (the chart's 400Mi cap OOMKilled the TSDB head with 7d retention + exemplar storage; 4682 crash-loops, each replaying the WAL and emitting ~34k exemplar WARNs that filelog then shipped to monoscope)
- `opentelemetry-collector.mode: deployment` (chart default DaemonSet binds host ports 6831/14250/14268 and would collide with the monoscope-agent DaemonSet)
- `opentelemetry-collector.resources` 256Mi/1Gi (200Mi default kept `memory_limiter` permanently above its soft threshold, silently refusing data)
- adds exporter `otlp/monoscope-agent → monoscope-agent-opentelemetry-collector.default.svc.cluster.local:4317`, `tls.insecure: true`
- re-lists each pipeline's exporters verbatim (the chart *replaces* pipeline arrays, it does not merge): traces `[otlp/jaeger, debug, spanmetrics, otlp/monoscope-agent]`, metrics `[otlphttp/prometheus, debug, otlp/monoscope-agent]`, logs `[opensearch, debug, otlp/monoscope-agent]`
- **No secrets in this file** — auth lives entirely in monoscope-agent.

Makefile targets: `k8s-apply-monoscope` (creates the secret from `$MONOSCOPE_API_KEY`, `helm upgrade --install` both releases), `k8s-apply-otel-demo-overlay` (pre-flight checks the `otel-demo` release + `monoscope-secrets` exist, then `helm upgrade otel-demo open-telemetry/opentelemetry-demo --reset-values --values monoscope-k8s/otel-demo-overlay.yaml`), `k8s-delete-monoscope`.

## 3. Frontend

- **Next.js 16.3.2 / React 19.2.8, Pages Router** — `src/frontend/pages/` has `_app.tsx`, `_document.tsx`, `index.tsx`, `cart/`, `product/`, `api/`.
- **HTML document root: `src/frontend/pages/_document.tsx`.** This is where a `<script>` tag goes. It already injects a config blob:

```tsx
const envString = `
  window.ENV = {
    NEXT_PUBLIC_PLATFORM: '${ENV_PLATFORM}',
    NEXT_PUBLIC_OTEL_SERVICE_NAME: '${WEB_OTEL_SERVICE_NAME}',
    NEXT_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '${otlpTracesEndpoint}',
    IS_SYNTHETIC_REQUEST: '${isSyntheticRequest}',
  };`;
…
<body>
  <Main />
  <script dangerouslySetInnerHTML={{ __html: this.props.envString }}></script>
  <NextScript />
</body>
```

Note it already reads W3C **baggage** server-side to detect `synthetic_request=true` and, for synthetic traffic, points the browser exporter directly at `http://${OTEL_COLLECTOR_HOST}:4318/v1/traces` instead of the public proxy URL.

- **npm-import entry point: `src/frontend/pages/_app.tsx`.** It already runs client-only init at module scope:

```tsx
if (typeof window !== 'undefined') {
  FrontendTracer();
  … OpenFeature.setContext(...) / setProvider(new FlagdWebProvider(...))
}
```

- **Existing browser telemetry: YES.** `src/frontend/utils/telemetry/FrontendTracer.ts` — `WebTracerProvider` + `ZoneContextManager` + `CompositePropagator(W3CBaggage, W3CTraceContext)` + `BatchSpanProcessor(OTLPTraceExporter{url: NEXT_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT}, {scheduledDelayMillis: 500})` + `getWebAutoInstrumentations` with `instrumentation-fetch` set to `propagateTraceHeaderCorsUrls: /.*/` and `applyCustomAttributesOnSpan` adding `demo.synthetic_request`.
- **Session identity already exists**: `src/frontend/utils/telemetry/SessionIdProcessor.ts` stamps `session.id` and `enduser.id` from `SessionGateway.getSession().userId` on **every** browser span. Monoscope session replay should reuse that same id so replays and spans join.
- **Server-side**: `src/frontend/utils/telemetry/Instrumentation.js` — `NodeSDK` with `getNodeAutoInstrumentations` (fs disabled), OTLP trace + metric exporters, container/env/host/os/process detectors. Loaded via `CMD ["--require=./Instrumentation.js", "server.js"]` in `src/frontend/Dockerfile`.
- **API-route wrapper**: `src/frontend/utils/telemetry/InstrumentationMiddleware.ts` wraps each Next API handler — records exceptions, sets `HTTP_STATUS_CODE`. **This is the natural insertion point for server-side request/response body capture** on `/api/*`; it already has the handler, request and response in scope and touches no bodies today.
- **Env vars** (`compose.yaml` frontend block, lines 247–312): `PORT`, `*_ADDR` for each gRPC backend, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME=frontend`, `PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `WEB_OTEL_SERVICE_NAME=frontend-web`, `OTEL_COLLECTOR_HOST`, `ENV_PLATFORM`, `FLAGD_HOST`, `FLAGD_PORT`. Anything new must be added here *and* surfaced through `_document.tsx`'s `window.ENV` to be readable in the browser.

## 4. Load generator

**It is k6 v2, not Locust — and it already drives a real headless Chromium.**

`src/load-generator/Dockerfile`:
- stage 1: `golang:1.26.6` + `xk6@v1.4.7` → `xk6 build v2.1.0 --with github.com/open-telemetry/opentelemetry-demo/src/load-generator/xk6-otel=./xk6-otel --output ./k6` (custom k6 binary with a local OTel extension)
- stage 2: `grafana/k6:2.2.0-with-browser` (chosen explicitly because "Debian's Chromium crashes on startup"), overwritten with the custom binary; copies `script.js`, `people.json`, `entrypoint.sh`
- `ENTRYPOINT ["./entrypoint.sh"]`

`src/load-generator/entrypoint.sh` polls flagd's OFREP endpoint for the `loadGeneratorVUs` integer flag every 10s and **restarts k6** when it changes (k6 can't resize VUs in place); passes the count as `LOAD_GENERATOR_VUS` (not `K6_VUS`, which would make k6 discard the script's `scenarios` block).

`src/load-generator/script.js` — two scenarios:

1. **`load` / `httpScenario`** — `constant-vus`, `vus = LOAD_GENERATOR_VUS`, `duration 9999h`. Weighted task picker (total weight 29): `index`(1), `browseProduct`(10), `getRecommendations`(3), `getAds`(3), `viewCart`(3), `addToCart`(2), `checkout`(1), `checkoutMulti`(1), `floodHome`(5). Endpoints hit: `/`, `/api/products/{id}`, `/api/recommendations?productIds=`, `/api/data/?contextKeys=`, `/api/cart` (GET + POST), `/api/checkout` (POST, body from `people.json`). Sleeps `1–10s` between tasks. Every task opens a span via the custom `Tracer` from `k6/x/otel` and sends `traceparent` + `baggage: synthetic_request=true,session.id=<uuid>` headers. Gated on the `loadGeneratorTraffic` flag; `floodHome` count comes from `loadGeneratorFloodHomepage`.

2. **`browser` / `browserScenario`** — `import { browser } from 'k6/browser'`, `constant-vus` with **vus: 1**, chromium `headless: true`. Enabled by `K6_BROWSER_ENABLED=true` (already set in `compose.yaml:437`, along with `K6_BROWSER_ARGS=no-sandbox,disable-dev-shm-usage`). Two flows, 50/50:
   - `changeCurrency(page)` — `page.goto(/cart)`, `page.selectOption('[name="currency_code"]','CHF')`, `waitForTimeout(2000)`
   - `addProductToCartBrowser(page)` — `goto(/)` raced with `waitForResponse(/RoofBinoculars\.jpg/)`, `waitForSelector('a[href="/product/2ZYFJ3GM2N"]')`, `click`, `waitForSelector('[data-cy="product-add-to-cart"]')`, `click`
   Each sets `page.setExtraHTTPHeaders({ baggage: 'synthetic_request=true' })` and wraps the flow in an OTel span.

**No mouse movement today** — only `page.click` / `page.selectOption`. k6's browser module is a Playwright-*like* API (the script comments note it is *not* Playwright: no `:has-text()` selector engine). Adding realistic pointer motion means using whatever `page.mouse.move` / `page.hover` k6 v2's browser module exposes, plus more page routes and dwell time; the scenario is already the right seam and the VU count is trivially raisable from 1.

**Other browser tooling in the repo**: **Cypress 15.21.0** e2e tests only — `src/frontend/Dockerfile.cypress` (`FROM cypress/included:15.21.0`, `ENTRYPOINT ["cypress","run"]`), `src/frontend/cypress/e2e/*.cy.ts`, run via `compose.tests.yaml` / `make run-tests`. **No Playwright, Puppeteer, or Selenium anywhere in the repo** (the only "Playwright" hits are a comment in `script.js` and `.gitignore`/CHANGELOG lines).

Load-gen telemetry env (`compose.yaml:409–453`): `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_SERVICE_NAME=load-generator`, plus k6-native `K6_OTEL_EXPORTER_PROTOCOL`, `K6_OTEL_HTTP_EXPORTER_ENDPOINT`, `K6_OTEL_HTTP_EXPORTER_INSECURE=true`, `K6_OTEL_METRIC_PREFIX=k6.` (k6 is run with `--out opentelemetry`). Healthcheck is `pgrep k6`.

## 5. Collector config

**Two different collectors — do not conflate them.**

### (a) Compose collector — `src/otel-collector/otelcol-config*.yml`

Layered via `--config` (later files **replace** arrays, never append — every layer must re-list exporters):

- `otelcol-config.yml` (base) — receivers `otlp` (grpc 4317 + http 4318 with `cors.allowed_origins: ["http://*","https://*"]`), `http_check/frontend-proxy`, `nginx`, `docker_stats`, `redis`, `postgresql`, `prometheus/ad` (scrapes `ad:9465`), `host_metrics`. Exporters: `debug` only.
- `otelcol-config-full.yml` — adds Kafka + PostgreSQL metric receivers
- `otelcol-config-observability.yml` — adds `otlp_grpc/jaeger`, `otlp_http/prometheus`, `opensearch`, `otlp_grpc/firepit` (profiles), and `extensions: [opamp]`
- `otelcol-config-extras.yml` — **intentionally empty vendor seam, always loaded last**. Its comments name the exporters a fork must repeat. **This is where the Monoscope exporter belongs for compose.**
- `otelcol-ebpf-profiling.yml` — profiling layer

Pipelines (base):

```yaml
traces:   receivers: [otlp]
          processors: [resource_detection, memory_limiter, transform/sanitize_spans,
                       gen_ai_normalizer, transform/redact_sensitive_data]
          exporters:  [debug, span_metrics]
metrics:  receivers: [docker_stats, http_check/frontend-proxy, host_metrics, nginx,
                      otlp, redis, postgresql, prometheus/ad, span_metrics]
          processors: [resource_detection, memory_limiter]
          exporters:  [debug]
logs:     receivers: [otlp]  processors: [resource_detection, memory_limiter, transform/sanitize_logs]  exporters: [debug]
profiles: receivers: [otlp]  processors: [resource_detection, filter/sanitize_profiles, memory_limiter] exporters: [debug]
```

Notable processors:
- `connectors: span_metrics: {}` — the **span_metrics connector with all defaults**; it is a *metrics receiver* in the metrics pipeline. No explicit exemplar config in this file. (Chart-side, `otel-demo-overlay.yaml`'s comments state exemplars stream from spanmetrics into Prometheus exemplar storage.)
- `transform/sanitize_spans` — `set_semconv_span_name("1.43.0", "original_span_name")` to cap span-name cardinality
- `gen_ai_normalizer: sources: [openllmetry]` — normalizes Traceloop/OpenLLMetry GenAI attributes
- **`transform/redact_sensitive_data`** — directly relevant to payload capture:
  ```
  delete_key(attributes, "demo.payment.card_cvv") …
  set(attributes["user.hash"], SHA256(attributes["user.email"])) … ; delete_key(attributes,"user.email") …
  replace_pattern(attributes["demo.payment.card_number"], "^\\d{4}-\\d{4}-\\d{4}-", "****-****-****-") …
  ```
  A commented-out `redaction` processor (HMAC-hashing card numbers) sits alongside it as an alternative. **Any Monoscope body capture will carry checkout PII/card data that these key-scoped rules will NOT catch** — they target specific attribute keys, not a serialized body blob.
- `filter/sanitize_profiles`, `transform/sanitize_logs` (renames the flat `otelcol.signal` scope attribute)
- collector self-telemetry exports metrics + logs back to itself over 4318.

### (b) k8s collector — the upstream chart's bundled collector

Its config is chart defaults plus `monoscope-k8s/otel-demo-overlay.yaml` (§2). The overlay's own comment warns that its verbatim copies of chart-default exporter lists must be re-synced against `helm show values open-telemetry/opentelemetry-demo`. The monoscope-agent/-cluster collectors are separate again and defined fully in `values-agent.yaml` / `values-cluster.yaml`.

## 6. Build and deploy

### Docker Compose (local)

- `Makefile:141–174`: `make build` → `docker compose --env-file .env --env-file .env.override -f compose.yaml -f compose.full.yaml -f compose.observability.yaml -f compose.extras.yaml build [$(service)]`; `make build-and-push` adds `--push`; `make build-multiplatform[-and-push]` uses `docker buildx bake` for amd64+arm64.
- `make start` / `start-minimal` / `start-no-o11y` / `start-profiling` bring the stack up; UI at `http://localhost:8080`.
- Image naming: `${IMAGE_NAME}:${DEMO_VERSION}-<service>` = `ghcr.io/open-telemetry/demo:latest-<service>`, with `cache_from: ghcr.io/open-telemetry/demo:3.0.0-<service>`. So a local `make build` **rebuilds locally and tags into the upstream namespace**; nothing is pushed unless you ask.
- A source change reaches compose via `make build service=<name> && make start` (or `make redeploy`).

### CI

- `.github/workflows/build-images.yml` fires on `src/**` or `test/**` pushes but is guarded by `if: ${{ !github.event.repository.fork }}` — **it does not run in this fork.**
- `.github/workflows/component-build-images.yml` (reusable) pushes to `ghcr.io/open-telemetry/demo` / `otel/demo`; `release.yml` tags with the release name, `nightly-release.yml` with `nightly`.

### Kubernetes

**Image tags in the cluster are not determinable from this repo.** There are no demo manifests or chart here; the running images come from whatever version of the upstream `open-telemetry/opentelemetry-demo` chart is installed, and `otel-demo-overlay.yaml` overrides **no** image fields (it only touches prometheus resources and the collector). The only image tags pinned in-repo are:

- `monoscope-k8s/values-{agent,cluster}.yaml`: `ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-k8s:0.149.0`
- `.env` (compose side only): `IMAGE_VERSION=3.0.0`, `DEMO_VERSION=latest`, and the dependent-image pins (collector-contrib `0.159.0`, flagd `v0.16.0`, grafana `13.1.0`, jaeger `2.19.0`, postgres `18.4`, prometheus `v3.13.1`, valkey `9.0.4`)

**How a service source change would reach the cluster today: it wouldn't.** The path has to be built:

1. Build + push to a registry you control — `IMAGE_NAME=<your-registry>/demo make build-and-push` (or the buildx multiplatform target). CI won't do it for you (fork guard).
2. Add per-component `image.repository` / `image.tag` overrides to `monoscope-k8s/otel-demo-overlay.yaml` — the upstream chart supports per-component image overrides, but this repo has **zero** wiring for it today.
3. `make k8s-apply-otel-demo-overlay` (note: `--reset-values`, so the overlay file must be the complete set of user values).

This gap is the main infrastructure work implied by "add Monoscope instrumentation to each service" for the k8s deployment.

## 7. Commits

### The 3 "local commits" (now 5)

- **`0d49bdfb`** *Add Monoscope k8s collector Helm values for docs validation* — creates `monoscope-k8s/values-agent.yaml` (DaemonSet: logs + node metrics + OTLP receiver) and `values-cluster.yaml` (Deployment ×1: cluster events + cluster metrics). Described as the canonical recipe validating the Kubernetes integration guide at `apitoolkit-landing/docs/sdks/infrastructure/kubernetes/`.
- **`ee2d9782`** *Wire bundled otel-collector to monoscope via in-cluster agent* — enables the agent ClusterIP Service with `internalTrafficPolicy: Local`; drops explicit `k8s_attributes` blocks in favour of the chart preset; adds `resources` to both so GOMEMLIMIT activates; adds `monoscope-k8s/otel-demo-overlay.yaml` (mode: deployment + one forward exporter, **no secrets**); adds the three Makefile targets. At this commit **logs were deliberately NOT forwarded** from the bundled collector, to avoid double-counting the agent's filelog.
- **`1534b78d`** — merge of `upstream/main`.

### The 2 "uncommitted files" — now committed as `5c66ef0c`

*"Raise prometheus/collector memory limits; forward OTLP logs to monoscope"*. It is exactly the diff described in the brief, and it is one coherent change:

- `otel-demo-overlay.yaml`: adds the `prometheus.server.resources` block (the 4682-restart WAL-replay-spam incident), adds `opentelemetry-collector.resources` (memory_limiter was silently dropping data at 200Mi), and **reverses the logs decision** — `logs.exporters` becomes `[opensearch, debug, otlp/monoscope-agent]` so OTLP log records (which carry `trace_id`/`span_id`) reach monoscope trace-correlated.
- `values-agent.yaml`: adds the matching `filelog.exclude` list for the 16 OTLP-emitting services, which is what prevents the double-counting the earlier commit avoided by not forwarding at all.

**Verdict: complete and correctly shipped as a single commit** — the two halves cross-reference each other in comments and are incoherent apart. Two maintenance caveats, both self-documented in the file: the excludes hardcode the `default_` namespace, and the exclude list must be re-synced whenever a service starts or stops emitting OTLP logs.

### `6d1adfc8` — merge of `upstream/main`

Brought in everything in §0. Touched essentially every `src/*` directory plus `.env`, all `compose*.yaml`, `Makefile`, `pb/demo.proto`, `telemetry-schema/`, and `test/`. It also merged cleanly over `monoscope-k8s/`.

## Implications for the planned work

1. **Sync is done** (0 behind). Re-plan from `6d1adfc8`.
2. **Payload capture is genuinely new work everywhere** — no service has a body hook. Insertion points differ by wiring: env vars for the auto-instrumented ones (ad, accounting, fraud-detection, kafka, payment, quote, recommendation), the named bootstrap file for the manual ones, `InstrumentationMiddleware.ts` for the frontend's API routes, and `otel-config.yml` for product-catalog.
3. **Browser SDK**: script tag → `src/frontend/pages/_document.tsx`; npm import → `src/frontend/pages/_app.tsx` next to `FrontendTracer()`; reuse `SessionIdProcessor`'s `session.id`/`enduser.id` so replay joins spans; add config through `window.ENV` + the frontend compose env block.
4. **Realistic browser sessions**: extend `browserScenario` in `src/load-generator/script.js` (already headless Chromium, already 50/50 flows, already OTel-spanned) — raise `vus` from 1, add routes, add pointer motion via k6's browser mouse API. Do **not** add Playwright; k6 v2's browser module is the in-tree mechanism.
5. **PII**: `transform/redact_sensitive_data` redacts by attribute *key*. Serialized bodies from `/api/checkout` will carry card + address data that these rules cannot see.
6. **Deploy gap**: nothing in-repo builds or pins demo images for k8s. Custom images + per-component `image.*` overrides in `otel-demo-overlay.yaml` must be added before instrumented source can reach the cluster.
