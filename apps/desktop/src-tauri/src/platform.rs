#[allow(unused_imports)]
use crate::notch_geometry::{covers_screen, fullscreen_top_inset, is_fullscreen_window, Frame};
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
            if height <= 32.0 {
                12.0
            } else {
                24.0
            }
        } else {
            42.0
        };
        use tauri::Manager;
        let placement = window.state::<crate::Desktop>().settings.lock().unwrap().notch_placement.clone();
        let notch = window.label() == "notch";
        let top = if notch && placement == crate::notch_display::Placement::Top {
            -(radius * scale).round() as i32
        } else { 0 };
        let left = if notch && placement == crate::notch_display::Placement::Left { -(radius * scale).round() as i32 } else { 0 };
        let right = if notch && placement == crate::notch_display::Placement::Right { (radius * scale).round() as i32 } else { 0 };
        let region = CreateRoundRectRgn(
            left,
            top,
            (width * scale).ceil() as i32 + 1 + right,
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
        use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
        let Ok(own) = window.hwnd() else { return false; };
        let target = MonitorFromWindow(windows::Win32::Foundation::HWND(own.0), MONITOR_DEFAULTTONEAREST);
        let mut target_info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(target, &mut target_info).as_bool() { return false; }
        let center_x = (target_info.rcMonitor.left + target_info.rcMonitor.right) / 2;
        let center_y = (target_info.rcMonitor.top + target_info.rcMonitor.bottom) / 2;
        let mut cursor = GetTopWindow(None).ok();
        let mut candidate = None;
        for _ in 0..512 {
            let Some(hwnd) = cursor else { break; };
            cursor = GetWindow(hwnd, GW_HWNDNEXT).ok();
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == std::process::id() || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() { continue; }
            let mut cloaked: u32 = 0;
            let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, std::mem::size_of::<u32>() as u32);
            if cloaked != 0 || MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) != target { continue; }
            let mut class = [0_u16; 128];
            let count = GetClassNameW(hwnd, &mut class);
            let class = String::from_utf16_lossy(&class[..count.max(0) as usize]);
            if ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"].contains(&class.as_str()) { continue; }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() && center_x >= rect.left && center_x < rect.right && center_y >= rect.top && center_y < rect.bottom {
                candidate = Some(hwnd);
                break;
            }
        }
        let Some(foreground) = candidate else { return false; };
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

/// macOS: inspect the notch screen even when the foreground application is on another display.
/// (NotchController.shouldAutoExpand). Window bounds from CGWindowList and the monitor frame are
/// both top-left-origin points. The monitor frame is the whole screen, menu bar and camera area
/// included; a fullscreen window may start below the camera's safe area, whose height (not the work
/// area's gap, which is the menu bar's with or without fullscreen) is the room allowed at the top.
/// A window that starts there is only fullscreen if the active Space is one (`mac_spaces`): a zoomed
/// window has the same bounds.
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
    let details = display_details(window).unwrap_or_default();
    let display = details.iter().find(|d| (d.x - screen.x).abs() < 1.0 && (d.y - screen.y).abs() < 1.0);
    let fullscreen_space = display.and_then(|d| mac_spaces::display_space_is_fullscreen(&d.id));
    if fullscreen_space == Some(true) { return true; }
    let inset = fullscreen_top_inset(safe_area_top(window));
    // CGWindowList is front-to-back. Do not mistake a covered fullscreen-size background window
    // for the content the user sees. Native fullscreen remains quiet even with a dialog above it.
    mac_windows::visible_application_windows().into_iter()
        .find(|frame| crate::notch_geometry::contains(*frame, screen.x + screen.width / 2.0, screen.y + screen.height / 2.0))
        .is_some_and(|frame| is_fullscreen_window(frame, screen, inset, fullscreen_space))
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn fullscreen(_window: &WebviewWindow) -> bool {
    false
}

