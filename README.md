# The Open 2026 — Snake Draft Pool

Single-page static site (plain HTML/CSS/JS, no build step) for a 7-owner snake draft pool
for the 2026 Open Championship. Shared state lives in Firebase Realtime Database; live
scores come from ESPN's public golf leaderboard API.

## How it works

- **Owners**: Ram, Dragon, Gary, GF, Ronnie, Phillips, Ace by default — team names, team
  count, and rounds are editable in the admin panel until the draft starts. Each owner opens
  the site and claims their seat from the dropdown (stored in the shared DB; a seat can only
  be claimed once).
- **Draft**: rounds × teams picks (default 7×7 = 49), snake order. The admin sets the
  round-1 order before starting. The big banner and the browser tab title always show who
  is on the clock.
- **Scoring**: after the draft completes, the page polls ESPN every 3 minutes. A golfer's
  score is their overall **to-par** number and updates live mid-round (a golfer 5-under
  thru 11 counts as −5 right now). A golfer who misses the cut (or WDs/DQs) scores **80
  strokes** for each unplayed round, i.e. +(80 − par) per round to par. Golfers who
  haven't hit a shot yet are "pending" and don't count as even par.
  - *Top X Combined* table: teams ranked by the summed to-par of their best X golfers
    (X is set in the admin panel and can be changed even mid-tournament).
  - *Best Golfer* table: teams ranked by their single best golfer.
  - The full official tournament leaderboard renders below the league standings.
- Roster golfers that fail to match ESPN's leaderboard by normalized name are flagged;
  fix them in **Admin → Scoring Fixes** with an exact ESPN name mapping or a manual
  total-score override.

## Admin

Open the **Admin** tab and enter the passphrase.

- **Draft Setup**: league setup (team names, one per line, and rounds per team — editable
  until the draft starts); set the round-1 draft order; paste the tournament field, one
  golfer per line as `Name, +odds` or `Name +odds` (odds optional; commas in odds OK).
- **Draft Control**: start draft, undo last pick, reset draft (keeps field & seats),
  full reset (erases everything except the admin passphrase hash).
- **Scoring Fixes**: per-golfer ESPN name mapping and manual score override.
- To point scoring at a different tournament, set `/state/espnEventId` in the DB to another
  ESPN golf event id (defaults to `401811957`, The Open 2026). Both reset buttons clear it.
- To change the passphrase: compute `sha256(newPass)` (hex), update `ADMIN_HASH` in
  `app.js`, and set `/admin/passHash` in the DB to the same value.

## ESPN API (verified 2026-07-12)

```
https://site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event=401811957
```

CORS is open (`access-control-allow-origin: *`). Shape:
`events[0].competitions[0].competitors[]`, each with `athlete.displayName`,
`linescores[{period, value}]` (per-round strokes), `score{value, displayValue}`,
`status.type.name` (`STATUS_CUT`, `STATUS_FINISH`, …), `status.position.displayName`,
and `sortOrder` (leaderboard position).

## Notifications

No automated notifications yet. When a pick is made, the submitting client calls
`notifyPickMade(pick)` in `app.js` — add any webhook/SMS/Slack integration in that one
function.

## Firebase security rules

`firebase-rules.json` holds the production rules: public reads (except `/admin`),
validated writes — seats are claim-once, picks are only accepted from the seat that is
actually on the clock at the current pick index, and everything else requires the admin
passphrase. The rules rely on **Anonymous Authentication**, so before applying them:

1. Firebase console → Authentication → Sign-in method → enable **Anonymous**.
2. Firebase console → Realtime Database → Rules → paste `firebase-rules.json` → Publish.

The admin proves the passphrase by writing its hash to `/admin/authorized/{uid}`, which
the rules compare against the (unreadable) `/admin/passHash`.

## Local development

Serve the directory with any static file server, e.g. `python -m http.server 8123`,
then open `http://localhost:8123/`. No build step.
