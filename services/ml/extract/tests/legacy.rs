//! Legacy binary Office documents assembled byte by byte inside compound files.

mod common;

use common::{ole, run, text, utf16};
use fdrive_ml_extract::{ExtractError, Format};

// ---------------------------------------------------------------- Word

/// A Word 97 main stream and table stream holding `pieces` (text, compressed?).
fn word(pieces: &[(&str, bool)], flags: u16) -> (Vec<u8>, Vec<u8>) {
    let mut main = vec![0u8; 0x200];
    main[..2].copy_from_slice(&0xA5ECu16.to_le_bytes());
    main[2..4].copy_from_slice(&0x00C1u16.to_le_bytes());
    main[0x0A..0x0C].copy_from_slice(&flags.to_le_bytes());
    let mut positions = vec![0u32];
    let mut descriptors = Vec::new();
    for (text, compressed) in pieces {
        let at = main.len() as u32;
        let chars = if *compressed {
            let bytes = windows_1252(text);
            main.extend_from_slice(&bytes);
            descriptors.push((at * 2) | 0x4000_0000);
            bytes.len() as u32
        } else {
            let bytes = utf16(text);
            main.extend_from_slice(&bytes);
            descriptors.push(at);
            (bytes.len() / 2) as u32
        };
        positions.push(positions.last().unwrap() + chars);
    }
    let mut plc = Vec::new();
    for position in &positions {
        plc.extend_from_slice(&position.to_le_bytes());
    }
    for descriptor in &descriptors {
        plc.extend_from_slice(&[0, 0]);
        plc.extend_from_slice(&descriptor.to_le_bytes());
        plc.extend_from_slice(&[0, 0]);
    }
    // A property block first, as real files have, then the piece table.
    let mut table = vec![0xEE; 7];
    let clx_at = table.len() as u32;
    table.extend_from_slice(&[0x01, 0x02, 0x00, 0xAA, 0xBB, 0x02]);
    table.extend_from_slice(&(plc.len() as u32).to_le_bytes());
    table.extend_from_slice(&plc);
    let clx_len = table.len() as u32 - clx_at;
    main[0x1A2..0x1A6].copy_from_slice(&clx_at.to_le_bytes());
    main[0x1A6..0x1AA].copy_from_slice(&clx_len.to_le_bytes());
    (main, table)
}

/// Windows-1252 bytes for text limited to Latin-1 plus the euro sign.
fn windows_1252(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| {
            if c == '€' {
                0x80
            } else {
                u8::try_from(u32::from(c)).unwrap()
            }
        })
        .collect()
}

#[test]
fn doc_reads_compressed_and_unicode_pieces() {
    let (main, table) = word(
        &[
            ("Räksmörgås kostar 5 €\r", true),
            (
                "Привет, мир 😀\rSee \u{13}HYPERLINK \"x\"\u{14}the link\u{15}.\r",
                false,
            ),
            ("A1\u{07}B1\u{07}\u{07}", true),
        ],
        0x0200,
    );
    let bytes = ole(&[
        ("/WordDocument", &main),
        ("/1Table", &table),
        ("/\u{5}SummaryInformation", b"props"),
    ]);
    let extracted = run(&bytes).unwrap();
    assert_eq!(extracted.format, Format::Doc);
    assert_eq!(
        extracted.text,
        "Räksmörgås kostar 5 €\nПривет, мир 😀\nSee the link.\nA1\tB1"
    );
}

#[test]
fn doc_falls_back_to_the_other_table_stream() {
    let (main, table) = word(&[("in table zero\r", true)], 0x0200);
    assert_eq!(
        text(&ole(&[("/WordDocument", &main), ("/0Table", &table)])),
        "in table zero"
    );
    let (main, table) = word(&[("flag says zero\r", true)], 0);
    assert_eq!(
        text(&ole(&[("/WordDocument", &main), ("/0Table", &table)])),
        "flag says zero"
    );
}

#[test]
fn doc_reports_encryption_and_damage() {
    let (main, table) = word(&[("secret", true)], 0x0300);
    assert!(matches!(
        run(&ole(&[("/WordDocument", &main), ("/1Table", &table)])),
        Err(ExtractError::Encrypted)
    ));

    let (main, _) = word(&[("no table", true)], 0x0200);
    let missing = run(&ole(&[("/WordDocument", &main)]));
    assert!(matches!(missing, Err(ExtractError::Malformed(reason)) if reason.contains("table stream")));

    let (main, table) = word(&[("cut", true)], 0x0200);
    let short_table = run(&ole(&[("/WordDocument", &main), ("/1Table", &table[..8])]));
    assert!(matches!(short_table, Err(ExtractError::Malformed(reason)) if reason.contains("out of range")));

    let (main, mut table) = word(&[("cut", true)], 0x0200);
    table[12] = 0x07;
    let no_pieces = run(&ole(&[("/WordDocument", &main), ("/1Table", &table)]));
    assert!(matches!(no_pieces, Err(ExtractError::Malformed(reason)) if reason.contains("piece table")));

    let short_header = run(&ole(&[("/WordDocument", &main[..0x40]), ("/1Table", &table)]));
    assert!(matches!(short_header, Err(ExtractError::Malformed(reason)) if reason.contains("header")));
    let tiny = run(&ole(&[("/WordDocument", &main[..5])]));
    assert!(matches!(tiny, Err(ExtractError::Malformed(reason)) if reason.contains("header")));
}

