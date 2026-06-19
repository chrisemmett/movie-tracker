# Claude instructions for movie-tracker

## Keep the design doc current

`docs/DESIGN.md` is the canonical low-level design for this app. Any change
that alters the codebase MUST update it in the same commit/PR. Treat the
design as part of the code — a PR that modifies behaviour without
reflecting it in the doc is incomplete.

This applies to any of the following:

- A new, removed, or renamed route, table column, env var, or external
  dependency.
- A change to a module's responsibility, the data shape returned by
  `toDisc()`, or the wire shape between client and server.
- A change to the DOM structure, layout, or rendering pipeline in
  `public/app.js` / `public/styles.css` that's visible at the level of
  detail the doc already describes (e.g. a new sticky region, a new view
  mode, a new modal flow).
- A change to the build, deploy, backup, or CI process.

Before declaring a task done, re-read the relevant section of
`docs/DESIGN.md` and confirm it still matches reality. If it doesn't,
update it — and if the change is small enough that the doc didn't need to
mention it, say so explicitly rather than silently skipping.

Bump the `Last revised:` date at the bottom of the doc whenever you touch
it.
