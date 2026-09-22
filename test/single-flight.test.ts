import { describe, expect, test } from 'bun:test';
import { SingleFlight, type SingleFlightOutcome } from '../src/core/single-flight.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('SingleFlight', () => {
  test('concurrent callers join one leader instead of running the work again', async () => {
    const flight = new SingleFlight<string>();
    let executions = 0;
    const gate = deferred<void>();

    const work = async (): Promise<SingleFlightOutcome<string>> => {
      executions++;
      await gate.promise;
      return { cacheable: true, value: 'body' };
    };

    const leader = flight.lead('k', work);
    const joiners = [flight.join('k'), flight.join('k'), flight.join('k')];
    expect(joiners.every((j) => j !== undefined)).toBe(true);

    gate.resolve();
    const results = await Promise.all([leader, ...(joiners as Promise<SingleFlightOutcome<string>>[])]);

    expect(executions).toBe(1);
    for (const result of results) expect(result).toEqual({ cacheable: true, value: 'body' });
  });

  test('the entry is deleted once the leader settles, so the next caller leads', async () => {
    const flight = new SingleFlight<string>();
    await flight.lead('k', async () => ({ cacheable: true, value: 'a' }));
    expect(flight.size).toBe(0);
    expect(flight.join('k')).toBeUndefined();
  });

  test('the entry is deleted even when the leader throws', async () => {
    const flight = new SingleFlight<string>();
    await expect(
      flight.lead('k', async () => {
        throw new Error('upstream exploded');
      }),
    ).rejects.toThrow('upstream exploded');
    expect(flight.size).toBe(0);
  });

  test('a non-cacheable leader outcome releases joiners to run on their own (REQ-029)', async () => {
    const flight = new SingleFlight<string>();
    const leader = flight.lead('k', async () => ({ cacheable: false }) as SingleFlightOutcome<string>);
    const joined = flight.join('k');
    expect(await leader).toEqual({ cacheable: false });
    expect(await joined).toEqual({ cacheable: false });
  });

  test('different keys do not share a leader', async () => {
    const flight = new SingleFlight<string>();
    const gate = deferred<void>();
    const a = flight.lead('a', async () => {
      await gate.promise;
      return { cacheable: true, value: 'a' };
    });
    expect(flight.join('b')).toBeUndefined();
    gate.resolve();
    await a;
  });
});
