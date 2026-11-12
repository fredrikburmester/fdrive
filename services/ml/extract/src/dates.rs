//! Spreadsheet dates: cells store a day count, and only the number format
//! says it is a date. Written out as ISO dates so they can be searched.

/// Whether a number format shows a date or a time. `code` is the format's
/// own pattern when the workbook defines one, else `id` is a built-in.
pub(crate) fn is_date_format(id: u32, code: Option<&str>) -> bool {
    let Some(code) = code else {
        return matches!(id, 14..=22 | 27..=36 | 45..=47 | 50..=58);
    };
    // Literal text and bracketed conditions say nothing about the value's kind.
    let mut quoted = false;
    let mut bracketed = false;
    let mut escaped = false;
    for c in code.chars() {
        if std::mem::take(&mut escaped) {
            continue;
        }
        match c {
            '"' => quoted = !quoted,
            _ if quoted => {}
            '\\' | '_' | '*' => escaped = true,
            '[' => bracketed = true,
            ']' => bracketed = false,
            _ if bracketed => {}
            'd' | 'D' | 'm' | 'M' | 'y' | 'Y' | 'h' | 'H' | 's' | 'S' => return true,
            _ => {}
        }
    }
    false
}

/// A serial day number as `YYYY-MM-DD`, with ` HH:MM:SS` when it has a time
/// of day, or the time alone for a value under one day. `None` when the
/// number is outside the range spreadsheets treat as dates.
pub(crate) fn serial_text(serial: f64, date1904: bool) -> Option<String> {
    if !(0.0..2_958_466.0).contains(&serial) {
        return None;
    }
    let mut days = serial.floor() as i64;
    let mut seconds = ((serial - serial.floor()) * 86_400.0).round() as i64;
    if seconds >= 86_400 {
        days += 1;
        seconds = 0;
    }
    let time = format!("{:02}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60);
    if days == 0 {
        return Some(time);
    }
    // Day 60 of the 1900 system is a 29 February that never existed, so
    // earlier days sit one closer to the epoch than later ones.
    let since_1970 = match (date1904, days) {
        (true, _) => days - 24_107,
        (false, ..=59) => days - 25_568,
        (false, _) => days - 25_569,
    };
    let (year, month, day) = civil(since_1970);
    Some(if seconds == 0 {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02} {time}")
    })
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_built_in_and_custom_date_formats() {
        assert!(is_date_format(14, None));
        assert!(is_date_format(22, None));
        assert!(is_date_format(46, None));
        assert!(!is_date_format(0, None));
        assert!(!is_date_format(2, None));
        assert!(!is_date_format(49, None));
        assert!(is_date_format(164, Some("yyyy-mm-dd")));
        assert!(is_date_format(164, Some("[$-409]d\\-mmm\\-yy;@")));
        assert!(is_date_format(164, Some("[h]:mm:ss")));
        assert!(!is_date_format(164, Some("General")));
        assert!(!is_date_format(164, Some("#,##0.00 \"dollars\"")));
        assert!(!is_date_format(164, Some("[Red]0.00\\ \\m;_-* 0")));
        assert!(!is_date_format(14, Some("0.00E+00")));
    }

    #[test]
    fn writes_serial_numbers_as_iso_dates() {
        assert_eq!(serial_text(1.0, false).as_deref(), Some("1900-01-01"));
        assert_eq!(serial_text(59.0, false).as_deref(), Some("1900-02-28"));
        assert_eq!(serial_text(61.0, false).as_deref(), Some("1900-03-01"));
        assert_eq!(serial_text(25_569.0, false).as_deref(), Some("1970-01-01"));
        assert_eq!(serial_text(45_351.0, false).as_deref(), Some("2024-02-29"));
        assert_eq!(
            serial_text(39_066.668_055_555_56, false).as_deref(),
            Some("2006-12-15 16:02:00")
        );
        assert_eq!(serial_text(0.75, false).as_deref(), Some("18:00:00"));
        assert_eq!(serial_text(1.999_999_999, false).as_deref(), Some("1900-01-02"));
        assert_eq!(serial_text(1.0, true).as_deref(), Some("1904-01-02"));
        assert_eq!(serial_text(43_889.0, true).as_deref(), Some("2024-02-29"));
        assert_eq!(serial_text(-1.0, false), None);
        assert_eq!(serial_text(3_000_000.0, false), None);
        assert_eq!(serial_text(f64::NAN, false), None);
    }
}
