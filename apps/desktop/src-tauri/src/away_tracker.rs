//! Turns "seconds since the last keyboard/mouse input" into "the user was away for N minutes".
//!
//! Pure logic: the caller feeds one observation per poll (wall-clock seconds, system idle seconds)
//! and gets `Some(minutes)` exactly once when the user comes back. Wall-clock time (not a
//! monotonic clock, which stops while a Mac sleeps) is what reveals a sleep between two polls.

/// Idle this long and the user counts as away from the computer.
pub const AWAY_THRESHOLD_SECS: u64 = 300;
/// How often the host polls the idle time.
pub const POLL_INTERVAL_SECS: u64 = 15;
/// The runtime accepts 3..=1440 minutes.
const MAX_AWAY_MINUTES: u64 = 1440;

#[derive(Debug, Default)]
pub struct AwayTracker {
    last_wall: Option<u64>,
    /// The longest absence seen so far in the current stretch; 0 while the user is present.
    peak_secs: u64,
}

impl AwayTracker {
    pub fn observe(&mut self, wall_secs: u64, idle_secs: u64) -> Option<u32> {
        let gap = self.last_wall.map_or(0, |last| wall_secs.saturating_sub(last));
        self.last_wall = Some(wall_secs);
        // Two polls further apart than that means the machine slept in between.
        if gap >= AWAY_THRESHOLD_SECS + POLL_INTERVAL_SECS {
            self.peak_secs = self.peak_secs.max(gap);
        }
        if idle_secs >= AWAY_THRESHOLD_SECS {
            self.peak_secs = self.peak_secs.max(idle_secs);
            return None;
        }
        let away = std::mem::take(&mut self.peak_secs);
        (away >= AWAY_THRESHOLD_SECS).then(|| (away / 60).min(MAX_AWAY_MINUTES) as u32)
    }
    /// Forget the current stretch (the feature was switched off and on again).
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds `(seconds since the previous poll, idle seconds)` pairs and collects what is reported.
    fn run(steps: &[(u64, u64)]) -> Vec<Option<u32>> {
        let mut tracker = AwayTracker::default();
        let mut wall = 1_000_000;
        steps
            .iter()
            .map(|&(advance, idle)| {
                wall += advance;
                tracker.observe(wall, idle)
            })
            .collect()
    }

    #[test]
    fn a_present_user_is_never_reported() {
        assert_eq!(run(&[(15, 0), (15, 3), (15, 120), (15, 299), (15, 4)]), vec![None; 5]);
    }

    #[test]
    fn coming_back_after_the_threshold_reports_the_longest_idle_once() {
        let steps = [(15, 290), (15, 305), (15, 320), (15, 900), (15, 2), (15, 17), (15, 32)];
        assert_eq!(run(&steps), vec![None, None, None, None, Some(15), None, None]);
    }

    #[test]
    fn the_threshold_is_inclusive_at_300_and_exclusive_at_299() {
        assert_eq!(run(&[(15, 299), (15, 0)]), vec![None, None]);
        assert_eq!(run(&[(15, 300), (15, 0)]), vec![None, Some(5)]);
    }

    #[test]
    fn minutes_round_down_and_are_capped_at_a_day() {
        assert_eq!(run(&[(15, 419), (15, 0)]), vec![None, Some(6)]);
        assert_eq!(run(&[(15, 200_000), (15, 0)]), vec![None, Some(1440)]);
    }

    #[test]
    fn a_sleep_between_polls_counts_as_the_gap_when_the_user_is_back() {
        // Slept 20 minutes; the first poll after waking already sees fresh input.
        assert_eq!(run(&[(15, 1), (1200, 1), (15, 2)]), vec![None, Some(20), None]);
    }

    #[test]
    fn a_sleep_while_idle_keeps_counting_until_input_returns() {
        // Idle reads high after waking (no input yet), then drops once the user touches the machine.
        assert_eq!(run(&[(15, 250), (3600, 3850), (15, 3865), (15, 1)]), vec![None, None, None, Some(64)]);
    }

    #[test]
    fn the_sleep_gap_wins_when_it_is_longer_than_the_idle_before_it() {
        assert_eq!(run(&[(15, 400), (3600, 0)]), vec![None, Some(60)]);
    }

    #[test]
    fn a_gap_just_under_the_sleep_limit_is_ordinary_jitter() {
        // 314 s between polls with a present user: not a sleep.
        assert_eq!(run(&[(15, 0), (314, 5)]), vec![None, None]);
        assert_eq!(run(&[(15, 0), (315, 5)]), vec![None, Some(5)]);
    }

    #[test]
    fn leaving_again_right_after_returning_starts_a_new_stretch() {
        let steps = [(15, 600), (15, 1), (15, 16), (15, 310), (15, 325), (15, 0)];
        assert_eq!(run(&steps), vec![None, Some(10), None, None, None, Some(5)]);
    }

    #[test]
    fn a_clock_that_jumps_backwards_is_not_a_sleep() {
        let mut tracker = AwayTracker::default();
        assert_eq!(tracker.observe(10_000, 0), None);
        assert_eq!(tracker.observe(5_000, 0), None);
    }

    #[test]
    fn reset_forgets_an_unfinished_absence() {
        let mut tracker = AwayTracker::default();
        tracker.observe(1_000, 400);
        tracker.reset();
        assert_eq!(tracker.observe(1_015, 0), None);
    }
}
