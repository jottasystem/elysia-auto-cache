import { execFileSync } from 'node:child_process';

let cached: boolean | undefined;

/**
 * Bounded probe. The timeout is not paranoia: on 2026-09-03 a bare `docker info`
 * hung a process for 332 minutes, so this never runs unbounded.
 */
export function dockerAvailable(): boolean {
  if (cached !== undefined) return cached;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}

/**
 * `REQUIRE_DOCKER=1` (or `REQUIRE_REDIS=1`, the name already used elsewhere in the
 * org) turns "skip because there is no Docker" into a failure.
 *
 * Skipping by default is deliberate: a suite that is red on every machine without
 * Docker trains everyone to ignore red. In CI, where the container is part of the
 * job, skipping would be the green-by-absence this flag exists to kill.
 */
export function dockerRequired(): boolean {
  return process.env.REQUIRE_DOCKER === '1' || process.env.REQUIRE_REDIS === '1';
}

/** True when the integration suite should run at all. */
export function canRunIntegration(): boolean {
  return dockerAvailable() || dockerRequired();
}

/** Call inside `beforeAll` so a required-but-missing Docker fails loudly. */
export function assertDockerWhenRequired(): void {
  if (dockerRequired() && !dockerAvailable()) {
    throw new Error(
      'REQUIRE_DOCKER/REQUIRE_REDIS is set but Docker is not reachable — refusing to report green by absence.',
    );
  }
}
