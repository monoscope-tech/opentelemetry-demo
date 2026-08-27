// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { withMonoscopePagesRouter } from '@monoscopetech/next';

/**
 * Wraps every /api route so Monoscope sees the request and response payloads.
 *
 * This is the SDK's own wrapper rather than a hand-rolled span hook, and the difference is
 * not stylistic. Monoscope only lifts bodies out of a span and into the Req/Resp Body tabs
 * when the span is one of its own — `monoscope.http` — and when the body attributes are
 * base64. A hook that sets `http.request.body` to raw JSON on the ambient span produces
 * attributes that are searchable but tabs that stay empty, which reads as the feature being
 * broken rather than as instrumentation that does not match the contract.
 *
 * The SDK composes with the OTel setup already in Instrumentation.js: it takes no exporter
 * configuration and writes to the ambient tracer, so the demo's collector routing is
 * untouched.
 */

// Recursive descent (`$..`) rather than fixed paths: the same field sits at different depths
// in a checkout request and in the order echoed back on the response, and a path that misses
// is indistinguishable from a field that was not there.
const SENSITIVE_PATHS = [
  '$..creditCard',
  '$..creditCardNumber',
  '$..creditCardCvv',
  '$..creditCardExpirationYear',
  '$..creditCardExpirationMonth',
  '$..email',
  '$..streetAddress',
  '$..zipCode',
];

const InstrumentationMiddleware = (handler: NextApiHandler): NextApiHandler =>
  withMonoscopePagesRouter(handler, {
    serviceName: process.env.OTEL_SERVICE_NAME || 'frontend',
    captureRequestBody: true,
    captureResponseBody: true,
    redactHeaders: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
    // The same paths on both sides because the checkout payload is echoed back in the
    // order confirmation, so the response carries the address just as the request does.
    redactRequestBody: SENSITIVE_PATHS,
    redactResponseBody: SENSITIVE_PATHS,
  }) as NextApiHandler;

export default InstrumentationMiddleware;
