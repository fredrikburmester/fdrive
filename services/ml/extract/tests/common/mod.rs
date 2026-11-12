//! Builders shared by the integration tests.
#![allow(dead_code)] // every test binary uses its own subset

use std::io::{Cursor, Write};
use std::path::Path;

use fdrive_ml_extract::{ExtractError, Extracted, Limits, extract};
use zip::write::SimpleFileOptions;

/// A ZIP archive with the given members, in order.
pub fn zip(members: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in members {
        writer.start_file(*name, SimpleFileOptions::default()).unwrap();
        writer.write_all(content).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// A compound file with the given streams; storages in a path are created as needed.
pub fn ole(streams: &[(&str, &[u8])]) -> Vec<u8> {
    ole_version(cfb::Version::V4, streams)
}

/// The same with 512-byte sectors, the layout the legacy Office applications wrote.
pub fn ole_small_sectors(streams: &[(&str, &[u8])]) -> Vec<u8> {
    ole_version(cfb::Version::V3, streams)
}

fn ole_version(version: cfb::Version, streams: &[(&str, &[u8])]) -> Vec<u8> {
    let mut file = cfb::CompoundFile::create_with_version(version, Cursor::new(Vec::new())).unwrap();
    for (path, content) in streams {
        if let Some(parent) = Path::new(path).parent() {
            file.create_storage_all(parent).unwrap();
        }
        file.create_stream(path).unwrap().write_all(content).unwrap();
    }
    file.flush().unwrap();
    file.into_inner().into_inner()
}

pub fn run(bytes: &[u8]) -> Result<Extracted, ExtractError> {
    extract(bytes, &Limits::default())
}

/// The text of a document that must extract.
pub fn text(bytes: &[u8]) -> String {
    run(bytes).unwrap().text
}

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap()
}

pub const CONTENT_TYPES: &[u8] =
    br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>"#;

/// A relationships part with `(id, type suffix, target)` entries.
pub fn rels(entries: &[(&str, &str, &str)]) -> Vec<u8> {
    let mut xml = String::from(
        r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for (id, kind, target) in entries {
        xml.push_str(&format!(
            r#"<Relationship Id="{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{target}"/>"#
        ));
    }
    xml.push_str("</Relationships>");
    xml.into_bytes()
}

/// UTF-16LE bytes of `text`.
pub fn utf16(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

/// A small deterministic generator, so a failing input can be reproduced.
pub struct Random(u64);

impl Random {
    pub fn new(seed: u64) -> Self {
        Self(seed | 1)
    }

    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    pub fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound.max(1) as u64) as usize
    }
}

/// Feeds damaged copies of `bytes` to the extractor: cut short at many
/// lengths, with bytes flipped, and with whole runs overwritten. Any result
/// is acceptable; a panic or a hang is not.
pub fn assert_survives_damage(bytes: &[u8]) {
    let limits = Limits {
        max_part_bytes: 8 << 20,
        max_total_bytes: 16 << 20,
        max_text_chars: 100_000,
    };
    let step = (bytes.len() / 300).max(1);
    for cut in (0..bytes.len())
        .step_by(step)
        .chain(bytes.len().saturating_sub(64)..bytes.len())
    {
        let _ = extract(&bytes[..cut], &limits);
    }
    let mut random = Random::new(bytes.len() as u64 * 0x9E37_79B9 + 7);
    for _ in 0..300 {
        let mut damaged = bytes.to_vec();
        for _ in 0..=random.below(4) {
            let at = random.below(damaged.len());
            damaged[at] = random.next() as u8;
        }
        let _ = extract(&damaged, &limits);
    }
    for fill in [0x00, 0xFF, 0x41] {
        for _ in 0..40 {
            let mut damaged = bytes.to_vec();
            let at = random.below(damaged.len());
            let end = (at + 1 + random.below(64)).min(damaged.len());
            damaged[at..end].fill(fill);
            let _ = extract(&damaged, &limits);
        }
    }
}
