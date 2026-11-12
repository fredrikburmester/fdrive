//! Bounds-checked readers for binary formats, and legacy text decoding.

use encoding_rs::Encoding;

pub(crate) fn u8_at(bytes: &[u8], at: usize) -> Option<u8> {
    bytes.get(at).copied()
}

pub(crate) fn u16le(bytes: &[u8], at: usize) -> Option<u16> {
    let raw = bytes.get(at..at.checked_add(2)?)?;
    Some(u16::from_le_bytes(raw.try_into().ok()?))
}

pub(crate) fn u32le(bytes: &[u8], at: usize) -> Option<u32> {
    let raw = bytes.get(at..at.checked_add(4)?)?;
    Some(u32::from_le_bytes(raw.try_into().ok()?))
}

pub(crate) fn u16be(bytes: &[u8], at: usize) -> Option<u16> {
    let raw = bytes.get(at..at.checked_add(2)?)?;
    Some(u16::from_be_bytes(raw.try_into().ok()?))
}

pub(crate) fn u32be(bytes: &[u8], at: usize) -> Option<u32> {
    let raw = bytes.get(at..at.checked_add(4)?)?;
    Some(u32::from_be_bytes(raw.try_into().ok()?))
}

pub(crate) fn f64le(bytes: &[u8], at: usize) -> Option<f64> {
    let raw = bytes.get(at..at.checked_add(8)?)?;
    Some(f64::from_le_bytes(raw.try_into().ok()?))
}

/// `bytes[at..at + len]`, or `None` when any of it is out of range.
pub(crate) fn span(bytes: &[u8], at: usize, len: usize) -> Option<&[u8]> {
    bytes.get(at..at.checked_add(len)?)
}

/// UTF-16LE to text; an odd trailing byte and unpaired surrogates are dropped or replaced.
pub(crate) fn utf16le(bytes: &[u8]) -> String {
    let units = bytes.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair));
    char::decode_utf16(units)
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

/// The encoding for a Windows code page number; unknown pages read as Windows-1252.
pub(crate) fn codepage(page: u32) -> &'static Encoding {
    let label = match page {
        874 => "windows-874",
        932 => "shift_jis",
        936 => "gbk",
        949 => "euc-kr",
        950 => "big5",
        866 => "ibm866",
        1200 => "utf-16le",
        1250..=1258 => return windows(page),
        10000 => "macintosh",
        20866 => "koi8-r",
        28591..=28606 => return iso8859(page - 28590),
        65001 => "utf-8",
        _ => "windows-1252",
    };
    Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::WINDOWS_1252)
}

fn windows(page: u32) -> &'static Encoding {
    Encoding::for_label(format!("windows-{page}").as_bytes()).unwrap_or(encoding_rs::WINDOWS_1252)
}

fn iso8859(part: u32) -> &'static Encoding {
    Encoding::for_label(format!("iso-8859-{part}").as_bytes()).unwrap_or(encoding_rs::WINDOWS_1252)
}

/// Decodes `bytes` in `encoding`, replacing what does not decode.
pub(crate) fn decode(bytes: &[u8], encoding: &'static Encoding) -> String {
    encoding.decode_without_bom_handling(bytes).0.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_readers_reject_short_input() {
        let bytes = [0x34, 0x12, 0x78, 0x56, 0, 0, 0, 0, 0, 0, 0xF0, 0x3F];
        assert_eq!(u8_at(&bytes, 1), Some(0x12));
        assert_eq!(u16le(&bytes, 0), Some(0x1234));
        assert_eq!(u32le(&bytes, 0), Some(0x5678_1234));
        assert_eq!(u16be(&bytes, 0), Some(0x3412));
        assert_eq!(u32be(&bytes, 0), Some(0x3412_7856));
        assert_eq!(f64le(&bytes, 4), Some(1.0));
        assert_eq!(u16le(&bytes, 11), None);
        assert_eq!(u32le(&bytes, usize::MAX), None);
        assert_eq!(u32be(&bytes, 10), None);
        assert_eq!(f64le(&bytes, 5), None);
        assert_eq!(span(&bytes, 10, 2), Some(&bytes[10..]));
        assert_eq!(span(&bytes, 10, 3), None);
        assert_eq!(span(&bytes, usize::MAX, 2), None);
    }

    #[test]
    fn utf16_tolerates_odd_lengths_and_lone_surrogates() {
        assert_eq!(utf16le(&[0x41, 0x00, 0xE5, 0x00, 0x42]), "Aå");
        assert_eq!(utf16le(&[0x00, 0xD8, 0x41, 0x00]), "\u{FFFD}A");
        assert_eq!(utf16le(&[0x3D, 0xD8, 0x00, 0xDE]), "😀");
    }

    #[test]
    fn code_pages_map_to_encodings() {
        assert_eq!(codepage(1252).name(), "windows-1252");
        assert_eq!(codepage(1251).name(), "windows-1251");
        assert_eq!(codepage(932).name(), "Shift_JIS");
        assert_eq!(codepage(65001).name(), "UTF-8");
        assert_eq!(codepage(28592).name(), "ISO-8859-2");
        assert_eq!(codepage(10000).name(), "macintosh");
        assert_eq!(codepage(437).name(), "windows-1252");
        assert_eq!(decode(&[0xE5, 0xE4, 0xF6], codepage(1252)), "åäö");
        assert_eq!(decode(&[0xC0], codepage(1251)), "А");
    }
}
