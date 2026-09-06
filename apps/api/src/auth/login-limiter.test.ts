import { describe, expect, it } from "vitest";
import { createLoginLimiter } from "./login-limiter";

function createClock(startMs: number) {
  let now = startMs;
  return {
    clock: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

const KEY = "127.0.0.1|alice";

describe("createLoginLimiter", () => {
  it("allows a key with no history", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    expect(limiter.check(KEY)).toEqual({ allowed: true });
  });

  it("stays allowed after fewer than maxFailures failures", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure(KEY);
    }

    expect(limiter.check(KEY)).toEqual({ allowed: true });
  });

  it("blocks after reaching maxFailures within the window", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(KEY);
    }

    const result = limiter.check(KEY);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(60_000);
  });

  it("unblocks once blockMs has elapsed", () => {
    const { clock, advance } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(KEY);
    }
    advance(60_001);

    expect(limiter.check(KEY)).toEqual({ allowed: true });
  });

  it("returns a smaller retryAfterMs as the block window elapses", () => {
    const { clock, advance } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(KEY);
    }
    advance(30_000);

    const result = limiter.check(KEY);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(30_000);
  });

  it("drops failures older than the window so they do not count toward the block", () => {
    const { clock, advance } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure(KEY);
    }
    advance(60_001);
    limiter.recordFailure(KEY);

    expect(limiter.check(KEY)).toEqual({ allowed: true });
  });

  it("recordSuccess clears failure history", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure(KEY);
    }
    limiter.recordSuccess(KEY);
    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure(KEY);
    }

    expect(limiter.check(KEY)).toEqual({ allowed: true });
  });

  it("recordSuccess clears an active block", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(KEY);
    }
    limiter.recordSuccess(KEY);

    expect(limiter.check(KEY)).toEqual({ allowed: true });
  });

  it("tracks separate keys independently", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(KEY);
    }

    expect(limiter.check("127.0.0.1|bob")).toEqual({ allowed: true });
  });

  it("uses the default policy (5 failures, 60s window and block) when none is given", () => {
    const { clock, advance } = createClock(0);
    const limiter = createLoginLimiter({ clock });

    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure(KEY);
    }
    expect(limiter.check(KEY)).toEqual({ allowed: true });

    limiter.recordFailure(KEY);
    expect(limiter.check(KEY)).toEqual({ allowed: false, retryAfterMs: 60_000 });

    advance(60_001);
    expect(limiter.check(KEY)).toEqual({ allowed: true });
  });

  it("recordFailure on an already-blocked key keeps it blocked without resetting the window early", () => {
    const { clock, advance } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(KEY);
    }
    advance(1_000);
    limiter.recordFailure(KEY);

    expect(limiter.check(KEY).allowed).toBe(false);
  });
});
