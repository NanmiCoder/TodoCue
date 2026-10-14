//! Actual Win32 thread activation regression. This does not claim that a CI
//! desktop has a foreground application or that WebView input has been tested.

use super::windows_activation::{allow_activation, is_passive, prevent_activation};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::{
            Input::KeyboardAndMouse::{GetActiveWindow, SetActiveWindow},
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowLongPtrW, IsWindowVisible,
                RegisterClassW, SetWindowLongPtrW, ShowWindow, UnregisterClassW, GWL_EXSTYLE,
                SW_HIDE, SW_SHOW, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WNDCLASSW, WS_EX_NOACTIVATE,
                WS_OVERLAPPEDWINDOW,
            },
        },
    },
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

struct WindowClass {
    name: Vec<u16>,
    instance: HINSTANCE,
    registered: bool,
}

impl WindowClass {
    fn register() -> Self {
        let instance = HINSTANCE(
            unsafe { GetModuleHandleW(PCWSTR::null()) }
                .expect("Activation test module handle unavailable")
                .0,
        );
        let name = wide(&format!(
            "TodoCueActivationRegression-{}-{}",
            std::process::id(),
            unsafe { GetCurrentThreadId() },
        ));
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: PCWSTR(name.as_ptr()),
            ..Default::default()
        };
        assert_ne!(
            unsafe { RegisterClassW(&class) },
            0,
            "RegisterClassW failed: {}",
            windows::core::Error::from_win32(),
        );
        Self {
            name,
            instance,
            registered: true,
        }
    }

    fn create(&self, title: &str, style: WINDOW_EX_STYLE) -> TestWindow {
        let title = wide(title);
        let hwnd = unsafe {
            CreateWindowExW(
                style,
                PCWSTR(self.name.as_ptr()),
                PCWSTR(title.as_ptr()),
                WS_OVERLAPPEDWINDOW,
                20,
                20,
                160,
                90,
                None,
                None,
                Some(self.instance),
                None,
            )
        }
        .expect("CreateWindowExW failed; this Windows host cannot run the activation regression");
        TestWindow { hwnd: Some(hwnd) }
    }

    fn unregister(&mut self) {
        unsafe { UnregisterClassW(PCWSTR(self.name.as_ptr()), Some(self.instance)) }
            .expect("Activation regression window class was not cleaned up");
        self.registered = false;
    }
}

impl Drop for WindowClass {
    fn drop(&mut self) {
        if self.registered {
            let _ = unsafe { UnregisterClassW(PCWSTR(self.name.as_ptr()), Some(self.instance)) };
        }
    }
}

struct TestWindow {
    hwnd: Option<HWND>,
}

impl TestWindow {
    fn handle(&self) -> HWND {
        self.hwnd.expect("Activation test window already destroyed")
    }

    fn destroy(&mut self) {
        unsafe { DestroyWindow(self.handle()) }.expect("Activation test window was not destroyed");
        self.hwnd = None;
    }
}

impl Drop for TestWindow {
    fn drop(&mut self) {
        if let Some(hwnd) = self.hwnd.take() {
            let _ = unsafe { DestroyWindow(hwnd) };
        }
    }
}

#[test]
fn passive_panel_guard_preserves_thread_activation_and_allows_explicit_editing() {
    // Each Rust test thread owns its windows and activation queue. There is no
    // dependency on the system foreground window, user data, or another app.
    // Class is created first, so its Drop runs after both windows on failures.
    let mut class = WindowClass::register();
    let mut a = class.create("TodoCue isolated activation test A", WINDOW_EX_STYLE(0));
    let mut b = class.create("TodoCue isolated activation test B", WS_EX_NOACTIVATE);

    prevent_activation(b.handle()).expect("Production passive activation guard could not install");
    assert!(is_passive(b.handle()));
    let foreign_handle = b.handle().0 as usize;
    let wrong_thread =
        std::thread::spawn(move || prevent_activation(HWND(foreign_handle as *mut _)))
            .join()
            .expect("Wrong-thread activation check panicked");
    assert!(
        wrong_thread.is_err(),
        "Passive guard accepted a window owned by another thread"
    );

    unsafe {
        // Establish a non-null queue activation baseline without asking to
        // foreground this test process. SetActiveWindow returns the *previous*
        // active window, which may validly be null; verify its effect instead.
        let _ = ShowWindow(a.handle(), SW_SHOWNOACTIVATE);
        let _ = SetActiveWindow(a.handle());
        assert_eq!(
            GetActiveWindow(),
            a.handle(),
            "Test window A could not become thread-active"
        );

        for _ in 0..2 {
            // Match Tao's SW_SHOW path and use the production activation guard.
            // NOACTIVATE alone was proven to steal activation on Windows CI.
            let _ = ShowWindow(b.handle(), SW_SHOW);
            assert!(
                IsWindowVisible(b.handle()).as_bool(),
                "Passive window B was not shown"
            );
            assert_eq!(
                GetActiveWindow(),
                a.handle(),
                "Guarded SW_SHOW stole thread activation"
            );
            let _ = SetActiveWindow(b.handle());
            assert_eq!(
                GetActiveWindow(),
                a.handle(),
                "Passive B accepted an unsolicited activation"
            );
            let _ = ShowWindow(b.handle(), SW_HIDE);
            assert!(
                !IsWindowVisible(b.handle()).as_bool(),
                "Window B could not be hidden"
            );
            assert_eq!(
                GetActiveWindow(),
                a.handle(),
                "Hiding passive B changed thread activation"
            );
        }

        // The hook filters exactly registered HWNDs. It must not block another
        // task/notch window or leave thread-wide activation disabled.
        let mut other = class.create(
            "TodoCue unrelated activation test window",
            WINDOW_EX_STYLE(0),
        );
        let _ = ShowWindow(other.handle(), SW_SHOWNOACTIVATE);
        let _ = SetActiveWindow(other.handle());
        assert_eq!(
            GetActiveWindow(),
            other.handle(),
            "Passive panel guard blocked an unrelated window"
        );
        let _ = SetActiveWindow(a.handle());
        assert_eq!(GetActiveWindow(), a.handle());
        other.destroy();

        // Editing restores focusability. Confirm that this restoration is not
        // permanently blocked by the passive presentation's style.
        allow_activation(b.handle())
            .expect("Explicit editing could not release passive activation");
        assert!(!is_passive(b.handle()));
        let style = GetWindowLongPtrW(b.handle(), GWL_EXSTYLE);
        SetWindowLongPtrW(
            b.handle(),
            GWL_EXSTYLE,
            style & !(WS_EX_NOACTIVATE.0 as isize),
        );
        assert_eq!(
            GetWindowLongPtrW(b.handle(), GWL_EXSTYLE) & WS_EX_NOACTIVATE.0 as isize,
            0
        );
        let _ = ShowWindow(b.handle(), SW_SHOW);
        let _ = SetActiveWindow(b.handle());
        assert_eq!(
            GetActiveWindow(),
            b.handle(),
            "Explicit editing could not activate B"
        );

        // Destroying a still-passive window removes its handle, so another
        // window reusing that value cannot inherit the activation restriction.
        prevent_activation(b.handle()).expect("Passive guard could not be restored");
        let _ = SetActiveWindow(a.handle());
        assert_eq!(GetActiveWindow(), a.handle());
    }

    let destroyed = b.handle();
    b.destroy();
    assert!(
        !is_passive(destroyed),
        "Destroyed HWND remained registered as passive"
    );
    a.destroy();
    class.unregister();
}
