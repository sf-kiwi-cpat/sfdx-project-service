import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WriteLock } from './lock.js';

describe('WriteLock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquire returns lock ID when lock is free', () => {
    const lock = new WriteLock(10_000);
    const id = lock.acquire();
    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
    expect(id!.length).toBeGreaterThan(0);
  });

  it('acquire returns null when lock is already held', () => {
    const lock = new WriteLock(10_000);
    const id1 = lock.acquire();
    const id2 = lock.acquire();
    expect(id1).toBeDefined();
    expect(id2).toBeNull();
  });

  it('isHeld returns true when lock is held', () => {
    const lock = new WriteLock(10_000);
    lock.acquire();
    expect(lock.isHeld()).toBe(true);
  });

  it('isHeld returns false when lock is released', () => {
    const lock = new WriteLock(10_000);
    const id = lock.acquire()!;
    lock.release(id);
    expect(lock.isHeld()).toBe(false);
  });

  it('renew resets TTL when lock ID matches', () => {
    const lock = new WriteLock(10_000);
    const id = lock.acquire()!;
    vi.advanceTimersByTime(5_000);
    const renewed = lock.renew(id);
    expect(renewed).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(lock.isHeld()).toBe(true);
  });

  it('renew returns false when lock ID does not match', () => {
    const lock = new WriteLock(10_000);
    lock.acquire();
    const renewed = lock.renew('wrong-id');
    expect(renewed).toBe(false);
  });

  it('release returns true when lock ID matches', () => {
    const lock = new WriteLock(10_000);
    const id = lock.acquire()!;
    expect(lock.release(id)).toBe(true);
  });

  it('release returns false when lock ID does not match', () => {
    const lock = new WriteLock(10_000);
    lock.acquire();
    expect(lock.release('wrong-id')).toBe(false);
  });

  it('lock auto-expires after TTL', () => {
    const lock = new WriteLock(1_000);
    lock.acquire();
    expect(lock.isHeld()).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(lock.isHeld()).toBe(false);
  });

  it('getLockId returns lock ID when held', () => {
    const lock = new WriteLock(10_000);
    const id = lock.acquire()!;
    expect(lock.getLockId()).toBe(id);
  });

  it('getLockId returns null when not held', () => {
    const lock = new WriteLock(10_000);
    expect(lock.getLockId()).toBeNull();
  });

  it('isHeld returns false via inline expiry when Date.now() >= expiresAt', () => {
    const lock = new WriteLock(5_000);
    lock.acquire();
    expect(lock.isHeld()).toBe(true);

    // Advance Date.now() past expiry WITHOUT firing timer callbacks
    vi.setSystemTime(Date.now() + 6_000);

    expect(lock.isHeld()).toBe(false);
  });

  it('renew returns false when no lock is held', () => {
    const lock = new WriteLock(10_000);
    expect(lock.renew('any-id')).toBe(false);
  });
});
