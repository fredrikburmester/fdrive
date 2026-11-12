//! Format detection from content alone, and the formats read without a container.

mod common;

use common::{fixture, ole, run, text, zip};
use fdrive_ml_extract::{ExtractError, Extracted, Format, Limits, extract};

fn unsupported(bytes: &[u8]) -> &'static str {
    match run(bytes) {
        Err(ExtractError::Unsupported(label)) => label,
        other => panic!("expected an unsupported document, got {other:?}"),
    }
}

#[test]
fn unreadable_formats_are_named() {
    assert_eq!(unsupported(b""), "unknown");
    assert_eq!(unsupported(b"just some notes\nwith two lines\n"), "unknown");
    assert_eq!(unsupported(b"\x89PNG\r\n\x1a\n"), "unknown");
    assert_eq!(unsupported(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), "unknown");
    assert_eq!(unsupported(b"%PDF-1.7\n"), "pdf");
    assert_eq!(unsupported(b"\xFFWPC\x10\x00\x00\x00"), "wordperfect");
    assert_eq!(unsupported(&zip(&[("readme.txt", b"hello")])), "zip");
    assert_eq!(
        unsupported(&zip(&[
            ("Index/Document.iwa", b"\x00"),
            ("Metadata/Properties.plist", b"")
        ])),
        "iwork"
    );
    assert_eq!(unsupported(&zip(&[("index.apxl", b"<key:presentation/>")])), "iwork");
    assert_eq!(
        unsupported(&zip(&[("mimetype", b"image/openraster"), ("stack.xml", b"<image/>")])),
        "zip"
    );
    assert_eq!(
        unsupported(&ole(&[("/VisioDocument", b"Visio (TM) Drawing")])),
        "visio-binary"
    );
    assert_eq!(
        unsupported(&ole(&[("/Quill/QuillSub/CONTENTS", b"CHNKINK")])),
        "publisher"
    );
    assert_eq!(unsupported(&ole(&[("/SomethingElse", b"data")])), "ole");
}

#[test]
fn password_protected_packages_are_encrypted() {
    let bytes = ole(&[("/EncryptedPackage", &[0x55; 64]), ("/EncryptionInfo", &[4, 0, 4, 0])]);
    assert!(matches!(run(&bytes), Err(ExtractError::Encrypted)));
}

