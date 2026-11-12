//! The bounds that keep a hostile or huge document from exhausting memory.

mod common;

use common::{CONTENT_TYPES, fixture, ole, ole_small_sectors, zip};
use fdrive_ml_extract::{ExtractError, Limits, extract};

fn limits(part: usize, total: usize, chars: usize) -> Limits {
    Limits {
        max_part_bytes: part,
        max_total_bytes: total,
        max_text_chars: chars,
    }
}

fn docx(paragraphs: usize) -> Vec<u8> {
    let mut document = String::from("<w:document><w:body>");
    for index in 0..paragraphs {
        document.push_str(&format!("<w:p><w:r><w:t>paragraph {index}</w:t></w:r></w:p>"));
    }
    document.push_str("</w:body></w:document>");
    zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("word/document.xml", document.as_bytes()),
    ])
}

#[test]
fn text_is_truncated_at_the_character_limit() {
    let extracted = extract(&docx(1000), &limits(1 << 20, 1 << 20, 25)).unwrap();
    assert_eq!(extracted.text, "paragraph 0\nparagraph 1\np");
    assert_eq!(extract(&docx(3), &limits(1 << 20, 1 << 20, 0)).unwrap().text, "");
}

#[test]
fn a_member_over_the_part_limit_yields_the_text_read_so_far() {
    let extracted = extract(&docx(1000), &limits(1500, 1 << 20, 1 << 20)).unwrap();
    assert!(extracted.text.starts_with("paragraph 0\nparagraph 1\n"));
    let last = extracted.text.lines().count();
    assert!((10..100).contains(&last), "{last} paragraphs read");
}

#[test]
fn a_zip_bomb_stops_at_the_total_limit() {
    // 64 MiB of spaces deflates to a few dozen kilobytes.
    let mut document = b"<w:document><w:body><w:p><w:r><w:t>before the padding</w:t></w:r></w:p>".to_vec();
    document.resize(64 << 20, b' ');
    let bytes = zip(&[("[Content_Types].xml", CONTENT_TYPES), ("word/document.xml", &document)]);
    assert!(bytes.len() < 1 << 20);
    let extracted = extract(&bytes, &limits(1 << 20, 1 << 16, 1 << 20)).unwrap();
    assert_eq!(extracted.text, "before the padding");
}

#[test]
fn a_limit_reached_before_any_text_is_malformed() {
    let mut document = vec![b' '; 4096];
    document.extend_from_slice(b"<w:document><w:body><w:p><w:r><w:t>late</w:t></w:r></w:p></w:body></w:document>");
    let bytes = zip(&[("[Content_Types].xml", CONTENT_TYPES), ("word/document.xml", &document)]);
    let error = extract(&bytes, &limits(2048, 1 << 20, 1 << 20)).unwrap_err();
    assert!(
        matches!(&error, ExtractError::Malformed(reason) if reason.contains("size limit")),
        "{error}"
    );
    assert_eq!(extract(&bytes, &Limits::default()).unwrap().text, "late");
}

#[test]
fn a_cut_shared_string_table_does_not_fail_the_workbook() {
    let mut strings = String::from("<sst>");
    for index in 0..500 {
        strings.push_str(&format!("<si><t>string {index}</t></si>"));
    }
    strings.push_str("</sst>");
    let sheet = r#"<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>499</v></c><c><v>7</v></c></row></sheetData></worksheet>"#;
    let bytes = zip(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("xl/workbook.xml", b"<workbook/>"),
        ("xl/sharedStrings.xml", strings.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
    ]);
    assert_eq!(
        extract(&bytes, &Limits::default()).unwrap().text,
        "string 0\tstring 499\t7"
    );
    // With the table cut short the workbook is unreadable past it, and says so.
    let error = extract(&bytes, &limits(1000, 1 << 20, 1 << 20)).unwrap_err();
    assert!(matches!(error, ExtractError::Malformed(_)));
}

#[test]
fn raw_text_formats_are_cut_at_the_limits() {
    let mut rtf = b"{\\rtf1 ".to_vec();
    for _ in 0..1000 {
        rtf.extend_from_slice(b"word\\par ");
    }
    rtf.push(b'}');
    let extracted = extract(&rtf, &limits(100, 1 << 20, 1 << 20)).unwrap();
    assert!(extracted.text.lines().count() < 12, "{}", extracted.text);
    assert_eq!(extract(&rtf, &limits(1 << 20, 1 << 20, 9)).unwrap().text, "word\nword");

    let html = format!("<html><body>{}</body></html>", "<p>line</p>".repeat(1000));
    let extracted = extract(html.as_bytes(), &limits(1 << 20, 64, 1 << 20)).unwrap();
    assert!(extracted.text.lines().count() < 6, "{}", extracted.text);
}

#[test]
fn compound_file_streams_are_cut_at_the_limits() {
    // A large stream in the regular sectors and a small one in the mini stream.
    let main = long_document(2000);
    let bytes = ole(&[("/WordDocument", &main), ("/Small", b"mini stream content")]);
    let whole = extract(&bytes, &Limits::default()).unwrap();
    assert_eq!(whole.text.lines().count(), 2000);
    let cut = extract(&bytes, &limits(0x300 + 64, 1 << 20, 1 << 20)).unwrap();
    assert!((5..12).contains(&cut.text.lines().count()), "{}", cut.text);
    let cut_total = extract(&bytes, &limits(1 << 20, 0x300 + 64, 1 << 20)).unwrap();
    assert!((5..12).contains(&cut_total.text.lines().count()), "{}", cut_total.text);
}

/// A Word 95 document whose text is `lines` numbered lines.
fn long_document(lines: usize) -> Vec<u8> {
    let mut main = vec![0u8; 0x300];
    main[..2].copy_from_slice(&0xA5DCu16.to_le_bytes());
    main[2..4].copy_from_slice(&0x0068u16.to_le_bytes());
    main[0x18..0x1C].copy_from_slice(&0x300u32.to_le_bytes());
    for index in 0..lines {
        main.extend_from_slice(format!("line {index}\r").as_bytes());
    }
    let end = main.len() as u32;
    main[0x1C..0x20].copy_from_slice(&end.to_le_bytes());
    main
}

#[test]
fn a_compound_file_too_large_for_its_header_table_is_read_to_the_end() {
    // With 512-byte sectors the header lists allocation sectors for 6.8 MiB;
    // beyond that the list continues in sectors of its own.
    let main = long_document(700_000);
    assert!(main.len() > 109 * 128 * 512);
    let bytes = ole_small_sectors(&[("/WordDocument", &main), ("/Small", b"mini stream content")]);
    let extracted = extract(&bytes, &limits(64 << 20, 64 << 20, 64 << 20)).unwrap();
    assert_eq!(extracted.text.lines().count(), 700_000);
    assert!(extracted.text.ends_with("line 699998\nline 699999"));
}

#[test]
fn every_real_fixture_stops_at_a_small_character_limit() {
    for name in [
        "report.doc",
        "report.docx",
        "report.epub",
        "report.odt",
        "report.pptx",
        "report.rtf",
        "sales.xls",
        "sales.xlsx",
    ] {
        let extracted = extract(&fixture(name), &limits(1 << 20, 1 << 20, 6)).unwrap();
        assert!(extracted.text.chars().count() <= 6, "{name}: {:?}", extracted.text);
        assert!(!extracted.text.is_empty(), "{name}");
    }
}
