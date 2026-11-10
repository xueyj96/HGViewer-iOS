use block2::RcBlock;
use objc2::{MainThreadMarker, msg_send, runtime::Bool};
use objc2_foundation::{NSObjectProtocol, NSError};
use objc2_ui_kit::{
    UIInterfaceOrientationMask, UIViewController, UIWindowSceneGeometryPreferencesIOS,
};
use std::{cell::Cell, ptr::NonNull, time::Duration};
use tokio::sync::oneshot;

#[tauri::command]
pub async fn set_ios_orientation(webview: tauri::Webview, landscape: bool) -> Result<(), String> {
    let (send_error, receive_error) = oneshot::channel();
    webview
        .with_webview(move |native| {
            // Tauri calls this closure on the main thread and owns the view controller.
            let Some(controller) =
                (unsafe { native.view_controller().cast::<UIViewController>().as_ref() })
            else {
                let _ = send_error.send("播放器窗口尚未就绪");
                return;
            };
            let Some(scene) = controller
                .view()
                .and_then(|view| view.window())
                .and_then(|window| window.windowScene())
            else {
                let _ = send_error.send("播放器窗口尚未就绪");
                return;
            };
            let Some(main_thread) = MainThreadMarker::new() else {
                let _ = send_error.send("无法在当前线程转屏");
                return;
            };
            let orientations = if landscape {
                UIInterfaceOrientationMask::Landscape
            } else {
                UIInterfaceOrientationMask::Portrait
            };
            let preferences = UIWindowSceneGeometryPreferencesIOS::initWithInterfaceOrientations(
                main_thread.alloc(),
                orientations,
            );
            let send_error = Cell::new(Some(send_error));
            let on_denial = RcBlock::new(move |_error: NonNull<NSError>| {
                if let Some(send_error) = send_error.take() {
                    let _ = send_error.send("iOS 当前未允许切换方向");
                }
            });
            controller.setNeedsUpdateOfSupportedInterfaceOrientations();
            scene.requestGeometryUpdateWithPreferences_errorHandler(&preferences, Some(&on_denial));
        })
        .map_err(|_| "无法访问播放器窗口".to_string())?;

    if let Ok(Ok(error)) = tokio::time::timeout(Duration::from_millis(900), receive_error).await {
        return Err(error.to_string());
    }
    Ok(())
}


#[tauri::command]
pub async fn set_ios_status_bar_hidden(webview: tauri::Webview, hidden: bool) -> Result<(), String> {
    webview
        .with_webview(move |native| {
            let controller = native.view_controller().cast::<UIViewController>();
            // Tao's window controller owns this preference and invalidates UIKit's appearance.
            if let Some(controller) = unsafe { controller.as_ref() } {
                if controller.respondsToSelector(objc2::sel!(setPrefersStatusBarHidden:)) {
                    let _: () = unsafe { msg_send![controller, setPrefersStatusBarHidden: Bool::new(hidden)] };
                }
            }
        })
        .map_err(|_| "无法访问播放器窗口".to_string())
}

#[tauri::command]
pub async fn ios_horizontal_safe_area(webview: tauri::Webview) -> Result<[f64; 2], String> {
    let (send, receive) = oneshot::channel();
    webview
        .with_webview(move |native| {
            let controller = native.view_controller().cast::<UIViewController>();
            let safe_area = unsafe { controller.as_ref() }
                .and_then(|controller| controller.view())
                .and_then(|view| view.window())
                .map(|window| {
                    let insets = window.safeAreaInsets();
                    [insets.left, insets.right]
                });
            let _ = send.send(safe_area);
        })
        .map_err(|_| "无法访问播放器窗口".to_string())?;
    receive.await.ok().flatten().ok_or_else(|| "窗口安全区尚未就绪".to_string())
}
