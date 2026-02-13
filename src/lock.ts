import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 60_000; // 1 minute - covers a single agent action

export interface LockState {
  lockId: string;
  expiresAt: number;
}

export class WriteLock {
  private state: LockState | null = null;
  private ttlMs: number;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Acquire the write lock. Returns lock ID if successful.
   * If already held, returns null.
   */
  acquire(): string | null {
    if (this.state) {
      return null;
    }
    const lockId = randomUUID();
    this.state = {
      lockId,
      expiresAt: Date.now() + this.ttlMs,
    };
    this.scheduleExpiry();
    return lockId;
  }

  /**
   * Renew the lock (reset TTL). Returns true if renewed, false if lock not held or ID mismatch.
   */
  renew(lockId: string): boolean {
    if (!this.state || this.state.lockId !== lockId) {
      return false;
    }
    this.state.expiresAt = Date.now() + this.ttlMs;
    this.scheduleExpiry();
    return true;
  }

  /**
   * Release the lock. Returns true if released, false if not held or ID mismatch.
   */
  release(lockId: string): boolean {
    if (!this.state || this.state.lockId !== lockId) {
      return false;
    }
    this.clearTimer();
    this.state = null;
    return true;
  }

  /**
   * Check if the lock is currently held.
   */
  isHeld(): boolean {
    if (!this.state) return false;
    if (Date.now() >= this.state.expiresAt) {
      this.state = null;
      this.clearTimer();
      return false;
    }
    return true;
  }

  /**
   * Get current lock ID if held, null otherwise.
   */
  getLockId(): string | null {
    if (!this.isHeld()) return null;
    return this.state!.lockId;
  }

  private scheduleExpiry(): void {
    this.clearTimer();
    const remaining = this.state!.expiresAt - Date.now();
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = null;
      this.state = null;
    }, Math.max(0, remaining));
  }

  private clearTimer(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
  }
}
