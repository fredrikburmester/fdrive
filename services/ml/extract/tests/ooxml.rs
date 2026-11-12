//! Office Open XML documents built member by member.

mod common;

use common::{CONTENT_TYPES, rels, run, text, zip};
use fdrive_ml_extract::{ExtractError, Format};

const DOCUMENT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
<w:body>
<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>R&#228;ksm&#246;rg&#229;s &amp; kaffe</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Left</w:t><w:tab/><w:t>Right</w:t><w:br/><w:t>Next line</w:t><w:noBreakHyphen/><w:t>joined</w:t></w:r></w:p>
<w:p><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:r><w:instrText>HYPERLINK "x"</w:instrText></w:r><w:r><w:t>kept</w:t></w:r></w:p>
<w:tbl><w:tblPr><w:tblStyle w:val="x"/></w:tblPr>
<w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p/></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p><w:p><w:r><w:t>B2 more</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:t>boxed once</w:t></mc:Choice><mc:Fallback><w:t>boxed twice</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>
<w:sectPr><w:footerReference w:type="default"/></w:sectPr>
</w:body></w:document>"#;

/// A chart: a title in drawing text, cached category labels, and cached numbers.
const CHART: &str = r#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>
<c:title><c:tx><c:rich><a:p><a:r><a:t>Int&#228;kt per region</a:t></a:r></a:p></c:rich></c:tx></c:title>
<c:plotArea><c:barChart><c:ser><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Norr</c:v></c:pt><c:pt idx="1"><c:v>S&#246;der</c:v></c:pt></c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:pt idx="0"><c:v>420</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>"#;

fn part(body: &str) -> Vec<u8> {
    format!(r#"<w:x xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>{body}</w:t></w:r></w:p></w:x>"#)
        .into_bytes()
}

#[test]
fn docx_reads_text_tables_and_the_parts_around_the_body() {
    let bytes = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", &rels(&[("rId1", "officeDocument", "word/document.xml")])),
        ("word/document.xml", DOCUMENT.as_bytes()),
        ("word/styles.xml", &part("not text")),
        ("word/footnotes.xml", &part("A footnote")),
        ("word/header1.xml", &part("Page header")),
        ("word/comments.xml", &part("A comment")),
        ("word/media/header.png", b"not xml"),
        ("word/charts/chart1.xml", CHART.as_bytes()),
        ("word/charts/chart2.xml", b"<c:chartSpace><c:broken"),
    ]);
    let extracted = run(&bytes).unwrap();
    assert_eq!(extracted.format, Format::Docx);
    assert_eq!(
        extracted.text,
        "Räksmörgås & kaffe\nLeft\tRight\nNext line-joined\nkept\nA1\tB1\n\tB2\nB2 more\nboxed once\nA comment\nA footnote\nPage header\nIntäkt per region\nNorr\nSöder"
    );
}

#[test]
fn docx_is_found_without_relationships_and_by_an_unusual_main_part() {
    let plain = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("word/document.xml", &part("by its usual name")),
    ]);
    assert_eq!(text(&plain), "by its usual name");

    let renamed = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        (
            "_rels/.rels",
            &rels(&[
                ("rId3", "extended-properties", "docProps/app.xml"),
                ("rId1", "officeDocument", "/word/document2.xml"),
            ]),
        ),
        ("word/document2.xml", &part("by its relationship")),
        ("word/footer2.xml", &part("footer")),
    ]);
    assert_eq!(text(&renamed), "by its relationship\nfooter");
}

#[test]
fn zip_members_stored_with_backslashes_are_found() {
    let bytes = zip(&[
        ("[content_types].xml", CONTENT_TYPES),
        (
            "_rels\\.rels",
            &rels(&[("rId1", "officeDocument", "word/document.xml")]),
        ),
        ("word\\document.xml", &part("windows paths")),
    ]);
    assert_eq!(text(&bytes), "windows paths");
}

#[test]
fn docx_with_broken_markup_is_malformed() {
    let bytes = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("word/document.xml", b"<w:document><w:p attr=></w:document"),
    ]);
    let error = run(&bytes).unwrap_err();
    assert!(
        matches!(&error, ExtractError::Malformed(reason) if reason.starts_with("word/document.xml")),
        "{error}"
    );
}

const WORKBOOK: &str = r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr date1904="DATE1904"/>
<sheets><sheet name="Second &amp; last" sheetId="2" r:id="rId2"/><sheet name="First" sheetId="1" r:id="rId1"/><sheet name="Dangling" sheetId="3" r:id="rId9"/></sheets></workbook>"#;

const SHARED_STRINGS: &str = r#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><t>Region</t></si>
<si><r><rPr><b/></rPr><t>Rich </t></r><r><t>text</t></r><rPh sb="0" eb="1"><t>phonetic</t></rPh></si>
<si><t/></si>
</sst>"#;

