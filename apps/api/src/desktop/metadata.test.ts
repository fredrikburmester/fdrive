import { expect, it, vi } from "vitest";
import type { MetadataService } from "../metadata/service.js";
import { withDesktopMetadata } from "./metadata.js";

it("updates stable desktop handles with shared metadata mutations", async () => {
  const metadata = {
    onMoved: vi.fn(),
    onDeleted: vi.fn(),
    onTrashed: vi.fn(),
  } as unknown as MetadataService;
  const desktop = { move: vi.fn(), remove: vi.fn() };
  const service = withDesktopMetadata(metadata, desktop);
  await service.onMoved("identity", "/before", "/after", true);
  await service.onDeleted("identity", "/gone", false);
  await service.onTrashed("identity", "/trash", false);
  expect(desktop.move).toHaveBeenCalledWith("identity", "/before", "/after");
  expect(desktop.remove.mock.calls).toEqual([
    ["identity", "/gone"],
    ["identity", "/trash"],
  ]);
  expect(metadata.onMoved).toHaveBeenCalledWith("identity", "/before", "/after", true);
  expect(metadata.onDeleted).toHaveBeenCalledWith("identity", "/gone", false);
  expect(metadata.onTrashed).toHaveBeenCalledWith("identity", "/trash", false);
});
