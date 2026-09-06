import { describe, expect, it } from "vitest";
import { skeletonKindFor } from "./skeleton.ts";

describe("skeletonKindFor", () => {
  it("treats plain text extensions as lines", () => {
    expect(skeletonKindFor("/notes.txt")).toBe("lines");
  });

  it("treats markdown extensions as lines", () => {
    expect(skeletonKindFor("/README.md")).toBe("lines");
  });

  it("treats code extensions as lines, including the .ts/video collision", () => {
    // `.ts` collides with the MPEG transport stream video mime type, but
    // the extension-first rule in `previewKindFor` (and so here) must keep
    // it in the code/lines bucket, not the video/media one.
    expect(skeletonKindFor("/index.ts")).toBe("lines");
    expect(skeletonKindFor("/main.py")).toBe("lines");
  });

  it("treats image extensions as media", () => {
    expect(skeletonKindFor("/photo.png")).toBe("media");
    expect(skeletonKindFor("/photo.JPG")).toBe("media");
  });

  it("treats video extensions as media", () => {
    expect(skeletonKindFor("/clip.mp4")).toBe("media");
  });

  it("treats pdf extensions as a page", () => {
    expect(skeletonKindFor("/report.pdf")).toBe("page");
  });

  it("treats audio extensions as audio", () => {
    expect(skeletonKindFor("/song.mp3")).toBe("audio");
  });

  it("treats unknown, office, and archive extensions as a card", () => {
    expect(skeletonKindFor("/spreadsheet.xlsx")).toBe("card");
    expect(skeletonKindFor("/archive.zip")).toBe("card");
    expect(skeletonKindFor("/binary.bin")).toBe("card");
    expect(skeletonKindFor("/no-extension")).toBe("card");
  });
});
