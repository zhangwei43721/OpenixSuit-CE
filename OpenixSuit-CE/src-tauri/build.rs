use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=libs/libefex");
    println!("cargo:rerun-if-changed=libs/OpenixIMG");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    // Compile libefex using its actual directory layout (includes/libefex.h)
    let efex_header = PathBuf::from("libs/libefex/includes/libefex.h");
    if efex_header.exists() {
        let mut efex_build = cc::Build::new();
        efex_build
            .include("libs/libefex/includes")
            .file("libs/libefex/src/efex-common.c")
            .file("libs/libefex/src/efex-fel.c")
            .file("libs/libefex/src/efex-fes.c")
            .file("libs/libefex/src/efex-payloads.c")
            .file("libs/libefex/src/efex-usb.c")
            .file("libs/libefex/src/arch/arm.c")
            .file("libs/libefex/src/arch/aarch64.c")
            .file("libs/libefex/src/arch/riscv.c")
            .file("libs/libefex/src/usb/usb_layer.c")
            .file("libs/libefex/src/usb/usb_layer_libusb.c");

        match target_os.as_str() {
            "windows" => {
                efex_build.file("libs/libefex/src/usb/usb_layer_winusb.c");
                efex_build.define("USE_WINUSB", None);
                println!("cargo:rustc-link-lib=winusb");
                println!("cargo:rustc-link-lib=setupapi");
            }
            "linux" => {
                let libusb = pkg_config::Config::new()
                    .probe("libusb-1.0")
                    .expect("libusb-1.0 not found via pkg-config");
                for path in libusb.include_paths {
                    efex_build.include(path);
                }
                println!("cargo:rustc-link-lib=usb-1.0");
            }
            "macos" => {
                for prefix in ["/opt/homebrew", "/usr/local"] {
                    let inc = PathBuf::from(prefix).join("include/libusb-1.0");
                    let lib = PathBuf::from(prefix).join("lib");
                    if inc.exists() {
                        efex_build.include(inc);
                    }
                    if lib.exists() {
                        println!("cargo:rustc-link-search=native={}", lib.display());
                    }
                }
                println!("cargo:rustc-link-lib=usb-1.0");
                println!("cargo:rustc-link-lib=framework=IOKit");
                println!("cargo:rustc-link-lib=framework=CoreFoundation");
            }
            _ => {}
        }
        efex_build.compile("efex");

        let wrapper = r#"
#include <stddef.h>
#include <stdint.h>
#ifdef _WIN32
#include <BaseTsd.h>
typedef SSIZE_T ssize_t;
#else
#include <sys/types.h>
#endif
#include "libefex.h"
"#;

        let bindings = bindgen::Builder::default()
            .header_contents("efex_wrapper.h", wrapper)
            .clang_arg("-Ilibs/libefex/includes")
            .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
            .generate()
            .expect("Unable to generate libefex bindings");
        bindings
            .write_to_file(out_dir.join("efex_bindings.rs"))
            .expect("Couldn't write bindings");
    } else {
        println!("cargo:warning=libs/libefex not found, building with stub FFI bindings");
        std::fs::write(out_dir.join("efex_bindings.rs"), "// stub bindings\n")
            .expect("Couldn't write stub bindings");
    }

    tauri_build::build();
}