/// Whether the Space the person is looking at is a native fullscreen one. WindowServer has no public
/// call for this (`NSApplication.currentSystemPresentationOptions` only reflects this process), so
/// the long-standing CGS functions are looked up at run time: if a future macOS drops one, the
/// answer is `None` and the app still starts.
#[cfg(target_os = "macos")]
mod mac_spaces {
    use std::ffi::{c_char, c_void};
    use std::sync::OnceLock;

    extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }
    const RTLD_DEFAULT: *mut c_void = -2_isize as *mut c_void;
    /// `kCGSSpaceFullscreen`; a regular desktop Space is 0.
    const FULLSCREEN_SPACE: i32 = 4;

    type MainConnection = unsafe extern "C" fn() -> u32;
    type ActiveSpace = unsafe extern "C" fn(u32) -> u64;
    type DisplaySpace = unsafe extern "C" fn(u32, *const objc2_foundation::NSString) -> u64;
    type SpaceType = unsafe extern "C" fn(u32, u64) -> i32;

    struct Api {
        connection: MainConnection,
        #[allow(dead_code)]
        active_space: ActiveSpace,
        display_space: Option<DisplaySpace>,
        space_type: SpaceType,
    }

    fn api() -> Option<&'static Api> {
        static API: OnceLock<Option<Api>> = OnceLock::new();
        API.get_or_init(|| unsafe {
            let find = |name: &'static std::ffi::CStr| {
                let symbol = dlsym(RTLD_DEFAULT, name.as_ptr());
                (!symbol.is_null()).then_some(symbol)
            };
            Some(Api {
                connection: std::mem::transmute::<*mut c_void, MainConnection>(find(
                    c"CGSMainConnectionID",
                )?),
                active_space: std::mem::transmute::<*mut c_void, ActiveSpace>(find(
                    c"CGSGetActiveSpace",
                )?),
                display_space: find(c"CGSManagedDisplayGetCurrentSpace").map(|symbol| std::mem::transmute::<*mut c_void, DisplaySpace>(symbol)),
                space_type: std::mem::transmute::<*mut c_void, SpaceType>(find(
                    c"CGSSpaceGetType",
                )?),
            })
        })
        .as_ref()
    }

    #[cfg(test)]
    pub fn active_space_is_fullscreen() -> Option<bool> {
        let api = api()?;
        unsafe {
            let connection = (api.connection)();
            let space = (api.active_space)(connection);
            Some((api.space_type)(connection, space) == FULLSCREEN_SPACE)
        }
    }

    pub fn display_space_is_fullscreen(id: &str) -> Option<bool> {
        let raw = id.strip_prefix("mac:")?;
        if raw.len() != 32 || !raw.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
        let uuid = format!("{}-{}-{}-{}-{}", &raw[..8], &raw[8..12], &raw[12..16], &raw[16..20], &raw[20..]).to_uppercase();
        let api = api()?;
        let display_space = api.display_space?;
        let name = objc2_foundation::NSString::from_str(&uuid);
        unsafe {
            let connection = (api.connection)();
            let space = display_space(connection, &*name);
            (space != 0).then(|| (api.space_type)(connection, space) == FULLSCREEN_SPACE)
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn the_space_type_can_be_read_on_this_macos() {
            // The value depends on where the person is looking; resolving the symbols must not.
            assert!(super::active_space_is_fullscreen().is_some());
        }
    }
}

