/// Reserve the visible menu bar or the native menu/camera safe inset even when the menu auto-hides.
pub fn safe_work_area(screen_y: f64, work: Frame, safe_top: f64, scale: f64) -> Frame {
    let y = work.y.max(screen_y + safe_top * scale);
    Frame { y, height: (work.y + work.height - y).max(0.0), ..work }
}

/// On a camera screen the band wraps the housing at the screen's top edge. Its center is an
/// empty spacer; only the two wings contain controls. Never offset the whole band below it.
pub fn camera_work_area(screen: Frame, work: Frame, camera_height: f64) -> Frame {
    if !camera_height.is_finite() || camera_height <= 0.0 { return work; }
    // A left/right Dock changes visibleFrame, but never moves the camera's screen center.
    Frame { x: screen.x, y: screen.y, width: screen.width, height: (work.y + work.height - screen.y).max(0.0) }
}

pub const DEFAULT_NOTCH_WIDTH: f64 = 273.0;

pub fn compact_width(camera_width: f64, placement: &crate::notch_display::Placement) -> f64 {
    use crate::notch_display::Placement;
    match placement {
        Placement::Top => (housing_width(camera_width, placement) + 44.0).min(DEFAULT_NOTCH_WIDTH),
        _ => 88.0,
    }
}

/// Cap the total width at the original default even on scaled displays. A spacer may
/// consume the entire collapsed band; controls must never spill into the physical housing.
pub fn housing_width(camera_width: f64, placement: &crate::notch_display::Placement) -> f64 {
    if *placement != crate::notch_display::Placement::Top { return 0.0; }
    if camera_width.is_finite() && camera_width > 0.0 { camera_width.min(DEFAULT_NOTCH_WIDTH) }
    else { 185.0 }
}

/// The band wraps the camera housing, or is as tall as a visible menu bar on a screen without one.
pub fn band_height(camera_height: f64, menu_height: f64, placement: &crate::notch_display::Placement) -> f64 {
    if *placement != crate::notch_display::Placement::Top { return 32.0; }
    if camera_height.is_finite() && camera_height > 0.0 { camera_height }
    else if menu_height.is_finite() && menu_height >= MIN_MENU_HEIGHT { menu_height }
    else { 32.0 }
}

/// Anything shorter is not a menu bar the band could sit in (auto-hidden, or none on this screen).
pub const MIN_MENU_HEIGHT: f64 = 18.0;
/// Room kept at the left of a menu bar for the active app's own menus when icons push the band
/// away from the center. Without the Accessibility permission nothing reports where they end; the
/// widest of 22 running apps measured on a 1920-point screen (Chrome, 11 menus) ended at 594
/// points. The center itself is always allowed, as it was for the original virtual notch.
pub const APP_MENU_ROOM: f64 = 640.0;
/// Space kept between the band and the nearest menu bar icon.
pub const MENU_ICON_GAP: f64 = 8.0;
/// A band that still fits stays where it is unless the best place moved further than this: an icon
/// that changes width (TodoCue's own count, 18 points; a clock gaining a digit) must not make it
/// hop, while an icon that comes or goes does move it.
pub const MENU_SETTLE: f64 = 24.0;

