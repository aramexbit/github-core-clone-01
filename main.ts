// Entry point for the github-core-clone forge.
//
// The lifecycle is the one the make.fun environment expects:
//   1. start the forge on an ephemeral port,
//   2. tell the environment which port it is on,
//   3. wait until the environment says the trial is done,
//   4. exit cleanly.
//
// Nothing here knows about the trial's checks; all behaviour lives in app.ts.

import { createForgeServer } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const REGISTER_ATTEMPTS = 60;
const REGISTER_DELAY_MS = 500;
const DONE_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  // Keep stdout clean for the harness; diagnostics go to stderr.
  process.stderr.write(`[github-core-clone] ${message}\n`);
}

/** POST {port} to the environment's /register, retrying while it warms up. */
async function register(port: number): Promise<boolean> {
  const url = `${ENV_URL.replace(/\/+$/, '')}/register`;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) {
        log(`registered on port ${port}`);
        return true;
      }
      log(`register attempt ${attempt}: HTTP ${response.status}`);
    } catch (error) {
      log(`register attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(REGISTER_DELAY_MS);
  }
  return false;
}

/** Long-poll the environment's /done until it reports the trial finished. */
async function waitForDone(): Promise<void> {
  const url = `${ENV_URL.replace(/\/+$/, '')}/done`;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) {
          log('environment reports done');
          return;
        }
      }
    } catch (error) {
      log(`done poll: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<number> {
  if (ENV_URL === '') {
    log('MAKEFUN_ENV_URL is not set; nothing to register with');
    return 1;
  }
  const server = createForgeServer({ token: SHOP_TOKEN });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('server did not bind a port'));
    });
  });
  log(`forge listening on port ${port}`);
  const registered = await register(port);
  if (!registered) {
    log('could not register with the environment');
    server.close();
    return 1;
  }
  await waitForDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
