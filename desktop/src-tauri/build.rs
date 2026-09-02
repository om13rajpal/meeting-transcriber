fn main() {
    // The `screencapturekit` crate compiles a Swift bridge, and that bridge's
    // Swift-6 concurrency runtime is referenced as `@rpath/
    // libswift_Concurrency.dylib` rather than by absolute path. The crate's own
    // build script does emit `-Wl,-rpath,/usr/lib/swift`, but a `rustc-link-arg`
    // from a *dependency's* build script is dropped when that dependency is an
    // rlib, so it never reaches the final link and every binary aborts at
    // startup with "Library not loaded: @rpath/libswift_Concurrency.dylib".
    // Re-emitting it here, from the crate actually being linked, is what makes
    // it stick. The library itself lives only in the dyld shared cache (there
    // is no such file on disk), so this path is resolved by dyld, not the
    // filesystem.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

    tauri_build::build()
}