/// Left edge of the place where a band `width` wide fits in the visible menu bar of a screen
/// without a camera housing: the screen's center when that is free, otherwise the free place
/// nearest to it, kept out of the app menus' room. It covers no menu bar icon (`windows`: frames
/// of the status-bar-level windows, of which only those in this menu bar count). macOS lays its
/// icons out without knowing about the band, so this is how they stay where it put them. The
/// band stays at `current` (its present left edge) while that still fits and the best place is
/// within `MENU_SETTLE` of it. `None` when no gap is wide enough: the band then goes below the
/// menu bar. All in points.
pub fn menu_bar_slot(screen: Frame, menu_height: f64, windows: &[Frame], width: f64, current: Option<f64>) -> Option<f64> {
    if !(width.is_finite() && width > 0.0 && menu_height.is_finite() && menu_height >= MIN_MENU_HEIGHT) {
        return None;
    }
    let end = screen.x + screen.width;
    let in_menu_bar = |icon: &&Frame| {
        (icon.y - screen.y).abs() <= EDGE_TOLERANCE
            && icon.y + icon.height <= screen.y + menu_height + EDGE_TOLERANCE
            && icon.x < end
            && icon.x + icon.width > screen.x
    };
    let mut taken: Vec<(f64, f64)> = windows
        .iter()
        .filter(in_menu_bar)
        .map(|icon| {
            let right = icon.x + icon.width;
            // Menu bar managers (Ice, Hidden Bar, Bartender) hide icons by stretching one empty
            // item thousands of points to the left; only its right end is a place to keep clear.
            let spacer = icon.x < screen.x - EDGE_TOLERANCE || icon.width > screen.width / 2.0;
            (if spacer { right } else { icon.x } - MENU_ICON_GAP, right + MENU_ICON_GAP)
        })
        .collect();
    taken.sort_by(|a, b| a.0.total_cmp(&b.0));
    let ideal = screen.x + (screen.width - width) / 2.0;
    let floor = screen.x + APP_MENU_ROOM.min((screen.width - width) / 2.0).max(0.0);
    let mut best: Option<f64> = None;
    let mut from = floor;
    for &(start, stop) in taken.iter().chain([&(end, end)]) {
        let to = start.min(end);
        if to - from >= width {
            let x = ideal.clamp(from, to - width);
            if best.is_none_or(|best| (x - ideal).abs() < (best - ideal).abs()) {
                best = Some(x);
            }
        }
        from = from.max(stop);
    }
    let fits = |x: f64| {
        x >= floor - EDGE_TOLERANCE
            && x + width <= end + EDGE_TOLERANCE
            && taken.iter().all(|&(start, stop)| x + width <= start || x >= stop)
    };
    match (best, current) {
        (Some(best), Some(current)) if (best - current).abs() <= MENU_SETTLE && fits(current) => Some(current),
        (best, _) => best,
    }
}

/// Physical position of the band in the menu bar, or of the card grown from it: centered on the
/// band's `center`, at the screen's top edge, kept on the screen.
pub fn menu_bar_layout(screen: Frame, center: f64, width: f64) -> (i32, i32) {
    let x = (center - width / 2.0).min(screen.x + screen.width - width).max(screen.x);
    (x.round() as i32, screen.y.round() as i32)
}

/// All inputs are physical pixels on the target display. Keep the entire expanded shell in the
/// usable area. Side tabs keep their top anchored while growing, unless the bottom would escape.
pub fn dock_layout(work: Frame, width: f64, height: f64, placement: &crate::notch_display::Placement) -> (i32, i32) {
    use crate::notch_display::Placement;
    let x = match placement {
        Placement::Top => work.x + (work.width - width) / 2.0,
        Placement::Left => work.x,
        Placement::Right => work.x + work.width - width,
    };
    let y = match placement {
        Placement::Top => work.y,
        _ => (work.y + work.height * 0.35).min(work.y + work.height - height),
    };
    (x.max(work.x).round() as i32, y.max(work.y).round() as i32)
}

/// An axis-aligned rectangle with a top-left origin and a size, in one consistent unit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// How far a window edge may be from the screen edge and still count as touching it.
const EDGE_TOLERANCE: f64 = 2.0;

/// Whether `window` is a fullscreen window of `screen` (NotchLayout.coversScreen). It must span the
/// screen's width and reach its bottom edge; its top may sit up to `top_inset` below the screen top,
/// because fullscreen windows can start below the camera or menu-bar safe area. Tolerance is 2.
pub fn covers_screen(window: Frame, screen: Frame, top_inset: f64) -> bool {
    let top_gap = window.y - screen.y;
    (window.x - screen.x).abs() <= EDGE_TOLERANCE
        && (window.width - screen.width).abs() <= EDGE_TOLERANCE
        && (window.y + window.height - (screen.y + screen.height)).abs() <= EDGE_TOLERANCE
        && top_gap >= -EDGE_TOLERANCE
        && top_gap <= top_inset.max(0.0) + EDGE_TOLERANCE
}

