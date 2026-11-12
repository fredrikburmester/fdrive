fn main() {
    // ONNX Runtime's macOS build references a compiler-rt symbol that rustc's
    // linker invocation leaves out of optimized builds. Linux is unaffected.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-fapple-link-rtlib");
    }
}
