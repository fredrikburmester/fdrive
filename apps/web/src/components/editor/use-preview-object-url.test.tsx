// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewObjectUrl } from "./use-preview-object-url";

const DELAY_MS = 400;

/**
 * jsdom implements neither `URL.createObjectURL` nor `URL.revokeObjectURL`,
 * so the pairing has to be observed through stubs: `live` is the set of URLs
 * the browser would still resolve, and `doubleRevoked` records revocations of
 * a URL that was already released (a real browser ignores those silently).
 */
interface ObjectUrlLedger {
  readonly created: string[];
  readonly revoked: string[];
  readonly doubleRevoked: string[];
  readonly live: Set<string>;
  readonly blobs: Map<string, Blob>;
}

let ledger: ObjectUrlLedger;

function installObjectUrlStubs(): ObjectUrlLedger {
  const next: ObjectUrlLedger = {
    created: [],
    revoked: [],
    doubleRevoked: [],
    live: new Set<string>(),
    blobs: new Map<string, Blob>(),
  };
  const create = vi.fn((source: Blob) => {
    const url = `blob:preview/${next.created.length + 1}`;
    next.created.push(url);
    next.live.add(url);
    next.blobs.set(url, source);
    return url;
  });
  const revoke = vi.fn((url: string) => {
    if (!next.live.delete(url)) {
      next.doubleRevoked.push(url);
    }
    next.revoked.push(url);
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  return next;
}

function Preview({ text }: { readonly text: string }) {
  const url = usePreviewObjectUrl(text, DELAY_MS);
  return <span data-testid="preview-url">{url}</span>;
}

function previewUrl(): string {
  return screen.getByTestId("preview-url").textContent ?? "";
}

function strict(text: string) {
  return (
    <StrictMode>
      <Preview text={text} />
    </StrictMode>
  );
}

/** Every URL the hook ever minted is released exactly once, and none leak. */
function expectBalancedLedger(): void {
  expect(ledger.doubleRevoked).toEqual([]);
  expect([...ledger.revoked].sort()).toEqual([...ledger.created].sort());
  expect([...ledger.live]).toEqual([]);
}

beforeEach(() => {
  ledger = installObjectUrlStubs();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePreviewObjectUrl", () => {
  it("mints one live object URL for the initial text", async () => {
    render(<Preview text="# hello" />);

    expect(ledger.created).toHaveLength(1);
    const url = previewUrl();
    expect(url).toBe(ledger.created[0]);
    expect(ledger.live.has(url)).toBe(true);
    await expect(ledger.blobs.get(url)?.text()).resolves.toBe("# hello");
  });

  it("hands back a live object URL after a Strict Mode remount", () => {
    // Strict Mode runs setup -> cleanup -> setup in development, so a URL
    // that is revoked by a cleanup must be replaced before it is rendered:
    // the preview pane cannot load a revoked blob URL.
    const view = render(strict("# hello"));

    const url = previewUrl();
    expect(url).not.toBe("");
    expect(ledger.live.has(url)).toBe(true);
    expect([...ledger.live]).toEqual([url]);
    expect(ledger.doubleRevoked).toEqual([]);

    view.unmount();
    expectBalancedLedger();
  });

  it("keeps the URL until the debounce elapses, then swaps it for the new text", async () => {
    vi.useFakeTimers();
    const view = render(<Preview text="one" />);
    const first = previewUrl();

    view.rerender(<Preview text="two" />);
    act(() => {
      vi.advanceTimersByTime(DELAY_MS - 1);
    });
    expect(previewUrl()).toBe(first);
    expect(ledger.created).toEqual([first]);
    expect(ledger.revoked).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const second = previewUrl();
    expect(second).not.toBe(first);
    expect(ledger.revoked).toEqual([first]);
    expect([...ledger.live]).toEqual([second]);
    await expect(ledger.blobs.get(second)?.text()).resolves.toBe("two");

    view.unmount();
    expect(ledger.revoked).toEqual([first, second]);
    expectBalancedLedger();
  });

  it("does not mint a second URL while the text is unchanged", () => {
    vi.useFakeTimers();
    const view = render(<Preview text="one" />);
    const url = previewUrl();

    view.rerender(<Preview text="one" />);
    act(() => {
      vi.advanceTimersByTime(DELAY_MS * 3);
    });

    expect(ledger.created).toEqual([url]);
    expect(ledger.revoked).toEqual([]);
    expect(previewUrl()).toBe(url);
  });

  it("releases the URL of an edit that is undone inside the debounce window", () => {
    vi.useFakeTimers();
    const view = render(<Preview text="one" />);
    const first = previewUrl();

    view.rerender(<Preview text="one!" />);
    act(() => {
      vi.advanceTimersByTime(DELAY_MS);
    });
    const second = previewUrl();
    expect(second).not.toBe(first);

    view.rerender(<Preview text="one" />);
    act(() => {
      vi.advanceTimersByTime(DELAY_MS);
    });

    expect([...ledger.live]).toEqual([previewUrl()]);
    view.unmount();
    expectBalancedLedger();
  });

  it("revokes exactly once on unmount", () => {
    const view = render(<Preview text="# hello" />);
    const url = previewUrl();

    view.unmount();

    expect(ledger.revoked).toEqual([url]);
    expect(ledger.doubleRevoked).toEqual([]);
    expect([...ledger.live]).toEqual([]);
  });

  it("leaks nothing across a Strict Mode text change and unmount", () => {
    vi.useFakeTimers();
    const view = render(strict("one"));

    view.rerender(strict("two"));
    act(() => {
      vi.advanceTimersByTime(DELAY_MS);
    });

    const url = previewUrl();
    expect(ledger.live.has(url)).toBe(true);
    expect([...ledger.live]).toEqual([url]);
    expect(ledger.doubleRevoked).toEqual([]);

    view.unmount();
    expectBalancedLedger();
  });
});