const STYLES: &str = r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts><numFmt numFmtId="164" formatCode="yyyy\-mm\-dd"/><numFmt numFmtId="165" formatCode="0.0 &quot;days&quot;"/></numFmts>
<cellStyleXfs><xf numFmtId="14"/></cellStyleXfs>
<cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="165"/></cellXfs>
</styleSheet>"#;

const SHEET_ONE: &str = r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>99</v></c></row>
<row r="2"><c r="A2"><v>42</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="b"><v>0</v></c><c r="D2" t="str"><f>A2&amp;"x"</f><v>42x</v></c><c r="E2" t="inlineStr"><is><t>inline</t></is></c></row>
<row r="3"><c r="A3" s="1"><v>45351</v></c><c r="B3" s="2" t="n"><v>45351.5</v></c><c r="C3" s="3"><v>2.5</v></c><c r="D3" s="1"><v>not a number</v></c><c r="E3" s="7"><v>7</v></c></row>
<row r="4"/>
</sheetData></worksheet>"#;

fn workbook(date1904: &str) -> Vec<u8> {
    zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", &rels(&[("rId1", "officeDocument", "xl/workbook.xml")])),
        ("xl/workbook.xml", WORKBOOK.replace("DATE1904", date1904).as_bytes()),
        (
            "xl/_rels/workbook.xml.rels",
            &rels(&[
                ("rId1", "worksheet", "worksheets/sheet1.xml"),
                ("rId2", "worksheet", "worksheets/sheet2.xml"),
                ("rId3", "sharedStrings", "strings.xml"),
                ("rId4", "styles", "styles.xml"),
            ]),
        ),
        ("xl/strings.xml", SHARED_STRINGS.as_bytes()),
        ("xl/styles.xml", STYLES.as_bytes()),
        ("xl/worksheets/sheet1.xml", SHEET_ONE.as_bytes()),
        (
            "xl/worksheets/sheet2.xml",
            br#"<worksheet><sheetData><row><c t="inlineStr"><is><r><t>only </t></r><r><t>cell</t></r></is></c></row></sheetData></worksheet>"#,
        ),
        (
            "xl/comments1.xml",
            br#"<comments><commentList><comment ref="A1"><text><r><t>Check this figure</t></r></text></comment></commentList></comments>"#,
        ),
        (
            "xl/drawings/drawing1.xml",
            br#"<xdr:wsDr><xdr:sp><xdr:txBody><a:p><a:r><a:t>A text box on the sheet</a:t></a:r></a:p></xdr:txBody></xdr:sp></xdr:wsDr>"#,
        ),
        ("xl/charts/chart1.xml", CHART.as_bytes()),
    ])
}

#[test]
fn xlsx_reads_sheets_in_workbook_order_with_every_cell_kind() {
    let extracted = run(&workbook("0")).unwrap();
    assert_eq!(extracted.format, Format::Xlsx);
    assert_eq!(
        extracted.text,
        "Second & last\nonly cell\nFirst\nRegion\tRich text\n42\tTRUE\tFALSE\t42x\tinline\n2024-02-29\t2024-02-29 12:00:00\t2.5\tnot a number\t7\nCheck this figure\nA text box on the sheet\nIntäkt per region\nNorr\nSöder"
    );
}

#[test]
fn xlsx_honours_the_1904_date_system() {
    assert!(text(&workbook("1")).contains("\n2028-03-01\t2028-03-01 12:00:00\t2.5"));
}

#[test]
fn xlsx_without_a_sheet_list_or_styles_falls_back_to_part_numbers() {
    let cell = |value: &str| {
        format!(r#"<worksheet><sheetData><row><c s="1"><v>{value}</v></c></row></sheetData></worksheet>"#)
    };
    let bytes = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("xl/workbook.xml", b"<workbook/>"),
        ("xl/worksheets/sheet10.xml", cell("ten").as_bytes()),
        ("xl/worksheets/sheet2.xml", cell("45351").as_bytes()),
        ("xl/worksheets/_rels/sheet2.xml.rels", &rels(&[])),
        ("xl/sharedStrings.xml", b"<sst><si><t>unused</t></si></sst>"),
    ]);
    assert_eq!(text(&bytes), "45351\nten");
}

const PRESENTATION: &str = r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/><p:sldId id="258" r:id="rId8"/></p:sldIdLst></p:presentation>"#;

fn slide(title: &str, body: &str) -> Vec<u8> {
    format!(
        r#"<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en"/><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:txBody><a:p><a:r><a:t>{body}</a:t></a:r><a:br/><a:r><a:t>second line</a:t></a:r></a:p></p:txBody></p:sp>
<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>c1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>c2</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>"#
    )
    .into_bytes()
}

