//! Inputs built to make careless parsing slow or large. Each of these would
//! run for hours, or allocate gigabytes, if a parser rescanned its input or
//! grew state with it; they pass by finishing at all.

mod common;

use common::{ole, run, text, utf16};
use fdrive_ml_extract::Format;

#[test]
fn html_with_endless_stray_markup_is_read_in_one_pass() {
    let brackets = format!("<html>{}", "a < ".repeat(500_000));
    assert!(text(brackets.as_bytes()).starts_with("a < a < a <"));

    let ampersands = format!("<html>{}", "&".repeat(2_000_000));
    assert_eq!(text(ampersands.as_bytes()).len(), 2_000_000);

    let scripts = format!("<html>{}<p>after</p>", "<script>x</script>".repeat(200_000));
    assert_eq!(text(scripts.as_bytes()), "after");

    let unfinished = format!("<html>{}", "<a href=\"".repeat(200_000));
    assert_eq!(text(unfinished.as_bytes()), "");
}

#[test]
fn rtf_made_of_braces_keeps_a_bounded_stack() {
    let mut rtf = b"{\\rtf1 start".to_vec();
    rtf.resize(rtf.len() + 5_000_000, b'{');
    rtf.extend_from_slice(b" end");
    let extracted = run(&rtf).unwrap();
    assert_eq!((extracted.format, extracted.text.as_str()), (Format::Rtf, "start end"));
}

#[test]
fn ppt_with_deeply_nested_containers_is_read_in_one_pass() {
    let depth = 400_000usize;
    let text_atom = {
        let body = utf16("at the bottom");
        let mut atom = vec![0x00, 0x00, 0xA0, 0x0F];
        atom.extend_from_slice(&(body.len() as u32).to_le_bytes());
        atom.extend_from_slice(&body);
        atom
    };
    let mut stream = Vec::with_capacity(depth * 8 + text_atom.len());
    for level in 0..depth {
        let inside = (depth - level - 1) * 8 + text_atom.len();
        stream.extend_from_slice(&[0x0F, 0x00, 0x88, 0x13]);
        stream.extend_from_slice(&(inside as u32).to_le_bytes());
    }
    stream.extend_from_slice(&text_atom);
    assert_eq!(text(&ole(&[("/PowerPoint Document", &stream)])), "at the bottom");
}

#[test]
fn xls_with_a_million_shared_strings_stays_compact() {
    let record = |id: u16, data: &[u8]| {
        let mut out = id.to_le_bytes().to_vec();
        out.extend_from_slice(&(data.len() as u16).to_le_bytes());
        out.extend_from_slice(data);
        out
    };
    let mut book = record(0x0809, &[0x00, 0x06, 0x05, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // One SST record with a string, then CONTINUE records full of empty strings.
    book.extend(record(0x00FC, &[1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, b'o', b'k']));
    let empties = [0u8; 8190];
    for _ in 0..400 {
        book.extend(record(0x003C, &empties));
    }
    book.extend(record(0x000A, &[]));
    book.extend(record(
        0x0809,
        &[0x00, 0x06, 0x10, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ));
    for row in 0..50_000u32 {
        let mut cell = (row as u16).to_le_bytes().to_vec();
        cell.extend_from_slice(&[0, 0, 0, 0]);
        cell.extend_from_slice(&(row % 2).to_le_bytes());
        book.extend(record(0x00FD, &cell));
    }
    book.extend(record(0x000A, &[]));
    let extracted = run(&ole(&[("/Workbook", &book)])).unwrap();
    assert_eq!(extracted.text.lines().count(), 25_000);
    assert!(extracted.text.lines().all(|line| line == "ok"));
}

#[test]
fn msg_lists_a_bounded_number_of_attachments() {
    let names: Vec<String> = (0..300)
        .map(|index| format!("/__attach_version1.0_#{index:08X}/__substg1.0_3707001F"))
        .collect();
    let content = utf16("file.pdf");
    let mut streams: Vec<(&str, &[u8])> = vec![("/__substg1.0_0037001F", &content)];
    streams.extend(names.iter().map(|name| (name.as_str(), content.as_slice())));
    let extracted = run(&ole(&streams)).unwrap();
    assert_eq!(extracted.format, Format::Msg);
    assert_eq!(
        extracted
            .text
            .lines()
            .filter(|line| *line == "Attachment: file.pdf")
            .count(),
        256
    );
}
