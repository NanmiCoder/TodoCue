#[allow(unused_imports)]
use crate::notch_geometry::{covers_screen, Frame};
use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
pub fn check_legacy_client() -> Result<(), String> {
    use objc2_app_kit::{NSAlert, NSRunningApplication};
    use objc2_foundation::NSString;
    let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(
        &NSString::from_str("com.todocue.app"),
    );
    let legacy = running.iter().any(|app| {
        app.processIdentifier() != std::process::id() as i32
            && app
                .executableURL()
                .and_then(|url| url.lastPathComponent())
                .is_some_and(|name| name.to_string() == "TodoCue")
    });
    if legacy {
        let alert = NSAlert::new(objc2::MainThreadMarker::new().ok_or("Expected main thread")?);
        alert.setMessageText(&NSString::from_str(
            "请先退出旧版 TodoCue / Quit the previous TodoCue first",
        ));
        alert.setInformativeText(&NSString::from_str("旧 SwiftUI 客户端仍在运行。退出旧版后重新打开通用版；任务数据会保留。 / Your tasks are preserved."));
        alert.runModal();
        return Err("The previous SwiftUI client is still running".into());
    }
    Ok(())
}
#[cfg(all(windows, test))]
#[path = "win_activation_tests.rs"]
mod win_activation_tests;
#[cfg(windows)]
#[path = "windows_activation.rs"]
mod windows_activation;

