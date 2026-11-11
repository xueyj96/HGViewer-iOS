fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
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
