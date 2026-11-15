//! A photo's details from its EXIF: when it was taken, the camera, its size as shown and
//! where it was taken. Read for files that get an image thumbnail, within the same size
//! limit, and stored on the file's row in `idx.files`.

use std::io::{BufReader, Read, Seek};

use chrono::{NaiveDate, NaiveDateTime};
use exif::{DateTime, Exif, In, Reader, Tag, Value};

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Photo {
    /// The camera's wall-clock time, without a time zone.
    pub taken_at: Option<NaiveDateTime>,
    pub camera: Option<String>,
    /// As the photo is shown, after its orientation.
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

/// The details in `file`'s EXIF; none when it has no EXIF or it cannot be read.
pub fn read(file: impl Read + Seek) -> Photo {
    Reader::new()
        .read_from_container(&mut BufReader::new(file))
        .map(|exif| details(&exif))
        .unwrap_or_default()
}

fn details(exif: &Exif) -> Photo {
    let value = |tag| exif.get_field(tag, In::PRIMARY).map(|field| &field.value);
    let ascii = |tag| match value(tag) {
        Some(Value::Ascii(parts)) => parts.first().map(Vec::as_slice),
        _ => None,
    };
    let text = |tag| {
        ascii(tag)
            .map(|bytes| String::from_utf8_lossy(bytes).trim_matches(['\0', ' ']).to_owned())
            .filter(|text| !text.is_empty())
    };
    let number = |tag| value(tag).and_then(|v| v.get_uint(0));
    let side = |tag| number(tag).and_then(|n| i32::try_from(n).ok()).filter(|n| *n > 0);
    let coordinate = |tag, reference, negative: u8| match value(tag) {
        Some(Value::Rational(parts)) if parts.len() == 3 => {
            let degrees = parts[0].to_f64() + parts[1].to_f64() / 60.0 + parts[2].to_f64() / 3600.0;
            let sign = if ascii(reference).and_then(<[u8]>::first) == Some(&negative) {
                -1.0
            } else {
                1.0
            };
            Some(sign * degrees).filter(|d| d.is_finite())
        }
        _ => None,
    };
    let (mut width, mut height) = (side(Tag::PixelXDimension), side(Tag::PixelYDimension));
    // Orientations 5 to 8 turn the photo a quarter, so it shows taller than it is stored.
    if number(Tag::Orientation).is_some_and(|o| (5..=8).contains(&o)) {
        std::mem::swap(&mut width, &mut height);
    }
    Photo {
        taken_at: ascii(Tag::DateTimeOriginal).and_then(taken_at),
        camera: camera(text(Tag::Make), text(Tag::Model)),
        width,
        height,
        latitude: coordinate(Tag::GPSLatitude, Tag::GPSLatitudeRef, b'S'),
        longitude: coordinate(Tag::GPSLongitude, Tag::GPSLongitudeRef, b'W'),
    }
}

fn taken_at(ascii: &[u8]) -> Option<NaiveDateTime> {
    let t = DateTime::from_ascii(ascii).ok()?;
    NaiveDate::from_ymd_opt(t.year.into(), t.month.into(), t.day.into())?.and_hms_opt(
        t.hour.into(),
        t.minute.into(),
        t.second.into(),
    )
}

/// "Make Model", or the model alone when it already names the make ("Canon EOS R5").
fn camera(make: Option<String>, model: Option<String>) -> Option<String> {
    match (make, model) {
        (Some(make), Some(model)) if model.to_lowercase().starts_with(&make.to_lowercase()) => Some(model),
        (Some(make), Some(model)) => Some(format!("{make} {model}")),
        (make, model) => model.or(make),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use exif::experimental::Writer;
    use exif::{Field, Rational};

    use super::*;

    fn field(tag: Tag, value: Value) -> Field {
        Field {
            tag,
            ifd_num: In::PRIMARY,
            value,
        }
    }

    fn ascii(text: &str) -> Value {
        Value::Ascii(vec![text.as_bytes().to_vec()])
    }

    fn dms(degrees: u32, minutes: u32, seconds_hundredths: u32) -> Value {
        Value::Rational(vec![
            Rational { num: degrees, denom: 1 },
            Rational { num: minutes, denom: 1 },
            Rational {
                num: seconds_hundredths,
                denom: 100,
            },
        ])
    }

    /// A small JPEG carrying `fields` in its EXIF.
    fn jpeg_with(fields: &[Field]) -> Vec<u8> {
        let mut writer = Writer::new();
        for field in fields {
            writer.push_field(field);
        }
        let mut tiff = Cursor::new(Vec::new());
        writer.write(&mut tiff, false).unwrap();
        let tiff = tiff.into_inner();
        let mut plain = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 2)
            .write_to(&mut plain, image::ImageFormat::Jpeg)
            .unwrap();
        let plain = plain.into_inner();
        let length = u16::try_from(2 + 6 + tiff.len()).unwrap().to_be_bytes();
        [&plain[..2], &[0xFF, 0xE1], &length, b"Exif\0\0", &tiff, &plain[2..]].concat()
    }

    #[test]
    fn reads_every_detail() {
        let bytes = jpeg_with(&[
            field(Tag::Make, ascii("Apple")),
            field(Tag::Model, ascii("iPhone 15 Pro")),
            field(Tag::Orientation, Value::Short(vec![6])),
            field(Tag::DateTimeOriginal, ascii("2024:05:01 14:03:09")),
            field(Tag::PixelXDimension, Value::Long(vec![4032])),
            field(Tag::PixelYDimension, Value::Long(vec![3024])),
            field(Tag::GPSLatitudeRef, ascii("S")),
            field(Tag::GPSLatitude, dms(33, 51, 3540)),
            field(Tag::GPSLongitudeRef, ascii("E")),
            field(Tag::GPSLongitude, dms(151, 12, 4500)),
        ]);
        let photo = read(Cursor::new(bytes));
        assert_eq!(
            photo.taken_at,
            NaiveDate::from_ymd_opt(2024, 5, 1).unwrap().and_hms_opt(14, 3, 9)
        );
        assert_eq!(photo.camera.as_deref(), Some("Apple iPhone 15 Pro"));
        // Turned a quarter: shown 3024 wide.
        assert_eq!((photo.width, photo.height), (Some(3024), Some(4032)));
        let latitude = photo.latitude.unwrap();
        let longitude = photo.longitude.unwrap();
        assert!((latitude + 33.859_833).abs() < 1e-5, "{latitude}");
        assert!((longitude - 151.2125).abs() < 1e-5, "{longitude}");
    }

    #[test]
    fn west_is_negative_and_upright_photos_keep_their_sides() {
        let bytes = jpeg_with(&[
            field(Tag::Orientation, Value::Short(vec![1])),
            field(Tag::PixelXDimension, Value::Short(vec![600])),
            field(Tag::PixelYDimension, Value::Short(vec![400])),
            field(Tag::GPSLongitudeRef, ascii("W")),
            field(Tag::GPSLongitude, dms(73, 59, 0)),
        ]);
        let photo = read(Cursor::new(bytes));
        assert_eq!((photo.width, photo.height), (Some(600), Some(400)));
        assert!((photo.longitude.unwrap() + 73.983_333).abs() < 1e-5);
        assert_eq!((photo.latitude, photo.taken_at, photo.camera), (None, None, None));
    }

    #[test]
    fn unreadable_values_are_left_out() {
        let bytes = jpeg_with(&[
            field(Tag::DateTimeOriginal, ascii("2024:13:40 99:00:00")),
            field(Tag::Make, ascii("  ")),
            field(Tag::PixelXDimension, Value::Long(vec![0])),
            field(
                Tag::GPSLatitude,
                Value::Rational(vec![Rational { num: 1, denom: 0 }; 3]),
            ),
            field(Tag::GPSLongitude, Value::Rational(vec![Rational { num: 1, denom: 1 }])),
        ]);
        assert_eq!(read(Cursor::new(bytes)), Photo::default());
    }

    #[test]
    fn a_file_without_exif_has_no_details() {
        let mut plain = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 2)
            .write_to(&mut plain, image::ImageFormat::Png)
            .unwrap();
        plain.set_position(0);
        assert_eq!(read(plain), Photo::default());
        assert_eq!(read(Cursor::new(b"not an image".to_vec())), Photo::default());
    }

    #[test]
    fn the_camera_names_the_make_once() {
        let s = |v: &str| Some(v.to_owned());
        assert_eq!(camera(s("Canon"), s("Canon EOS R5")), s("Canon EOS R5"));
        assert_eq!(camera(s("SONY"), s("ILCE-7M3")), s("SONY ILCE-7M3"));
        assert_eq!(camera(None, s("X100V")), s("X100V"));
        assert_eq!(camera(s("FUJIFILM"), None), s("FUJIFILM"));
        assert_eq!(camera(None, None), None);
    }
}
