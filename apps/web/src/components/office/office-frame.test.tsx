// @vitest-environment jsdom
import type { OfficeOpenResponse } from "@fdrive/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficeFrame } from "./office-frame";

const descriptor: OfficeOpenResponse = {
  fileId: "file",
  identityId: "identity",
  path: "/file.docx",
  mode: "view",
  actionUrl: "https://editor.test/edit?WOPISrc=http%3A%2F%2Fapi.test",
  editorOrigin: "https://editor.test",
  formFields: { access_token: "unit-test-token", access_token_ttl: "100" },
  expiresAt: "2099-01-01T00:00:00.000Z",
};
beforeEach(() => {
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function send(data: unknown, source: Window | null, origin = descriptor.editorOrigin) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
  });
}
describe("office frame", () => {
  it("posts hidden fields once under Strict Mode into a unique sandboxed target", () => {
    const { container, rerender } = render(
      <StrictMode>
        <OfficeFrame descriptor={descriptor} onMessage={vi.fn()} onRetry={vi.fn()} />
      </StrictMode>,
    );
    const frame = screen.getByTitle("Office document");
    const form = container.querySelector("form");
    expect(form?.target).toBe(frame.getAttribute("name"));
    expect(form?.method).toBe("post");
    expect(form?.hidden).toBe(true);
    expect(
      form?.querySelector<HTMLInputElement>('input[name="access_token"]')?.value ===
        descriptor.formFields.access_token,
    ).toBe(true);
    expect(form?.querySelector('input[name="access_token"]')?.getAttribute("type")).toBe("hidden");
    expect(
      container.textContent?.includes(descriptor.formFields.access_token ?? "unit-test-token"),
    ).toBe(false);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("sandbox")).toContain("allow-forms");
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1);
    rerender(
      <StrictMode>
        <OfficeFrame descriptor={{ ...descriptor }} onMessage={vi.fn()} onRetry={vi.fn()} />
      </StrictMode>,
    );
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(2);
  });
  it("authenticates messages, announces host readiness, and removes listeners", () => {
    const message = vi.fn();
    const { unmount } = render(
      <OfficeFrame descriptor={descriptor} onMessage={message} onRetry={vi.fn()} />,
    );
    const frame = screen.getByTitle<HTMLIFrameElement>("Office document");
    const child = frame.contentWindow;
    if (child === null) throw new Error("Missing iframe window");
    const post = vi.spyOn(child, "postMessage");
    fireEvent.load(frame);
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("Host_PostmessageReady"),
      descriptor.editorOrigin,
    );
    send({ MessageId: "UI_Close" }, child, "https://evil.test");
    send({ MessageId: "UI_Close" }, window);
    expect(message).not.toHaveBeenCalled();
    send({ MessageId: "App_LoadingStatus", Values: { Status: "Frame_Ready" } }, child);
    expect(screen.getByRole("status").textContent).toContain("Opening");
    send({ MessageId: "App_LoadingStatus", Values: { Status: "Document_Loaded" } }, child);
    expect(screen.queryByRole("status")).toBeNull();
    expect(message).toHaveBeenCalledTimes(2);
    unmount();
    send({ MessageId: "UI_Close" }, child);
    expect(message).toHaveBeenCalledTimes(2);
  });
  it("offers recovery for failed and unresponsive editors without claiming a save", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    render(<OfficeFrame descriptor={descriptor} onMessage={vi.fn()} onRetry={retry} />);
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(screen.getByRole("status").textContent).toContain("has not responded");
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(retry).toHaveBeenCalledOnce();
    const frame = screen.getByTitle<HTMLIFrameElement>("Office document");
    send({ MessageId: "App_LoadingStatus", Values: { Status: "Failed" } }, frame.contentWindow);
    expect(screen.getByRole("status").textContent).toContain("could not open");
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