#[test]
fn damaged_containers_are_malformed() {
    assert!(
        matches!(run(b"PK\x03\x04 not really a zip"), Err(ExtractError::Malformed(reason)) if reason.starts_with("zip"))
    );
    assert!(
        matches!(run(b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1 short"), Err(ExtractError::Malformed(reason)) if reason.contains("compound file"))
    );
    let mut no_root = ole(&[("/WordDocument", b"x")]);
    no_root[48..52].copy_from_slice(&0xFFFF_FFFEu32.to_le_bytes());
    assert!(matches!(run(&no_root), Err(ExtractError::Malformed(_))));
}

#[test]
fn rtf_is_recognized_behind_a_byte_order_mark_and_whitespace() {
    let extracted = run(b"\xEF\xBB\xBF \r\n{\\rtf1\\ansi Hello\\par World}").unwrap();
    assert_eq!(
        (extracted.format, extracted.text.as_str()),
        (Format::Rtf, "Hello\nWorld")
    );
}

#[test]
fn mail_is_recognized_by_its_headers() {
    let extracted = run(b"From: a@example.com\r\nTo: b@example.com\r\nSubject: Hello\r\n\r\nBody text\r\n").unwrap();
    assert_eq!(extracted.format, Format::Eml);
    assert_eq!(
        extracted.text,
        "Subject: Hello\nFrom: a@example.com\nTo: b@example.com\nBody text"
    );
}

#[test]
fn html_and_word_xml_saved_as_documents_are_read() {
    let html = run(b"  <!DOCTYPE html><html><body><p>Saved as .doc</p></body></html>").unwrap();
    assert_eq!((html.format, html.text.as_str()), (Format::Html, "Saved as .doc"));
    assert_eq!(text(b"<HTML><BODY>upper case</BODY></HTML>"), "upper case");

    let word = br#"<?xml version="1.0"?><?mso-application progid="Word.Document"?>
<w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml"><w:body><w:p><w:r><w:t>Word 2003</w:t></w:r></w:p><w:p><w:r><w:t>XML</w:t></w:r></w:p></w:body></w:wordDocument>"#;
    let extracted = run(word).unwrap();
    assert_eq!(
        (extracted.format, extracted.text.as_str()),
        (Format::WordXml, "Word 2003\nXML")
    );

    let broken = run(b"<?xml version=\"1.0\"?><w:wordDocument><w:p a=></w:wordDocument");
    assert!(matches!(broken, Err(ExtractError::Malformed(reason)) if reason.starts_with("word xml")));
}

/// A Mobipocket book whose text records hold `records`, already encoded.
fn mobi(compression: u16, encryption: u16, encoding: u32, trailers: u16, records: &[&[u8]]) -> Vec<u8> {
    let mut first = Vec::new();
    first.extend_from_slice(&compression.to_be_bytes());
    first.extend_from_slice(&[0, 0]);
    first.extend_from_slice(&1000u32.to_be_bytes());
    first.extend_from_slice(&(records.len() as u16).to_be_bytes());
    first.extend_from_slice(&4096u16.to_be_bytes());
    first.extend_from_slice(&encryption.to_be_bytes());
    first.extend_from_slice(&[0, 0]);
    first.extend_from_slice(b"MOBI");
    first.extend_from_slice(&0xE8u32.to_be_bytes());
    first.extend_from_slice(&2u32.to_be_bytes());
    first.extend_from_slice(&encoding.to_be_bytes());
    first.resize(0xF2, 0);
    first.extend_from_slice(&trailers.to_be_bytes());
    first.resize(0x100, 0);

    let all: Vec<&[u8]> = std::iter::once(first.as_slice())
        .chain(records.iter().copied())
        .collect();
    let mut out = vec![0u8; 78];
    out[..5].copy_from_slice(b"Alice");
    out[60..68].copy_from_slice(b"BOOKMOBI");
    out[76..78].copy_from_slice(&(all.len() as u16).to_be_bytes());
    let mut offset = 78 + 8 * all.len() + 2;
    for record in &all {
        out.extend_from_slice(&(offset as u32).to_be_bytes());
        out.extend_from_slice(&[0; 4]);
        offset += record.len();
    }
    out.extend_from_slice(&[0, 0]);
    for record in &all {
        out.extend_from_slice(record);
    }
    out
}

#[test]
fn mobi_reads_plain_and_packed_text_records() {
    let plain = mobi(
        1,
        0,
        65001,
        0,
        &[
            "<html><body><p>Kapitel ett</p>".as_bytes(),
            "<p>räksmörgås</p></body></html>".as_bytes(),
        ],
    );
    let extracted = run(&plain).unwrap();
    assert_eq!(
        (extracted.format, extracted.text.as_str()),
        (Format::Mobi, "Kapitel ett\nräksmörgås")
    );

    // "<p>abc" then a reference repeating "abc", a space pair, and Windows-1252 bytes
    // behind a length prefix; the record ends with a three-byte trailing entry.
    let packed: &[u8] = &[
        b'<',
        b'p',
        b'>',
        b'a',
        b'b',
        b'c',
        0x80,
        0x18,
        0xC0 | b'd',
        0x02,
        0xE5,
        0xE4,
        9,
        9,
        0x83,
    ];
    assert_eq!(text(&mobi(2, 0, 1252, 0b10, &[packed])), "abcabc dåä");
}

#[test]
fn mobi_reports_what_it_cannot_read() {
    assert!(matches!(
        run(&mobi(2, 2, 65001, 0, &[b"x"])),
        Err(ExtractError::Encrypted)
    ));
    assert!(matches!(
        run(&mobi(17480, 0, 65001, 0, &[b"x"])),
        Err(ExtractError::Unsupported("mobi-huffman"))
    ));
    assert!(
        matches!(run(&mobi(7, 0, 65001, 0, &[b"x"])), Err(ExtractError::Malformed(reason)) if reason.contains("compression"))
    );
    let whole = mobi(1, 0, 65001, 0, &[b"text"]);
    assert!(matches!(run(&whole[..77]), Err(ExtractError::Malformed(reason)) if reason.contains("header")));
    assert!(matches!(run(&whole[..90]), Err(ExtractError::Malformed(reason)) if reason.contains("header")));
    // More text records promised than the file holds, and a packed record that produces nothing.
    let mut promised = mobi(1, 0, 65001, 0, &[b"<p>only</p>"]);
    let first = u32::from_be_bytes(promised[78..82].try_into().unwrap()) as usize;
    promised[first + 8..first + 10].copy_from_slice(&9u16.to_be_bytes());
    assert_eq!(text(&promised), "only");
    assert_eq!(text(&mobi(2, 0, 65001, 0, &[&[0x80, 0x08], b"<p>unreached</p>"])), "");
}

#[test]
fn formats_have_stable_labels() {
    let all = [
        (Format::Docx, "docx"),
        (Format::Xlsx, "xlsx"),
        (Format::Pptx, "pptx"),
        (Format::Vsdx, "vsdx"),
        (Format::Odt, "odt"),
        (Format::Ods, "ods"),
        (Format::Odp, "odp"),
        (Format::Epub, "epub"),
        (Format::Rtf, "rtf"),
        (Format::Eml, "eml"),
        (Format::Doc, "doc"),
        (Format::Xls, "xls"),
        (Format::Ppt, "ppt"),
        (Format::Msg, "msg"),
        (Format::Mobi, "mobi"),
        (Format::Html, "html"),
        (Format::WordXml, "word-xml"),
    ];
    for (format, label) in all {
        assert_eq!(format.as_str(), label);
        assert_eq!(format.to_string(), label);
    }
}

#[test]
fn errors_describe_themselves() {
    assert_eq!(
        ExtractError::Unsupported("iwork").to_string(),
        "unsupported document type: iwork"
    );
    assert_eq!(ExtractError::Encrypted.to_string(), "document is encrypted");
    assert_eq!(
        ExtractError::Malformed("zip: bad".into()).to_string(),
        "malformed document: zip: bad"
    );
}

#[test]
fn real_files_from_other_tools_are_read() {
    let report = |name: &str, format: Format| {
        let Extracted { format: detected, text } = extract(&fixture(name), &Limits::default()).unwrap();
        assert_eq!(detected, format, "{name}");
        for line in [
            "Kvartalsrapport Q3",
            "Räksmörgåsar såldes för 1\u{a0}250 kr under tredje kvartalet.",
            "See the full report for details.",
            "Region\tIntäkt",
            "Söder\t830",
            "Nästa steg",
            "Öppna butik i Malmö",
        ] {
            // Converters disagree on the non-breaking space and on list markers.
            let found = text
                .lines()
                .any(|have| have.replace('\u{a0}', " ").ends_with(&line.replace('\u{a0}', " ")));
            assert!(found, "{name} lacks {line:?} in:\n{text}");
        }
    };
    report("report.doc", Format::Doc);
    report("report.rtf", Format::Rtf);
    report("report.docx", Format::Docx);
    report("report.odt", Format::Odt);
    report("report.epub", Format::Epub);
    report("report.pptx", Format::Pptx);

    for (name, format) in [("sales.xls", Format::Xls), ("sales.xlsx", Format::Xlsx)] {
        let extracted = run(&fixture(name)).unwrap();
        assert_eq!(extracted.format, format);
        assert_eq!(
            extracted.text.lines().take(4).collect::<Vec<_>>(),
            [
                "Försäljning",
                "Region\tIntäkt\tDatum\tKlar",
                "Norr\t420\t2024-02-29\tTRUE",
                "Söder\t830.5\t2023-12-31\tFALSE"
            ],
            "{name}"
        );
        assert!(
            extracted
                .text
                .ends_with("Anteckningar\nRäksmörgåsar såldes bäst i Malmö"),
            "{name}: {}",
            extracted.text
        );
    }
}

#[test]
fn damaged_text_formats_never_panic() {
    common::assert_survives_damage(&fixture("report.rtf"));
    common::assert_survives_damage(b"From: Art <art@example.com>\r\nTo: b@example.com\r\nSubject: =?utf-8?B?UsOka3Ntw7ZyZ8Olcw==?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>Hi &amp; bye</p>\r\n--b\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\n\r\nJVBERi0=\r\n--b--\r\n");
    common::assert_survives_damage(b"<html><head><title>T</title><script>x</script></head><body><table><tr><td>a&nbsp;&#229;</td></tr></table><!-- c --></body></html>");
    let packed: &[u8] = &[
        b'<',
        b'p',
        b'>',
        b'a',
        b'b',
        b'c',
        0x80,
        0x18,
        0xC0 | b'd',
        0x02,
        0xE5,
        0xE4,
        9,
        9,
        0x83,
    ];
    common::assert_survives_damage(&mobi(2, 0, 1252, 0b11, &[packed, packed]));
}

#[test]
fn random_bytes_behind_every_signature_never_panic() {
    let mut random = common::Random::new(2024);
    let signatures: [&[u8]; 9] = [
        b"PK\x03\x04",
        b"PK\x05\x06",
        b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1",
        b"{\\rtf1",
        b"<html>",
        b"<?xml version=\"1.0\"?><w:wordDocument>",
        b"From: a\nTo: b\n",
        b"%PDF",
        b"",
    ];
    for signature in signatures {
        for _ in 0..60 {
            let mut bytes = signature.to_vec();
            let len = random.below(4096);
            bytes.extend((0..len).map(|_| random.next() as u8));
            let _ = run(&bytes);
            // The Mobipocket signature sits at a fixed offset rather than at the start.
            if bytes.len() >= 68 {
                bytes[60..68].copy_from_slice(b"BOOKMOBI");
                let _ = run(&bytes);
            }
        }
    }
}
