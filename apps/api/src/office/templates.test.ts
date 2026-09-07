import { XMLValidator } from "fast-xml-parser";
import { expect, it } from "vitest";
import { blankDocument, blankDocumentParts } from "./templates.ts";

it.each(["docx", "xlsx", "pptx", "odt", "ods", "odp"])(
  "builds valid XML ZIP parts for %s",
  async (ext) => {
    const parts = blankDocumentParts(ext);
    for (const [name, content] of Object.entries(parts))
      if (name !== "mimetype") expect(XMLValidator.validate(content)).toBe(true);
    const bytes = await blankDocument(ext);
    expect(Buffer.from(bytes).subarray(0, 2).toString()).toBe("PK");
    expect(bytes.length).toBeGreaterThan(200);
    if (ext.startsWith("od")) expect(Object.keys(parts)[0]).toBe("mimetype");
  },
);
it("rejects unsupported templates", () => expect(() => blankDocumentParts("exe")).toThrow());
