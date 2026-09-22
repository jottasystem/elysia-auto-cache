import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

export const VALKEY_IMAGE = process.env.VALKEY_IMAGE || 'valkey/valkey:9.1';

export type ValkeyContainer = {
  name: string;
  host: string;
  port: number;
  url: string;
  stop: () => void;
  /** Pause the container's process — the cheapest way to make Redis "go down" mid-test. */
  pause: () => void;
  unpause: () => void;
  cli: (...args: string[]) => string;
};

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${what}${detail}`);
}

/**
 * A disposable standalone Valkey on a free loopback port.
 *
 * Standalone, not the single-node cluster the sibling library boots: the consumer
 * connects with `new Redis(endpoint)`, so standalone is the topology this code
 * actually runs against. Cluster-slot colocation is asserted separately, from the
 * key format, which is where that guarantee actually lives.
 */
export async function startValkey(): Promise<ValkeyContainer> {
  const port = await freePort();
  const name = `elysia-auto-cache-valkey-${port}`;

  docker('run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:6379`, VALKEY_IMAGE);

  const cli = (...args: string[]) =>
    execFileSync('docker', ['exec', name, 'valkey-cli', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();

  await waitFor(() => cli('PING') === 'PONG', 30_000, `valkey ${name} to answer PING`);

  return {
    name,
    host: '127.0.0.1',
    port,
    url: `redis://127.0.0.1:${port}`,
    cli,
    pause: () => docker('pause', name),
    unpause: () => docker('unpause', name),
    stop: () => {
      try {
        docker('rm', '-f', name);
      } catch {
        // already gone
      }
    },
  };
}