#[test]
fn pptx_reads_slides_in_presentation_order_with_their_notes() {
    let bytes = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        (
            "_rels/.rels",
            &rels(&[("rId1", "officeDocument", "ppt/presentation.xml")]),
        ),
        ("ppt/presentation.xml", PRESENTATION.as_bytes()),
        (
            "ppt/_rels/presentation.xml.rels",
            &rels(&[
                ("rId1", "slideMaster", "slideMasters/slideMaster1.xml"),
                ("rId2", "slide", "slides/slide1.xml"),
                ("rId3", "slide", "slides/slide2.xml"),
            ]),
        ),
        ("ppt/slides/slide1.xml", &slide("Shown second", "body one")),
        ("ppt/slides/slide2.xml", &slide("Shown first", "body two")),
        (
            "ppt/slides/_rels/slide2.xml.rels",
            &rels(&[
                ("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
                ("rId2", "notesSlide", "../notesSlides/notesSlide7.xml"),
            ]),
        ),
        (
            "ppt/notesSlides/notesSlide7.xml",
            &slide("Speaker notes", "remember this"),
        ),
        (
            "ppt/slideMasters/slideMaster1.xml",
            &slide("Click to edit", "master text"),
        ),
        ("ppt/charts/chart3.xml", CHART.as_bytes()),
        (
            "ppt/diagrams/data1.xml",
            br#"<dgm:dataModel><dgm:ptLst><dgm:pt><dgm:t><a:p><a:r><a:t>SmartArt step</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>"#,
        ),
    ]);
    let extracted = run(&bytes).unwrap();
    assert_eq!(extracted.format, Format::Pptx);
    assert_eq!(
        extracted.text,
        "Shown first\nbody two\nsecond line\nc1\tc2\nSpeaker notes\nremember this\nsecond line\nc1\tc2\nShown second\nbody one\nsecond line\nc1\tc2\nIntäkt per region\nNorr\nSöder\nSmartArt step"
    );
}

#[test]
fn pptx_without_a_slide_list_falls_back_to_part_numbers() {
    let bytes = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("ppt/presentation.xml", b"<p:presentation/>"),
        ("ppt/slides/slide10.xml", &slide("Ten", "x")),
        ("ppt/slides/slide9.xml", &slide("Nine", "y")),
    ]);
    assert!(text(&bytes).starts_with("Nine\ny\n"));
    assert!(text(&bytes).contains("\nTen\nx\n"));
}

#[test]
fn vsdx_reads_shape_text_page_by_page() {
    let page = |text: &str| {
        format!(
            r#"<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main"><Shapes><Shape><Cell N="PinX" V="1"/><Text><cp IX="0"/>{text}<fld IX="0">field</fld></Text></Shape><Shape><Text>second shape</Text></Shape></Shapes></PageContents>"#
        )
    };
    let bytes = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", &rels(&[("rId1", "document", "visio/document.xml")])),
        ("visio/document.xml", b"<VisioDocument/>"),
        (
            "visio/pages/pages.xml",
            b"<Pages><Page Name=\"not a page part\"/></Pages>",
        ),
        ("visio/pages/page2.xml", page("Router ").as_bytes()),
        ("visio/pages/page1.xml", page("Switch ").as_bytes()),
        (
            "visio/masters/master1.xml",
            b"<MasterContents><Shapes><Shape><Text>Master label</Text></Shape></Shapes></MasterContents>",
        ),
    ]);
    let extracted = run(&bytes).unwrap();
    assert_eq!(extracted.format, Format::Vsdx);
    assert_eq!(
        extracted.text,
        "Switch field\nsecond shape\nRouter field\nsecond shape\nMaster label"
    );
}

#[test]
fn other_open_packaging_documents_are_unsupported() {
    let binary = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", &rels(&[("rId1", "officeDocument", "xl/workbook.bin")])),
        ("xl/workbook.bin", b"\x83\x01\x00"),
    ]);
    assert!(matches!(run(&binary), Err(ExtractError::Unsupported("xlsb"))));

    let xps = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        (
            "_rels/.rels",
            &rels(&[("rId1", "officeDocument", "Documents/1/FixedDocument.fdoc")]),
        ),
        ("Documents/1/FixedDocument.fdoc", b"<FixedDocument/>"),
    ]);
    assert!(matches!(run(&xps), Err(ExtractError::Unsupported("ooxml"))));

    let empty = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", &rels(&[("rId1", "officeDocument", "word/missing.xml")])),
    ]);
    assert!(matches!(run(&empty), Err(ExtractError::Unsupported("ooxml"))));
}

#[test]
fn damaged_packages_never_panic() {
    common::assert_survives_damage(&workbook("0"));
    common::assert_survives_damage(&zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", &rels(&[("rId1", "officeDocument", "word/document.xml")])),
        ("word/document.xml", DOCUMENT.as_bytes()),
    ]));
    for name in ["report.docx", "report.pptx", "sales.xlsx"] {
        common::assert_survives_damage(&common::fixture(name));
    }
}
