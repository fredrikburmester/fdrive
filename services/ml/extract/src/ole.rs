//! OLE2 compound files, the container of the legacy Office formats.
//!
//! A small read-only reader. Files written by real applications often break
//! rules a strict parser enforces (Apple's exporters reuse mini sectors, for
//! one), so this one checks only what it needs to stay in bounds.

use std::collections::HashSet;

use crate::ExtractError;
use crate::bytes::{span, u16le, u32le, utf16le};
use crate::limits::Budget;

/// The eight bytes every compound file starts with.
pub(crate) const MAGIC: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/// Sector numbers from here up are markers, not sectors.
const MAX_SECTOR: u32 = 0xFFFF_FFFA;
const NO_ENTRY: u32 = 0xFFFF_FFFF;
const ENTRY_BYTES: usize = 128;
const MINI_SECTOR: usize = 64;

const STORAGE: u8 = 1;
const STREAM: u8 = 2;
const ROOT: u8 = 5;

pub(crate) struct Ole<'a> {
    bytes: &'a [u8],
    sector: usize,
    /// Streams shorter than this live in the mini stream.
    cutoff: u64,
    fat: Vec<u32>,
    mini_fat: Vec<u32>,
    /// The sectors of the mini stream, which the root entry owns.
    mini_sectors: Vec<u32>,
    entries: Vec<Entry>,
}

struct Entry {
    name: String,
    kind: u8,
    left: u32,
    right: u32,
    child: u32,
    start: u32,
    size: u64,
}

impl<'a> Ole<'a> {
    pub(crate) fn open(bytes: &'a [u8]) -> Result<Self, ExtractError> {
        Self::read(bytes).ok_or_else(|| ExtractError::Malformed("compound file header".into()))
    }

    fn read(bytes: &'a [u8]) -> Option<Self> {
        let shift = u16le(bytes, 30)?;
        if !bytes.starts_with(MAGIC) || !(7..=16).contains(&shift) {
            return None;
        }
        let sector = 1usize << shift;
        let mut ole = Self {
            bytes,
            sector,
            cutoff: u64::from(u32le(bytes, 56)?),
            fat: Vec::new(),
            mini_fat: Vec::new(),
            mini_sectors: Vec::new(),
            entries: Vec::new(),
        };
        // A table has one entry per sector, mini sector or directory slot
        // the file can hold. A file that names the same table sector again
        // and again would otherwise grow these far past its own size.
        let fat_cap = bytes.len() / sector + sector / 4;
        for number in ole.fat_sectors()? {
            let Some(data) = ole.sector(number).filter(|_| ole.fat.len() < fat_cap) else {
                break;
            };
            ole.fat
                .extend(data.as_chunks::<4>().0.iter().map(|raw| u32::from_le_bytes(*raw)));
        }
        let mini_cap = bytes.len() / MINI_SECTOR + sector / 4;
        for number in ole.chain(u32le(bytes, 60)?) {
            if ole.mini_fat.len() >= mini_cap {
                break;
            }
            if let Some(data) = ole.sector(number) {
                ole.mini_fat
                    .extend(data.as_chunks::<4>().0.iter().map(|raw| u32::from_le_bytes(*raw)));
            }
        }
        let entry_cap = bytes.len() / ENTRY_BYTES;
        for number in ole.chain(u32le(bytes, 48)?) {
            let Some(data) = ole.sector(number).filter(|_| ole.entries.len() < entry_cap) else {
                break;
            };
            for raw in data.chunks(ENTRY_BYTES) {
                ole.entries.extend(Entry::read(raw, shift));
            }
        }
        let root = ole.entries.first().filter(|entry| entry.kind == ROOT)?;
        ole.mini_sectors = ole.chain(root.start);
        Some(ole)
    }

