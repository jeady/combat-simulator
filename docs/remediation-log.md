
## Workstream B

### B3 — slayer-task evaluation through the worker pool

`GameScorer.evaluateSlayerTask` now dispatches all accessible task monsters
concurrently through the worker pool (via `simulateManySettled`) when a pool is
present; the pool-less scorer keeps the serial path. Headless tests can't cover
this (it needs `Global`), so the settled-dispatch plumbing is verified by the
`worker-pool.test.ts` `simulateManySettled` tests.

VERIFY IN-GAME: run auto-optimize against a slayer task with ~8 reachable
monsters using 8 workers; each candidate's per-monster sims should now run in
parallel, giving an ~N× (up to worker count) speedup on the slayer path versus
the previous serial per-monster loop.
