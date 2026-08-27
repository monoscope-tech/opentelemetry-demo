# Monoscope config for the demo project

Everything here targets the public demo project
`00000000-0000-0000-0000-000000000000`.

**Two mechanisms, two formats — they are not interchangeable.**

## `dashboards/` — server-side git sync

Monoscope reads `monoscope/dashboards/*.yaml` from the `monoscope-config`
branch. Each file is a **bare `Dashboard`** object (`title:` at the top level).

Sync is bidirectional:

- **push** — saving a dashboard in the UI commits the YAML back here
- **pull** — a push event on this repo triggers a webhook that reapplies the
  files to the project

> A **push webhook is the only pull trigger.** There is no cron and no manual
> "sync now", regardless of what the settings page says. The GitHub App
> installation configures the webhook automatically.

Do not hand-write files here — save the dashboard in the UI and let the push
produce the YAML, so the shape is always one monoscope can read back.

## `monitors/` — CLI apply

Git sync does **not** carry monitors. They go through the CLI:

```sh
MONOSCOPE_PROJECT=00000000-0000-0000-0000-000000000000 \
  monoscope monitors apply monoscope/monitors/
```

Idempotent — monitors upsert by `title`, so re-running is safe.

These files use the `MonitorInput` shape, which is **not** the same schema as
`dashboards/`. Dashboards applied through the CLI nest under `schema:`; the
git-synced ones do not. Keeping the two in separate directories is what stops
the wrong file reaching the wrong consumer.

<!-- sync probe -->
