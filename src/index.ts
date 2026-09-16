interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * WARN Act layoff notices — state-by-state.
 * Fleet #623.
 *
 * WHY THIS IS PARTIAL BY CONSTRUCTION. There is no national WARN database.
 * The federal DOL does not require, collect or publish one — employers file
 * with the state dislocated-worker unit where the site sits, and each state
 * labor department publishes (or doesn't) on its own terms. Probed 2026-08-28
 * across ten states, the formats ranged from a Socrata JSON endpoint to an
 * accordion of HTML to a system that stopped updating in 2013. So coverage is
 * a per-state fact, not a national one.
 *
 * That shapes the whole surface: EVERY response carries `states_covered`, and
 * an empty result says which states were actually searched. A caller asking
 * "any layoffs at Acme" who gets `[]` back must be able to tell "Acme filed
 * nothing in a covered state" from "Acme is in Georgia and nobody publishes
 * Georgia" — those are different answers and only one of them is about Acme.
 * A bare empty array collapses them, which is how a coverage hole turns into
 * a confident wrong answer.
 *
 * SOURCES are mirrored by workers/data-pipeline (see
 * workers/data-pipeline/src/datasets/warn.ts for the per-state ingest and its
 * traps). This pack only reads `warn_notices` over PostgREST.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'WARN Act layoff notices');
}

interface Cfg { url: string; key: string }

const TABLE = 'warn_notices';

// The Workers runtime sends no User-Agent of its own, so every outbound fetch
// names us explicitly. Packs that skipped this have died at upstreams behind a
// bot filter, which answers 403 and reads as "the API closed" rather than as a
// missing header.
const UA = 'pipeworx-mcp-warn-notices/1.0 (+https://pipeworx.io)';

