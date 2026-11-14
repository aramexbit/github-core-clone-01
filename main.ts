// main.ts — lifecycle driver for the github-core-clone-01 forge.
//
// The grading harness starts this process next to its own "env" server and
// drives the whole run through three small HTTP exchanges:
//
//   1. bind — we listen on an ephemeral port the kernel picks for us;
//   2. announce — we POST that port to the env's /register endpoint;
//   3. wait — we poll the env's /done endpoint until it says the suite
//      finished, then we shut the forge down and exit 0.
//
// That is everything this file does. The forge itself — the GitHub REST
// surface, GraphQL, MCP and the git smart-HTTP server — lives in app.ts
// behind createApp(). Nothing below knows about repositories, issues, pull
// requests or packfiles; it only owns the lifecycle around the server.
//
// Environment:
//   MAKEFUN_ENV_URL  origin of the env server, e.g. http://store:8080.
//                    When it is unset there is nobody to talk to, so we
//                    exit 1 immediately instead of hanging around.

import { createApp } from "./app.ts";

// ---------------------------------------------------------------------------
// Tunables for the retry loops. The env is local and fast, so the waits
// below are deliberately generous: a slow first register must never kill
// a run that would otherwise have graded fine.
// ---------------------------------------------------------------------------

const REGISTER_PATH = "/register";
const DONE_PATH = "/done";

const RETRY_FIRST_MS = 250; // wait before the first retry of a failed call
const RETRY_MAX_MS = 5000; // ceiling for the exponential backoff
const DONE_POLL_MS = 500; // gap between /done polls while the suite runs

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** Promise-based sleep, so the loops below read like plain prose. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Marks an error as "do not retry": the request itself is wrong, not the
 * env. A 400 or 405 from /register means our payload or method is bad, so
 * hammering the env again would only waste the wall clock.
 */
class FatalLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalLifecycleError";
  }
}

/**
 * Keep calling `work` until it succeeds. Transient failures (the env not
 * up yet, a dropped connection, a 5xx) are retried with exponential
 * backoff; a FatalLifecycleError is rethrown at once.
 */
async function withRetries<T>(label: string, work: () => Promise<T>): Promise<T> {
  let delayMs = RETRY_FIRST_MS;
  for (;;) {
    try {
      return await work();
    } catch (err) {
      if (err instanceof FatalLifecycleError) throw err;
      console.error(`[lifecycle] ${label} failed; retrying in ${delayMs}ms:`, err);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, RETRY_MAX_MS);
    }
  }
}

/** Drop trailing slashes so `${origin}/register` never becomes `//register`. */
function cleanOrigin(raw: string): string {
  return raw.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// The two env exchanges
// ---------------------------------------------------------------------------

/**
 * Tell the env which port the forge bound. The env records the address this
 * request came from plus the port as our base URL and dials it from then on.
 *
 * Accepted answers: 200 (registered) and 409 (first register already won;
 * a later one does not move the base URL, which is fine — we are the later
 * one only if something registered before us). 400/405 are fatal: our
 * request itself is malformed. Anything else is treated as transient and
 * retried by withRetries.
 */
async function announcePort(envOrigin: string, port: number): Promise<void> {
  const target = `${envOrigin}${REGISTER_PATH}`;
  await withRetries("register", async () => {
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
    });
    if (res.status === 200 || res.status === 409) return;
    if (res.status === 400 || res.status === 405) {
      throw new FatalLifecycleError(`register rejected with HTTP ${res.status}`);
    }
    throw new Error(`register answered HTTP ${res.status}`);
  });
}

/**
 * Poll GET /done until the env answers {"done": true}. While the suite is
 * still running it answers {"done": false} at once; we never hold a request
 * open and we never exit early. A failed poll (network blip, non-2xx) is
 * logged and retried on the next tick instead of aborting the run.
 */
async function waitForDone(envOrigin: string): Promise<void> {
  const target = `${envOrigin}${DONE_PATH}`;
  let failuresInARow = 0;
  for (;;) {
    try {
      const res = await fetch(target);
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
        failuresInARow = 0;
      } else {
        console.error(`[lifecycle] /done answered HTTP ${res.status}; polling again`);
        failuresInARow += 1;
      }
    } catch (err) {
      failuresInARow += 1;
      console.error("[lifecycle] /done poll failed; polling again:", err);
    }
    // Back off a little after repeated failures, but stay on the regular
    // cadence while the env is answering normally.
    const gap = failuresInARow > 0
      ? Math.min(DONE_POLL_MS * 2 ** failuresInARow, RETRY_MAX_MS)
      : DONE_POLL_MS;
    await sleep(gap);
  }
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

/** Bind, announce, wait, shut down. Returns the process exit code. */
async function runLifecycle(): Promise<number> {
  const rawOrigin = process.env.MAKEFUN_ENV_URL;
  if (!rawOrigin) {
    console.error("[lifecycle] MAKEFUN_ENV_URL is not set; nothing to register with.");
    return 1;
  }
  const envOrigin = cleanOrigin(rawOrigin);

  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    forge.once("error", reject);
    forge.listen(0, () => resolve());
  });

  const bound = forge.address();
  if (bound === null || typeof bound === "string") {
    console.error("[lifecycle] could not read the port the forge bound.");
    return 1;
  }
  const port = bound.port;
  console.log(`[lifecycle] forge listening on ephemeral port ${port}`);

  await announcePort(envOrigin, port);
  console.log("[lifecycle] registered with the env; waiting for the suite to finish...");
  await waitForDone(envOrigin);

  console.log("[lifecycle] env reports done; closing the forge.");
  await new Promise<void>((resolve) => forge.close(() => resolve()));
  return 0;
}

runLifecycle()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[lifecycle] fatal error:", err);
    process.exit(1);
  });
