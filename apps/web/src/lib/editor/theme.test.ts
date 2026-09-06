import { describe, expect, it } from "vitest";
import { editorThemeSpec } from "./theme";

describe("editorThemeSpec", () => {
  const spec = editorThemeSpec();

  it("themes the root element from background and foreground tokens", () => {
    expect(spec["&"]).toMatchObject({
      color: "var(--foreground)",
      backgroundColor: "var(--background)",
    });
  });

  it("themes the gutters from the muted and border tokens", () => {
    expect(spec[".cm-gutters"]).toMatchObject({
      color: "var(--muted-foreground)",
      borderRight: "1px solid var(--border)",
    });
  });

  it("themes the active line from the muted token", () => {
    expect(spec[".cm-activeLine"]).toEqual({ backgroundColor: "var(--muted)" });
    expect(spec[".cm-activeLineGutter"]).toEqual({ backgroundColor: "var(--muted)" });
  });

  it("uses the shared monospace stack everywhere text is rendered", () => {
    expect(spec["&"]?.fontFamily).toContain("monospace");
    expect(spec[".cm-content"]?.fontFamily).toContain("monospace");
  });
});