/// Ordinary viewing keeps the keyboard in the user's current application.
#[cfg(target_os = "macos")]
pub fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            if let Ok(raw) = target.ns_window() {
                unsafe {
                    (&*(raw as *const objc2_app_kit::NSWindow)).orderFrontRegardless();
                }
            }
        })
        .map_err(|e| e.to_string())
}
#[cfg(windows)]
pub fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "panel" {
        return Err("Passive activation is only supported for the task panel".into());
    }
    on_window_thread(window, |window| {
        let hwnd =
            windows::Win32::Foundation::HWND(window.hwnd().map_err(|e| e.to_string())?.0 as *mut _);
        // Tao uses SW_SHOW even with NOACTIVATE, which activates the window on
        // real Windows. The thread hook persists through queued show operations
        // while Tauri remains responsible for its visibility bookkeeping.
        windows_activation::prevent_activation(hwnd)?;
        window.set_focusable(false).map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())
    })
}
#[cfg(windows)]
pub fn allow_activation(window: &WebviewWindow) -> Result<(), String> {
    on_window_thread(window, |window| {
        let hwnd =
            windows::Win32::Foundation::HWND(window.hwnd().map_err(|e| e.to_string())?.0 as *mut _);
        windows_activation::allow_activation(hwnd)
    })
}
#[cfg(not(windows))]
pub fn allow_activation(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}
#[cfg(windows)]
fn on_window_thread(
    window: &WebviewWindow,
    operation: impl FnOnce(&WebviewWindow) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let target = window.clone();
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    // Wry executes this inline on the UI thread and dispatches from other
    // threads. Acknowledge the operation so hook installation failures never
    // report success or race a following explicit focus request.
    window
        .run_on_main_thread(move || {
            let _ = send.send(operation(&target));
        })
        .map_err(|e| e.to_string())?;
    receive
        .recv()
        .map_err(|_| "Window activation operation did not complete".to_string())?
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
thread_local! {
    static NOTCH_MOUSE_MONITORS: std::cell::RefCell<Vec<objc2::rc::Retained<objc2::runtime::AnyObject>>> = const { std::cell::RefCell::new(Vec::new()) };
}
#[cfg(target_os = "macos")]
pub fn monitor_notch_clicks(app: &tauri::AppHandle) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask, NSWindow};
    use std::ptr::NonNull;
    use tauri::Manager;
    let _marker =
        MainThreadMarker::new().ok_or("Mouse monitors must be installed on the main thread")?;
    let mask = NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown;
    let global_app = app.clone();
    let global = RcBlock::new(move |_event: NonNull<NSEvent>| {
        crate::notch_outside(&global_app);
    });
    let local_app = app.clone();
    let local = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        if let Some(window) = local_app.get_webview_window("notch") {
            if let Ok(raw) = window.ns_window() {
                unsafe {
                    let native = &*(raw as *const NSWindow);
                    if event.as_ref().windowNumber() != native.windowNumber() {
                        crate::notch_outside(&local_app);
                    }
                }
            }
        }
        event.as_ptr()
    });
    let monitors = [
        NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &global),
        unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local) },
    ];
    NOTCH_MOUSE_MONITORS.with(|stored| stored.borrow_mut().extend(monitors.into_iter().flatten()));
    Ok(())
}
#[cfg(not(target_os = "macos"))]
pub fn monitor_notch_clicks(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

/// Mirror the original non-activating bar: hiding its key window releases the keyboard,
/// then notch_present places and re-shows the collapsed bar without focusing it.
#[cfg(target_os = "macos")]
pub fn release_notch_keyboard(window: &WebviewWindow) -> Result<(), String> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            if let Ok(raw) = target.ns_window() {
                unsafe {
                    let native = &*(raw as *const objc2_app_kit::NSWindow);
                    native.makeFirstResponder(None);
                    native.orderOut(None);
                }
            }
        })
        .map_err(|error| error.to_string())
}
#[cfg(not(target_os = "macos"))]
pub fn release_notch_keyboard(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn notch_level(window: &WebviewWindow) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior};
    let _marker = MainThreadMarker::new().ok_or("Notch must be configured on the main thread")?;
    let raw = window.ns_window().map_err(|e| e.to_string())?;
    unsafe {
        let native = &*(raw as *const NSWindow);
        native.setLevel(NSStatusWindowLevel + 1);
        native.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
pub fn notch_level(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub fn configure(
    window: &WebviewWindow,
    interactive: bool,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use windows::Win32::{
        Foundation::HWND,
        Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn},
        UI::WindowsAndMessaging::*,
    };
    let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0 as *mut _);
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    unsafe {
        let mut style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        style |= WS_EX_TOOLWINDOW.0;
        if interactive {
            style &= !WS_EX_NOACTIVATE.0;
        } else {
            style |= WS_EX_NOACTIVATE.0;
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style as isize);
        let radius = if window.label() == "notch" {
            if height <= 24.0 {
                10.0
            } else {
                24.0
            }
        } else {
            42.0
        };
        let top = if window.label() == "notch" {
            -(radius * scale).round() as i32
        } else {
            0
        };
        let region = CreateRoundRectRgn(
            0,
            top,
            (width * scale).ceil() as i32 + 1,
            (height * scale).ceil() as i32 + 1,
            (radius * 2.0 * scale) as i32,
            (radius * 2.0 * scale) as i32,
        );
        // A successful SetWindowRgn transfers ownership to Windows.
        if SetWindowRgn(hwnd, Some(region), true) == 0 {
            let _ = DeleteObject(region.into());
            return Err("Window region could not be applied".into());
        }
    }
    Ok(())
}
#[cfg(not(windows))]
pub fn configure(
    _window: &WebviewWindow,
    _interactive: bool,
    _width: f64,
    _height: f64,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub fn fullscreen(window: &WebviewWindow) -> bool {
    use windows::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        },
        UI::WindowsAndMessaging::*,
    };
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.0.is_null() {
            return false;
        }
        if window
            .hwnd()
            .map(|hwnd| hwnd.0 == foreground.0)
            .unwrap_or(false)
        {
            return false;
        }
        if window
            .hwnd()
            .map(|hwnd| {
                MonitorFromWindow(
                    windows::Win32::Foundation::HWND(hwnd.0),
                    MONITOR_DEFAULTTONEAREST,
                ) != MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST)
            })
            .unwrap_or(true)
        {
            return false;
        }
        // A maximized decorated window and the desktop are not immersive fullscreen.
        if GetWindowLongPtrW(foreground, GWL_STYLE) as u32 & WS_CAPTION.0 != 0 {
            return false;
        }
        let mut class = [0_u16; 128];
        let count = GetClassNameW(foreground, &mut class);
        let class = String::from_utf16_lossy(&class[..count.max(0) as usize]);
        if class == "Progman" || class == "WorkerW" {
            return false;
        }
        let mut rect = RECT::default();
        if GetWindowRect(foreground, &mut rect).is_err() {
            return false;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(
            MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST),
            &mut info,
        )
        .as_bool()
        {
            return false;
        }
        let monitor = info.rcMonitor;
        let frame = |left: i32, top: i32, right: i32, bottom: i32| Frame {
            x: left as f64,
            y: top as f64,
            width: (right - left) as f64,
            height: (bottom - top) as f64,
        };
        covers_screen(
            frame(rect.left, rect.top, rect.right, rect.bottom),
            frame(monitor.left, monitor.top, monitor.right, monitor.bottom),
            0.0,
        )
    }
}

