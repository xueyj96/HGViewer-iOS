use base64::{engine::general_purpose::STANDARD, Engine};
use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::NSString;
use objc2_ui_kit::{
    UIColor, UIGraphicsImageRenderer, UIGraphicsImageRendererContext, UIImage, UIImageRenderingMode,
};
use std::{collections::BTreeMap, ptr::NonNull};
use tokio::sync::oneshot;

const SYMBOLS: &[&str] = &[
    "chevron.left",
    "chevron.right",
    "gearshape",
    "moon",
    "sun.max",
    "heart",
    "trash",
    "bolt",
    "lock",
    "link",
    "arrow.clockwise",
    "info.circle",
];

#[tauri::command]
pub async fn settings_symbols(webview: tauri::Webview) -> Result<BTreeMap<String, String>, String> {
    let (send, receive) = oneshot::channel();
    webview
        .with_webview(move |_| {
            let Some(main_thread) = MainThreadMarker::new() else {
                return;
            };
            let canvas = CGSize::new(24.0, 24.0);
            let renderer = UIGraphicsImageRenderer::initWithSize(main_thread.alloc(), canvas);
            let white = UIColor::whiteColor();
            let mut icons = BTreeMap::new();
            for &name in SYMBOLS {
                let Some(image) = UIImage::systemImageNamed(&NSString::from_str(name)) else {
                    continue;
                };
                let image = image
                    .imageWithTintColor_renderingMode(&white, UIImageRenderingMode::AlwaysOriginal);
                // UIKit owns this image, and rendering happens synchronously on its main thread.
                let size = unsafe { image.size() };
                if size.width <= 0.0 || size.height <= 0.0 {
                    continue;
                }
                let scale = 22.0 / size.width.max(size.height);
                let size = CGSize::new(size.width * scale, size.height * scale);
                let rect = CGRect::new(
                    CGPoint::new(
                        (canvas.width - size.width) / 2.0,
                        (canvas.height - size.height) / 2.0,
                    ),
                    size,
                );
                let draw = RcBlock::new(move |_: NonNull<UIGraphicsImageRendererContext>| {
                    image.drawInRect(rect)
                });
                // The retained block remains valid for the duration of the renderer call.
                let png = unsafe { renderer.PNGDataWithActions(RcBlock::as_ptr(&draw)) };
                icons.insert(name.to_string(), STANDARD.encode(png.to_vec()));
            }
            let _ = send.send(icons);
        })
        .map_err(|_| "无法读取系统图标".to_string())?;
    receive.await.map_err(|_| "无法读取系统图标".to_string())
}
