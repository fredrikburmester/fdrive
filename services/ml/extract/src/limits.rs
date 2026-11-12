//! Byte and character bounds, and the accounting that enforces them.

use std::io::{self, Read};

/// Bounds that keep one hostile or huge document from exhausting memory.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Most decompressed bytes read from one archive member.
    pub max_part_bytes: usize,
    /// Most decompressed bytes read across a whole document.
    pub max_total_bytes: usize,
    /// Extraction stops once this many characters of text are collected.
    pub max_text_chars: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_part_bytes: 64 * 1024 * 1024,
            max_total_bytes: 256 * 1024 * 1024,
            max_text_chars: 4_000_000,
        }
    }
}

/// Running byte allowance for one document. Every parser draws from it, so a
/// zip bomb is cut off no matter which member carries the payload.
pub(crate) struct Budget {
    part_max: usize,
    total_left: usize,
    exhausted: bool,
}

impl Budget {
    pub(crate) fn new(limits: &Limits) -> Self {
        Self {
            part_max: limits.max_part_bytes,
            total_left: limits.max_total_bytes,
            exhausted: false,
        }
    }

    /// Whether some input was left unread because a limit was reached.
    pub(crate) fn exhausted(&self) -> bool {
        self.exhausted
    }

    /// Wraps `inner` so reads stop at the per-part and whole-document limits.
    pub(crate) fn limit<R: Read>(&mut self, inner: R) -> Limited<'_, R> {
        Limited {
            inner,
            part_left: self.part_max,
            budget: self,
        }
    }

    /// The prefix of `bytes` the limits allow, charged against the total.
    pub(crate) fn slice<'a>(&mut self, bytes: &'a [u8]) -> &'a [u8] {
        let allowed = bytes.len().min(self.part_max).min(self.total_left);
        if allowed < bytes.len() {
            self.exhausted = true;
        }
        self.total_left -= allowed;
        bytes.get(..allowed).unwrap_or(bytes)
    }

    /// `wanted` bytes capped at the per-part limit, for a part read in pieces.
    pub(crate) fn part(&mut self, wanted: usize) -> usize {
        if wanted > self.part_max {
            self.exhausted = true;
        }
        wanted.min(self.part_max)
    }

    /// Charges `wanted` bytes of produced output and returns how many are allowed.
    pub(crate) fn charge(&mut self, wanted: usize) -> usize {
        let allowed = wanted.min(self.total_left);
        if allowed < wanted {
            self.exhausted = true;
        }
        self.total_left -= allowed;
        allowed
    }
}

/// A reader that reports end of input once either limit is spent.
pub(crate) struct Limited<'b, R> {
    inner: R,
    part_left: usize,
    budget: &'b mut Budget,
}

impl<R: Read> Read for Limited<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let room = self.part_left.min(self.budget.total_left);
        if room == 0 {
            // Only a member with data still unread counts as cut short.
            let mut probe = [0u8; 1];
            if !buf.is_empty() && self.inner.read(&mut probe)? > 0 {
                self.budget.exhausted = true;
            }
            return Ok(0);
        }
        let want = buf.len().min(room);
        let Some(target) = buf.get_mut(..want) else {
            return Ok(0);
        };
        let read = self.inner.read(target)?;
        self.part_left -= read;
        self.budget.total_left -= read;
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(part: usize, total: usize) -> Limits {
        Limits {
            max_part_bytes: part,
            max_total_bytes: total,
            max_text_chars: 100,
        }
    }

    #[test]
    fn defaults_match_the_documented_bounds() {
        let limits = Limits::default();
        assert_eq!(limits.max_part_bytes, 64 * 1024 * 1024);
        assert_eq!(limits.max_total_bytes, 256 * 1024 * 1024);
        assert_eq!(limits.max_text_chars, 4_000_000);
    }

    #[test]
    fn a_reader_within_the_limits_is_not_exhausted() {
        let mut budget = Budget::new(&limits(8, 8));
        let mut out = Vec::new();
        budget.limit(&b"12345678"[..]).read_to_end(&mut out).unwrap();
        assert_eq!(out, b"12345678");
        assert!(!budget.exhausted());
    }

    #[test]
    fn a_reader_stops_at_the_part_limit() {
        let mut budget = Budget::new(&limits(4, 100));
        let mut out = Vec::new();
        budget.limit(&b"123456"[..]).read_to_end(&mut out).unwrap();
        assert_eq!(out, b"1234");
        assert!(budget.exhausted());
    }

    #[test]
    fn the_total_limit_spans_readers() {
        let mut budget = Budget::new(&limits(4, 6));
        let mut out = Vec::new();
        budget.limit(&b"1234"[..]).read_to_end(&mut out).unwrap();
        budget.limit(&b"5678"[..]).read_to_end(&mut out).unwrap();
        assert_eq!(out, b"123456");
        assert!(budget.exhausted());
    }

    #[test]
    fn slices_and_charges_draw_from_the_total() {
        let mut budget = Budget::new(&limits(4, 6));
        assert_eq!(budget.slice(b"abcdef"), b"abcd");
        assert!(budget.exhausted());
        assert_eq!(budget.charge(5), 2);
        assert_eq!(budget.charge(1), 0);

        let mut parts = Budget::new(&limits(4, 100));
        assert_eq!(parts.part(3), 3);
        assert!(!parts.exhausted());
        assert_eq!(parts.part(9), 4);
        assert!(parts.exhausted());

        let mut roomy = Budget::new(&limits(10, 10));
        assert_eq!(roomy.slice(b"abc"), b"abc");
        assert_eq!(roomy.charge(3), 3);
        assert!(!roomy.exhausted());
    }
}
