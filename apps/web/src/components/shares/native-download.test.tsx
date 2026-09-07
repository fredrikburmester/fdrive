// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { NativeShareDownload } from "./native-download";

afterEach(() => {
  cleanup();
});

it("renders a labelled link by default", () => {
  render(<NativeShareDownload href="/api/v1/public/shares/1/archive" label="Download ZIP" />);
  const link = screen.getByRole("link", { name: "Download ZIP" });
  expect(link.textContent).toContain("Download ZIP");
  expect(link.getAttribute("href")).toBe("/api/v1/public/shares/1/archive");
});

it("renders a ghost icon button with an sr-only accessible name when `icon` is set", () => {
  render(<NativeShareDownload href="/api/v1/public/shares/1/download?path=%2Fa.png" icon />);
  const link = screen.getByRole("link", { name: "Download" });
  expect(link.getAttribute("href")).toBe("/api/v1/public/shares/1/download?path=%2Fa.png");
  expect(screen.getByText("Download", { selector: "span" }).className).toContain("sr-only");
});

it("uses a custom label as both the icon variant's tooltip text and its accessible name", () => {
  render(<NativeShareDownload href="/api/v1/public/shares/1/archive" label="Download ZIP" icon />);
  expect(screen.getByRole("link", { name: "Download ZIP" })).toBeTruthy();
});