#[cfg(target_os = "macos")]
mod mac_windows {
    use crate::notch_geometry::Frame;
    use objc2::{
        msg_send,
        rc::autoreleasepool,
        runtime::AnyObject,
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

    /// On-screen windows, front-to-back, that `keep` accepts by whether TodoCue owns them, layer
    /// and alpha. `None` when the window list cannot be read.
    fn windows(options: u32, keep: impl Fn(bool, Option<f64>, Option<f64>) -> bool) -> Option<Vec<Frame>> {
        autoreleasepool(|_| unsafe {
            let list = CGWindowListCopyWindowInfo(options, 0);
            if list.is_null() {
                return None;
            }
            let array = list as *mut AnyObject;
            let count: usize = msg_send![array, count];
            let mut frames = Vec::new();
            for index in 0..count {
                let entry: *mut AnyObject = msg_send![array, objectAtIndex: index];
                if entry.is_null()
                    || !keep(
                        number(entry, "kCGWindowOwnerPID") == Some(std::process::id() as f64),
                        number(entry, "kCGWindowLayer"),
                        number(entry, "kCGWindowAlpha"),
                    ) {
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
            Some(frames)
        })
    }

    /// Visible normal application windows, front-to-back, excluding TodoCue and desktop elements.
    pub fn visible_application_windows() -> Vec<Frame> {
        windows(ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS, |own, layer, alpha| {
            !own && layer == Some(0.0) && alpha != Some(0.0)
        })
        .unwrap_or_default()
    }

    /// Visible windows at the status-bar level: the menu bar icons of every app, TodoCue's own
    /// tray icon included (macOS 26 hosts them all in Control Center, earlier versions in each
    /// app). The notch sits one level higher. Bounds and layer need no Screen Recording
    /// permission; window names would.
    pub fn status_bar_windows() -> Option<Vec<Frame>> {
        let level = objc2_app_kit::NSStatusWindowLevel as f64;
        windows(ON_SCREEN_ONLY, |_, layer, alpha| layer == Some(level) && alpha != Some(0.0))
    }
}

/// Global top-left points of the menu bar icons on every screen; `None` when they cannot be read.
#[cfg(target_os = "macos")]
pub fn status_bar_windows() -> Option<Vec<Frame>> {
    mac_windows::status_bar_windows()
}
#[cfg(not(target_os = "macos"))]
pub fn status_bar_windows() -> Option<Vec<Frame>> {
    None
}

/// Opacity of a window as a whole, glass included. macOS only; Windows fades the page with CSS
/// because its transparent WebView2 window is not a layered window. Must run on the main thread.
#[cfg(target_os = "macos")]
pub fn set_alpha_now(window: &WebviewWindow, alpha: f64) {
    if let Ok(raw) = window.ns_window() {
        unsafe { (&*(raw as *const objc2_app_kit::NSWindow)).setAlphaValue(alpha) };
    }
}
#[cfg(not(target_os = "macos"))]
pub fn set_alpha_now(_window: &WebviewWindow, _alpha: f64) {}

/// Run `read` on the main thread and wait for its answer. `None` if the main thread does not
/// answer in time, so a busy or blocked one never stalls the caller for long.
#[cfg(target_os = "macos")]
fn on_main_thread<T: Send + 'static>(
    window: &WebviewWindow,
    read: impl FnOnce(&WebviewWindow) -> T + Send + 'static,
) -> Option<T> {
    if objc2::MainThreadMarker::new().is_some() {
        return Some(read(window));
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(read(&target));
        })
        .ok()?;
    receiver.recv_timeout(std::time::Duration::from_millis(300)).ok()
}

/// Whether the window is in the Space the person is looking at. A window that is ordered in on
/// another Space is "visible" but not here (macOS); elsewhere it always is.
#[cfg(target_os = "macos")]
pub fn on_active_space(window: &WebviewWindow) -> bool {
    on_main_thread(window, |window| {
        window
            .ns_window()
            .map(|raw| unsafe { (&*(raw as *const objc2_app_kit::NSWindow)).isOnActiveSpace() })
            .unwrap_or(true)
    })
    .unwrap_or(true)
}
#[cfg(not(target_os = "macos"))]
pub fn on_active_space(_window: &WebviewWindow) -> bool {
    true
}

/// Height of the camera housing's safe area at the top of the window's screen; 0 without one.
#[cfg(target_os = "macos")]
fn safe_area_top(window: &WebviewWindow) -> f64 {
    on_main_thread(window, |window| {
        let Ok(raw) = window.ns_window() else {
            return 0.0;
        };
        unsafe {
            (&*(raw as *const objc2_app_kit::NSWindow))
                .screen()
                .map(|screen| screen.safeAreaInsets().top)
                .unwrap_or(0.0)
        }
    })
    .unwrap_or(0.0)
}

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

/// Native identity is independent of resolution, scale, arrangement and localized display name.
#[cfg(target_os = "macos")]
#[derive(Clone)]
pub struct DisplayDetails {
    pub id: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub safe_top: f64,
    pub has_notch: bool,
    pub camera_height: f64,
    pub camera_width: f64,
}

/// Last complete answer of `display_details`. While screens are being plugged in or the Mac wakes,
/// the main thread can stay busy past the read's timeout; the last known notch and menu bar
/// geometry is far closer to the truth than failing the placement of the notch window.
#[cfg(target_os = "macos")]
static LAST_DISPLAY_DETAILS: std::sync::Mutex<Option<Vec<DisplayDetails>>> = std::sync::Mutex::new(None);

#[cfg(target_os = "macos")]
thread_local! {
    /// Whether this thread's latest `display_details` call fell back to the cached answer.
    static DETAILS_STALE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(target_os = "macos")]
pub fn display_details(window: &WebviewWindow) -> Result<Vec<DisplayDetails>, String> {
    let read = read_display_details(window);
    DETAILS_STALE.set(read.is_err());
    crate::notch_display::or_last_known(read, &LAST_DISPLAY_DETAILS)
}

/// True when the calling thread's latest screen read failed and an older one was used instead.
/// A placement made from it is provisional: callers that remember "placed for this layout" must
/// not, so the placement is tried again with a fresh read.
#[cfg(target_os = "macos")]
pub fn display_details_stale() -> bool {
    DETAILS_STALE.get()
}
#[cfg(not(target_os = "macos"))]
pub fn display_details_stale() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn read_display_details(window: &WebviewWindow) -> Result<Vec<DisplayDetails>, String> {
    on_main_thread(window, |_| {
        use objc2::{msg_send, MainThreadMarker};
        use objc2_app_kit::{NSScreen, NSStatusBar};
        use objc2_foundation::{NSRect, NSString};
        use std::ffi::c_void;
        #[repr(C)]
        struct UuidBytes { bytes: [u8; 16] }
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGDisplayBounds(display: u32) -> NSRect;
            fn CGDisplayCreateUUIDFromDisplayID(display: u32) -> *const c_void;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFUUIDGetUUIDBytes(uuid: *const c_void) -> UuidBytes;
            fn CFRelease(value: *const c_void);
        }
        let marker = MainThreadMarker::new().expect("Display enumeration on main thread");
        let menu_height = NSStatusBar::systemStatusBar().thickness();
        NSScreen::screens(marker).iter().filter_map(|screen| unsafe {
            let number = screen.deviceDescription().objectForKey(&NSString::from_str("NSScreenNumber"))?;
            let display_id: u32 = msg_send![&*number, unsignedIntValue];
            let uuid = CGDisplayCreateUUIDFromDisplayID(display_id);
            if uuid.is_null() { return None; }
            let id = CFUUIDGetUUIDBytes(uuid).bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
            CFRelease(uuid);
            let bounds = CGDisplayBounds(display_id);
            let safe = screen.safeAreaInsets().top;
            let left = screen.auxiliaryTopLeftArea();
            let right = screen.auxiliaryTopRightArea();
            let camera_width = if safe > 0.0 && left.size.width > 0.0 && right.size.width > 0.0 {
                (right.origin.x - left.origin.x - left.size.width).max(0.0)
            } else { 0.0 };
            Some(DisplayDetails {
                id: format!("mac:{id}"), name: screen.localizedName().to_string(),
                x: bounds.origin.x, y: bounds.origin.y,
                safe_top: safe.max(menu_height), has_notch: safe > 0.0,
                camera_height: safe, camera_width,
            })
        }).collect()
    }).ok_or_else(|| "Could not read connected displays".into())
}