#[test]
fn doc_pieces_pointing_past_the_stream_yield_what_exists() {
    let (mut main, table) = word(&[("whole\r", true), ("truncated piece", false)], 0x0200);
    main.truncate(main.len() - 10);
    assert_eq!(
        text(&ole(&[("/WordDocument", &main), ("/1Table", &table)])),
        "whole\ntruncated"
    );
}

/// A Word 6/95 main stream: 8-bit text between two offsets of the header.
fn word95(text: &[u8], flags: u16) -> Vec<u8> {
    let mut main = vec![0u8; 0x300];
    main[..2].copy_from_slice(&0xA5DCu16.to_le_bytes());
    main[2..4].copy_from_slice(&0x0068u16.to_le_bytes());
    main[0x0A..0x0C].copy_from_slice(&flags.to_le_bytes());
    let start = main.len() as u32;
    main.extend_from_slice(text);
    let end = main.len() as u32;
    main[0x18..0x1C].copy_from_slice(&start.to_le_bytes());
    main[0x1C..0x20].copy_from_slice(&end.to_le_bytes());
    main
}

#[test]
fn doc_from_word_95_reads_its_text_range_or_pieces() {
    let main = word95(b"The quick brown fox\rr\xE4ksm\xF6rg\xE5s\r", 0);
    assert_eq!(
        text(&ole(&[("/WordDocument", &main)])),
        "The quick brown fox\nräksmörgås"
    );

    // Fast-saved: a piece table inside the main stream replaces the plain range.
    let mut complex = word95(b"second first ", 0x0004);
    let base = 0x300u32;
    let mut clx = vec![0x02, 28, 0, 0, 0];
    for position in [0u32, 6, 13] {
        clx.extend_from_slice(&position.to_le_bytes());
    }
    for start in [base + 7, base] {
        clx.extend_from_slice(&[0, 0]);
        clx.extend_from_slice(&start.to_le_bytes());
        clx.extend_from_slice(&[0, 0]);
    }
    let clx_at = complex.len() as u32;
    complex.extend_from_slice(&clx);
    complex[0x160..0x164].copy_from_slice(&clx_at.to_le_bytes());
    complex[0x164..0x168].copy_from_slice(&(clx.len() as u32).to_le_bytes());
    assert_eq!(text(&ole(&[("/WordDocument", &complex)])), "first second");

    // 16-bit characters, in the plain range and in pieces.
    let wide = word95(&utf16("Привет, 世界\r"), 0x1000);
    assert_eq!(text(&ole(&[("/WordDocument", &wide)])), "Привет, 世界");
    let mut wide_pieces = word95(&utf16("мир привет "), 0x1004);
    let mut clx = vec![0x02, 28, 0, 0, 0];
    for position in [0u32, 7, 11] {
        clx.extend_from_slice(&position.to_le_bytes());
    }
    for start in [base + 8, base] {
        clx.extend_from_slice(&[0, 0]);
        clx.extend_from_slice(&start.to_le_bytes());
        clx.extend_from_slice(&[0, 0]);
    }
    let clx_at = wide_pieces.len() as u32;
    wide_pieces.extend_from_slice(&clx);
    wide_pieces[0x160..0x164].copy_from_slice(&clx_at.to_le_bytes());
    wide_pieces[0x164..0x168].copy_from_slice(&(clx.len() as u32).to_le_bytes());
    assert_eq!(text(&ole(&[("/WordDocument", &wide_pieces)])), "привет мир");

    let mut reversed = word95(b"text", 0);
    reversed[0x18..0x1C].copy_from_slice(&0x400u32.to_le_bytes());
    reversed[0x1C..0x20].copy_from_slice(&0x300u32.to_le_bytes());
    assert!(
        matches!(run(&ole(&[("/WordDocument", &reversed)])), Err(ExtractError::Malformed(reason)) if reason.contains("out of range"))
    );
    let short = word95(b"", 0);
    assert!(
        matches!(run(&ole(&[("/WordDocument", &short[..0x1A])])), Err(ExtractError::Malformed(reason)) if reason.contains("header"))
    );
}

