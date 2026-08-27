// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { v4 as uuidv4 } from 'uuid';
import SessionGateway from '../../gateways/Session.gateway';

const {
  NEXT_PUBLIC_MONOSCOPE_API_KEY = '',
  NEXT_PUBLIC_MONOSCOPE_OTLP_ENDPOINT = '',
  NEXT_PUBLIC_MONOSCOPE_APP_URL = '',
  NEXT_PUBLIC_MONOSCOPE_REPLAY_SAMPLE_RATE = '',
  NEXT_PUBLIC_OTEL_SERVICE_NAME = '',
} = typeof window !== 'undefined' ? window.ENV : {};

/**
 * The sessionStorage contract we share with `@monoscopetech/browser`.
 *
 * These three constants are copied from the SDK's own `resolveSessionId()`.
 * We write both keys before the SDK loads so that it adopts our id instead of
 * minting its own — its rule is "reuse the stored id only if a stored
 * last-activity timestamp is fresher than the timeout", so seeding the id
 * alone would silently not take.
 *
 * Why we need the id before the SDK exists at all: see initMonoscope().
 */
const SESSION_KEY = 'monoscope-session-id';
const ACTIVITY_KEY = 'monoscope-last-activity';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

let instance: unknown = null;

/**
 * The id every signal for this browser session must agree on.
 *
 * A replay only becomes reachable in the UI if its upload `sessionId` is
 * byte-identical to the `session.id` attribute on the project's spans — the
 * sessions list joins the two on that value. Deriving a second id anywhere
 * puts recordings in storage that the UI can never surface.
 *
 * This is deliberately synchronous. SessionIdProcessor stamps every span as it
 * starts, including spans created before the SDK's dynamic import resolves; if
 * this returned a placeholder until then, the first spans of every page load
 * would land on a different session from the recording.
 *
 * Rotation mirrors the SDK exactly (30 minutes idle, tab-scoped) so the two
 * never disagree about when a session ends.
 */
export function browserSessionId(): string {
  if (typeof window === 'undefined') return SessionGateway.getSession().userId;
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    const lastActivity = sessionStorage.getItem(ACTIVITY_KEY);
    const fresh =
      stored && lastActivity && Date.now() - parseInt(lastActivity, 10) < SESSION_TIMEOUT_MS;

    const id = fresh ? (stored as string) : uuidv4();
    sessionStorage.setItem(SESSION_KEY, id);
    sessionStorage.setItem(ACTIVITY_KEY, String(Date.now()));
    return id;
  } catch {
    // Private mode / storage disabled. Fall back to the persistent user id so
    // spans still carry *a* session, rather than a new one per span.
    return SessionGateway.getSession().userId;
  }
}

/**
 * Monoscope RUM: browser traces, web vitals and rrweb session replay.
 *
 * The import is dynamic and browser-only for two independent reasons:
 *
 *  1. RUM is meaningless during SSR.
 *  2. `@monoscopetech/browser@0.11.6` **cannot be imported by Node at all**.
 *     It is published with `"type": "module"` but its `dist/index.js` uses
 *     extensionless relative imports (`import … from "./replay"`), which is
 *     invalid ESM — Node fails with ERR_MODULE_NOT_FOUND. A static import
 *     therefore breaks `next build` during page-data collection, not just at
 *     runtime. Once the package ships valid ESM this can become a normal
 *     top-level import.
 *
 * Resolves to null when no API key is configured — the demo has to keep
 * working for anyone running it without a Monoscope project, and the SDK
 * constructor throws on a missing key.
 */
export async function initMonoscope(): Promise<unknown> {
  if (instance || !NEXT_PUBLIC_MONOSCOPE_API_KEY || typeof window === 'undefined') return instance;

  // Seed the shared session id before the SDK reads sessionStorage.
  const sessionId = browserSessionId();

  const { default: Monoscope } = await import('@monoscopetech/browser');
  const rate = Number(NEXT_PUBLIC_MONOSCOPE_REPLAY_SAMPLE_RATE);

  instance = new Monoscope({
    apiKey: NEXT_PUBLIC_MONOSCOPE_API_KEY,
    serviceName: NEXT_PUBLIC_OTEL_SERVICE_NAME || 'frontend-web',
    exporterEndpoint: NEXT_PUBLIC_MONOSCOPE_OTLP_ENDPOINT || undefined,
    // Session replay uploads go to the app host, not the collector.
    replayEventsBaseUrl: NEXT_PUBLIC_MONOSCOPE_APP_URL || undefined,
    // There is no on/off switch for replay in the SDK — it configures
    // unconditionally — so the sample rate is the only lever. Default to
    // recording everything: this is a demo whose point is having something to
    // watch.
    replaySampleRate:
      NEXT_PUBLIC_MONOSCOPE_REPLAY_SAMPLE_RATE !== '' && Number.isFinite(rate) ? rate : 1,
  });

  const { userId } = SessionGateway.getSession();
  // The demo's only notion of a person is the uuid it keeps in localStorage,
  // so it is both the user id and the closest thing to a name we can offer.
  (instance as { setUser: (u: Record<string, string>) => void }).setUser({
    id: userId,
    full_name: `Demo shopper ${userId.slice(0, 8)}`,
  });

  // Tenant is deliberately NOT set here — see DEMO_TENANT.

  if (
    (instance as { getSessionId?: () => string }).getSessionId?.() !== sessionId &&
    typeof console !== 'undefined'
  ) {
    // Loud on purpose: if this ever fires, replays are being written under an
    // id no span carries, and they will silently never appear in the UI.
    console.warn('[Monoscope] session id diverged from the seeded one; replays will not link to traces');
  }

  return instance;
}

/**
 * The tenant the demo reports as.
 *
 * Stamped by SessionIdProcessor onto the demo's own browser spans rather than
 * handed to the SDK, because **the published
 * `@monoscopetech/browser@0.11.6` has no tenant support at all**: neither a
 * `tenant` config option nor a `setTenant()` method exists in its typings or
 * its runtime bundle. Both exist in the monoscope-web source, so the npm
 * release is simply behind — once a version ships with them, move this to
 * `setTenant(DEMO_TENANT)` and drop the attributes from the span processor.
 *
 * The demo has no real tenancy; one stable tenant keeps the facet populated
 * and filterable without inventing customers that do not exist. Note tenant.*
 * is display/filter-only in Monoscope — it plays no part in session grouping.
 */
export const DEMO_TENANT = { id: 'otel-demo', name: 'OpenTelemetry Demo' };