/// Whether a visible application `window` puts the notch's `screen` into fullscreen, which silences
/// the notch. Geometry alone cannot tell a native fullscreen window from a zoomed one on a screen
/// with a camera housing: both span the screen and start at the menu bar's bottom edge (measured on
/// a 1728 x 1117 screen with a 32-point safe area: both are X 0, Y 33, 1728 x 1084). So a window
/// that starts below the top edge only counts when the system says the active Space is a fullscreen
/// one (`fullscreen_space`, `None` when it cannot be read: keep treating the window as fullscreen).
/// A window flush with the top edge leaves no room for a menu bar, so it is fullscreen regardless.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn is_fullscreen_window(
    window: Frame,
    screen: Frame,
    top_inset: f64,
    fullscreen_space: Option<bool>,
) -> bool {
    if !covers_screen(window, screen, top_inset) {
        return false;
    }
    let flush_with_top = window.y - screen.y <= EDGE_TOLERANCE;
    flush_with_top || fullscreen_space != Some(false)
}

/// How far below the top of its screen a fullscreen window may start: the camera housing's safe
/// area (0 on a screen without one). It must not come from the work area: `NSScreen.visibleFrame`
/// keeps leaving out the menu bar both in native fullscreen and for a merely zoomed window
/// (measured: 33 points either way), so it cannot tell them apart. Neither can this inset: see
/// `is_fullscreen_window`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn fullscreen_top_inset(safe_area_top: f64) -> f64 {
    if safe_area_top.is_finite() && safe_area_top > 0.0 {
        safe_area_top
    } else {
        0.0
    }
}

/// Unit used to compare positions on one machine. macOS reports every position as points times the
/// scale of *some* screen (the pointer: the main screen's; a window: its own screen's; a monitor:
/// its own), so each is divided by its own scale to get points. Windows reports virtual-desktop
/// pixels throughout and needs no conversion.
fn common_unit(value: (f64, f64), scale: f64, per_screen_scale: bool) -> (f64, f64) {
    if per_screen_scale && scale.is_finite() && scale > 0.0 {
        (value.0 / scale, value.1 / scale)
    } else {
        value
    }
}

/// Whether the pointer is over a window. `cursor_scale` is the scale the pointer position was
/// reported with, `window_scale` the one of the window's own screen.
pub fn pointer_in_window(
    cursor: (f64, f64),
    cursor_scale: f64,
    origin: (f64, f64),
    size: (f64, f64),
    window_scale: f64,
    per_screen_scale: bool,
) -> bool {
    let cursor = common_unit(cursor, cursor_scale, per_screen_scale);
    let origin = common_unit(origin, window_scale, per_screen_scale);
    let size = common_unit(size, window_scale, per_screen_scale);
    contains(Frame { x: origin.0, y: origin.1, width: size.0, height: size.1 }, cursor.0, cursor.1)
}

/// Whether the pointer is on a monitor (`position` and `size` as the monitor reports them).
pub fn pointer_on_monitor(
    cursor: (f64, f64),
    cursor_scale: f64,
    position: (f64, f64),
    size: (f64, f64),
    monitor_scale: f64,
    per_screen_scale: bool,
) -> bool {
    pointer_in_window(cursor, cursor_scale, position, size, monitor_scale, per_screen_scale)
}

