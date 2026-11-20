fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        let simulator = std::env::var("TARGET")
            .unwrap_or_default()
            .ends_with("-sim");
        let slice = if simulator {
            "ios-arm64-simulator"
        } else {
            "ios-arm64"
        };
        let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
        let framework = root.join("../build/remux/HGRemux.xcframework").join(slice);
        assert!(
            framework.join("HGRemux.framework/HGRemux").is_file(),
            "Build the pinned local remux engine first: python3 scripts/build-remux-ios.py"
        );
        println!("cargo:rustc-link-search=framework={}", framework.display());
        println!("cargo:rustc-link-lib=framework=HGRemux");
        println!(
            "cargo:rerun-if-changed={}",
            framework.join("HGRemux.framework/HGRemux").display()
        );
        println!("cargo:rerun-if-changed=src/ios_player.m");
        println!("cargo:rerun-if-changed=src/ios_download_background.m");
        cc::Build::new()
            .file("src/ios_player.m")
            .file("src/ios_download_background.m")
            .flag("-fobjc-arc")
            .compile("hg_ios_player");
        for framework in [
            "AVFoundation",
            "CoreMedia",
            "UIKit",
            "WebKit",
            "QuartzCore",
            "BackgroundTasks",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build();
}
