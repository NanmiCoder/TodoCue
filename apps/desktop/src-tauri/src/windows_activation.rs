//! A thread-local CBT hook stops passive panel presentation from taking the
//! keyboard. NOACTIVATE alone does not stop Tao's SW_SHOW activation on Windows.

use std::{cell::RefCell, collections::HashSet};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::Threading::GetCurrentThreadId,
    UI::WindowsAndMessaging::{
        CallNextHookEx, GetWindowThreadProcessId, SetWindowsHookExW, UnhookWindowsHookEx,
        HCBT_ACTIVATE, HCBT_DESTROYWND, HHOOK, WH_CBT,
    },
};

#[derive(Default)]
struct ThreadActivation {
    hook: Option<HHOOK>,
    passive: HashSet<usize>,
}

impl Drop for ThreadActivation {
    fn drop(&mut self) {
        if let Some(hook) = self.hook.take() {
            let _ = unsafe { UnhookWindowsHookEx(hook) };
        }
    }
}

thread_local! {
    // Keep the hook until the UI thread exits. Presentation can be queued by
    // Tauri, so a temporary guard would be dropped before SW_SHOW is handled.
    static ACTIVATION: RefCell<ThreadActivation> = RefCell::new(ThreadActivation::default());
}

fn check_window_thread(hwnd: HWND) -> Result<(), String> {
    let owner = unsafe { GetWindowThreadProcessId(hwnd, None) };
    if owner == 0 || owner != unsafe { GetCurrentThreadId() } {
        return Err("Window activation must run on the owning UI thread".into());
    }
    Ok(())
}

pub(super) fn prevent_activation(hwnd: HWND) -> Result<(), String> {
    check_window_thread(hwnd)?;
    ACTIVATION.with(|state| {
        let mut state = state.borrow_mut();
        if state.hook.is_none() {
            state.hook = Some(
                unsafe {
                    SetWindowsHookExW(WH_CBT, Some(activation_hook), None, GetCurrentThreadId())
                }
                .map_err(|error| format!("Passive panel activation hook unavailable: {error}"))?,
            );
        }
        state.passive.insert(hwnd.0 as usize);
        Ok(())
    })
}

pub(super) fn allow_activation(hwnd: HWND) -> Result<(), String> {
    check_window_thread(hwnd)?;
    ACTIVATION.with(|state| {
        state.borrow_mut().passive.remove(&(hwnd.0 as usize));
    });
    Ok(())
}

unsafe extern "system" fn activation_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HCBT_ACTIVATE as i32 {
        // Never unwind through Win32's callback, including TLS teardown. No
        // native operation runs while the passive set is borrowed.
        let blocked = ACTIVATION
            .try_with(|state| {
                state
                    .try_borrow()
                    .is_ok_and(|state| state.passive.contains(&wparam.0))
            })
            .unwrap_or(false);
        if blocked {
            return LRESULT(1);
        }
    } else if code == HCBT_DESTROYWND as i32 {
        // A later unrelated window may reuse a HWND. Destroying the registered
        // panel removes its entry before that handle can be reused.
        let _ = ACTIVATION.try_with(|state| {
            if let Ok(mut state) = state.try_borrow_mut() {
                state.passive.remove(&wparam.0);
            }
        });
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

#[cfg(test)]
pub(super) fn is_passive(hwnd: HWND) -> bool {
    ACTIVATION.with(|state| state.borrow().passive.contains(&(hwnd.0 as usize)))
}
