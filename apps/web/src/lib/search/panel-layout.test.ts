import { expect, it } from "vitest";
import { searchPanelLayout } from "./panel-layout";

it("returns mobile when useIsMobile reports true", () => {
  expect(searchPanelLayout(true)).toBe("mobile");
});

it("returns desktop when useIsMobile reports false", () => {
  expect(searchPanelLayout(false)).toBe("desktop");
});
