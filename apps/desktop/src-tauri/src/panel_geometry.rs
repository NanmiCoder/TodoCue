/// Keep the fixed edge where possible, moving it only to satisfy the working-area minimum.
pub fn resize(
    west: bool,
    frame: (f64, f64, f64, f64),
    area: (f64, f64, f64, f64),
    scale: f64,
    desired: f64,
) -> (f64, f64, f64, f64) {
    let inset_x = (12.0 * scale).min(((area.2 - scale) / 2.0).max(0.0));
    let inset_y = (12.0 * scale).min(((area.3 - scale) / 2.0).max(0.0));
    let left = area.0 + inset_x;
    let right = area.0 + area.2 - inset_x;
    let top = area.1 + inset_y;
    let bottom = area.1 + area.3 - inset_y;
    let minimum_width = (300.0 * scale).min(right - left);
    let minimum_height = (360.0 * scale).min(bottom - top);
    if west {
        let fixed_right = (frame.0 + frame.2).clamp(left + minimum_width, right);
        let maximum_width = (600.0 * scale).min(fixed_right - left);
        let width = (desired * scale).clamp(minimum_width, maximum_width);
        let height = frame.3.clamp(minimum_height, bottom - top);
        (
            fixed_right - width,
            frame.1.clamp(top, bottom - height),
            width,
            height,
        )
    } else {
        let fixed_top = frame.1.clamp(top, bottom - minimum_height);
        let height = (desired * scale).clamp(minimum_height, bottom - fixed_top);
        let width = frame
            .2
            .clamp(minimum_width, (600.0 * scale).min(right - left));
        (frame.0.clamp(left, right - width), fixed_top, width, height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn moved_panels_resize_inside_their_actual_remaining_working_area() {
        let frame = (20.0, 200.0, 340.0, 680.0);
        let area = (0.0, 0.0, 1440.0, 900.0);
        assert_eq!(
            resize(true, frame, area, 1.0, 600.0),
            (12.0, 200.0, 348.0, 680.0)
        );
        assert_eq!(
            resize(false, frame, area, 1.0, 980.0),
            (20.0, 200.0, 340.0, 688.0)
        );
        // A Retina display to the left of the primary display has negative physical coordinates.
        let shifted = resize(
            true,
            (-2840.0, 400.0, 680.0, 1360.0),
            (-2880.0, 0.0, 2880.0, 1800.0),
            2.0,
            600.0,
        );
        assert_eq!(shifted, (-2856.0, 400.0, 696.0, 1360.0));
        let small = resize(
            false,
            (100.0, 300.0, 340.0, 680.0),
            (0.0, 0.0, 280.0, 340.0),
            1.0,
            680.0,
        );
        assert_eq!(small, (12.0, 12.0, 256.0, 316.0));
    }
}
