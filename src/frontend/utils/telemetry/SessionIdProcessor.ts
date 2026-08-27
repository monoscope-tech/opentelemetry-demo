// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { Context } from "@opentelemetry/api";
import { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-web";
import SessionGateway from "../../gateways/Session.gateway";
import { AttributeNames } from "../enums/AttributeNames";
import { browserSessionId, DEMO_TENANT } from "./MonoscopeRUM";

const { userId } = SessionGateway.getSession();

export class SessionIdProcessor implements SpanProcessor {
    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onStart(span: Span, parentContext: Context): void {
        // session.id comes from the Monoscope SDK so that these spans and the
        // rrweb recording share one id — that join is what makes a replay
        // reachable from a session in the UI. Read it per span rather than
        // once at module load: the SDK rotates the id after 30 minutes idle,
        // and a cached value would strand every later span on a dead session.
        span.setAttribute(AttributeNames.SESSION_ID, browserSessionId());
        // enduser.id stays the localStorage uuid: it outlives any single
        // session and is the demo's stand-in for a signed-in person.
        span.setAttribute(AttributeNames.ENDUSER_ID, userId);
        // user.id as well as enduser.id: Monoscope reads both, but only
        // user.id backs the session fallback and the user facet, so a span
        // carrying just enduser.id shows up with no user attached.
        span.setAttribute("user.id", userId);
        // Tenant rides here because the published browser SDK cannot send it
        // — see DEMO_TENANT.
        span.setAttribute("tenant.id", DEMO_TENANT.id);
        span.setAttribute("tenant.name", DEMO_TENANT.name);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
    onEnd(span: ReadableSpan): void {}

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}
