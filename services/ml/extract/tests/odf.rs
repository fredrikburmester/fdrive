//! OpenDocument and EPUB packages built member by member.

mod common;

use common::{run, text, zip};
use fdrive_ml_extract::{ExtractError, Format};

const NAMESPACES: &str = r#"xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0""#;

fn document(kind: &str, body: &str) -> Vec<u8> {
    let content =
        format!("<office:document-content {NAMESPACES}><office:body>{body}</office:body></office:document-content>");
    zip(&[
        (
            "mimetype",
            format!("application/vnd.oasis.opendocument.{kind}").as_bytes(),
        ),
        ("content.xml", content.as_bytes()),
        (
            "META-INF/manifest.xml",
            b"<manifest:manifest><manifest:file-entry manifest:full-path=\"content.xml\"/></manifest:manifest>",
        ),
    ])
}

#[test]
fn odt_reads_headings_paragraphs_and_tables() {
    let bytes = document(
        "text",
        r#"<office:text>
<text:tracked-changes><text:changed-region><text:deletion><text:p>deleted earlier</text:p></text:deletion></text:changed-region></text:tracked-changes>
<text:h text:outline-level="1">Kvartalsrapport</text:h>
<text:p>R&#228;ksm&#246;rg&#229;s <text:span>med<text:s/>dill</text:span><text:tab/>och<text:s text:c="3"/>kaffe<text:line-break/>p&#229; ny rad</text:p>
<table:table table:name="Table1"><table:table-row><table:table-cell><text:p>A1</text:p></table:table-cell><table:table-cell><text:p>B1</text:p><text:p>B1 more</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell/><table:covered-table-cell/><table:table-cell><text:p>C2</text:p></table:table-cell></table:table-row></table:table>
<text:p>Frame <draw:frame><draw:text-box><text:p>inside</text:p></draw:text-box></draw:frame>after</text:p>
</office:text>"#,
    );
    let extracted = run(&bytes).unwrap();
    assert_eq!(extracted.format, Format::Odt);
    assert_eq!(
        extracted.text,
        "Kvartalsrapport\nRäksmörgås med dill\toch   kaffe\npå ny rad\nA1\tB1\nB1 more\n\t\tC2\nFrame inside\nafter"
    );
}

#[test]
fn ods_writes_sheet_names_and_rows() {
    let bytes = document(
        "spreadsheet",
        r#"<office:spreadsheet><table:table table:name="F&#246;rs&#228;ljning"><table:table-row><table:table-cell><text:p>Region</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1000"><text:p>420</text:p></table:table-cell></table:table-row></table:table>
<table:table table:name="Tom"/></office:spreadsheet>"#,
    );
    let extracted = run(&bytes).unwrap();
    assert_eq!(extracted.format, Format::Ods);
    assert_eq!(extracted.text, "Försäljning\nRegion\t420\nTom");
}

#[test]
fn odp_and_templates_and_staroffice_files_are_recognized() {
    let slide = r#"<office:presentation><draw:page><draw:frame><draw:text-box><text:p>Slide title</text:p></draw:text-box></draw:frame></draw:page></office:presentation>"#;
    let extracted = run(&document("presentation", slide)).unwrap();
    assert_eq!(
        (extracted.format, extracted.text.as_str()),
        (Format::Odp, "Slide title")
    );
    assert_eq!(
        run(&document("text-template", "<text:p>t</text:p>")).unwrap().format,
        Format::Odt
    );
    assert_eq!(
        run(&document("spreadsheet-template", "<text:p>t</text:p>"))
            .unwrap()
            .format,
        Format::Ods
    );

    let star = zip(&[
        ("mimetype", b"application/vnd.sun.xml.writer\n"),
        (
            "content.xml",
            b"<office:document-content><text:p>old</text:p></office:document-content>",
        ),
    ]);
    assert_eq!(text(&star), "old");
}

#[test]
fn encrypted_unknown_and_incomplete_packages_are_reported() {
    let encrypted = zip(&[
        ("mimetype", b"application/vnd.oasis.opendocument.text"),
        ("content.xml", b"\x01\x02\x03 ciphertext"),
        (
            "META-INF/manifest.xml",
            b"<manifest:manifest><manifest:file-entry manifest:full-path=\"content.xml\"><manifest:encryption-data manifest:checksum=\"x\"/></manifest:file-entry></manifest:manifest>",
        ),
    ]);
    assert!(matches!(run(&encrypted), Err(ExtractError::Encrypted)));
    assert!(matches!(
        run(&document("graphics", "<draw:page/>")),
        Err(ExtractError::Unsupported("opendocument"))
    ));

    let hollow = zip(&[("mimetype", b"application/vnd.oasis.opendocument.text")]);
    assert!(matches!(run(&hollow), Err(ExtractError::Malformed(reason)) if reason == "missing content.xml"));

    let broken = zip(&[
        ("mimetype", b"application/vnd.oasis.opendocument.text"),
        ("content.xml", b"<a><b c=></a"),
    ]);
    assert!(matches!(run(&broken), Err(ExtractError::Malformed(reason)) if reason.starts_with("content.xml")));
}

