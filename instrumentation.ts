// Runs once when the Next.js server starts (dev and production).
export async function register() {
  // Skip during `next build`: arming the queue/avatar loops and running DB
  // backfills are runtime concerns. Doing them across the 15 parallel build
  // workers contends on the DB (SQLITE_BUSY), and the queue worker must never
  // send while building. They run normally when the server actually starts.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAvatarPrefetchLoop } = await import("./lib/avatar-prefetch");
    startAvatarPrefetchLoop();
    const { startQueueWorker } = await import("./lib/queue-worker");
    startQueueWorker();
    // Watches the connected inboxes for Gmail "Message blocked" bounces and
    // stands the affected account down for the rest of the day.
    const { startBounceWatch } = await import("./lib/bounce-watch");
    startBounceWatch();
    // One-time: standardize any history country values missing country_std.
    const { backfillCountryStd } = await import("./lib/history-sync");
    const n = backfillCountryStd();
    if (n > 0) console.log(`[country] backfilled country_std for ${n} rows`);
    // One-time: resolve timezone for sequences enqueued before the resolver.
    const { backfillSequenceLocations } = await import("./lib/sequences-store");
    const m = backfillSequenceLocations();
    if (m > 0) console.log(`[country] resolved timezone for ${m} sequences`);
  }
}
