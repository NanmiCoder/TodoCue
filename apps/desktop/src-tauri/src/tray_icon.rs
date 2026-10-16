//! The Cue mark drawn for the tray: the ring with its gap and the dot, as in the original
//! status item (`StatusItemController.cueImage`, an 18-point canvas). Rendered here so no image
//! decoder or asset file is needed. macOS uses black as a template image; Windows and others use the
//! signal orange, which reads on both light and dark taskbars.

const CANVAS: f64 = 18.0;
const RING_CENTER: (f64, f64) = (8.0, 9.0);
const RING_RADIUS: f64 = 6.0;
const RING_WIDTH: f64 = 1.7;
const GAP_HALF_ANGLE_DEGREES: f64 = 38.0;
const DOT_CENTER: (f64, f64) = (14.7, 9.0);
const DOT_RADIUS: f64 = 1.7;

pub const ORANGE: [u8; 3] = [0xF2, 0x6A, 0x2E];
pub const TEMPLATE_BLACK: [u8; 3] = [0, 0, 0];

fn coverage(x: f64, y: f64) -> f64 {
    let (dx, dy) = (x - RING_CENTER.0, y - RING_CENTER.1);
    let distance = (dx * dx + dy * dy).sqrt();
    // Image y grows downward; the original arc is measured with y up.
    let angle = (-dy).atan2(dx).to_degrees().abs();
    let ring = if angle >= GAP_HALF_ANGLE_DEGREES {
        (distance - RING_RADIUS).abs() - RING_WIDTH / 2.0
    } else {
        // Inside the gap the nearest ring material is a round cap at either end.
        let end = GAP_HALF_ANGLE_DEGREES.to_radians();
        let cap = |sign: f64| {
            let (ex, ey) = (RING_CENTER.0 + RING_RADIUS * end.cos(), RING_CENTER.1 + sign * RING_RADIUS * end.sin());
            ((x - ex).powi(2) + (y - ey).powi(2)).sqrt() - RING_WIDTH / 2.0
        };
        cap(1.0).min(cap(-1.0))
    };
    let dot = ((x - DOT_CENTER.0).powi(2) + (y - DOT_CENTER.1).powi(2)).sqrt() - DOT_RADIUS;
    ring.min(dot)
}

/// Straight (non-premultiplied) RGBA, `size` × `size`, antialiased by signed distance.
pub fn mark_rgba(size: u32, color: [u8; 3]) -> Vec<u8> {
    let scale = size as f64 / CANVAS;
    let mut pixels = Vec::with_capacity((size * size * 4) as usize);
    for row in 0..size {
        for column in 0..size {
            let x = (column as f64 + 0.5) / scale;
            let y = (row as f64 + 0.5) / scale;
            let alpha = (0.5 - coverage(x, y) * scale).clamp(0.0, 1.0);
            pixels.extend_from_slice(&[color[0], color[1], color[2], (alpha * 255.0).round() as u8]);
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alpha(pixels: &[u8], size: u32, x: f64, y: f64) -> u8 {
        let scale = size as f64 / CANVAS;
        let (column, row) = ((x * scale) as u32, (y * scale) as u32);
        pixels[((row * size + column) * 4 + 3) as usize]
    }

    #[test]
    fn draws_the_ring_the_dot_and_leaves_the_gap_and_corners_clear() {
        let size = 36;
        let pixels = mark_rgba(size, TEMPLATE_BLACK);
        assert_eq!(pixels.len(), (size * size * 4) as usize);
        // Left of the ring, and the dot in the gap.
        assert!(alpha(&pixels, size, 2.0, 9.0) > 200);
        assert!(alpha(&pixels, size, 14.7, 9.0) > 200);
        // The ring is open to the right of its centre, apart from the dot.
        assert_eq!(alpha(&pixels, size, 13.64, 6.95), 0);
        // Ring centre and canvas corners are clear.
        assert_eq!(alpha(&pixels, size, 8.0, 9.0), 0);
        assert_eq!(alpha(&pixels, size, 0.2, 0.2), 0);
        assert_eq!(alpha(&pixels, size, 17.8, 17.8), 0);
    }

    #[test]
    fn colour_is_constant_so_it_works_as_a_template() {
        let pixels = mark_rgba(22, ORANGE);
        assert!(pixels.chunks(4).all(|p| p[..3] == ORANGE));
        let template = mark_rgba(22, TEMPLATE_BLACK);
        assert!(template.chunks(4).all(|p| p[..3] == [0, 0, 0]));
    }

    #[test]
    fn it_is_symmetric_top_to_bottom() {
        let size = 36;
        let pixels = mark_rgba(size, ORANGE);
        for row in 0..size / 2 {
            for column in 0..size {
                let a = pixels[((row * size + column) * 4 + 3) as usize] as i16;
                let b = pixels[(((size - 1 - row) * size + column) * 4 + 3) as usize] as i16;
                assert!((a - b).abs() <= 1, "row {row} column {column}");
            }
        }
    }
}
