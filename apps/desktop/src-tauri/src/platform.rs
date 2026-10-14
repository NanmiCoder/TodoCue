use tauri::WebviewWindow;
#[cfg(all(windows, test))]
#[path = "win_activation_tests.rs"]
mod win_activation_tests;

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
    // Keep Tao's visibility bookkeeping synchronized. Direct ShowWindow bypasses
    // it and breaks subsequent focus/hide commands. Editing explicitly restores
    // focusability; ordinary presentation keeps the NOACTIVATE style.
    window.set_focusable(false).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())
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
        (rect.left - monitor.left).abs() <= 2
            && (rect.top - monitor.top).abs() <= 2
            && (rect.right - monitor.right).abs() <= 2
            && (rect.bottom - monitor.bottom).abs() <= 2
    }
}
#[cfg(not(windows))]
pub fn fullscreen(_window: &WebviewWindow) -> bool {
    false
}

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