/// macOS: the frontmost application owns an on-screen window covering the notch's screen
/// (NotchController.shouldAutoExpand). Window bounds from CGWindowList and the monitor frame are
/// both top-left-origin points; the allowed top gap is the menu-bar / camera band.
#[cfg(target_os = "macos")]
pub fn fullscreen(window: &WebviewWindow) -> bool {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return false;
    };
    let scale = monitor.scale_factor();
    let screen = Frame {
        x: monitor.position().x as f64 / scale,
        y: monitor.position().y as f64 / scale,
        width: monitor.size().width as f64 / scale,
        height: monitor.size().height as f64 / scale,
    };
    let inset = (monitor.work_area().position.y - monitor.position().y).max(0) as f64 / scale;
    mac_windows::front_application_windows()
        .into_iter()
        .any(|frame| covers_screen(frame, screen, inset))
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn fullscreen(_window: &WebviewWindow) -> bool {
    false
}

#[cfg(target_os = "macos")]
mod mac_windows {
    use crate::notch_geometry::Frame;
    use objc2::{
        msg_send,
        rc::autoreleasepool,
        runtime::{AnyClass, AnyObject},
    };
    use objc2_foundation::NSString;
    use std::ffi::c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(object: *const c_void);
    }
    const ON_SCREEN_ONLY: u32 = 1;
    const EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;

    unsafe fn number(dictionary: *mut AnyObject, key: &str) -> Option<f64> {
        let key = NSString::from_str(key);
        let value: *mut AnyObject = msg_send![dictionary, objectForKey: &*key];
        if value.is_null() {
            None
        } else {
            Some(msg_send![value, doubleValue])
        }
    }

    /// Frames of every on-screen window owned by the frontmost application, unless that is us.
    pub fn front_application_windows() -> Vec<Frame> {
        autoreleasepool(|_| unsafe {
            let Some(class) = AnyClass::get(c"NSWorkspace") else {
                return Vec::new();
            };
            let workspace: *mut AnyObject = msg_send![class, sharedWorkspace];
            if workspace.is_null() {
                return Vec::new();
            }
            let application: *mut AnyObject = msg_send![workspace, frontmostApplication];
            if application.is_null() {
                return Vec::new();
            }
            let pid: i32 = msg_send![application, processIdentifier];
            if pid == std::process::id() as i32 {
                return Vec::new();
            }
            let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS, 0);
            if list.is_null() {
                return Vec::new();
            }
            let array = list as *mut AnyObject;
            let count: usize = msg_send![array, count];
            let mut frames = Vec::new();
            for index in 0..count {
                let entry: *mut AnyObject = msg_send![array, objectAtIndex: index];
                if entry.is_null() || number(entry, "kCGWindowOwnerPID") != Some(pid as f64) {
                    continue;
                }
                let key = NSString::from_str("kCGWindowBounds");
                let bounds: *mut AnyObject = msg_send![entry, objectForKey: &*key];
                if bounds.is_null() {
                    continue;
                }
                if let (Some(x), Some(y), Some(width), Some(height)) = (
                    number(bounds, "X"),
                    number(bounds, "Y"),
                    number(bounds, "Width"),
                    number(bounds, "Height"),
                ) {
                    frames.push(Frame { x, y, width, height });
                }
            }
            CFRelease(list);
            frames
        })
    }
}

/// Opacity of a window as a whole, glass included. macOS only; Windows fades the page with CSS
/// because its transparent WebView2 window is not a layered window.
#[cfg(target_os = "macos")]
pub fn set_alpha(window: &WebviewWindow, alpha: f64) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(raw) = target.ns_window() {
            unsafe { (&*(raw as *const objc2_app_kit::NSWindow)).setAlphaValue(alpha) };
        }
    });
}
#[cfg(not(target_os = "macos"))]
pub fn set_alpha(_window: &WebviewWindow, _alpha: f64) {}

