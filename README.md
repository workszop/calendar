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

## Test

```bash
bun run test       # builds first, then unit, DOM, API and production HTTP tests
bun run lint       # tsc --noEmit
```

Times are shown in the browser's own timezone; polls record it for reference only.

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
