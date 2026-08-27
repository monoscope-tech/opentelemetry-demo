// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler, NextApiResponse } from 'next';
import {context, Exception, Span, SpanStatusCode, trace} from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { serializeBody } from './PayloadCapture';

const InstrumentationMiddleware = (handler: NextApiHandler): NextApiHandler => {
  return async (request, response) => {
    const span = trace.getSpan(context.active()) as Span;

    // Request body first: a handler that throws still leaves the payload that
    // caused it on the span, which is the whole point of capturing it.
    const requestBody = serializeBody(request.body);
    if (requestBody !== undefined) {
      span.setAttribute('http.request.body', requestBody);
      span.setAttribute('http.request.body.size', requestBody.length);
    }

    const restore = captureResponseBody(response, span);

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      httpStatus = response.statusCode;
    } catch (error) {
      span.recordException(error as Exception);
      span.setStatus({ code: SpanStatusCode.ERROR });
      httpStatus = 500;
      throw error;
    } finally {
      span.setAttribute(SemanticAttributes.HTTP_STATUS_CODE, httpStatus);
      restore();
    }
  };
};

/**
 * Next gives no hook for "the handler is about to send this", so the two
 * methods the demo's API routes actually use are wrapped for the duration of
 * the request and put back afterwards.
 *
 * Every step is defensive: capture must never be the reason a response fails
 * to send. If serialization throws, the original method still runs.
 */
function captureResponseBody(response: NextApiResponse, span: Span): () => void {
  const originalJson = response.json.bind(response);
  const originalSend = response.send.bind(response);

  const record = (body: unknown) => {
    try {
      const serialized = serializeBody(body);
      if (serialized !== undefined) {
        span.setAttribute('http.response.body', serialized);
        span.setAttribute('http.response.body.size', serialized.length);
      }
    } catch {
      // ignore — telemetry never blocks a response
    }
  };

  response.json = (body: unknown) => {
    record(body);
    return originalJson(body);
  };
  response.send = (body: unknown) => {
    record(body);
    return originalSend(body);
  };

  return () => {
    response.json = originalJson;
    response.send = originalSend;
  };
}

async function runWithSpan(parentSpan: Span, fn: () => Promise<unknown>) {
  const ctx = trace.setSpan(context.active(), parentSpan);
  return await context.with(ctx, fn);
}

export default InstrumentationMiddleware;