    /// The sectors holding the allocation table: 109 listed in the header,
    /// the rest in a chain of extension sectors.
    fn fat_sectors(&self) -> Option<Vec<u32>> {
        let mut sectors = Vec::new();
        for index in 0..109 {
            sectors.push(u32le(self.bytes, 76 + 4 * index)?);
        }
        let mut next = u32le(self.bytes, 68)?;
        let per_sector = self.sector / 4 - 1;
        // The file cannot hold more table sectors than it has sectors, and an
        // extension sector seen before means the chain has looped.
        let limit = self.bytes.len() / self.sector + 109;
        let mut visited = HashSet::new();
        while sectors.len() < limit && visited.insert(next) {
            let Some(data) = self.sector(next) else {
                break;
            };
            for index in 0..per_sector {
                sectors.push(u32le(data, 4 * index)?);
            }
            next = u32le(data, 4 * per_sector)?;
        }
        sectors.retain(|&sector| sector <= MAX_SECTOR);
        Some(sectors)
    }

    fn sector(&self, number: u32) -> Option<&'a [u8]> {
        if number > MAX_SECTOR {
            return None;
        }
        let at = (number as usize).checked_add(1)?.checked_mul(self.sector)?;
        // The last sector of a file is sometimes cut short.
        let rest = self.bytes.get(at..)?;
        Some(rest.get(..self.sector).unwrap_or(rest))
    }

    /// The sectors of the chain starting at `start`. A chain longer than the
    /// table has looped, so the walk stops there.
    fn chain(&self, start: u32) -> Vec<u32> {
        follow(&self.fat, start)
    }

    fn find(&self, path: &str) -> Option<&Entry> {
        let mut current = self.entries.first()?;
        for part in path.split('/').filter(|part| !part.is_empty()) {
            current = self
                .siblings(current.child)
                .into_iter()
                .find(|entry| entry.name.eq_ignore_ascii_case(part))?;
        }
        Some(current)
    }

    /// Every entry of the sibling tree rooted at `first`.
    fn siblings(&self, first: u32) -> Vec<&Entry> {
        let mut out = Vec::new();
        let mut visited = vec![false; self.entries.len()];
        let mut pending = vec![first];
        while let Some(index) = pending.pop() {
            let Some(entry) = self.entries.get(index as usize) else {
                continue;
            };
            let Some(seen) = visited.get_mut(index as usize).filter(|seen| !**seen) else {
                continue;
            };
            *seen = true;
            pending.extend([entry.right, entry.left].into_iter().filter(|&next| next != NO_ENTRY));
            if matches!(entry.kind, STORAGE | STREAM) {
                out.push(entry);
            }
        }
        out
    }

    /// Whether a stream or storage exists at `path`, e.g. `/WordDocument`.
    pub(crate) fn has(&self, path: &str) -> bool {
        self.find(path).is_some()
    }

    /// The names of the entries directly inside the storage at `path`.
    pub(crate) fn children(&self, path: &str) -> Vec<String> {
        self.find(path)
            .map(|storage| {
                self.siblings(storage.child)
                    .into_iter()
                    .map(|entry| entry.name.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A whole stream in memory, cut at the limits; `None` when it is missing.
    pub(crate) fn stream(&self, path: &str, budget: &mut Budget) -> Option<Vec<u8>> {
        let entry = self.find(path).filter(|entry| entry.kind == STREAM)?;
        let wanted = budget.part(usize::try_from(entry.size).unwrap_or(usize::MAX));
        let mut out = Vec::new();
        if entry.size < self.cutoff {
            for number in follow(&self.mini_fat, entry.start) {
                let Some(data) = self.mini_sector(number) else {
                    break;
                };
                if !append(&mut out, data, wanted, budget) {
                    break;
                }
            }
        } else {
            for number in self.chain(entry.start) {
                let Some(data) = self.sector(number) else {
                    break;
                };
                if !append(&mut out, data, wanted, budget) {
                    break;
                }
            }
        }
        Some(out)
    }

    fn mini_sector(&self, number: u32) -> Option<&'a [u8]> {
        let at = (number as usize).checked_mul(MINI_SECTOR)?;
        let host = *self.mini_sectors.get(at / self.sector)?;
        span(self.sector(host)?, at % self.sector, MINI_SECTOR)
    }
}

/// Appends `data` up to `wanted` total bytes; `false` once the stream or the budget is full.
fn append(out: &mut Vec<u8>, data: &[u8], wanted: usize, budget: &mut Budget) -> bool {
    let room = wanted.saturating_sub(out.len());
    let piece = data.get(..room).unwrap_or(data);
    let allowed = budget.charge(piece.len());
    out.extend_from_slice(piece.get(..allowed).unwrap_or(piece));
    allowed == piece.len() && out.len() < wanted
}

fn follow(table: &[u32], start: u32) -> Vec<u32> {
    let mut sectors = Vec::new();
    let mut next = start;
    while next <= MAX_SECTOR && sectors.len() <= table.len() {
        sectors.push(next);
        let Some(&after) = table.get(next as usize) else {
            break;
        };
        next = after;
    }
    sectors
}

impl Entry {
    fn read(raw: &[u8], sector_shift: u16) -> Option<Self> {
        let name_bytes = usize::from(u16le(raw, 64)?).clamp(2, 64) - 2;
        let size = u64::from(u32le(raw, 120)?);
        // Version 3 files (512-byte sectors) leave the high half of the size undefined.
        let high = if sector_shift > 9 {
            u64::from(u32le(raw, 124)?)
        } else {
            0
        };
        Some(Self {
            name: utf16le(raw.get(..name_bytes)?),
            kind: *raw.get(66)?,
            left: u32le(raw, 68)?,
            right: u32le(raw, 72)?,
            child: u32le(raw, 76)?,
            start: u32le(raw, 116)?,
            size: size | (high << 32),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 512-byte-sector file of `sectors` sectors after the header, with
    /// `difat` as the header's first table sector entries.
    fn file(sectors: usize, difat: &[u32]) -> Vec<u8> {
        let mut bytes = vec![0u8; 512 * (sectors + 1)];
        bytes[..8].copy_from_slice(MAGIC);
        bytes[30..32].copy_from_slice(&9u16.to_le_bytes());
        for slot in 0..109 {
            let sector = difat.get(slot).copied().unwrap_or(0xFFFF_FFFF);
            bytes[76 + 4 * slot..80 + 4 * slot].copy_from_slice(&sector.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn a_table_sector_listed_again_and_again_does_not_grow_the_table() {
        // Every header slot names sector 0 as a table sector.
        let mut bytes = file(4, &[0; 109]);
        // The directory chain starts at sector 1, whose first entry is a root.
        bytes[48..52].copy_from_slice(&1u32.to_le_bytes());
        bytes[512 + 512 + 66] = ROOT;
        let ole = Ole::read(&bytes).unwrap();
        // 109 listings of one 128-entry sector would be 13,952 entries; the
        // bound allows one sector past an entry per sector of the file.
        assert!(
            ole.fat.len() <= bytes.len() / 512 + 2 * 128,
            "{} entries",
            ole.fat.len()
        );
    }

    #[test]
    fn a_looping_chain_of_table_extensions_ends() {
        let mut bytes = file(4, &[]);
        // The extension chain starts at sector 2, which names itself as the next one.
        bytes[68..72].copy_from_slice(&2u32.to_le_bytes());
        let extension = 512 * 3;
        for slot in 0..127 {
            bytes[extension + 4 * slot..extension + 4 * slot + 4].copy_from_slice(&0u32.to_le_bytes());
        }
        bytes[extension + 508..extension + 512].copy_from_slice(&2u32.to_le_bytes());
        let ole = Ole {
            bytes: &bytes,
            sector: 512,
            cutoff: 0,
            fat: vec![],
            mini_fat: vec![],
            mini_sectors: vec![],
            entries: vec![],
        };
        assert_eq!(ole.fat_sectors().unwrap().len(), 127);
    }
}