const CONTAINER: &[u8] = br#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;

const PACKAGE: &[u8] = br#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
<metadata><dc:title>Alice &amp; friends</dc:title><dc:creator>Lewis Carroll</dc:creator><dc:language>en</dc:language></metadata>
<manifest><item id="two" href="text/chapter%202.xhtml#start" media-type="application/xhtml+xml"/><item id="one" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/><item href="no-id.xhtml"/></manifest>
<spine><itemref idref="one"/><itemref idref="two"/><itemref idref="gone"/><itemref/></spine></package>"#;

fn chapter(title: &str, body: &str) -> Vec<u8> {
    format!("<?xml version=\"1.0\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>{title}</title><style>p {{ margin: 0 }}</style></head><body><h1>{title}</h1><p>{body}</p></body></html>").into_bytes()
}

#[test]
fn epub_reads_chapters_in_spine_order() {
    let bytes = zip(&[
        ("mimetype", b"application/epub+zip"),
        ("META-INF/container.xml", CONTAINER),
        ("OEBPS/content.opf", PACKAGE),
        (
            "OEBPS/text/chapter 2.xhtml",
            &chapter("Chapter 2", "The pool of tears&nbsp;&mdash; again"),
        ),
        (
            "OEBPS/text/chapter1.xhtml",
            &chapter("Chapter 1", "Down the <em>rabbit</em> hole"),
        ),
        ("OEBPS/style.css", b"p { margin: 0 }"),
    ]);
    let extracted = run(&bytes).unwrap();
    assert_eq!(extracted.format, Format::Epub);
    assert_eq!(
        extracted.text,
        "Alice & friends\nLewis Carroll\nChapter 1\nChapter 1\nDown the rabbit hole\nChapter 2\nChapter 2\nThe pool of tears — again"
    );
}

#[test]
fn epub_without_a_usable_spine_reads_chapters_by_name() {
    let by_container = zip(&[
        ("META-INF/container.xml", CONTAINER),
        ("b.html", &chapter("B", "second")),
        ("a.xhtml", &chapter("A", "first")),
        ("cover.jpg", b"\xFF\xD8"),
    ]);
    let extracted = run(&by_container).unwrap();
    assert_eq!(extracted.format, Format::Epub);
    assert_eq!(extracted.text, "A\nA\nfirst\nB\nB\nsecond");

    let no_container = zip(&[
        ("mimetype", b"application/epub+zip"),
        ("only.htm", &chapter("Only", "one")),
    ]);
    assert_eq!(text(&no_container), "Only\nOnly\none");
}

#[test]
fn epub_with_rights_management_or_no_chapters_is_reported() {
    let locked = zip(&[
        ("mimetype", b"application/epub+zip"),
        ("META-INF/rights.xml", b"<rights/>"),
        ("a.xhtml", b"\x00\x01"),
    ]);
    assert!(matches!(run(&locked), Err(ExtractError::Encrypted)));

    let hollow = zip(&[
        ("mimetype", b"application/epub+zip"),
        ("META-INF/container.xml", CONTAINER),
    ]);
    assert!(matches!(run(&hollow), Err(ExtractError::Malformed(reason)) if reason == "no chapters"));

    let broken = zip(&[
        ("mimetype", b"application/epub+zip"),
        ("META-INF/container.xml", CONTAINER),
        ("OEBPS/content.opf", b"<package><item id=></package"),
    ]);
    assert!(matches!(run(&broken), Err(ExtractError::Malformed(reason)) if reason.starts_with("OEBPS/content.opf")));
}

#[test]
fn damaged_packages_never_panic() {
    common::assert_survives_damage(&document(
        "text",
        "<text:p>one</text:p><table:table><table:table-row><table:table-cell><text:p>c</text:p></table:table-cell></table:table-row></table:table>",
    ));
    common::assert_survives_damage(&zip(&[
        ("mimetype", b"application/epub+zip"),
        ("META-INF/container.xml", CONTAINER),
        ("OEBPS/content.opf", PACKAGE),
        (
            "OEBPS/text/chapter1.xhtml",
            &chapter("Chapter 1", "Down the rabbit hole"),
        ),
    ]));
    for name in ["report.odt", "report.epub"] {
        common::assert_survives_damage(&common::fixture(name));
    }
}
