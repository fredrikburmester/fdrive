// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBadge, StatusDot, type StatusTone } from "./status";

afterEach(cleanup);

function dotOf(badge: HTMLElement): HTMLElement | null {
  return badge.querySelector('[data-slot="status-badge-dot"]');
}

describe("StatusBadge", () => {
  it("says a plain fact in a word, with no dot", () => {
    render(<StatusBadge>4 users</StatusBadge>);

    const badge = screen.getByText("4 users");
    expect(badge.getAttribute("data-slot")).toBe("status-badge");
    expect(badge.getAttribute("data-tone")).toBe("neutral");
    expect(dotOf(badge)).toBeNull();
    expect(badge.classList.contains("bg-muted")).toBe(true);
  });

  it("puts a dot ahead of a state's word, which the word alone still says", () => {
    const tones: readonly [Exclude<StatusTone, "neutral">, string][] = [
      ["success", "On"],
      ["warning", "Needs attention"],
      ["danger", "Failed"],
      ["off", "Off"],
    ];
    for (const [tone, word] of tones) {
      render(<StatusBadge tone={tone}>{word}</StatusBadge>);

      const badge = screen.getByText(word);
      expect(badge.getAttribute("data-tone")).toBe(tone);
      const dot = dotOf(badge);
      expect(dot).not.toBeNull();
      // The color only repeats the word, so the dot says nothing to assistive technology.
      expect(dot?.getAttribute("aria-hidden")).toBe("true");
      expect(badge.firstElementChild).toBe(dot);
      expect(badge.textContent).toBe(word);
      cleanup();
    }
  });

  it("colors each tone with its own tokens", () => {
    render(
      <>
        <StatusBadge tone="success">On</StatusBadge>
        <StatusBadge tone="warning">Needs attention</StatusBadge>
        <StatusBadge tone="danger">Failed</StatusBadge>
        <StatusBadge tone="off">Off</StatusBadge>
      </>,
    );

    const on = screen.getByText("On");
    expect(on.classList.contains("bg-success-muted")).toBe(true);
    expect(on.classList.contains("text-success")).toBe(true);
    expect(dotOf(on)?.classList.contains("bg-success-dot")).toBe(true);

    const attention = screen.getByText("Needs attention");
    expect(attention.classList.contains("bg-warning-muted")).toBe(true);
    expect(attention.classList.contains("text-warning")).toBe(true);

    const failed = screen.getByText("Failed");
    expect(failed.classList.contains("bg-destructive-muted")).toBe(true);
    expect(failed.classList.contains("text-destructive")).toBe(true);

    // Off is a hollow dot on the neutral ground: nothing is wrong, it is only not on.
    const off = screen.getByText("Off");
    expect(off.classList.contains("bg-muted")).toBe(true);
    expect(off.classList.contains("text-muted-foreground")).toBe(true);
    expect(dotOf(off)?.classList.contains("border")).toBe(true);
    expect(dotOf(off)?.classList.contains("bg-success-dot")).toBe(false);
  });

  it("lets the caller add or drop the dot", () => {
    render(
      <>
        <StatusBadge dot>Watcher on</StatusBadge>
        <StatusBadge tone="success" dot={false}>
          Verified
        </StatusBadge>
      </>,
    );

    expect(dotOf(screen.getByText("Watcher on"))).not.toBeNull();
    expect(dotOf(screen.getByText("Verified"))).toBeNull();
  });

  it("takes a class and the span's own attributes", () => {
    render(
      <StatusBadge tone="warning" className="ml-2" title="The worker is restarting">
        Preparing
      </StatusBadge>,
    );

    const badge = screen.getByText("Preparing");
    expect(badge.tagName).toBe("SPAN");
    expect(badge.classList.contains("ml-2")).toBe(true);
    expect(badge.getAttribute("title")).toBe("The worker is restarting");
  });
});

describe("StatusDot", () => {
  it("is an image named by the state's word", () => {
    render(
      <>
        <StatusDot tone="success" label="On" />
        <StatusDot tone="off" label="Off" />
      </>,
    );

    const on = screen.getByRole("img", { name: "On" });
    expect(on.getAttribute("data-slot")).toBe("status-dot");
    expect(on.getAttribute("data-tone")).toBe("success");
    expect(on.classList.contains("bg-success-dot")).toBe(true);
    expect(on.textContent).toBe("");

    // Off is hollow, so the two differ by more than a color.
    const off = screen.getByRole("img", { name: "Off" });
    expect(off.getAttribute("data-tone")).toBe("off");
    expect(off.classList.contains("border")).toBe(true);
    expect(off.classList.contains("bg-success-dot")).toBe(false);
  });

  it("has a tone for attention and for failure", () => {
    render(
      <>
        <StatusDot tone="warning" label="Needs attention" />
        <StatusDot tone="danger" label="Failed" />
      </>,
    );

    expect(
      screen.getByRole("img", { name: "Needs attention" }).classList.contains("bg-warning"),
    ).toBe(true);
    expect(screen.getByRole("img", { name: "Failed" }).classList.contains("bg-destructive")).toBe(
      true,
    );
  });

  it("takes a class and the span's own attributes", () => {
    render(<StatusDot tone="success" label="On" className="ml-auto" title="Thumbnails are on" />);

    const dot = screen.getByRole("img", { name: "On" });
    expect(dot.classList.contains("ml-auto")).toBe(true);
    expect(dot.getAttribute("title")).toBe("Thumbnails are on");
  });
});
