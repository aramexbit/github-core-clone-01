// github-core-clone-01 v6 — entrypoint: lifecycle driver only.
// Spawns the vendored Go forge binary (forge/forge, statically linked,
// built from forge/*.go), reads the ephemeral loopback port it prints on
// stdout ("PORT <n>"), registers the port with the make.fun environment,
// then waits for /done before exiting cleanly.

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const envUrl = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
const token = process.env.MAKEFUN_SHOP_TOKEN ?? "";
if (!envUrl || !token) {
  console.error("MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN must both be set");
  process.exit(1);
}

const repoDir = dirname(fileURLToPath(import.meta.url));
const binaryPath = join(repoDir, "forge", "forge");

const child: ChildProcess = spawn(binaryPath, [], {
  env: { ...process.env, MAKEFUN_SHOP_TOKEN: token },
  stdio: ["ignore", "pipe", "inherit"],
});

let port = 0;
const portPromise = new Promise<number>((resolve, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error("forge binary did not print its port in time")), 30000);
  child.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const m = /^PORT (\d+)\n/m.exec(buf);
    if (m) {
      clearTimeout(timer);
      resolve(parseInt(m[1], 10));
    }
  });
  child.once("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`forge binary exited early with code ${code}`));
  });
  child.once("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
});

try {
  port = await portPromise;
} catch (e) {
  console.error(`could not start forge binary: ${(e as Error).message}`);
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  process.exit(1);
}

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
  child.kill("SIGTERM");
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

child.kill("SIGTERM");
process.exit(0);
