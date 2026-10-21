//! System-wide idle time: seconds since the last keyboard or mouse input of the logged-in session.

/// `None` where the platform offers no reading (or the call failed).
#[cfg(target_os = "macos")]
pub fn idle_seconds() -> Option<u64> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType (~0).
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    (seconds.is_finite() && seconds >= 0.0).then_some(seconds as u64)
}

#[cfg(windows)]
pub fn idle_seconds() -> Option<u64> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return None;
    }
    // Both are 32-bit millisecond tick counts that wrap after ~49 days.
    let millis = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
    Some(u64::from(millis) / 1000)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn idle_seconds() -> Option<u64> {
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn the_session_idle_time_can_be_read() {
        // A sane reading: present, and not longer than the machine has existed.
        assert!(super::idle_seconds().is_some_and(|seconds| seconds < 10 * 365 * 86_400));
    }
}
