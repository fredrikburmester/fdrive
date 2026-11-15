import { expect, it, vi } from "vitest";
import type { MetadataService } from "../metadata/service.js";
import { withDesktopMetadata } from "./metadata.js";

it("updates stable desktop handles with shared metadata mutations", async () => {
  const metadata = {
    onMoved: vi.fn(),
    onDeleted: vi.fn(),
  } as unknown as MetadataService;
  const desktop = { move: vi.fn(), remove: vi.fn() };
  const service = withDesktopMetadata(metadata, desktop);
  const leaf = "/.trash/.fdrive-move-v1/file/p/binned/v/1";
  await service.onMoved("identity", "/before", "/after", true);
  await service.onDeleted("identity", "/gone", false);
  // Into Trash and back out an item keeps its handle; the Mac finds it in its Trash.
  await service.onMoved("identity", "/binned", leaf, false);
  await service.onMoved("identity", leaf, "/restored", false);
  expect(desktop.move.mock.calls).toEqual([
    ["identity", "/before", "/after"],
    ["identity", "/binned", leaf],
    ["identity", leaf, "/restored"],
  ]);
  expect(desktop.remove.mock.calls).toEqual([["identity", "/gone"]]);
  expect(metadata.onMoved).toHaveBeenCalledWith("identity", "/before", "/after", true);
  expect(metadata.onMoved).toHaveBeenCalledWith("identity", "/binned", leaf, false);
  expect(metadata.onDeleted).toHaveBeenCalledWith("identity", "/gone", false);
});
