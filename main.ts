// github-core-clone-01 v3 — entrypoint: lifecycle driver only.
// Binds the forge on an ephemeral loopback port, registers it with the
// make.fun environment, then waits for /done before exiting cleanly.

import { createForge } from "./app.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const envUrl = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
const token = process.env.MAKEFUN_SHOP_TOKEN ?? "";
if (!envUrl || !token) {
  console.error("MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN must both be set");
  process.exit(1);
}

const server = createForge(token);
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (!address || typeof address === "string") {
  console.error("server did not bind a TCP port");
  process.exit(1);
}
const port = address.port;

// Register with the environment (the environment dials the address this
// request came from, so loopback is correct).
let registered = false;
for (let attempt = 0; attempt < 40 && !registered; attempt++) {
  try {
    const r = await fetch(`${envUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
    });
    if (r.ok) registered = true;
  } catch {
    // environment not ready yet; retry
  }
  if (!registered) await sleep(500);
}
if (!registered) {
  console.error("could not register with the environment");
  server.close();
  process.exit(1);
}

// Wait for the suite to finish.
for (;;) {
  try {
    const r = await fetch(`${envUrl}/done`);
    if (r.ok) {
      const body = (await r.json()) as { done?: boolean };
      if (body.done === true) break;
    }
  } catch {
    // environment not reachable yet; keep polling
  }
  await sleep(250);
}

server.close();
process.exit(0);
