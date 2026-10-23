import { describe, expect, it } from 'vitest';
import { pickSessionToEvict } from './sessionEviction';

describe('pickSessionToEvict', () => {
  const noTransfers = () => false;

  it('picks the oldest session when nothing is transferring', () => {
    expect(pickSessionToEvict(['s1', 's2', 's3'], noTransfers)).toBe('s1');
  });

  it('skips sessions with active or paused transfers and evicts the next-oldest idle one', () => {
    const busy = new Set(['s1', 's2']);
    expect(pickSessionToEvict(['s1', 's2', 's3'], id => busy.has(id))).toBe('s3');
  });

  it('returns undefined when every session has transfers（宁可超限也不杀传输）', () => {
    expect(pickSessionToEvict(['s1', 's2'], () => true)).toBeUndefined();
  });

  it('returns undefined for an empty session list', () => {
    expect(pickSessionToEvict([], noTransfers)).toBeUndefined();
  });
});
