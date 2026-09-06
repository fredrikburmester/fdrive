/**
 * A minimal, hand-built single-page PDF encoder for dev seed data. Not a
 * general-purpose PDF writer: fixed to one line of Helvetica text on an
 * otherwise blank small page, just enough for a PDF preview viewer to have
 * something real to render. The cross-reference table's byte offsets are
 * computed from the actual encoded bytes, so the file is valid PDF.
 */

const PDF_HEADER = "%PDF-1.4\n";

/** Escapes the characters PDF literal strings require backslashes before. */
export function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Encodes a minimal one-page PDF showing `text` in Helvetica. Pure: the
 * same `text` always produces the same bytes. `text` should be plain ASCII;
 * this is a fixed-purpose encoder, not a general PDF text layout engine.
 */
export function encodeMinimalPdf(text: string): Buffer {
  const content = `BT /F1 16 Tf 24 160 Td (${escapePdfText(text)}) Tj ET`;
  const objectBodies: readonly string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let body = PDF_HEADER;
  // Index 0 is the free-list head SFTPGo/PDF readers expect at object 0;
  // it has no real offset, so it is left as 0 and never written into `body`.
  const offsetByObjectId: number[] = [0];

  objectBodies.forEach((objectBody, index) => {
    const objectId = index + 1;
    offsetByObjectId.push(Buffer.byteLength(body, "latin1"));
    body += `${objectId} 0 obj\n${objectBody}\nendobj\n`;
  });

  const entryCount = objectBodies.length + 1;
  const xrefOffset = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${entryCount}\n0000000000 65535 f \n`;
  for (let objectId = 1; objectId < entryCount; objectId += 1) {
    const offset = offsetByObjectId[objectId] ?? 0;
    xref += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size ${entryCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(body + xref + trailer, "latin1");
}
