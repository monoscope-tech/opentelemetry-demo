// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Payload capture for a gRPC handler, written against Monoscope's span contract.
//
// There is no native Monoscope SDK that covers this service: every one of them is an HTTP
// middleware, and payment speaks gRPC. So rather than leave the demo's gRPC services with no
// request/response payloads at all, this reproduces by hand what the SDKs emit.
//
// The contract, from the ingestion side (OtlpServer.hs `isOurSdkSpan`, Telemetry.hs): a span
// is treated as carrying payloads only if it is *named* `monoscope.http` (or the legacy
// `apitoolkit-http-span`) AND its `http.request.body` / `http.response.body` attributes are
// **base64**. Only then does the server lift them into the `body` column that the Req/Resp
// Body tabs read. Raw JSON on the ambient span is searchable but leaves the tabs empty, which
// reads as the feature being broken rather than as instrumentation that misses the contract.
//
// Note what that contract costs here: it is HTTP-shaped, so a gRPC call has to describe itself
// in HTTP terms — method POST (which gRPC does ride on), and the RPC path as the route. That
// mismatch is the argument for teaching the SDKs gRPC natively rather than repeating this
// per service.

const opentelemetry = require('@opentelemetry/api')

// Redaction runs before the payload reaches the span — the charge request carries a full
// credit card, and the demo project is public. Matching by key name at any depth rather than
// by fixed path: the card sits under `creditCard` on the request and is echoed at a different
// depth in the reply, and a path that misses looks exactly like a field that was not there.
const SENSITIVE = new Set([
  'creditCardNumber',
  'creditCardCvv',
  'creditCardExpirationYear',
  'creditCardExpirationMonth',
  'email',
  'streetAddress',
  'zipCode',
])

// protobuf-js decodes a 64-bit field into a Long — `{low, high, unsigned}` — which
// JSON.stringify renders verbatim. An amount that reads {"low":42,"high":0,"unsigned":false}
// instead of "42" looks like broken capture, so collapse it back to the number it stands for.
const isLong = v =>
  v && typeof v === 'object' && typeof v.low === 'number' && typeof v.high === 'number'

const redact = value => {
  if (isLong(value)) return String(value.high * 2 ** 32 + (value.low >>> 0))
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE.has(k) ? '[REDACTED]' : redact(v)])
    )
  }
  return value
}

// Best-effort by design: capture must never be the reason a charge fails, so anything
// JSON.stringify cannot represent (a Buffer field, a cycle) degrades to no body rather than
// to an exception on the request path.
const encodeBody = value => {
  try {
    return Buffer.from(JSON.stringify(redact(value) ?? null)).toString('base64')
  } catch {
    return ''
  }
}

/**
 * Wrap a gRPC handler so Monoscope sees its request and response payloads.
 *
 * The span is a child of the ambient auto-instrumentation span rather than a replacement for
 * it, so the trace keeps the shape `@opentelemetry/instrumentation-grpc` gives it and this
 * only adds the payload detail alongside.
 */
const capturePayloads = (rpcPath, handler) => (call, callback) =>
  opentelemetry.trace
    .getTracer('monoscope')
    .startActiveSpan('monoscope.http', span => {
      span.setAttributes({
        'http.request.method': 'POST',
        'http.route': rpcPath,
        'http.target': rpcPath,
        'rpc.system': 'grpc',
        'apitoolkit.sdk_type': 'JsGrpcManual',
        'http.request.body': encodeBody(call.request),
      })

      // Wrap the callback rather than awaiting the handler: a gRPC handler reports both
      // success and failure through it, so this is the one place that sees every outcome.
      handler(call, (err, response) => {
        span.setAttributes({
          'http.response.body': encodeBody(err ? { error: err.message } : response),
          // gRPC has no status line; 200/500 is what the contract's HTTP shape can express.
          'http.response.status_code': err ? 500 : 200,
        })
        if (err) span.setStatus({ code: opentelemetry.SpanStatusCode.ERROR, message: err.message })
        span.end()
        callback(err, response)
      })
    })

module.exports = { capturePayloads }