/// A summary property set whose only property is the code page.
fn summary(page: u16) -> Vec<u8> {
    let mut out = vec![0xFE, 0xFF, 0, 0, 2, 0, 0, 0];
    out.extend_from_slice(&[0; 16]);
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&[0xE0; 16]);
    out.extend_from_slice(&48u32.to_le_bytes());
    // The section: size, property count, then (id, offset) pairs and the values.
    out.extend_from_slice(&32u32.to_le_bytes());
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&[2, 0, 0, 0, 24, 0, 0, 0]);
    out.extend_from_slice(&[1, 0, 0, 0, 24, 0, 0, 0]);
    out.extend_from_slice(&[2, 0, 0, 0]);
    out.extend_from_slice(&page.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

#[test]
fn doc_from_word_95_uses_the_code_page_of_its_summary() {
    let main = word95(b"\xCF\xF0\xE8\xE2\xE5\xF2\r", 0);
    let cyrillic = ole(&[("/WordDocument", &main), ("/\u{5}SummaryInformation", &summary(1251))]);
    assert_eq!(text(&cyrillic), "Привет");
    // No summary, or one too damaged to read, leaves Windows-1252.
    assert_eq!(text(&ole(&[("/WordDocument", &main)])), "Ïðèâåò");
    for cut in [10, 47, 54, 60, 70] {
        let damaged = ole(&[
            ("/WordDocument", &main),
            ("/\u{5}SummaryInformation", &summary(1251)[..cut]),
        ]);
        assert_eq!(text(&damaged), "Ïðèâåò", "summary cut at {cut}");
    }
    let no_code_page = ole(&[
        ("/WordDocument", &main),
        (
            "/\u{5}SummaryInformation",
            &summary(1251)
                .iter()
                .map(|&byte| if byte == 1 { 9 } else { byte })
                .collect::<Vec<u8>>(),
        ),
    ]);
    assert_eq!(text(&no_code_page), "Ïðèâåò");
}

// ---------------------------------------------------------------- Excel

fn record(id: u16, data: &[u8]) -> Vec<u8> {
    let mut out = id.to_le_bytes().to_vec();
    out.extend_from_slice(&(data.len() as u16).to_le_bytes());
    out.extend_from_slice(data);
    out
}

fn cell(row: u16, column: u16, format: u16, value: &[u8]) -> Vec<u8> {
    let mut out = row.to_le_bytes().to_vec();
    out.extend_from_slice(&column.to_le_bytes());
    out.extend_from_slice(&format.to_le_bytes());
    out.extend_from_slice(value);
    out
}

/// A BIFF8 string body: flags byte, then compressed or wide characters.
fn biff8(text: &str, wide: bool) -> Vec<u8> {
    let mut out = vec![u8::from(wide)];
    if wide {
        out.extend_from_slice(&utf16(text));
    } else {
        out.extend(text.chars().map(|c| c as u8));
    }
    out
}

fn sheet_name(name: &str) -> Vec<u8> {
    let mut data = vec![0, 0, 0, 0, 0, 0, name.chars().count() as u8];
    data.extend_from_slice(&biff8(name, true));
    data
}

const BOF: u16 = 0x0809;
const EOF: u16 = 0x000A;

fn bof(version: u16, kind: u16) -> Vec<u8> {
    let mut data = version.to_le_bytes().to_vec();
    data.extend_from_slice(&kind.to_le_bytes());
    data.extend_from_slice(&[0; 12]);
    record(BOF, &data)
}

fn workbook_globals(date1904: bool) -> Vec<u8> {
    let mut book = bof(0x0600, 0x0005);
    book.extend(record(0x0042, &1200u16.to_le_bytes()));
    book.extend(record(0x0022, &u16::from(date1904).to_le_bytes()));
    // A custom date format, then three cell formats: general, the custom one, built-in 14.
    let mut format = 164u16.to_le_bytes().to_vec();
    format.extend_from_slice(&10u16.to_le_bytes());
    format.extend_from_slice(&biff8("yyyy-mm-dd", false));
    book.extend(record(0x041E, &format));
    for id in [0u16, 164, 14] {
        let mut xf = vec![0, 0];
        xf.extend_from_slice(&id.to_le_bytes());
        xf.extend_from_slice(&[0; 16]);
        book.extend(record(0x00E0, &xf));
    }
    book.extend(record(0x0085, &sheet_name("Försäljning")));
    book.extend(record(0x0085, &sheet_name("Diagram")));
    book.extend(record(0x0085, &sheet_name("Sista")));
    // Shared strings: "Region" compressed, then "Intäkt" split across a CONTINUE record.
    let mut sst = vec![2, 0, 0, 0, 2, 0, 0, 0, 6, 0];
    sst.extend_from_slice(&biff8("Region", false));
    sst.extend_from_slice(&[6, 0, 0, b'I', b'n']);
    book.extend(record(0x00FC, &sst));
    let mut rest = vec![1];
    rest.extend_from_slice(&utf16("täkt"));
    book.extend(record(0x003C, &rest));
    book.extend(record(EOF, &[]));
    book
}

fn workbook(date1904: bool) -> Vec<u8> {
    let mut book = workbook_globals(date1904);
    book.extend(bof(0x0600, 0x0010));
    book.extend(record(0x00FD, &cell(0, 0, 0, &0u32.to_le_bytes())));
    book.extend(record(0x00FD, &cell(0, 1, 0, &1u32.to_le_bytes())));
    book.extend(record(0x00FD, &cell(0, 2, 0, &7u32.to_le_bytes())));
    let mut label = 4u16.to_le_bytes().to_vec();
    label.extend_from_slice(&biff8("Norr", false));
    book.extend(record(0x0204, &cell(1, 0, 0, &label)));
    book.extend(record(0x0203, &cell(1, 1, 0, &420.5f64.to_le_bytes())));
    book.extend(record(0x0203, &cell(1, 2, 1, &45351f64.to_le_bytes())));
    book.extend(record(0x027E, &cell(1, 3, 0, &((42u32 << 2) | 2).to_le_bytes())));
    book.extend(record(0x027E, &cell(1, 4, 2, &((45351u32 << 2) | 2).to_le_bytes())));
    // Three RK cells in one record: columns 0 to 2 of row 2, the last one a date.
    let mut multiple = 2u16.to_le_bytes().to_vec();
    multiple.extend_from_slice(&0u16.to_le_bytes());
    for (format, value) in [(0u16, 1u32), (0, 2), (1, 61)] {
        multiple.extend_from_slice(&format.to_le_bytes());
        multiple.extend_from_slice(&((value << 2) | 2).to_le_bytes());
    }
    multiple.extend_from_slice(&2u16.to_le_bytes());
    book.extend(record(0x00BD, &multiple));
    // Formulas: a number, a boolean, an error, and a string that follows in its own record.
    let mut formula = 3.25f64.to_le_bytes().to_vec();
    formula.extend_from_slice(&[0; 6]);
    book.extend(record(0x0006, &cell(3, 0, 0, &formula)));
    book.extend(record(0x0006, &cell(3, 1, 0, &[1, 0, 1, 0, 0, 0, 0xFF, 0xFF])));
    book.extend(record(0x0006, &cell(3, 2, 0, &[2, 0, 7, 0, 0, 0, 0xFF, 0xFF])));
    book.extend(record(0x0006, &cell(3, 3, 0, &[0, 0, 0, 0, 0, 0, 0xFF, 0xFF])));
    let mut string = 5u16.to_le_bytes().to_vec();
    string.extend_from_slice(&biff8("Summa", true));
    book.extend(record(0x0207, &string));
    book.extend(record(0x0207, &string));
    book.extend(record(0x0205, &cell(4, 0, 0, &[1, 0])));
    book.extend(record(0x0205, &cell(4, 1, 0, &[0, 0])));
    book.extend(record(0x0205, &cell(4, 2, 0, &[7, 1])));
    book.extend(record(0x0201, &cell(4, 3, 0, &[])));
    // An embedded chart substream, whose records are not cells of this sheet.
    book.extend(bof(0x0600, 0x0020));
    book.extend(record(0x0203, &cell(9, 9, 0, &999f64.to_le_bytes())));
    book.extend(record(EOF, &[]));
    book.extend(record(EOF, &[]));
    book.extend(bof(0x0600, 0x0020));
    book.extend(record(EOF, &[]));
    book.extend(bof(0x0600, 0x0010));
    let mut rich = 2u16.to_le_bytes().to_vec();
    rich.extend_from_slice(&[0x0D, 1, 0, 2, 0, 0, 0]);
    rich.extend_from_slice(&utf16("åä"));
    rich.extend_from_slice(&[0; 6]);
    book.extend(record(0x00D6, &cell(0, 0, 0, &rich)));
    book.extend(record(EOF, &[]));
    book
}

#[test]
fn xls_reads_every_cell_kind_sheet_by_sheet() {
    let extracted = run(&ole(&[("/Workbook", &workbook(false))])).unwrap();
    assert_eq!(extracted.format, Format::Xls);
    assert_eq!(
        extracted.text,
        "Försäljning\nRegion\tIntäkt\nNorr\t420.5\t2024-02-29\t42\t2024-02-29\n1\t2\t1900-03-01\n3.25\tTRUE\tSumma\nTRUE\tFALSE\nDiagram\nSista\nåä"
    );
}

#[test]
fn xls_honours_the_1904_date_system() {
    assert!(text(&ole(&[("/Workbook", &workbook(true))])).contains("Norr\t420.5\t2028-03-01\t42\t2028-03-01"));
}

#[test]
fn xls_from_excel_95_reads_code_page_strings() {
    let mut book = bof(0x0500, 0x0005);
    book.extend(record(0x0042, &1251u16.to_le_bytes()));
    let mut format = 164u16.to_le_bytes().to_vec();
    format.extend_from_slice(b"\x08dd/mm/yy");
    book.extend(record(0x041E, &format));
    for id in [0u16, 164] {
        book.extend(record(
            0x00E0,
            &[&[0, 0][..], &id.to_le_bytes()[..], &[0; 12][..]].concat(),
        ));
    }
    book.extend(record(
        0x0085,
        &[&[0, 0, 0, 0, 0, 0, 4][..], &b"\xCB\xE8\xF1\xF2"[..]].concat(),
    ));
    book.extend(record(EOF, &[]));
    book.extend(bof(0x0500, 0x0010));
    book.extend(record(
        0x0204,
        &cell(
            0,
            0,
            0,
            &[&6u16.to_le_bytes()[..], &b"\xCF\xF0\xE8\xE2\xE5\xF2"[..]].concat(),
        ),
    ));
    book.extend(record(0x0203, &cell(0, 1, 1, &36526f64.to_le_bytes())));
    book.extend(record(EOF, &[]));
    assert_eq!(text(&ole(&[("/Book", &book)])), "Лист\nПривет\t2000-01-01");
}

#[test]
fn xls_reports_encryption_and_damage() {
    let mut locked = bof(0x0600, 0x0005);
    locked.extend(record(0x002F, &[1, 0, 1, 0, 1, 0]));
    assert!(matches!(
        run(&ole(&[("/Workbook", &locked)])),
        Err(ExtractError::Encrypted)
    ));
    let garbage = run(&ole(&[("/Workbook", &[0xAB; 64])]));
    assert!(matches!(garbage, Err(ExtractError::Malformed(reason)) if reason.contains("no workbook records")));

    // Records that end early are skipped rather than trusted.
    let mut book = workbook_globals(false);
    book.extend(bof(0x0600, 0x0010));
    for id in [0x00FD, 0x0204, 0x0203, 0x027E, 0x00BD, 0x0006, 0x0205, 0x0207] {
        book.extend(record(id, &[1]));
        book.extend(record(id, &cell(0, 0, 0, &[])));
    }
    book.extend(record(0x00FD, &cell(1, 0, 0, &0u32.to_le_bytes())));
    book.extend(record(0x00FC, &[1, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, b'a']));
    book.extend_from_slice(&[0x3C, 0x00, 0xFF, 0xFF, 1, 2, 3]);
    assert_eq!(text(&ole(&[("/Workbook", &book)])), "Försäljning\nRegion");
}

// ---------------------------------------------------------------- PowerPoint

fn atom(kind: u16, instance: u16, body: &[u8]) -> Vec<u8> {
    let mut out = (instance << 4).to_le_bytes().to_vec();
    out.extend_from_slice(&kind.to_le_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    out
}

fn container(kind: u16, instance: u16, children: &[Vec<u8>]) -> Vec<u8> {
    let body = children.concat();
    let mut out = ((instance << 4) | 0x000F).to_le_bytes().to_vec();
    out.extend_from_slice(&kind.to_le_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

fn persist(reference: u32) -> Vec<u8> {
    let mut body = reference.to_le_bytes().to_vec();
    body.extend_from_slice(&[0; 16]);
    atom(0x03F3, 0, &body)
}

fn chars(text: &str) -> Vec<u8> {
    atom(0x0FA0, 0, &utf16(text))
}

fn bytes(text: &str) -> Vec<u8> {
    atom(0x0FA8, 0, text.as_bytes())
}

/// A slide or notes page whose drawing holds one text box per entry of `boxes`.
fn page(kind: u16, boxes: &[Vec<u8>]) -> Vec<u8> {
    let shapes: Vec<Vec<u8>> = boxes
        .iter()
        // A text box that declares itself an atom, as most real ones do.
        .map(|text| container(0xF004, 0, &[atom(0xF00A, 0, &[0; 8]), atom(0xF00D, 0, text)]))
        .collect();
    container(
        kind,
        0,
        &[
            atom(0x03EF, 0, &[0; 24]),
            container(0x040C, 0, &[container(0xF002, 0, &[container(0xF003, 0, &shapes)])]),
        ],
    )
}

struct Deck {
    stream: Vec<u8>,
    current_user: Vec<u8>,
}

/// A presentation with two slides shown in the order 4, 3, one notes page, a
/// superseded copy of a slide, and an earlier edit behind the newest one.
fn deck(edit_len: usize, token: u32) -> Deck {
    let document = container(
        0x03E8,
        0,
        &[
            atom(0x03E9, 0, &[0; 40]),
            container(
                0x0FD9,
                3,
                &[atom(0x0FDA, 0, &[0; 4]), atom(0x0FBA, 2, &utf16("Confidential footer"))],
            ),
            container(
                0x1388,
                0,
                &[container(0x138A, 0, &[atom(0x0FBA, 0, &utf16("___PPT10"))])],
            ),
            container(0x0FF0, 1, &[persist(2), chars("Click to edit Master title style")]),
            container(
                0x0FF0,
                0,
                &[
                    persist(4),
                    atom(0x0F9F, 0, &[0; 4]),
                    chars("Shown first\rwith a second line\u{0B}and a third"),
                    persist(3),
                    atom(0x0F9F, 0, &[1, 0, 0, 0]),
                    bytes("Shown second"),
                    persist(6),
                ],
            ),
            container(0x0FF0, 2, &[persist(5)]),
        ],
    );
    let stale = page(0x03EE, &[chars("Superseded text")]);
    let slide_three = page(0x03EE, &[bytes("Shown second"), bytes("Box on the second slide")]);
    let slide_four = page(
        0x03EE,
        &[
            chars("Box on the first slide"),
            atom(
                0x138B,
                0,
                &container(
                    0x2EE0,
                    0,
                    &[
                        atom(0x0FBA, 0, &utf16("Reviewer")),
                        atom(0x0FBA, 1, &utf16("Please check this")),
                    ],
                ),
            ),
        ],
    );
    let notes = page(0x03F0, &[bytes("*"), chars("Speaker notes")]);
    let master = container(0x03F8, 0, &[chars("Master body text")]);

    let mut stream = Vec::new();
    let mut place = |record: &[u8]| {
        let at = stream.len() as u32;
        stream.extend_from_slice(record);
        at
    };
    let document_at = place(&document);
    let master_at = place(&master);
    let stale_at = place(&stale);
    let directory = |entries: &[(u32, &[u32])]| {
        let mut body = Vec::new();
        for (first, offsets) in entries {
            body.extend_from_slice(&(((offsets.len() as u32) << 20) | first).to_le_bytes());
            for offset in *offsets {
                body.extend_from_slice(&offset.to_le_bytes());
            }
        }
        atom(0x1772, 0, &body)
    };
    let edit = |previous: u32, directory_at: u32, len: usize| {
        let mut body = vec![0u8; len];
        body[8..12].copy_from_slice(&previous.to_le_bytes());
        body[12..16].copy_from_slice(&directory_at.to_le_bytes());
        body[16..20].copy_from_slice(&1u32.to_le_bytes());
        atom(0x0FF5, 0, &body)
    };
    // The first save: document, master, and slide 4 in its superseded form.
    let old_directory_at = place(&directory(&[(1, &[document_at, master_at]), (4, &[stale_at])]));
    let old_edit_at = place(&edit(0, old_directory_at, 28));
    let three_at = place(&slide_three);
    let four_at = place(&slide_four);
    let notes_at = place(&notes);
    let new_directory_at = place(&directory(&[(3, &[three_at, four_at, notes_at])]));
    let new_edit_at = place(&edit(old_edit_at, new_directory_at, edit_len));

    let mut body = 0x14u32.to_le_bytes().to_vec();
    body.extend_from_slice(&token.to_le_bytes());
    body.extend_from_slice(&new_edit_at.to_le_bytes());
    body.extend_from_slice(&[0; 8]);
    Deck {
        stream,
        current_user: atom(0x0FF6, 0, &body),
    }
}

const PLAIN_TOKEN: u32 = 0xE391_C05F;

#[test]
fn ppt_reads_live_slides_in_order_then_notes_and_footers() {
    let deck = deck(28, PLAIN_TOKEN);
    let extracted = run(&ole(&[
        ("/PowerPoint Document", &deck.stream),
        ("/Current User", &deck.current_user),
    ]))
    .unwrap();
    assert_eq!(extracted.format, Format::Ppt);
    assert_eq!(
        extracted.text,
        "Shown first\nwith a second line\nand a third\nBox on the first slide\nReviewer\nPlease check this\nShown second\nBox on the second slide\nSpeaker notes\nConfidential footer"
    );
}

#[test]
fn ppt_without_a_usable_directory_reads_every_text_record() {
    let deck = deck(28, PLAIN_TOKEN);
    let expected = "Confidential footer\nShown first\nwith a second line\nand a third\nShown second\nSuperseded text\nShown second\nBox on the second slide\nBox on the first slide\nReviewer\nPlease check this\nSpeaker notes";
    assert_eq!(text(&ole(&[("/PowerPoint Document", &deck.stream)])), expected);

    // A "Current User" stream pointing nowhere, at a non-edit, or at an edit with a bad directory.
    for target in [0xFFFF_FF00u32, 0, 8] {
        let mut current = deck.current_user.clone();
        current[16..20].copy_from_slice(&target.to_le_bytes());
        assert_eq!(
            text(&ole(&[
                ("/PowerPoint Document", &deck.stream),
                ("/Current User", &current)
            ])),
            expected
        );
    }
    let mut broken = deck.stream.clone();
    let edit_at = u32::from_le_bytes(deck.current_user[16..20].try_into().unwrap()) as usize;
    broken[edit_at + 8 + 12..edit_at + 8 + 16].copy_from_slice(&3u32.to_le_bytes());
    assert_eq!(
        text(&ole(&[
            ("/PowerPoint Document", &broken),
            ("/Current User", &deck.current_user)
        ])),
        expected
    );
}

#[test]
fn ppt_reports_encryption_and_a_missing_stream() {
    let by_edit = deck(32, PLAIN_TOKEN);
    let result = run(&ole(&[
        ("/PowerPoint Document", &by_edit.stream),
        ("/Current User", &by_edit.current_user),
    ]));
    assert!(matches!(result, Err(ExtractError::Encrypted)));
    let by_token = deck(28, 0xF3D1_C4DF);
    let result = run(&ole(&[
        ("/PowerPoint Document", &by_token.stream),
        ("/Current User", &by_token.current_user),
    ]));
    assert!(matches!(result, Err(ExtractError::Encrypted)));
}

#[test]
fn ppt_with_a_directory_that_reaches_no_slides_falls_back() {
    // The directory resolves the document, but its slide list is empty.
    let document = container(
        0x03E8,
        0,
        &[
            container(0x0FF0, 0, &[]),
            container(0x0FD9, 3, &[atom(0x0FBA, 2, &utf16("Footer only"))]),
        ],
    );
    let mut stream = document.clone();
    let directory_at = stream.len() as u32;
    stream.extend(atom(
        0x1772,
        0,
        &[&((1u32 << 20) | 1).to_le_bytes()[..], &0u32.to_le_bytes()[..]].concat(),
    ));
    let edit_at = stream.len() as u32;
    let mut edit = vec![0u8; 28];
    // An edit naming itself as its predecessor must not loop.
    edit[8..12].copy_from_slice(&edit_at.to_le_bytes());
    edit[12..16].copy_from_slice(&directory_at.to_le_bytes());
    edit[16..20].copy_from_slice(&1u32.to_le_bytes());
    stream.extend(atom(0x0FF5, 0, &edit));
    let mut current = vec![0u8; 20];
    current[16..20].copy_from_slice(&edit_at.to_le_bytes());
    assert_eq!(
        text(&ole(&[("/PowerPoint Document", &stream), ("/Current User", &current)])),
        "Footer only"
    );
}

// ---------------------------------------------------------------- Outlook

/// A property stream header followed by `(tag, value)` entries.
fn properties(entries: &[(u32, u32)]) -> Vec<u8> {
    let mut out = vec![0u8; 32];
    for (tag, value) in entries {
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&value.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
    }
    out
}

#[test]
fn msg_reads_unicode_properties_and_attachment_names() {
    let bytes = ole(&[
        ("/__properties_version1.0", &properties(&[])),
        ("/__substg1.0_0037001F", &utf16("Kvartalsrapport\0")),
        ("/__substg1.0_0C1A001F", &utf16("Åsa Öberg")),
        ("/__substg1.0_5D01001F", &utf16("asa@example.com")),
        ("/__substg1.0_0E04001F", &utf16("Bo Ek; Li Wu")),
        ("/__substg1.0_0E03001F", &utf16("  ")),
        ("/__substg1.0_1000001F", &utf16("Hej,\r\n\r\nRapporten är klar.\r\n")),
        ("/__substg1.0_10130102", b"<p>ignored when there is a text body</p>"),
        (
            "/__attach_version1.0_#00000000/__substg1.0_3707001F",
            &utf16("rapport.pdf"),
        ),
        ("/__attach_version1.0_#00000001/__substg1.0_3704001E", b"BILAGA~1.XLS"),
        ("/__attach_version1.0_#00000002/__substg1.0_37010102", b"\x00\x01"),
        ("/__substg1.0_0E02001F", &utf16("Hemlig Mottagare")),
        ("/__recip_version1.0_#00000000/__substg1.0_3001001F", &utf16("Bo Ek")),
        (
            "/__recip_version1.0_#00000000/__substg1.0_39FE001F",
            &utf16("bo.ek@example.com"),
        ),
        (
            "/__recip_version1.0_#00000001/__substg1.0_3001001F",
            &utf16("li@example.com"),
        ),
        (
            "/__recip_version1.0_#00000001/__substg1.0_3003001F",
            &utf16("li@example.com"),
        ),
        ("/__recip_version1.0_#00000002/__substg1.0_0FFF0102", b"\x00"),
    ]);
    let extracted = run(&bytes).unwrap();
    assert_eq!(extracted.format, Format::Msg);
    assert_eq!(
        extracted.text,
        "Subject: Kvartalsrapport\nFrom: Åsa Öberg <asa@example.com>\nTo: Bo Ek; Li Wu\nBcc: Hemlig Mottagare\nRecipient: Bo Ek <bo.ek@example.com>\nRecipient: li@example.com\nHej,\nRapporten är klar.\nAttachment: rapport.pdf\nAttachment: BILAGA~1.XLS"
    );
}

#[test]
fn msg_decodes_narrow_strings_in_the_message_code_page() {
    let bytes = ole(&[
        (
            "/__properties_version1.0",
            &properties(&[(0x0E1D_001E, 0), (0x3FFD_0003, 1251)]),
        ),
        ("/__substg1.0_0037001E", b"\xCF\xF0\xE8\xE2\xE5\xF2"),
        ("/__substg1.0_0C1A001E", b"no-reply@example.com"),
        ("/__substg1.0_0C1F001E", b"no-reply@example.com"),
        (
            "/__substg1.0_10130102",
            b"<html><body><p>\xCC\xE8\xF0 &amp; \xF2\xF0\xF3\xE4</p></body></html>",
        ),
    ]);
    assert_eq!(text(&bytes), "Subject: Привет\nFrom: no-reply@example.com\nМир & труд");

    let internet = ole(&[
        ("/__properties_version1.0", &properties(&[(0x3FDE_0003, 28592)])),
        ("/__substg1.0_0037001E", b"\xA3\xF3d\xBC"),
        ("/__substg1.0_0C1F001E", b"SMTP-less"),
        ("/__substg1.0_1013001F", &utf16("<b>html as a string</b>")),
    ]);
    assert_eq!(text(&internet), "Subject: Łódź\nFrom: SMTP-less\nhtml as a string");

    let utf8_html = ole(&[("/__substg1.0_10130102", "<p>räksmörgås</p>".as_bytes())]);
    assert_eq!(text(&utf8_html), "räksmörgås");
    let bare = ole(&[("/__properties_version1.0", &[0; 8])]);
    assert_eq!(text(&bare), "");
}

// ---------------------------------------------------------------- damage

#[test]
fn damaged_files_never_panic() {
    let (main, table) = word(
        &[("Räksmörgås\r", true), ("Привет\u{13}x\u{14}y\u{15}\r", false)],
        0x0200,
    );
    common::assert_survives_damage(&ole(&[("/WordDocument", &main), ("/1Table", &table)]));
    common::assert_survives_damage(&ole(&[("/WordDocument", &word95(b"The quick brown fox\r", 0))]));
    common::assert_survives_damage(&ole(&[("/Workbook", &workbook(false))]));
    let deck = deck(28, PLAIN_TOKEN);
    common::assert_survives_damage(&ole(&[
        ("/PowerPoint Document", &deck.stream),
        ("/Current User", &deck.current_user),
    ]));
    common::assert_survives_damage(&ole(&[
        ("/__properties_version1.0", &properties(&[(0x3FFD_0003, 1251)])),
        ("/__substg1.0_0037001F", &utf16("Subject")),
        ("/__substg1.0_1000001E", b"Body"),
        ("/__attach_version1.0_#00000000/__substg1.0_3707001F", &utf16("a.pdf")),
    ]));
    for name in ["report.doc", "sales.xls"] {
        common::assert_survives_damage(&common::fixture(name));
    }
}

#[test]
fn damaged_record_streams_never_panic() {
    // Damage inside the streams themselves, where a container-level cut never reaches.
    let limits = fdrive_ml_extract::Limits::default();
    let deck = deck(28, PLAIN_TOKEN);
    let (main, table) = word(&[("Räksmörgås\r", true), ("Привет\r", false)], 0x0200);
    let book = workbook(false);
    let mut random = common::Random::new(42);
    for _ in 0..400 {
        let mut stream = deck.stream.clone();
        let mut current = deck.current_user.clone();
        let mut damaged_main = main.clone();
        let mut damaged_table = table.clone();
        let mut damaged_book = book.clone();
        for target in [
            &mut stream,
            &mut current,
            &mut damaged_main,
            &mut damaged_table,
            &mut damaged_book,
        ] {
            for _ in 0..=random.below(3) {
                let at = random.below(target.len());
                target[at] = random.next() as u8;
            }
            if random.below(4) == 0 {
                let keep = random.below(target.len());
                target.truncate(keep);
            }
        }
        let _ = fdrive_ml_extract::extract(
            &ole(&[("/PowerPoint Document", &stream), ("/Current User", &current)]),
            &limits,
        );
        let _ = fdrive_ml_extract::extract(
            &ole(&[("/WordDocument", &damaged_main), ("/1Table", &damaged_table)]),
            &limits,
        );
        let _ = fdrive_ml_extract::extract(&ole(&[("/Workbook", &damaged_book)]), &limits);
    }
}
