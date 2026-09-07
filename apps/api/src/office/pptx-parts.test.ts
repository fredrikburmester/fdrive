import { posix } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { expect, it } from "vitest";
import { blankPresentationParts } from "./pptx-parts.ts";

it("creates one editable title/body slide with resolvable package relationships and content types", () => {
  const parts = blankPresentationParts();
  const parser = new XMLParser({
    ignoreAttributes: false,
    isArray: (name) => name === "Relationship" || name === "Override",
  });
  expect(Object.keys(parts).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toEqual([
    "ppt/slides/slide1.xml",
  ]);
  expect(parts["ppt/slides/slide1.xml"]).toContain('type="title"');
  expect(parts["ppt/slides/slide1.xml"]).toContain('type="body"');
  expect(parts["ppt/slides/slide1.xml"]).not.toContain("<a:t>");
  const contentTypes = parser.parse(parts["[Content_Types].xml"] ?? "") as {
    Types: { Override: { "@_PartName": string; "@_ContentType": string }[] };
  };
  for (const [name, xml] of Object.entries(parts)) {
    expect(XMLValidator.validate(xml), name).toBe(true);
    if (name.endsWith(".rels")) {
      const relationships = parser.parse(xml) as {
        Relationships: {
          Relationship: {
            "@_Id": string;
            "@_Target": string;
            "@_Type": string;
            "@_TargetMode"?: string;
          }[];
        };
      };
      const ids = relationships.Relationships.Relationship.map((item) => item["@_Id"]);
      expect(new Set(ids).size).toBe(ids.length);
      for (const item of relationships.Relationships.Relationship) {
        expect(item["@_TargetMode"]).toBeUndefined();
        const target = posix.normalize(
          posix.join(posix.dirname(posix.dirname(name)), item["@_Target"]),
        );
        expect(parts[target], `${name} -> ${target}`).toBeDefined();
        expect(item["@_Type"]).toMatch(
          /^http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships\//,
        );
      }
    } else if (name !== "[Content_Types].xml") {
      const type = contentTypes.Types.Override.find((item) => item["@_PartName"] === `/${name}`);
      expect(type?.["@_ContentType"], name).toMatch(
        /^application\/vnd.openxmlformats-officedocument\./,
      );
      const refs = [...xml.matchAll(/r:id="([^"]+)"/g)].map((match) => match[1]);
      if (refs.length) {
        const relsName = posix.join(posix.dirname(name), "_rels", `${posix.basename(name)}.rels`);
        for (const ref of refs) expect(parts[relsName], relsName).toContain(`Id="${ref}"`);
      }
    }
  }
  expect(contentTypes.Types.Override).toHaveLength(5);
});
