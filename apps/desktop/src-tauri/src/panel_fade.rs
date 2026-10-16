//! The panel's show / hide fade as a small state machine, separated from the window so the order of
//! events can be tested. Window changes are made on the main thread, but the fade runs on another
//! one: a step that was queued for the main thread can still be waiting there when the panel is
//! shown again. Every queued step therefore carries the generation it was made for and checks it
//! again where it runs; a step that was overtaken does nothing.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

#[derive(Clone, Default)]
pub struct PanelFade {
    generation: Arc<AtomicU64>,
    hiding: Arc<AtomicBool>,
}

impl PanelFade {
    /// The panel is being shown. Returns its generation and whether a fade-out was still running
    /// (which this cancels).
    pub fn present(&self) -> (u64, bool) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        (generation, self.hiding.swap(false, Ordering::SeqCst))
    }

    /// The panel is being hidden. `None` when a fade-out is already running. `animated` marks the
    /// panel as leaving until the fade ends or the panel is shown again.
    pub fn start_hide(&self, animated: bool) -> Option<u64> {
        if self.hiding.load(Ordering::SeqCst) {
            return None;
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if animated {
            self.hiding.store(true, Ordering::SeqCst);
        }
        Some(generation)
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    pub fn is_hiding(&self) -> bool {
        self.hiding.load(Ordering::SeqCst)
    }

    /// `action` for the main thread. It runs only if nothing has started a newer show or hide by
    /// the time it gets there.
    pub fn guarded<F: FnOnce() + Send + 'static>(
        &self,
        generation: u64,
        action: F,
    ) -> impl FnOnce() + Send + 'static {
        let fade = self.clone();
        move || {
            if fade.is_current(generation) {
                action();
            }
        }
    }

    /// The last step of a fade-out: `action` hides the window, and the panel stops "leaving".
    pub fn guarded_finish_hide<F: FnOnce() + Send + 'static>(
        &self,
        generation: u64,
        action: F,
    ) -> impl FnOnce() + Send + 'static {
        let fade = self.clone();
        move || {
            if fade.is_current(generation) {
                action();
                fade.hiding.store(false, Ordering::SeqCst);
            }
        }
    }
}

/// Whether the panel counts as up for the shortcut, the tray and the notch: on screen, in the Space
/// the person is looking at, and not on its way out.
pub fn showing(visible: bool, on_active_space: bool, hiding: bool) -> bool {
    visible && on_active_space && !hiding
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A panel window and the main thread's queue of pending closures.
    #[derive(Clone, Default)]
    struct Stage {
        window: Arc<Mutex<(bool, f64)>>,
        queue: Arc<Mutex<Vec<Box<dyn FnOnce() + Send>>>>,
    }
    impl Stage {
        fn shown() -> Self {
            let stage = Stage::default();
            *stage.window.lock().unwrap() = (true, 1.0);
            stage
        }
        fn enqueue(&self, step: impl FnOnce() + Send + 'static) {
            self.queue.lock().unwrap().push(Box::new(step));
        }
        fn alpha_step(&self, alpha: f64) -> impl FnOnce() + Send + 'static {
            let window = self.window.clone();
            move || window.lock().unwrap().1 = alpha
        }
        fn hide_step(&self) -> impl FnOnce() + Send + 'static {
            let window = self.window.clone();
            move || *window.lock().unwrap() = (false, 1.0)
        }
        /// The main thread gets to its queue.
        fn drain(&self) {
            let steps: Vec<_> = std::mem::take(&mut *self.queue.lock().unwrap());
            for step in steps {
                step();
            }
        }
        fn visible(&self) -> bool {
            self.window.lock().unwrap().0
        }
        fn alpha(&self) -> f64 {
            self.window.lock().unwrap().1
        }
    }

    #[test]
    fn a_fade_step_queued_before_a_show_cannot_leave_the_panel_translucent() {
        let fade = PanelFade::default();
        let stage = Stage::shown();
        let generation = fade.start_hide(true).unwrap();
        // The fade task got past its own check and queued a step for the main thread...
        stage.enqueue(fade.guarded(generation, stage.alpha_step(0.4)));
        // ...and the person pressed the shortcut before the main thread reached it.
        let (_, fading_out) = fade.present();
        assert!(fading_out);
        stage.alpha_step(1.0)();
        stage.drain();
        assert_eq!(stage.alpha(), 1.0);
        assert!(!fade.is_hiding());
    }

    #[test]
    fn the_final_hide_queued_before_a_show_does_not_hide_the_shown_panel() {
        let fade = PanelFade::default();
        let stage = Stage::shown();
        let generation = fade.start_hide(true).unwrap();
        stage.enqueue(fade.guarded_finish_hide(generation, stage.hide_step()));
        fade.present();
        stage.drain();
        assert!(stage.visible());
        assert!(!fade.is_hiding());
    }

    #[test]
    fn an_undisturbed_fade_out_hides_and_stops_leaving() {
        let fade = PanelFade::default();
        let stage = Stage::shown();
        let generation = fade.start_hide(true).unwrap();
        assert!(fade.is_hiding());
        stage.enqueue(fade.guarded(generation, stage.alpha_step(0.5)));
        stage.drain();
        assert_eq!(stage.alpha(), 0.5);
        stage.enqueue(fade.guarded_finish_hide(generation, stage.hide_step()));
        stage.drain();
        assert!(!stage.visible());
        assert!(!fade.is_hiding());
        assert_eq!(stage.alpha(), 1.0);
    }

    #[test]
    fn a_hide_cancels_the_fade_in_and_a_second_hide_is_ignored() {
        let fade = PanelFade::default();
        let stage = Stage::default();
        let (shown, fading_out) = fade.present();
        assert!(!fading_out);
        stage.enqueue(fade.guarded(shown, stage.alpha_step(0.3)));
        let hiding = fade.start_hide(true).unwrap();
        assert!(fade.start_hide(true).is_none());
        stage.drain();
        assert_eq!(stage.alpha(), 0.0, "the stale fade-in step is dropped");
        assert!(fade.is_current(hiding));
        assert!(!fade.is_current(shown));
    }

    #[test]
    fn an_instant_hide_does_not_mark_the_panel_as_leaving() {
        let fade = PanelFade::default();
        let generation = fade.start_hide(false).unwrap();
        assert!(!fade.is_hiding());
        assert!(fade.is_current(generation));
        let (_, fading_out) = fade.present();
        assert!(!fading_out);
        assert!(!fade.is_current(generation));
    }

    #[test]
    fn the_panel_only_counts_as_up_in_the_space_being_looked_at() {
        assert!(showing(true, true, false));
        // Ordered in on another Space: the shortcut must bring it here, not close it.
        assert!(!showing(true, false, false));
        assert!(!showing(true, true, true));
        assert!(!showing(false, true, false));
    }
}
