# cal-synch

Group meeting scheduler. The organiser creates a poll with candidate dates and
an hour range, participants paint their availability, the group heatmap and a
ranked list of best windows show where everyone overlaps, and the organiser
locks the agreed time with calendar export.

Stack: Vite + React 19 + Tailwind v4 (edulab design system), Express API with
JSON file storage in `data/polls.json` (created on first run, not committed).

## Run

```bash
bun install        # or npm install
bun run dev        # http://localhost:3000 (API + Vite dev server)
```

Production: `bun run build` then `bun run start`. The start command sets
`NODE_ENV=production`, serves public assets from `dist/`, and runs the private
server bundle from `build/`. Fingerprinted assets are cached for a year;
HTML is revalidated so a new deployment is picked up immediately.

Environment: `PORT` (default 3000), `POLLS_DATA_FILE` (default `data/polls.json`).

## Netlify

Connect the GitHub repository to Netlify and deploy `main`. The checked-in
configuration builds the frontend, publishes `dist/`, and routes `/api/*` to the
Netlify Function. Uploading only the static build with Netlify Drop is not enough.

Meetings persist in the site's **Blobs** store named `calendar-polls`, under the
`polls` key. The native function runtime supplies storage credentials; no separate
database account or frontend API key is needed. Production data survives new
deploys. Preview and branch deploys use separate, deploy-specific store names.

Cloud writes use ETag checks and retry known conflicts, so separate function
instances cannot silently overwrite concurrent updates. If contention persists,
the API returns a retryable error instead of claiming a successful save. This
shared JSON-array store is intended for small trusted groups, not a high-volume
database. Netlify Functions and Blobs usage is subject to your account's limits.

After deploying, `/api/health` must return JSON with `status: "ok"` and
`/api/polls` must return a JSON array, not an HTML page or 404. Local commands
continue to use the local JSON file; it is never uploaded automatically.

## Test

```bash
bun run test       # builds first, then unit, DOM, API and production HTTP tests
bun run lint       # tsc --noEmit
```

Times are shown in the browser's own timezone; polls record it for reference only.

## Adding dates to a poll

**Add dates** (next to "Organized by") proposes more candidate dates for an
open poll, with the same hour range and drag grid as New Poll. Existing dates
and answers are unchanged. It is hidden once a time is locked; re-open voting
first. Like other edits, it is available to anyone with access to the app.
Adding later dates also pushes back the poll's automatic cleanup.

## Automatic poll cleanup

A poll is deleted automatically once its last proposed date is more than
14 days in the past (UTC calendar days: a poll ending 1 October is kept
through 15 October). Expired polls disappear from the API immediately and are
removed from storage on the next save. A daily sweep also deletes them: the
`cleanup-polls` scheduled function on Netlify (production deploys only; use
"Run now" on the Functions page to trigger it), and a startup plus 24-hour
timer on the local server. Creating a poll that is already past that window
is rejected. The window is `RETENTION_DAYS` in `server/retention.ts`.

## Grid view

Choose **30 min** or **1 hour** above either availability grid. The choice is
remembered in this browser and changes only the display, not meeting duration
or existing answers. Hourly painting applies to all underlying half-hour slots;
cells show **Mixed** when those answers differ. Short final blocks remain visible.
The group heatmap counts someone as available only for an entire displayed block.

## Deployment limits

This is a trusted-group app, not an authenticated public service: anyone with
access can list polls, read contact details, edit responses and finalize meetings.
Use a private network or an authenticated reverse proxy before sharing beyond
the trusted group. Run only one server process per data file; the write queue
does not coordinate multiple processes. Back up the data file before upgrades.
Unreadable or malformed JSON storage returns an error rather than overwriting
existing data with an empty poll list.
