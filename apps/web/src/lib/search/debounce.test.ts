import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncer } from "./debounce";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createDebouncer", () => {
  it("calls fn once after the delay", () => {
    const fn = vi.fn();
    const debounced = createDebouncer(fn, 150);

    debounced.run("hello");
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledExactlyOnceWith("hello");
  });

  it("resets the timer on a second call within the delay", () => {
    const fn = vi.fn();
    const debounced = createDebouncer(fn, 150);

    debounced.run("h");
    vi.advanceTimersByTime(100);
    debounced.run("he");
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledExactlyOnceWith("he");
  });

  it("does not call fn after cancel", () => {
    const fn = vi.fn();
    const debounced = createDebouncer(fn, 150);

    debounced.run("hello");
    debounced.cancel();
    vi.advanceTimersByTime(150);

    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel is a no-op when nothing is scheduled", () => {
    const fn = vi.fn();
    const debounced = createDebouncer(fn, 150);

    expect(() => debounced.cancel()).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("allows scheduling again after firing", () => {
    const fn = vi.fn();
    const debounced = createDebouncer(fn, 150);

    debounced.run("a");
    vi.advanceTimersByTime(150);
    debounced.run("b");
    vi.advanceTimersByTime(150);

    expect(fn).toHaveBeenNthCalledWith(1, "a");
    expect(fn).toHaveBeenNthCalledWith(2, "b");
  });
});
