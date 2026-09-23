# warn-notices

US WARN Act layoff and plant-closure notices — the 60-day advance filings
employers must make before a mass layoff — from state labor departments.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1669+ live data sources.

**Coverage is partial on purpose, and every response says so.** There is no
national WARN database: the federal DOL neither collects nor publishes one, so
employers file with the state where the site sits and each state publishes on
its own terms. This pack covers the states that publish machine-readable data
and reports exactly which those are.

## Tools

| Tool | Answers |
|---|---|
| `warn_search` | Which employers filed notices, filtered by company, state, date or size? |
| `warn_recent` | What was filed lately, newest first? |
| `warn_company` | Every notice one employer has filed, with per-state and per-year totals. |
| `warn_coverage` | Which states are covered, how many notices each holds, and how current each is. |

Every response carries `states_covered`. An empty result distinguishes
`state_not_covered` from `no_matching_notices`, because "Georgia isn't
covered" and "this employer filed nothing" are different answers and only one
of them is about the employer.

## Coverage

| State | Source | Format | History | Cadence |
|---|---|---|---|---|
| CA | EDD WARN report | XLSX | rolling ~2-month window | twice weekly |
| IL | Illinois WorkNet WARN API | JSON | since 1987 | weekly |
| NY | NYSDOL WARN dashboard | Tableau CSV | since 2025-04 | weekly, in bursts |
| OH | ODJFS annual notice file | CSV | current year | weekly |
| TX | TWC via data.texas.gov | Socrata JSON | since 2019 | irregular, has lagged ~2 months |

Each state is registered in `data_freshness` **separately** (`warn-ca`,
`warn-il`, …) so one stalled feed is visible instead of being hidden behind a
fresher state's date.

### Probed and not shipped

Recorded so nobody re-probes them:

- **NJ** — XLSX exists, but the state's own file is column-shifted on many
  rows (company names landing in the date column). Needs row-level repair.
- **PA / WA / FL** — real and current, but HTML only. PA is a nested
  accordion, WA an ASP.NET GridView needing `__VIEWSTATE` postbacks past page
  one, FL a paginated table. All scrapeable; none machine-readable.
- **GA** — no current public listing exists. The legacy search still answers
  but stops in 2013, and the modern site is an employer submission form with
  no public index.

## Data sources

- California EDD — <https://edd.ca.gov/en/jobs_and_training/Layoff_Services_WARN>
- Illinois WorkNet — <https://apps.illinoisworknet.com/iebs/layoff/publiclayoffs>
- New York DOL — <https://dol.ny.gov/warn-dashboard>
- Ohio ODJFS — <https://jfs.ohio.gov/> (annual `warn-notice.csv` asset)
- Texas Workforce Commission — <https://data.texas.gov/d/8w53-c4f6>

Ingest lives in `workers/data-pipeline/src/datasets/warn.ts`; the per-source
traps are documented there. Table: `warn_notices` (migration 108).

## Gotchas worth knowing

- **Texas publishes no layoff-vs-closure flag.** `type` is null for TX rather
  than guessed — an invented "Layoff" would read as reported fact.
- **Texas lags.** Its newest notice trailed the other states by ~2 months as of
  2026-08-29. That is normal for this feed.
- **Effective dates are not always dates.** Several states publish a range or
  the word "various", so `effective_date` is set only when it parses and
  `effective_date_as_published` always carries what was actually written.
- **Company names are free text.** Search matches on a suffix-stripped form,
  so "Tesla" finds "Tesla, Inc."; `matched_filed_names` echoes back the exact
  strings matched so a caller can spot a loose match across sister entities.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "warn-notices": {
      "url": "https://gateway.pipeworx.io/warn-notices/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/warn-notices/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1669+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/warn_search \
  -H 'Content-Type: application/json' \
  -d '{"state":"TX","min_employees":200,"since":"2026-01-01"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/warn_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "warn-notices": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-warn-notices"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-warn-notices
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Warn Notices data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
