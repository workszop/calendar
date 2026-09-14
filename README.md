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

Rebuilding does not reload a running backend process. Restart it after a build;
otherwise the new frontend can call routes that the old backend does not have.
For the local user service, run `systemctl --user restart cal-synch.service`
after `npm run build`. This preserves the poll data file.

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
`/api/polls` must return a JSON array (empty without `?ids=`), not an HTML page or 404. Local commands
continue to use the local JSON file; it is never uploaded automatically.

## Test

```bash
bun run test       # builds first, then unit, DOM, API and production HTTP tests
bun run lint       # tsc --noEmit
```

Times are shown in the browser's own timezone; polls record it for reference only.

## Workspace

The root page lists meetings instead of opening a sample or the latest poll.
Use **Open**, **Agreed**, or **All** and search by meeting name. Opening a
meeting keeps its `?poll=` link shareable; **All meetings** returns to the list.

**Create a poll** opens one page with the meeting name, duration and date calendar
together. Optional metadata stays collapsed until needed. Each selected day starts
with no times: click slots or drag within its column to propose a range, including
gaps. **Copy times to…** copies the exact selection to explicitly chosen days.
The yellow **Create poll** action stays in the viewport. A failed save keeps the
draft available to retry.
After creation, share the real invitation link and then open the meeting.

Each meeting has two main views: **Group overview** and **My answer**. Group
results use a selected-time inspector beside the calendar (below it on narrow
screens); hovering another time does not replace a pinned selection. Detailed
filters, recommendations, display settings and management actions are available
on demand. A poll without responses shows a waiting state rather than a grid of
zero counts. The answer view keeps painting first and identity/save controls
in a persistent bottom action bar. Creation, home and selected-time confirmation
also keep their primary action in the viewport. Content has measured bottom
clearance, and the bar follows the visible viewport when a mobile keyboard opens.
The selected-time inspector distinguishes calendar cells from
the full meeting window and shows attendance for the complete duration.

## Adding dates to a poll

**Add dates** in the meeting workspace proposes more candidate dates for an
open poll, using its existing hour-range controls and drag grid. Existing dates
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

Open the calendar settings and choose **30 min** or **1 hour**. The choice is
remembered in this browser and changes only the display, not meeting duration
or existing answers. Hourly painting applies to all underlying half-hour slots;
cells show **Mixed** when those answers differ. Short final blocks remain visible.
The group heatmap counts someone as available only for an entire displayed block.

## Deployment limits

## Access codes

There are no accounts. Creating a poll returns an **organizer code**, kept in the
creating browser and shown once on the share screen, where it can be copied, sent
as an organizer link (`?poll=<id>#organizer=<code>`) or saved as a text file.
Locking a time, re-opening voting, adding dates, removing responses and deleting
the poll require that code (`X-Organizer-Code` header); anyone else can enter it
under **Manage poll** to unlock those tools. Each saved response gets an **edit
code** kept in the answering browser (`X-Edit-Code`); a response cannot be changed
without it, and typing an existing name creates a new response. Codes cannot be
recovered: the server stores only their SHA-256 hashes. Emails are returned only
to the organizer. There is no public poll list: the home page shows polls this
browser created or answered. Polls stored before access codes existed are removed.

## Deployment limits

Anyone holding a poll link can read its title, dates, names and answers, and add
a response. Run only one server process per data file; the write queue
does not coordinate multiple processes. Back up the data file before upgrades.
Unreadable or malformed JSON storage returns an error rather than overwriting
existing data with an empty poll list.
