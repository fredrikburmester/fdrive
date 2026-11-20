// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setListDesign } from "@/lib/files/use-list-design";
import { FileIcon } from "./file-icon";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function iconClass(container: HTMLElement) {
  return container.querySelector("svg")?.getAttribute("class") ?? "";
}

it("stays muted in the classic list and takes its kind's color in the beta", () => {
  const folder = render(<FileIcon kind="dir" ext="" mime={null} />);
  const pdf = render(<FileIcon kind="file" ext=".pdf" mime="application/pdf" />);
  expect(iconClass(folder.container)).toContain("text-muted-foreground");
  expect(iconClass(pdf.container)).toContain("text-muted-foreground");

  act(() => setListDesign("beta"));
  expect(iconClass(folder.container)).toContain("text-ring");
  expect(iconClass(pdf.container)).toContain("text-tag-red");
  expect(pdf.container.querySelector("svg")?.getAttribute("data-icon-kind")).toBe("pdf");
});

it("keeps the classic list's shapes for text, PDFs and documents", () => {
  const shape = (ext: string) =>
    render(<FileIcon kind="file" ext={ext} mime={null} />).container.querySelector("svg")
      ?.classList;
  expect(shape(".txt")?.contains("lucide-file-text")).toBe(true);
  expect(shape(".pdf")?.contains("lucide-file")).toBe(true);
  act(() => setListDesign("beta"));
  expect(shape(".md")?.contains("lucide-text-align-start")).toBe(true);
});

it("lets a caller's class win, as the sidebar's muted favorites do", () => {
  act(() => setListDesign("beta"));
  const { container } = render(
    <FileIcon kind="dir" ext="" mime={null} className="text-muted-foreground" />,
  );
  expect(iconClass(container)).toContain("text-muted-foreground");
  expect(iconClass(container)).not.toContain("text-ring");
});

it("keeps lucide's line weight unless a caller asks for a lighter one", () => {
  const plain = render(<FileIcon kind="dir" ext="" mime={null} />);
  expect(plain.container.querySelector("svg")?.getAttribute("stroke-width")).toBe("2");
  const light = render(<FileIcon kind="dir" ext="" mime={null} strokeWidth={1.5} />);
  expect(light.container.querySelector("svg")?.getAttribute("stroke-width")).toBe("1.5");
});
