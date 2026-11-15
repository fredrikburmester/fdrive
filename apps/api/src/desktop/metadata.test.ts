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
  await service.onMoved("identity", "/before", "/after", true);
  await service.onDeleted("identity", "/gone", false);
  // Into Trash, which the Mac never reaches, an item is gone for it: its handle retires.
  await service.onMoved("identity", "/binned", "/.trash/.fdrive-move-v1/file/p/binned/v/1", false);
  expect(desktop.move.mock.calls).toEqual([["identity", "/before", "/after"]]);
  expect(desktop.remove.mock.calls).toEqual([
    ["identity", "/gone"],
    ["identity", "/binned"],
  ]);
  expect(metadata.onMoved).toHaveBeenCalledWith("identity", "/before", "/after", true);
  expect(metadata.onMoved).toHaveBeenCalledWith(
    "identity",
    "/binned",
    "/.trash/.fdrive-move-v1/file/p/binned/v/1",
    false,
  );
  expect(metadata.onDeleted).toHaveBeenCalledWith("identity", "/gone", false);
});
