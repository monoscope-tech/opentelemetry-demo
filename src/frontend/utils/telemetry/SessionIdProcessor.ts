// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { Context } from "@opentelemetry/api";
import { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-web";
import SessionGateway from "../../gateways/Session.gateway";
import { AttributeNames } from "../enums/AttributeNames";
import { browserSessionId, DEMO_TENANT } from "./MonoscopeRUM";

const { userId } = SessionGateway.getSession();

// Every demo shopper is a headless browser in one cluster, so the address Monoscope sees is the
// same for all of them and its visitor map would be a single country. Each shopper instead keeps
// one public address from consumer ISPs around the world (checked against DB-IP, weighted towards
// the US as real traffic is), sent as client.address, which Monoscope places ahead of the sender.
const DEMO_ADDRESSES = [
    '8.8.8.8', '8.8.8.8', '8.8.8.8', '8.8.8.8', // US
    '81.2.69.142', '81.2.69.142', // GB
    '49.36.0.1', '49.36.0.1', // IN
    '95.91.0.1', // DE
    '62.210.0.1', // FR
    '51.15.0.1', // NL
    '89.160.20.112', // SE
    '105.112.0.1', // NG
    '41.0.0.1', // ZA
    '177.0.0.1', // BR
    '24.48.0.1', // CA
    '126.0.0.1', // JP
    '1.120.0.1', // AU
];
const clientAddress = DEMO_ADDRESSES[[...userId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % DEMO_ADDRESSES.length];

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
        span.setAttribute("client.address", clientAddress);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
    onEnd(span: ReadableSpan): void {}

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}
