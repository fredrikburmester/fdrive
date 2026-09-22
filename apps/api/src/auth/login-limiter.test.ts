import { describe, expect, it } from "vitest";
import { createLoginLimiter, DEFAULT_CAPACITY } from "./login-limiter";

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

  it("recordSuccess clears only that key, leaving same-group siblings' history intact", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    const alice = "198.51.100.7|alice";
    const bob = "198.51.100.7|bob";
    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure(alice, "198.51.100.7");
      limiter.recordFailure(bob, "198.51.100.7");
    }

    // A valid login for Alice must not reset Bob's spraying budget for the
    // same address block (docs/AUTH.md: a success clears "that username key's
    // failure history ... never the address key").
    limiter.recordSuccess(alice);
    limiter.recordFailure(bob, "198.51.100.7");
    expect(limiter.check(bob, "198.51.100.7")).toEqual({
      allowed: false,
      retryAfterMs: 60_000,
    });

    // Alice's own history is genuinely gone: four fresh failures stay tracked
    // but do not block her.
    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure(alice, "198.51.100.7");
    }
    expect(limiter.check(alice, "198.51.100.7")).toEqual({ allowed: true });
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

describe("createLoginLimiter capacity", () => {
  it("exposes 10000 as the default capacity", () => {
    expect(DEFAULT_CAPACITY).toBe(10_000);
  });

  it("denies (fails closed) a brand-new key once capacity is reached", () => {
    // Idle (no-failure) keys are swept away as soon as they are checked
    // again, so only keys with at least one recorded failure occupy a
    // capacity slot for any length of time; that is also the shape a real
    // attacker forging ips or usernames would produce.
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({ clock, capacity: 2 });

    limiter.recordFailure("ip1|alice");
    limiter.recordFailure("ip2|bob");
    expect(limiter.check("ip3|carol")).toEqual({ allowed: false });
  });

  it("does not record a failure for a key it could not track at capacity", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({ clock, capacity: 1 });

    limiter.recordFailure("ip1|alice");
    // ip2|bob cannot be tracked: capacity is full and it is a new key.
    limiter.recordFailure("ip2|bob");
    // Once room frees up (a success clears the first key), bob still has no
    // recorded failures because the earlier recordFailure was a no-op.
    limiter.recordSuccess("ip1|alice");
    expect(limiter.check("ip2|bob")).toEqual({ allowed: true });
  });

  it("still tracks an already-known key normally once at capacity", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({ clock, capacity: 1, maxFailures: 2, blockMs: 60_000 });

    limiter.recordFailure("ip1|alice");
    limiter.recordFailure("ip1|alice");

    expect(limiter.check("ip1|alice")).toEqual({ allowed: false, retryAfterMs: 60_000 });
  });

  it("sweeps idle keys on every call, freeing capacity once their state expires", () => {
    const { clock, advance } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      capacity: 1,
      maxFailures: 5,
      windowMs: 1_000,
      blockMs: 1_000,
    });

    limiter.recordFailure("ip1|alice");
    expect(limiter.check("ip2|bob")).toEqual({ allowed: false });

    advance(1_001);
    // ip1|alice's single failure is now outside the window, so the sweep on
    // this call drops its now-idle entry and frees a capacity slot.
    expect(limiter.check("ip2|bob")).toEqual({ allowed: true });
  });
});

describe("createLoginLimiter per-group fan-out", () => {
  const GROUP = "203.0.113.9";
  const OTHER_GROUP = "198.51.100.7";
  const invented = (index: number) => `${GROUP}|sftpgo|ghost-${index}`;

  it("keeps one group's invented keys from filling the map, so another group is still tracked", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      capacity: 10,
      maxKeysPerGroup: 3,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    // One caller cycling usernames: every attempt would otherwise mint a
    // slot of its own and, past `capacity`, fail every other key closed.
    for (let i = 0; i < 100; i += 1) {
      limiter.recordFailure(invented(i), GROUP);
    }

    const victim = `${OTHER_GROUP}|sftpgo|alice`;
    expect(limiter.check(victim, OTHER_GROUP)).toEqual({ allowed: true });
    // ...and it is a real slot, not an unthrottled pass: it still blocks.
    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(victim, OTHER_GROUP);
    }
    expect(limiter.check(victim, OTHER_GROUP)).toEqual({ allowed: false, retryAfterMs: 60_000 });
  });

  it("blocks a key within its group's budget exactly as an ungrouped one", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxKeysPerGroup: 3,
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 60_000,
    });

    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(invented(0), GROUP);
    }

    expect(limiter.check(invented(0), GROUP)).toEqual({ allowed: false, retryAfterMs: 60_000 });
  });

  it("leaves a key over the budget untracked instead of denying it or counting its failures", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({ clock, maxKeysPerGroup: 1, maxFailures: 5 });

    limiter.recordFailure(invented(0), GROUP);
    for (let i = 0; i < 20; i += 1) {
      limiter.recordFailure(invented(1), GROUP);
    }

    // The caller's own per-group bucket (passed ungrouped) is what bounds
    // these attempts; the key itself has no history of its own.
    expect(limiter.check(invented(1), GROUP)).toEqual({ allowed: true });
    // The key that did get a slot is unaffected by the fan-out around it.
    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure(invented(0), GROUP);
    }
    expect(limiter.check(invented(0), GROUP).allowed).toBe(false);
  });

  it("frees a group's budget as its keys expire", () => {
    const { clock, advance } = createClock(0);
    const limiter = createLoginLimiter({
      clock,
      maxKeysPerGroup: 1,
      maxFailures: 5,
      windowMs: 1_000,
      blockMs: 1_000,
    });

    limiter.recordFailure(invented(0), GROUP);
    limiter.recordFailure(invented(1), GROUP);
    advance(1_001);
    // The first key's failure has aged out, so the group has room again.
    limiter.recordFailure(invented(1), GROUP);

    expect(limiter.check(invented(1), GROUP)).toEqual({ allowed: true });
    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure(invented(1), GROUP);
    }
    expect(limiter.check(invented(1), GROUP)).toEqual({ allowed: false, retryAfterMs: 1_000 });
  });

  it("frees a group's budget when a key succeeds", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({ clock, maxKeysPerGroup: 1, maxFailures: 5 });

    limiter.recordFailure(invented(0), GROUP);
    limiter.recordSuccess(invented(0));
    limiter.recordFailure(invented(1), GROUP);

    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure(invented(1), GROUP);
    }
    expect(limiter.check(invented(1), GROUP).allowed).toBe(false);
  });

  it("exempts ungrouped keys from the budget, so per-address and setup buckets stay trackable", () => {
    const { clock } = createClock(0);
    const limiter = createLoginLimiter({ clock, maxKeysPerGroup: 1, maxFailures: 5 });

    limiter.recordFailure(invented(0), GROUP);
    limiter.recordFailure(invented(1), GROUP);
    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(`login-ip|${GROUP}`);
    }
    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(`setup|${GROUP}`);
    }

    expect(limiter.check(`login-ip|${GROUP}`).allowed).toBe(false);
    expect(limiter.check(`setup|${GROUP}`).allowed).toBe(false);
  });
});