/// Whether a point lies inside a frame (left/top inclusive, right/bottom exclusive).
pub fn contains(frame: Frame, x: f64, y: f64) -> bool {
    x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(x: f64, y: f64, width: f64, height: f64) -> Frame {
        Frame { x, y, width, height }
    }
    #[test]
    fn fullscreen_windows_cover_their_screen_even_below_the_camera_area() {
        let screen = frame(0.0, 0.0, 1728.0, 1117.0);
        assert!(covers_screen(frame(0.0, 0.0, 1728.0, 1117.0), screen, 0.0));
        assert!(covers_screen(frame(0.0, 32.0, 1728.0, 1085.0), screen, 32.0));
        assert!(covers_screen(frame(1.0, 1.0, 1727.0, 1116.0), screen, 0.0));
        // A top gap beyond the inset, a short window or a narrow window is not fullscreen.
        assert!(!covers_screen(frame(0.0, 40.0, 1728.0, 1077.0), screen, 32.0));
        assert!(!covers_screen(frame(0.0, 0.0, 1728.0, 1000.0), screen, 32.0));
        assert!(!covers_screen(frame(0.0, 0.0, 1200.0, 1117.0), screen, 0.0));
        // Windows reaching above the screen by more than the tolerance do not count either.
        assert!(!covers_screen(frame(0.0, -10.0, 1728.0, 1127.0), screen, 0.0));
    }
    #[test]
    fn fullscreen_uses_the_screens_own_origin() {
        let screen = frame(-1920.0, 0.0, 1920.0, 1080.0);
        assert!(covers_screen(frame(-1920.0, 0.0, 1920.0, 1080.0), screen, 0.0));
        assert!(!covers_screen(frame(0.0, 0.0, 1920.0, 1080.0), screen, 0.0));
    }
    #[test]
    fn a_camera_screen_window_below_the_camera_area_needs_the_safe_area_as_inset() {
        let screen = frame(0.0, 0.0, 1728.0, 1117.0);
        // A fullscreen window on a notched screen starts under the 32-point camera area, so the
        // zero inset of a screen without a camera would reject it.
        let window = frame(0.0, 32.0, 1728.0, 1085.0);
        let no_camera_inset = 0.0;
        assert!(!covers_screen(window, screen, no_camera_inset), "the camera area must be allowed for");
        assert!(covers_screen(window, screen, fullscreen_top_inset(32.0)));
        // A zoomed window under a visible menu bar is not fullscreen on a screen without a camera.
        let zoomed = frame(0.0, 24.0, 1728.0, 1093.0);
        assert!(!covers_screen(zoomed, screen, fullscreen_top_inset(0.0)));
        assert_eq!(fullscreen_top_inset(f64::NAN), 0.0);
        assert_eq!(fullscreen_top_inset(-4.0), 0.0);
    }
    #[test]
    fn a_zoomed_window_under_the_menu_bar_does_not_silence_the_notch_on_a_camera_screen() {
        // Measured on the built-in screen: a zoomed window (double-click on the title bar) and a
        // native fullscreen window have the same bounds, only the active Space's type differs.
        let screen = frame(0.0, 0.0, 1728.0, 1117.0);
        let below_menu_bar = frame(0.0, 33.0, 1728.0, 1084.0);
        let inset = fullscreen_top_inset(32.0);
        assert!(covers_screen(below_menu_bar, screen, inset), "geometry alone cannot tell them apart");
        assert!(!is_fullscreen_window(below_menu_bar, screen, inset, Some(false)));
        assert!(is_fullscreen_window(below_menu_bar, screen, inset, Some(true)));
        // The Space cannot be read: keep the earlier behaviour (quiet) rather than guess.
        assert!(is_fullscreen_window(below_menu_bar, screen, inset, None));
    }
    #[test]
    fn a_window_flush_with_the_top_is_fullscreen_whatever_the_space_says() {
        let screen = frame(0.0, 0.0, 1920.0, 1080.0);
        let flush = frame(0.0, 0.0, 1920.0, 1080.0);
        assert!(is_fullscreen_window(flush, screen, 0.0, Some(false)));
        assert!(is_fullscreen_window(flush, screen, 0.0, Some(true)));
        assert!(is_fullscreen_window(flush, screen, 0.0, None));
    }
    #[test]
    fn a_window_that_does_not_cover_the_screen_is_never_fullscreen() {
        let screen = frame(0.0, 0.0, 1728.0, 1117.0);
        let moved_down = frame(0.0, 60.0, 1728.0, 1057.0);
        let inset = fullscreen_top_inset(32.0);
        for space in [Some(true), Some(false), None] {
            assert!(!is_fullscreen_window(moved_down, screen, inset, space));
        }
    }

    // Main screen: 1512 x 982 points at 2x. An external 1920 x 1080 screen at 1x to its right.
    // The pointer is reported with the main screen's scale, the notch window with its own screen's.
    #[test]
    fn the_pointer_is_compared_with_a_window_in_the_same_unit_on_mixed_density_screens() {
        // The notch sits on the external screen: x = 1512 + (1920 - 273) / 2, 1x, 273 x 24.
        let origin = (2335.0, 0.0);
        let size = (273.0, 24.0);
        // Pointer over the notch at point (2400, 5) is reported as (4800, 10).
        assert!(pointer_in_window((4800.0, 10.0), 2.0, origin, size, 1.0, true));
        // Pointer at point (1170, 5), on the main screen, is reported as (2340, 10) and used to
        // look like it was over the notch.
        assert!(!pointer_in_window((2340.0, 10.0), 2.0, origin, size, 1.0, true));
        // The same notch on the main screen: origin and size are in 2x pixels.
        assert!(pointer_in_window((1000.0, 20.0), 2.0, (800.0, 0.0), (546.0, 74.0), 2.0, true));
        assert!(!pointer_in_window((1000.0, 90.0), 2.0, (800.0, 0.0), (546.0, 74.0), 2.0, true));
    }

    #[test]
    fn monitors_are_looked_up_by_the_pointer_in_the_same_unit() {
        let main = ((0.0, 0.0), (3024.0, 1964.0), 2.0);
        let external = ((1512.0, 0.0), (1920.0, 1080.0), 1.0);
        let on = |cursor: (f64, f64), monitor: ((f64, f64), (f64, f64), f64)| {
            pointer_on_monitor(cursor, 2.0, monitor.0, monitor.1, monitor.2, true)
        };
        // Point (2000, 500) is on the external screen; it is reported as (4000, 1000).
        assert!(on((4000.0, 1000.0), external));
        assert!(!on((4000.0, 1000.0), main));
        // Point (700, 300) is on the main screen.
        assert!(on((1400.0, 600.0), main));
        assert!(!on((1400.0, 600.0), external));
        // A screen left of the main one has negative coordinates.
        let left = ((-1920.0, 0.0), (1920.0, 1080.0), 1.0);
        assert!(pointer_on_monitor((-1000.0, 1000.0), 2.0, left.0, left.1, left.2, true));
    }

    #[test]
    fn windows_positions_are_already_in_one_unit_and_are_not_scaled() {
        // Per-monitor DPI aware: everything is virtual-desktop pixels. A 150% screen at x = 1920.
        assert!(pointer_in_window((2100.0, 10.0), 1.5, (2000.0, 0.0), (410.0, 36.0), 1.5, false));
        assert!(!pointer_in_window((2500.0, 10.0), 1.5, (2000.0, 0.0), (410.0, 36.0), 1.5, false));
        assert!(pointer_on_monitor((2100.0, 10.0), 1.0, (1920.0, 0.0), (2560.0, 1440.0), 1.5, false));
    }

    #[test]
    fn pointer_containment_is_half_open() {
        let area = frame(10.0, 20.0, 100.0, 30.0);
        assert!(contains(area, 10.0, 20.0));
        assert!(contains(area, 109.9, 49.9));
        assert!(!contains(area, 110.0, 30.0));
        assert!(!contains(area, 50.0, 50.0));
        assert!(!contains(area, 9.9, 30.0));
    }
    #[test]
    fn menu_and_camera_are_reserved_even_with_an_auto_hidden_menu() {
        let screen = frame(0.0, 0.0, 3456.0, 2234.0);
        assert_eq!(safe_work_area(0.0, screen, 32.0, 2.0).y, 64.0);
        let work = frame(0.0, 66.0, 3456.0, 2168.0);
        assert_eq!(safe_work_area(0.0, work, 32.0, 2.0), work);
        assert_eq!(safe_work_area(-1080.0, frame(-1920.0, -1080.0, 1920.0, 1080.0), 24.0, 1.0).y, -1056.0);
        // A Windows taskbar stays reserved without inventing a macOS menu inset.
        let work = frame(60.0, 0.0, 1860.0, 1040.0);
        assert_eq!(safe_work_area(0.0, work, 0.0, 1.0), work);
    }
    #[test]
    fn the_compact_camera_band_stays_at_the_screen_top() {
        use crate::notch_display::Placement::Top;
        let work = frame(0.0, 66.0, 3456.0, 2168.0);
        let screen = frame(0.0, 0.0, 3456.0, 2234.0);
        let area = camera_work_area(screen, work, 32.0);
        assert_eq!(area.y, 0.0);
        assert_eq!(area.y + area.height, work.y + work.height);
        assert_eq!(dock_layout(area, compact_width(185.0, &Top) * 2.0, 64.0, &Top), (1499, 0));
        // Global coordinates above the main display, even with an auto-hidden menu bar.
        let above = frame(-1920.0, -1080.0, 1920.0, 1080.0);
        assert_eq!(camera_work_area(above, above, 32.0).y, -1080.0);
        // Side Dock must not move the band away from the camera's center.
        let side_dock = frame(160.0, 66.0, 3296.0, 2168.0);
        assert_eq!(camera_work_area(screen, side_dock, 32.0), area);
        // Screens with no physical housing continue to reserve the menu/taskbar.
        assert_eq!(camera_work_area(screen, work, 0.0), work);
        assert_eq!(camera_work_area(screen, work, f64::NAN), work);
    }
    #[test]
    fn compact_wings_use_half_the_space_and_never_exceed_the_original_width() {
        use crate::notch_display::Placement::*;
        assert_eq!(compact_width(185.0, &Top), 229.0);
        assert_eq!(compact_width(210.0, &Top), 254.0);
        assert_eq!(compact_width(250.0, &Top), 273.0);
        assert_eq!(compact_width(300.0, &Top), 273.0);
        assert_eq!(housing_width(185.0, &Top), 185.0);
        assert_eq!((compact_width(185.0, &Top) - housing_width(185.0, &Top)) / 2.0, 22.0);
        assert_eq!(housing_width(210.0, &Top), 210.0);
        assert_eq!(housing_width(300.0, &Top), 273.0);
        assert_eq!(housing_width(0.0, &Top), 185.0);
        assert_eq!(housing_width(f64::NAN, &Top), 185.0);
        for side in [Left, Right] {
            assert_eq!(compact_width(185.0, &side), 88.0);
            assert_eq!(housing_width(185.0, &side), 0.0);
        }
    }
    #[test]
    fn the_band_matches_camera_height_without_dropping_below_it() {
        use crate::notch_display::Placement::*;
        assert_eq!(band_height(32.0, 33.0, &Top), 32.0);
        assert_eq!(band_height(28.0, 0.0, &Top), 28.0);
        assert_eq!(band_height(40.0, 0.0, &Top), 40.0);
        assert_eq!(band_height(0.0, 0.0, &Top), 32.0);
        assert_eq!(band_height(f64::NAN, f64::NAN, &Top), 32.0);
        assert_eq!(band_height(40.0, 0.0, &Left), 32.0);
    }
    #[test]
    fn without_a_camera_the_band_is_as_tall_as_a_visible_menu_bar() {
        use crate::notch_display::Placement::*;
        assert_eq!(band_height(0.0, 30.0, &Top), 30.0);
        assert_eq!(band_height(0.0, 24.0, &Top), 24.0);
        // Auto-hidden, or no menu bar on this screen.
        assert_eq!(band_height(0.0, 0.0, &Top), 32.0);
        assert_eq!(band_height(0.0, 30.0, &Right), 32.0);
    }

    // Measured 2026-10-20 on a BenQ RD280U, 1920 x 1280 points with a 30-point menu bar and
    // icons from x = 979 to the right edge. The centered band (845 to 1074) covered three of them.
    fn crowded_menu_bar() -> Vec<Frame> {
        [979.0, 1013.0, 1051.0, 1089.0, 1121.0, 1159.0, 1191.0, 1313.0, 1347.0, 1382.0, 1414.0, 1468.0,
            1512.0, 1550.0, 1588.0, 1630.0, 1668.0, 1700.0, 1742.0]
            .windows(2)
            .map(|pair| frame(pair[0], 0.0, pair[1] - pair[0], 30.0))
            .chain([frame(1742.0, 0.0, 178.0, 30.0)])
            .collect()
    }
    /// Icons 40 points wide side by side from `left` to `right`, as macOS lays them out.
    fn icons_from(left: f64, right: f64) -> Vec<Frame> {
        let mut icons = Vec::new();
        let mut x = left;
        while x < right {
            icons.push(frame(x, 0.0, 40.0_f64.min(right - x), 30.0));
            x += 40.0;
        }
        icons
    }
    /// Without a camera the band keeps the notch shape and width of the built-in screen.
    const BAND: f64 = 229.0;
    #[test]
    fn a_crowded_menu_bar_moves_the_band_next_to_its_icons() {
        let screen = frame(0.0, 0.0, 1920.0, 1280.0);
        assert_eq!(compact_width(0.0, &crate::notch_display::Placement::Top), BAND);
        let left = menu_bar_slot(screen, 30.0, &crowded_menu_bar(), BAND, None).unwrap();
        assert_eq!(left, 979.0 - MENU_ICON_GAP - BAND);
        // In 2x pixels, collapsed and as the 560-point card grown from it.
        let pixels = frame(0.0, 0.0, 3840.0, 2560.0);
        let center = (left + BAND / 2.0) * 2.0;
        assert_eq!(menu_bar_layout(pixels, center, BAND * 2.0), (1484, 0));
        assert_eq!(menu_bar_layout(pixels, center, 1120.0), (1153, 0));
    }
    #[test]
    fn a_free_center_keeps_the_band_centered() {
        let screen = frame(0.0, 0.0, 1920.0, 1280.0);
        let icons = [frame(1400.0, 0.0, 520.0, 30.0)];
        assert_eq!(menu_bar_slot(screen, 30.0, &icons, BAND, None), Some(845.5));
        assert_eq!(menu_bar_slot(screen, 30.0, &[], BAND, None), Some(845.5));
        // On a narrow screen too: the center is allowed even inside the app menus' room.
        let narrow = frame(0.0, 0.0, 1440.0, 900.0);
        let few = [frame(1140.0, 0.0, 300.0, 24.0)];
        assert_eq!(menu_bar_slot(narrow, 24.0, &few, BAND, None), Some(605.5));
    }
    #[test]
    fn the_band_takes_the_free_gap_nearest_the_center() {
        let screen = frame(0.0, 0.0, 1920.0, 1280.0);
        // Gaps 640 to 992 and 1108 to 1392 both fit; the first is nearer the center.
        let icons = [frame(1000.0, 0.0, 100.0, 30.0), frame(1400.0, 0.0, 520.0, 30.0)];
        assert_eq!(menu_bar_slot(screen, 30.0, &icons, BAND, None), Some(763.0));
    }
    #[test]
    fn icons_never_push_the_band_into_the_app_menus_room() {
        let screen = frame(0.0, 0.0, 1920.0, 1280.0);
        assert_eq!(menu_bar_slot(screen, 30.0, &icons_from(900.0, 1920.0), BAND, None), Some(663.0));
        assert_eq!(menu_bar_slot(screen, 30.0, &icons_from(860.0, 1920.0), BAND, None), None);
        let narrow = frame(0.0, 0.0, 1440.0, 900.0);
        assert_eq!(menu_bar_slot(narrow, 30.0, &icons_from(499.0, 1440.0), BAND, None), None);
    }
    #[test]
    fn without_a_visible_menu_bar_there_is_no_slot() {
        let screen = frame(0.0, 0.0, 1920.0, 1280.0);
        assert_eq!(menu_bar_slot(screen, 0.0, &[], BAND, None), None);
        assert_eq!(menu_bar_slot(screen, f64::NAN, &[], BAND, None), None);
        assert_eq!(menu_bar_slot(screen, 30.0, &[], f64::NAN, None), None);
    }
    #[test]
    fn only_icons_in_this_screens_menu_bar_count() {
        let screen = frame(-1920.0, -1280.0, 1920.0, 1280.0);
        let others = [
            // Another screen's icon, a status-level window lower down, and a tall one.
            frame(-1000.0, 0.0, 400.0, 30.0),
            frame(-1100.0, -900.0, 400.0, 30.0),
            frame(-1100.0, -1280.0, 400.0, 600.0),
        ];
        assert_eq!(menu_bar_slot(screen, 30.0, &others, BAND, None), Some(-1074.5));
        let own = [frame(-1000.0, -1280.0, 400.0, 30.0)];
        assert_eq!(menu_bar_slot(screen, 30.0, &own, BAND, None), Some(-1008.0 - BAND));
    }
    #[test]
    fn an_icon_changing_width_does_not_make_the_band_hop() {
        let screen = frame(0.0, 0.0, 1920.0, 1280.0);
        let with_tray = |left: f64| {
            let mut icons = crowded_menu_bar();
            icons[0] = frame(left, 0.0, 1013.0 - left, 30.0);
            icons
        };
        let placed = Some(742.0);
        // TodoCue's own count disappears: its icon narrows by 18 points. The band stays.
        assert_eq!(menu_bar_slot(screen, 30.0, &with_tray(997.0), BAND, placed), placed);
        // It comes back: the band still fits.
        assert_eq!(menu_bar_slot(screen, 30.0, &with_tray(979.0), BAND, placed), placed);
        // An icon grown into the gap moves the band.
        assert_eq!(menu_bar_slot(screen, 30.0, &with_tray(961.0), BAND, placed), Some(724.0));
        // A new icon appears beside it: the band moves out of its way.
        let mut more = crowded_menu_bar();
        more.push(frame(899.0, 0.0, 80.0, 30.0));
        assert_eq!(menu_bar_slot(screen, 30.0, &more, BAND, placed), Some(662.0));
        // Icons went away and the center is free: further than the settle distance, so it moves.
        assert_eq!(menu_bar_slot(screen, 30.0, &[frame(1400.0, 0.0, 520.0, 30.0)], BAND, Some(700.0)), Some(845.5));
        // No room left: the band goes below the menu bar wherever it was.
        assert_eq!(menu_bar_slot(screen, 30.0, &icons_from(600.0, 1920.0), BAND, placed), None);
    }
    #[test]
    fn a_menu_bar_manager_spacer_only_keeps_its_right_end_clear() {
        let screen = frame(0.0, 0.0, 1920.0, 1280.0);
        let icons = [frame(1400.0, 0.0, 520.0, 30.0)];
        // Ice and others stretch one empty item thousands of points to the left.
        let spacer = |right: f64| frame(right - 10_000.0, 0.0, 10_000.0, 30.0);
        let left_of_center = [spacer(700.0), icons[0]];
        assert_eq!(menu_bar_slot(screen, 30.0, &left_of_center, BAND, None), Some(845.5));
        let at_center = [spacer(950.0), icons[0]];
        assert_eq!(menu_bar_slot(screen, 30.0, &at_center, BAND, None), Some(958.0));
        // One wider than half the screen counts the same way even when it starts on it.
        let wide = [frame(100.0, 0.0, 1200.0, 30.0), icons[0]];
        assert_eq!(menu_bar_slot(screen, 30.0, &wide, BAND, None), Some(845.5));
    }
    #[test]
    fn the_card_stays_on_the_screen_near_its_edges() {
        let screen = frame(-3840.0, 0.0, 3840.0, 2560.0);
        assert_eq!(menu_bar_layout(screen, -100.0, 1120.0), (-1120, 0));
        assert_eq!(menu_bar_layout(screen, -3800.0, 1120.0), (-3840, 0));
    }
    #[test]
    fn placement_keeps_the_menu_bar_and_taskbar_free() {
        use crate::notch_display::Placement::*;
        let work = frame(-1920.0, 28.0, 1920.0, 1012.0);
        assert_eq!(dock_layout(work, 128.0, 32.0, &Top), (-1024, 28));
        assert_eq!(dock_layout(work, 88.0, 32.0, &Left), (-1920, 382));
        assert_eq!(dock_layout(work, 560.0, 560.0, &Right), (-560, 382));
        let small = frame(60.0, -1000.0, 900.0, 600.0);
        assert_eq!(dock_layout(small, 560.0, 560.0, &Right), (400, -960));
        // 2x Retina coordinates, including negative origins.
        assert_eq!(dock_layout(frame(-3840.0, 64.0, 3840.0, 2000.0), 256.0, 64.0, &Top), (-2048, 64));
    }
}
