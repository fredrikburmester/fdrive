//! A compact table of strings addressed by index.

/// Shared string tables can hold millions of tiny entries. One buffer plus an
/// end offset per entry keeps an entry at four bytes of overhead, where a
/// `Vec<String>` would spend twenty-four.
#[derive(Default)]
pub(crate) struct StringTable {
    text: String,
    ends: Vec<u32>,
}

impl StringTable {
    /// Appends a string. Text past 4 GiB cannot be addressed and is dropped.
    pub(crate) fn push(&mut self, value: &str) {
        if u32::try_from(self.text.len() + value.len()).is_ok() {
            self.text.push_str(value);
        }
        self.ends.push(self.text.len() as u32);
    }

    pub(crate) fn get(&self, index: usize) -> Option<&str> {
        let end = *self.ends.get(index)? as usize;
        let start = match index.checked_sub(1) {
            Some(previous) => *self.ends.get(previous)? as usize,
            None => 0,
        };
        self.text.get(start..end)
    }

    #[cfg(test)]
    pub(crate) fn to_vec(&self) -> Vec<&str> {
        (0..self.ends.len()).filter_map(|index| self.get(index)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_entries_by_index() {
        let mut table = StringTable::default();
        assert_eq!(table.get(0), None);
        for value in ["Region", "", "Intäkt"] {
            table.push(value);
        }
        assert_eq!(table.get(0), Some("Region"));
        assert_eq!(table.get(1), Some(""));
        assert_eq!(table.get(2), Some("Intäkt"));
        assert_eq!(table.get(3), None);
        assert_eq!(table.to_vec(), ["Region", "", "Intäkt"]);
    }
}