/// The panel follows you to the active Space and may sit over a fullscreen app, like the original.
#[cfg(target_os = "macos")]
pub fn panel_spaces(window: &WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let raw = window.ns_window().map_err(|e| e.to_string())?;
    unsafe {
        let native = &*(raw as *const NSWindow);
        native.setCollectionBehavior(
            NSWindowCollectionBehavior::MoveToActiveSpace
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
pub fn panel_spaces(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// The system "reduce motion" preference (macOS accessibility, Windows animation effects).
#[cfg(target_os = "macos")]
pub fn reduce_motion() -> bool {
    use objc2::{
        msg_send,
        rc::autoreleasepool,
        runtime::{AnyClass, AnyObject},
    };
    autoreleasepool(|_| unsafe {
        let Some(class) = AnyClass::get(c"NSWorkspace") else {
            return false;
        };
        let workspace: *mut AnyObject = msg_send![class, sharedWorkspace];
        !workspace.is_null() && msg_send![workspace, accessibilityDisplayShouldReduceMotion]
    })
}
#[cfg(windows)]
pub fn reduce_motion() -> bool {
    use windows::{
        core::BOOL,
        Win32::UI::WindowsAndMessaging::{
            SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        },
    };
    let mut enabled = BOOL(1);
    let read = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut enabled as *mut BOOL as *mut std::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    read.is_ok() && !enabled.as_bool()
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn reduce_motion() -> bool {
    false
}

/// Windows keeps a window on the virtual desktop it was created on. Move it to the desktop the
/// user is looking at (the foreground window's) so the hotkey, the tray and the notch show up
/// where they are. Fire and forget; a no-op when it is already there.
#[cfg(windows)]
pub fn follow_virtual_desktop(window: &WebviewWindow) {
    use windows::Win32::{
        Foundation::HWND,
        System::Com::{CoCreateInstance, CLSCTX_ALL},
        UI::{
            Shell::{IVirtualDesktopManager, VirtualDesktopManager},
            WindowsAndMessaging::GetForegroundWindow,
        },
    };
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(hwnd) = target.hwnd() else { return };
        let hwnd = HWND(hwnd.0 as *mut _);
        unsafe {
            let Ok(manager) =
                CoCreateInstance::<_, IVirtualDesktopManager>(&VirtualDesktopManager, None, CLSCTX_ALL)
            else {
                return;
            };
            if manager
                .IsWindowOnCurrentVirtualDesktop(hwnd)
                .map(|here| here.as_bool())
                .unwrap_or(true)
            {
                return;
            }
            let foreground = GetForegroundWindow();
            if foreground.0.is_null() {
                return;
            }
            if let Ok(desktop) = manager.GetWindowDesktopId(foreground) {
                let _ = manager.MoveWindowToDesktop(hwnd, &desktop);
            }
        }
    });
}
#[cfg(not(windows))]
pub fn follow_virtual_desktop(_window: &WebviewWindow) {}

#[cfg(target_os = "macos")]
pub fn glass(window: &WebviewWindow) -> Result<(), String> {
    use objc2::{msg_send, MainThreadMarker};
    use objc2_app_kit::{
        NSGlassEffectView, NSGlassEffectViewStyle, NSView, NSVisualEffectView, NSWindow,
    };
    use objc2_foundation::NSProcessInfo;
    let marker = MainThreadMarker::new().ok_or("Glass must be configured on the main thread")?;
    let raw = window.ns_window().map_err(|e| e.to_string())?;
    unsafe {
        let native = &*(raw as *const NSWindow);
        let content = native.contentView().ok_or("Window content unavailable")?;
        let effect: objc2::rc::Retained<NSView> = if NSProcessInfo::processInfo()
            .operatingSystemVersion()
            .majorVersion
            >= 26
        {
            let glass = NSGlassEffectView::new(marker);
            glass.setStyle(NSGlassEffectViewStyle::Regular);
            glass.setCornerRadius(42.0);
            objc2::rc::Retained::into_super(glass)
        } else {
            let blur = NSVisualEffectView::new(marker);
            let _: () = msg_send![&blur, setBlendingMode: 0_isize];
            let _: () = msg_send![&blur, setMaterial: 6_isize];
            let _: () = msg_send![&blur, setState: 1_isize];
            objc2::rc::Retained::into_super(blur)
        };
        let frame = content.bounds();
        effect.setFrame(frame);
        let _: () = msg_send![&effect, setAutoresizingMask: 18_usize];
        let _: () = msg_send![&effect, setWantsLayer: true];
        let layer: *mut objc2::runtime::AnyObject = msg_send![&effect, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setCornerRadius: 42_f64];
            let _: () = msg_send![layer, setMasksToBounds: true];
        }
        let effect_view: &NSView = effect.as_ref();
        let _: () = msg_send![&content, addSubview: effect_view, positioned: -1_isize, relativeTo: std::ptr::null::<NSView>()];
    }
    Ok(())
}
#[cfg(windows)]
pub fn glass(window: &WebviewWindow) -> Result<(), String> {
    use tauri::{utils::WindowEffect, window::EffectsBuilder};
    // Acrylic is available on Windows 10/11. CSS retains an opaque fallback if the
    // compositor cannot apply it (remote sessions and disabled transparency).
    let _ = window.set_effects(
        EffectsBuilder::new()
            .effect(WindowEffect::Acrylic)
            .color(tauri::window::Color(238, 240, 242, 160))
            .build(),
    );
    Ok(())
}
#[cfg(not(any(target_os = "macos", windows)))]
pub fn glass(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}
