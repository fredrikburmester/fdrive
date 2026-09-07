const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const DRAW = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PRESENT = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS = `xmlns:a="${DRAW}" xmlns:r="${REL}" xmlns:p="${PRESENT}"`;
const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const COLORS =
  '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>';

function placeholder(id: number, type: "title" | "body", y: number, height: number): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${type === "title" ? "Title" : "Body"}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${type}" idx="${id - 2}"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="${y}"/><a:ext cx="8229600" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
}
function relationships(entries: readonly (readonly [string, string, string])[]): string {
  return `${XML}<Relationships xmlns="${PKG}">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
}

/** Authored ECMA-376 starter with one editable slide and a complete layout/master/theme graph. */
export function blankPresentationParts(): Readonly<Record<string, string>> {
  const shapes =
    placeholder(2, "title", 274320, 1143000) + placeholder(3, "body", 1600200, 4525963);
  const scheme = [
    ["dk1", "000000"],
    ["lt1", "FFFFFF"],
    ["dk2", "1F2937"],
    ["lt2", "F3F4F6"],
    ["accent1", "2563EB"],
    ["accent2", "DC2626"],
    ["accent3", "16A34A"],
    ["accent4", "7C3AED"],
    ["accent5", "0891B2"],
    ["accent6", "EA580C"],
    ["hlink", "0000FF"],
    ["folHlink", "800080"],
  ]
    .map(([name, color]) => `<a:${name}><a:srgbClr val="${color}"/></a:${name}>`)
    .join("");
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = `<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  const font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>';
  const types = [
    ["/ppt/presentation.xml", "presentationml.presentation.main"],
    ["/ppt/slides/slide1.xml", "presentationml.slide"],
    ["/ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout"],
    ["/ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster"],
    ["/ppt/theme/theme1.xml", "theme"],
  ]
    .map(
      ([name, type]) =>
        `<Override PartName="${name}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`,
    )
    .join("");
  return {
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types}</Types>`,
    "_rels/.rels": relationships([["rId1", "officeDocument", "ppt/presentation.xml"]]),
    "ppt/presentation.xml": `${XML}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": relationships([
      ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
      ["rId2", "slide", "slides/slide1.xml"],
    ]),
    "ppt/slides/slide1.xml": `${XML}<p:sld ${NS}><p:cSld><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    "ppt/slides/_rels/slide1.xml.rels": relationships([
      ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
    ]),
    "ppt/slideLayouts/slideLayout1.xml": `${XML}<p:sldLayout ${NS} type="obj" preserve="1"><p:cSld name="Title and Body"><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships([
      ["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"],
    ]),
    "ppt/slideMasters/slideMaster1.xml": `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld>${COLORS}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3600"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships([
      ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
      ["rId2", "theme", "../theme/theme1.xml"],
    ]),
    "ppt/theme/theme1.xml": `${XML}<a:theme xmlns:a="${DRAW}" name="fdrive"><a:themeElements><a:clrScheme name="fdrive">${scheme}</a:clrScheme><a:fontScheme name="fdrive"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme><a:fmtScheme name="fdrive"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${line.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`,
  };
}
