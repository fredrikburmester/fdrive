import { ZipFile } from "yazl";
import { WopiError } from "./errors.ts";
import { blankPresentationParts } from "./pptx-parts.ts";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types";
const ODF = "urn:oasis:names:tc:opendocument:xmlns";
/** Minimal ECMA-376 and ODF 1.2 packages, authored here without user content. */
export function blankDocumentParts(extension: string): Readonly<Record<string, string>> {
  const ext = extension.toLowerCase();
  if (ext === "pptx") return blankPresentationParts();
  const odf = { odt: "text", ods: "spreadsheet", odp: "presentation" }[ext];
  if (odf) {
    const mime = `application/vnd.oasis.opendocument.${odf}`;
    const content =
      ext === "ods"
        ? '<table:table table:name="Sheet1"><table:table-row><table:table-cell><text:p/></table:table-cell></table:table-row></table:table>'
        : ext === "odp"
          ? '<draw:page draw:name="Slide1"/>'
          : "<text:p/>";
    return {
      mimetype: mime,
      "META-INF/manifest.xml": `${XML}<manifest:manifest xmlns:manifest="${ODF}:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
      "content.xml": `${XML}<office:document-content xmlns:office="${ODF}:office:1.0" xmlns:text="${ODF}:text:1.0" xmlns:table="${ODF}:table:1.0" xmlns:draw="${ODF}:drawing:1.0" office:version="1.2"><office:automatic-styles/><office:body><office:${odf}>${content}</office:${odf}></office:body></office:document-content>`,
    };
  }
  let main: string;
  let content: string;
  let mime: string;
  const extras: Record<string, string> = {};
  const overrides: string[] = [];
  if (ext === "docx") {
    main = "word/document.xml";
    mime = "wordprocessingml.document";
    content =
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr/></w:body></w:document>';
  } else if (ext === "xlsx") {
    main = "xl/workbook.xml";
    mime = "spreadsheetml.sheet";
    content = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    extras["xl/_rels/workbook.xml.rels"] =
      `${XML}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
    extras["xl/worksheets/sheet1.xml"] =
      `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;
    overrides.push(
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    );
  } else throw new WopiError(400);
  return {
    "[Content_Types].xml": `${XML}<Types xmlns="${CONTENT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${mime}.main+xml"/>${overrides.join("")}</Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="${main}"/></Relationships>`,
    [main]: `${XML}${content}`,
    ...extras,
  };
}
export async function blankDocument(extension: string): Promise<Uint8Array> {
  const zip = new ZipFile();
  for (const [name, text] of Object.entries(blankDocumentParts(extension)))
    zip.addBuffer(Buffer.from(text), name, { compress: name !== "mimetype" });
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
