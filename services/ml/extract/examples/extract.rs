//! Prints the text of each file given on the command line.
//!
//! `cargo run -p fdrive-ml-extract --example extract -- report.docx`

use fdrive_ml_extract::{Limits, extract};

fn main() {
    for path in std::env::args().skip(1) {
        match std::fs::read(&path).map(|bytes| extract(&bytes, &Limits::default())) {
            Ok(Ok(extracted)) => println!("== {path} [{}]\n{}", extracted.format, extracted.text),
            Ok(Err(error)) => println!("== {path} [error]\n{error}"),
            Err(error) => println!("== {path} [unreadable]\n{error}"),
        }
    }
}
