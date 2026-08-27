#!/usr/bin/env bash
# Check values-agent.yaml's filelog exclude list against what the demo actually emits.
#
# The list is wrong in both directions and both are silent: a service that starts
# shipping OTLP logs but is not excluded has its logs counted twice; a service
# excluded here that does not ship OTLP logs has its logs dropped entirely, with
# nothing anywhere to notice. That second one had been true of kafka for as long as
# the list existed.
#
# Exits non-zero on drift so this can gate a deploy rather than being a thing
# someone remembers to run.
set -euo pipefail

PROJECT="${MONOSCOPE_PROJECT:-00000000-0000-0000-0000-000000000000}"
SINCE="${SINCE:-30m}"
VALUES="$(dirname "$0")/values-agent.yaml"

# Services observed shipping OTLP logs. Trace-correlated log records can only come
# from the OTLP path — filelog-scraped stdout has no trace context — so this is a
# sound test for "the logger SDK is wired up", not a proxy for it.
emitting=$(monoscope -p "$PROJECT" --json chart \
  'kind == "log" and context.trace_id != "" | summarize count(*) by resource.service.name' \
  --since "$SINCE" | jq -r '.data_text[][0]' | sort -u)

# The agent's own self-exclusion is a preset default, not a demo service.
excluded=$(grep -oE '/var/log/pods/default_[a-z-]+-\*_' "$VALUES" \
  | sed -E 's|/var/log/pods/default_(.*)-\*_|\1|' \
  | grep -v '^monoscope-agent-opentelemetry-collector' | sort -u)

double_counted=$(comm -23 <(echo "$emitting") <(echo "$excluded"))
dropped=$(comm -13 <(echo "$emitting") <(echo "$excluded"))

if [ -n "$double_counted" ]; then
  echo "DOUBLE-COUNTED — emits OTLP logs but is not excluded, so filelog scrapes it too:"
  echo "$double_counted" | sed 's/^/  /'
fi
if [ -n "$dropped" ]; then
  echo "DROPPED — excluded from filelog but ships no OTLP logs, so its logs reach monoscope from nowhere:"
  echo "$dropped" | sed 's/^/  /'
fi
if [ -n "$double_counted$dropped" ]; then
  echo
  echo "Fix $VALUES so its exclude list is exactly the emitting set, then re-run."
  exit 1
fi

echo "in sync — $(echo "$emitting" | wc -l | tr -d ' ') services emit OTLP logs and all are excluded from filelog"