async function pg<T>(cfg: Cfg, query: string, relation: string = TABLE): Promise<T> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${relation}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`data query ${relation}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

/**
 * Company names are free text filed by the employer, so the same firm appears
 * as "Tesla, Inc.", "Tesla Inc" and "TESLA MOTORS". Normalisation strips the
 * corporate suffix and punctuation for MATCHING only — the original string is
 * always what gets returned, because a caller checking a legal entity needs
 * to see what was actually filed.
 */
const SUFFIXES = /\b(incorporated|corporation|company|limited|holdings|group|llc|l\.l\.c|inc|corp|co|ltd|lp|llp|plc|pllc|na)\b/g;
function normCompany(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,'"()]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** PostgREST reserves these inside its filter grammar. */
const esc = (s: string) => s.replace(/[(),*]/g, ' ').trim();

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

interface NoticeRow {
  state: string;
  company: string;
  company_norm: string;
  location_city: string | null;
  county: string | null;
  notice_date: string;
  effective_date: string | null;
  effective_date_text: string | null;
  employees: number | null;
  notice_type: string | null;
  source_url: string | null;
}

function shape(r: NoticeRow) {
  return {
    state: r.state,
    company: r.company,
    city: r.location_city,
    county: r.county,
    notice_date: r.notice_date,
    // effective_date is null when the state published a range or "various";
    // effective_date_text then carries what they actually wrote.
    effective_date: r.effective_date,
    effective_date_as_published: r.effective_date_text,
    employees: r.employees,
    type: r.notice_type,
    source_url: r.source_url,
  };
}

interface CoverageRow {
  state: string;
  notices: number;
  latest_notice_date: string | null;
  earliest_notice_date: string | null;
  last_ingested_at: string | null;
}

/**
 * Coverage is read from the data itself rather than a hardcoded list, so a
 * state whose ingest silently stops still reports its real last notice date
 * instead of an optimistic constant.
 *
 * It reads the `warn_coverage_v` VIEW, which aggregates in Postgres, rather
 * than counting rows here. Counting client-side looked fine and was wrong:
 * PostgREST clamps every response to 1000 rows no matter what `limit=` asks
 * for, so summing the fetched page reported the first two states alphabetically
 * and silently dropped the other three — a coverage tool under-reporting
 * coverage, which is the one thing it must never do.
 */
async function coverage(cfg: Cfg): Promise<CoverageRow[]> {
  const rows = await pg<CoverageRow[]>(cfg, 'select=*&order=state.asc', 'warn_coverage_v');
  return rows.map((r) => ({ ...r, notices: Number(r.notices) }));
}

const COVERAGE_NOTE =
  'WARN filings are made with individual state labor departments; there is no federal WARN database. Coverage is limited to the states listed in states_covered — a company with no rows may still have filed in a state that is not covered, or in one that publishes nothing machine-readable.';

const tools: McpToolExport['tools'] = [
  {
    name: 'warn_search',
    description:
      'Search US WARN Act layoff and plant-closure notices filed with state labor departments — the legally required 60-day advance notice of a mass layoff or site closure. Returns employer name, site city and county, notice date, layoff effective date, number of workers affected, and whether the filing is a layoff or a closure. Answers "which employers filed layoff notices in Texas this year", "layoff filings above 200 workers since June", "WARN notices in Suffolk County". Covers the states named in states_covered on every response.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        company: { type: 'string', description: 'Employer name, free text. Matched loosely against the filed legal name, so "Tesla" finds "Tesla, Inc.".' },
        state: { type: 'string', description: 'Two-letter state code, e.g. "TX". Omit to search every covered state.' },
        since: { type: 'string', description: 'Earliest WARN notice date, YYYY-MM-DD.' },
        min_employees: { type: 'number', description: 'Only notices affecting at least this many workers.' },
        limit: { type: 'number', description: 'Max notices to return (default 50, max 500).' },
      },
      required: [],
    },
  },
  {
    name: 'warn_recent',
    description:
      'Most recent US WARN Act layoff and plant-closure notices across every covered state, newest first — the earliest public signal that an employer is cutting jobs, filed roughly 60 days before the layoff takes effect. Answers "recent layoff notices", "who announced layoffs this month", "latest WARN filings in Texas". Returns employer, site, worker count and effective date, plus states_covered so a quiet month is distinguishable from a coverage gap.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'Look back this many days from today by WARN notice date (default 30).' },
        state: { type: 'string', description: 'Two-letter state code to restrict to, e.g. "NY". Omit for all covered states.' },
        limit: { type: 'number', description: 'Max notices to return (default 50, max 500).' },
      },
      required: [],
    },
  },
  {
    name: 'warn_company',
    description:
      'Every WARN Act layoff and closure notice one employer has filed, across all covered states, with a per-state and per-year breakdown. Answers "has Tesla filed layoff notices", "how many workers has Amazon laid off by WARN filing", "which sites did this company close". Use to trace one employer\'s layoff history rather than browsing a date range.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        company: { type: 'string', description: 'Employer name, free text — "Tesla" matches "Tesla, Inc." and "TESLA MOTORS".' },
        limit: { type: 'number', description: 'Max notices to return (default 200, max 500).' },
      },
      required: ['company'],
    },
  },
  {
    name: 'warn_coverage',
    description:
      'Which US states WARN layoff-notice coverage extends to, how many notices are available for each, and the date of the newest notice per state. Answers "which states do you have WARN data for", "how current is the layoff data", "is Georgia covered". Read this before treating an empty WARN search result as evidence that no layoffs were filed.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  },
];

async function warnSearch(cfg: Cfg, a: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 500);
  const parts = ['select=*', `order=notice_date.desc`, `limit=${limit}`];
  if (a.company) {
    const n = normCompany(String(a.company));
    if (n) parts.push(`company_norm=ilike.*${encodeURIComponent(esc(n))}*`);
  }
  if (a.state) parts.push(`state=eq.${encodeURIComponent(String(a.state).toUpperCase().trim())}`);
  if (a.since) parts.push(`notice_date=gte.${encodeURIComponent(String(a.since))}`);
  if (a.min_employees != null) parts.push(`employees=gte.${Number(a.min_employees)}`);

  const rows = await pg<NoticeRow[]>(cfg, parts.join('&'));
  const covered = await coverage(cfg);
  const states = covered.map((c) => c.state);

  if (!rows.length) {
    return {
      found: false,
      // Naming the filters back is what makes a zero interpretable: the caller
      // can see whether they asked for an uncovered state before concluding
      // the employer filed nothing.
      searched: { company: a.company ?? null, state: a.state ?? null, since: a.since ?? null, min_employees: a.min_employees ?? null },
      reason: a.state && !states.includes(String(a.state).toUpperCase().trim())
        ? 'state_not_covered'
        : 'no_matching_notices',
      hint: a.state && !states.includes(String(a.state).toUpperCase().trim())
        ? `WARN data is not available for "${a.state}". Covered states: ${states.join(', ')}. Call warn_coverage for per-state currency.`
        : 'No notice matched. Widen `since`, drop `min_employees`, or try a shorter company fragment — names are filed as free text.',
      states_covered: states,
      coverage_note: COVERAGE_NOTE,
    };
  }

  return {
    found: true,
    count: rows.length,
    notices: rows.map(shape),
    states_covered: states,
    coverage_note: COVERAGE_NOTE,
  };
}

async function warnRecent(cfg: Cfg, a: Record<string, unknown>) {
  const days = Math.min(Math.max(Number(a.days) || 30, 1), 3650);
  const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 500);
  const since = isoDaysAgo(days);
  const parts = ['select=*', `notice_date=gte.${since}`, 'order=notice_date.desc', `limit=${limit}`];
  if (a.state) parts.push(`state=eq.${encodeURIComponent(String(a.state).toUpperCase().trim())}`);

  const rows = await pg<NoticeRow[]>(cfg, parts.join('&'));
  const covered = await coverage(cfg);
  const states = covered.map((c) => c.state);
  const byState: Record<string, number> = {};
  for (const r of rows) byState[r.state] = (byState[r.state] ?? 0) + 1;

  if (!rows.length) {
    return {
      found: false,
      window: { days, since },
      reason: 'no_notices_in_window',
      // States publish in bursts and several refresh weekly or slower, so an
      // empty 30-day window is routinely a publication-lag artifact rather
      // than a quiet labour market. The per-state latest date says which.
      hint: `No WARN notice was filed in a covered state in the last ${days} days. Several states publish on a weekly-or-slower cadence, so widen `
        + '`days`, or call warn_coverage to see each state\'s newest notice date.',
      states_covered: states,
      latest_by_state: covered,
      coverage_note: COVERAGE_NOTE,
    };
  }

  return {
    found: true,
    window: { days, since },
    count: rows.length,
    notices_by_state: byState,
    notices: rows.map(shape),
    states_covered: states,
    coverage_note: COVERAGE_NOTE,
  };
}

async function warnCompany(cfg: Cfg, a: Record<string, unknown>) {
  const raw = String(a.company ?? '').trim();
  const limit = Math.min(Math.max(Number(a.limit) || 200, 1), 500);
  const covered = await coverage(cfg);
  const states = covered.map((c) => c.state);

  if (!raw) {
    return { found: false, reason: 'missing_company', hint: 'Pass an employer name, e.g. {"company":"Tesla"}.', states_covered: states };
  }
  const n = normCompany(raw);
  const rows = await pg<NoticeRow[]>(
    cfg,
    `select=*&company_norm=ilike.*${encodeURIComponent(esc(n))}*&order=notice_date.desc&limit=${limit}`,
  );

  if (!rows.length) {
    return {
      found: false,
      company: raw,
      reason: 'no_notices_for_company',
      hint: `No WARN notice matched "${raw}" in the covered states (${states.join(', ')}). The employer may have filed in an uncovered state, filed under a different legal entity name, or not filed at all. Try a shorter fragment of the name.`,
      states_covered: states,
      coverage_note: COVERAGE_NOTE,
    };
  }

  const byState: Record<string, number> = {};
  const byYear: Record<string, number> = {};
  let workers = 0;
  const names = new Set<string>();
  for (const r of rows) {
    byState[r.state] = (byState[r.state] ?? 0) + 1;
    byYear[r.notice_date.slice(0, 4)] = (byYear[r.notice_date.slice(0, 4)] ?? 0) + 1;
    workers += r.employees ?? 0;
    names.add(r.company);
  }

  return {
    found: true,
    company: raw,
    // The distinct filed names are echoed back because a loose match can
    // legitimately span sister entities; the caller decides if that is one
    // company or several.
    matched_filed_names: [...names],
    total_notices: rows.length,
    total_workers_affected: workers,
    notices_by_state: byState,
    notices_by_year: byYear,
    notices: rows.map(shape),
    states_covered: states,
    coverage_note: COVERAGE_NOTE,
  };
}

async function warnCoverage(cfg: Cfg) {
  const covered = await coverage(cfg);
  return {
    states_covered: covered.map((c) => c.state),
    state_count: covered.length,
    total_notices: covered.reduce((n, c) => n + c.notices, 0),
    // Two different questions, both worth answering: latest_notice_date is the
    // newest notice the state has published, data_current_as_of is how recently
    // that state's data was refreshed here. A stale feed and a genuinely quiet
    // state look identical unless both are visible.
    by_state: covered.map((c) => ({
      state: c.state,
      notices: c.notices,
      latest_notice_date: c.latest_notice_date,
      earliest_notice_date: c.earliest_notice_date,
      data_current_as_of: c.last_ingested_at,
    })),
    // Named explicitly so a caller doesn't have to infer the gap from the
    // table above; these are the states whose data was probed and found not
    // machine-readable, which is why a search for them returns nothing.
    states_probed_not_covered: {
      NJ: 'XLSX published, but the state file is column-shifted on many rows; needs repair before it can be trusted.',
      PA: 'Current, HTML accordion only.',
      WA: 'Current, ASP.NET grid requiring viewstate postbacks past page one.',
      FL: 'Current, paginated HTML table.',
      GA: 'No current public listing; the legacy search stops in 2013.',
    },
    coverage_note: COVERAGE_NOTE,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const cfg: Cfg = { url: String(args._supabaseUrl ?? ''), key: String(args._supabaseKey ?? '') };
  if (!cfg.url || !cfg.key) throw new Error('warn-notices needs gateway-injected database credentials');

  switch (name) {
    case 'warn_search': return warnSearch(cfg, args);
    case 'warn_recent': return warnRecent(cfg, args);
    case 'warn_company': return warnCompany(cfg, args);
    case 'warn_coverage': return warnCoverage(cfg);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
