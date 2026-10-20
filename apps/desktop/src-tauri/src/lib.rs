#[cfg(target_os = "macos")]
mod macos_home;
mod export;
mod host_tray;
mod notch_geometry;
mod notch_display;
#[cfg(any(target_os = "macos", test))]
mod panel_geometry;
mod panel_fade;
mod platform;
mod runtime;
mod tray_icon;
mod windows_home;

use runtime::{Request, Runtime, Status};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use host_tray::TrayState;
use panel_fade::PanelFade;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    language: String,
    width: f64,
    height: f64,
    notch_enabled: bool,
    notch_display: Option<notch_display::Selection>,
    notch_placement: notch_display::Placement,
    quiet_fullscreen: bool,
    shortcut: Option<String>,
    autostart: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            language: "zh-CN".into(),
            width: 340.0,
            height: 680.0,
            notch_enabled: true,
            notch_display: None,
            notch_placement: notch_display::Placement::Top,
            quiet_fullscreen: true,
            shortcut: None,
            autostart: false,
        }
    }
}
impl Settings {
    fn validate(&mut self) -> Result<(), String> {
        if !["zh-CN", "en"].contains(&self.language.as_str())
            || !self.width.is_finite()
            || !self.height.is_finite()
        {
            return Err("Invalid desktop settings".into());
        }
        self.width = self.width.clamp(300.0, 600.0);
        self.height = self.height.clamp(360.0, 10000.0);
        Ok(())
    }
}
#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct NotchState {
    width: f64,
    height: f64,
    pinned: bool,
    expanded: bool,
    stack: bool,
    reduced_motion: bool,
    /// The renderer asks for the keyboard: the input field or the notch band was clicked. Clicks on
    /// card buttons never do, so they do not pull the keyboard away from the user's application.
    focus: bool,
    /// Host-side latch: the keyboard was granted and the quick look is still open.
    #[serde(skip)]
    keyboard: bool,
}
/// The keyboard is granted on request and kept until the quick look closes.
fn latch_keyboard(previous: bool, state: &NotchState) -> bool {
    state.expanded && (previous || state.focus)
}
/// One `notch_present` call takes its turn: it reads what the last call left, works out the
/// keyboard latch from it and stores its own state, all under one lock. Two calls that overlap
/// (the renderer measures more than once) can then never both start from the same "previous" and
/// let the later writer take back a grant the other made. Nothing slow runs under the lock.
fn take_turn(shared: &Mutex<NotchState>, mut incoming: NotchState) -> (NotchState, NotchState) {
    let mut stored = shared.lock().unwrap();
    let previous = stored.clone();
    incoming.keyboard = latch_keyboard(previous.keyboard, &incoming);
    *stored = incoming.clone();
    (previous, incoming)
}
/// The notch was taken away (switched off, or quiet because of a fullscreen app): the quick look
/// is gone and with it the keyboard, so coming back starts from a clean slate.
fn release_turn(shared: &Mutex<NotchState>) {
    let mut stored = shared.lock().unwrap();
    stored.keyboard = false;
    stored.expanded = false;
}
#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NotchMetrics {
    band_height: f64,
    compact_width: f64,
    housing_width: f64,
}
#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
enum Target {
    Task(String),
    Periodic(String),
    NewTask,
    /// Open the task's edit form (the notch menu's "Edit…").
    TaskEdit(String),
    /// Ask to delete the task; the panel shows its confirmation first.
    TaskDelete(String),
    NewPeriodic,
    PeriodicList,
    Settings,
    Open,
}
#[derive(Default)]
struct Routing {
    ready: bool,
    pending: Option<Target>,
}
struct Desktop {
    home: PathBuf,
    settings: Mutex<Settings>,
    notch: Mutex<NotchState>,
    routing: Mutex<Routing>,
    notch_animation: AtomicU64,
    panel_resize: AtomicU64,
    /// Generation and "leaving" flag of the panel's fades; see `panel_fade.rs`.
    panel_fade: PanelFade,
    fitted_panel: Mutex<Option<(f64, f64)>>,
    tray: Mutex<Option<TrayState>>,
    menu_slot: Mutex<Option<MenuSlot>>,
    /// Host-loop ticks left in which the band looks for its menu bar place on every tick; set when
    /// TodoCue's own menu bar icon changes width, which moves the icons beside the band.
    menu_refresh: AtomicU64,
}
/// Where the band sits in a display's menu bar (its left edge in points, `None`: below the menu
/// bar). Found while the band is collapsed and kept while it is open, so the card never leaves
/// the band it grew from.
struct MenuSlot {
    display: String,
    left: Option<f64>,
}

fn parse_target(argument: &str) -> Option<Target> {
    let url = url::Url::parse(argument).ok()?;
    if url.scheme() != "todocue"
        || !url.username().is_empty()
        || url.password().is_some()
        || windows_home::query_home(&url).is_err()
        || url.fragment().is_some()
    {
        return None;
    }
    if url.host_str()? == "open" && ["", "/"].contains(&url.path()) {
        return Some(Target::Open);
    }
    let id = url.path().strip_prefix('/')?;
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    match url.host_str()? {
        "task" => Some(Target::Task(id.into())),
        "periodic" => Some(Target::Periodic(id.into())),
        _ => None,
    }
}
fn route_target(app: &tauri::AppHandle, target: Target) {
    let focus_input = matches!(
        target,
        Target::NewTask
            | Target::NewPeriodic
            | Target::Settings
            | Target::TaskEdit(_)
            | Target::TaskDelete(_)
    );
    let desktop = app.state::<Desktop>();
    let mut routing = desktop.routing.lock().unwrap();
    if routing.ready {
        let _ = app.emit_to("panel", "route:reveal", target);
    } else {
        routing.pending = Some(target);
    }
    drop(routing);
    let _ = panel_present(app.clone(), desktop, focus_input);
}
fn notch_outside(app: &tauri::AppHandle) {
    if app
        .try_state::<Desktop>()
        .is_some_and(|desktop| desktop.notch.lock().unwrap().expanded)
    {
        let _ = app.emit_to("notch", "notch:outside", ());
    }
}
#[tauri::command]
fn route_ready(window: WebviewWindow, desktop: State<'_, Desktop>) -> Option<Target> {
    if window.label() != "panel" {
        return None;
    }
    let mut routing = desktop.routing.lock().unwrap();
    routing.ready = true;
    routing.pending.take()
}
#[tauri::command]
fn panel_new_task(app: tauri::AppHandle) {
    route_target(&app, Target::NewTask);
}

#[tauri::command]
async fn runtime_request(
    runtime: State<'_, Arc<Runtime>>,
    input: Request,
) -> Result<Value, String> {
    runtime.request(input).await
}
#[tauri::command]
async fn runtime_subscribe(
    app: tauri::AppHandle,
    runtime: State<'_, Arc<Runtime>>,
) -> Result<Status, String> {
    Ok(runtime.inner().subscribe(app).await)
}
#[tauri::command]
fn settings_load(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Option<Settings> {
    if !desktop.home.join("desktop-preview-settings.json").exists() {
        return None;
    }
    let mut settings = desktop.settings.lock().unwrap().clone();
    settings.autostart = app.autolaunch().is_enabled().unwrap_or(false);
    Some(settings)
}
fn set_autostart(
    app: &tauri::AppHandle,
    home: &std::path::Path,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        windows_home::correct_startup_command(home)?;
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())?;
    }
    let _ = home;
    Ok(())
}
/// The tray menu shows the language and the "open at login" check; a settings change that touches
/// either has to rebuild it, because the renderer only pushes what the board looks like.
fn tray_needs_refresh(language_changed: bool, startup_changed: bool) -> bool {
    language_changed || startup_changed
}
#[tauri::command]
fn settings_save(
    app: tauri::AppHandle,
    desktop: State<'_, Desktop>,
    mut settings: Settings,
) -> Result<(), String> {
    settings.validate()?;
    if let Some(value) = &settings.shortcut {
        value.parse::<Shortcut>().map_err(|e| e.to_string())?;
    }
    let mut current = desktop.settings.lock().unwrap();
    std::fs::create_dir_all(&desktop.home).map_err(|e| e.to_string())?;
    let path = desktop.home.join("desktop-preview-settings.json");
    let temporary = path.with_extension("tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let changed_shortcut = settings.shortcut != current.shortcut;
    let language_changed = settings.language != current.language;
    if changed_shortcut {
        if let Some(value) = &settings.shortcut {
            if let Err(error) = app.global_shortcut().register(value.as_str()) {
                let _ = std::fs::remove_file(&temporary);
                return Err(error.to_string());
            }
        }
    }
    let startup = app.autolaunch().is_enabled().unwrap_or(false);
    let changed_startup = settings.autostart != startup;
    let result = (|| -> Result<(), String> {
        if changed_startup {
            set_autostart(&app, &desktop.home, settings.autostart)?;
        }
        std::fs::rename(&temporary, &path).map_err(|e| e.to_string())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        if changed_shortcut {
            if let Some(value) = &settings.shortcut {
                let _ = app.global_shortcut().unregister(value.as_str());
            }
        }
        if changed_startup {
            let _ = set_autostart(&app, &desktop.home, startup);
        }
        return Err(error);
    }
    if changed_shortcut {
        if let Some(value) = &current.shortcut {
            let _ = app.global_shortcut().unregister(value.as_str());
        }
    }
    *current = settings.clone();
    drop(current);
    if tray_needs_refresh(language_changed, changed_startup) {
        refresh_tray(&app);
    }
    if let Some(panel) = app.get_webview_window("panel") {
        fit_panel(&panel, &settings, false)?;
    }
    if let Some(notch) = app.get_webview_window("notch") {
        let _ = position_notch(&notch);
        if settings.notch_enabled && !(settings.quiet_fullscreen && platform::fullscreen(&notch)) {
            notch.show().map_err(|e| e.to_string())?;
        } else {
            notch.hide().map_err(|e| e.to_string())?;
        }
    }
    app.emit("settings:changed", settings)
        .map_err(|e| e.to_string())
}
/// macOS reports positions in points times the scale of one screen or another; Windows in
/// virtual-desktop pixels. `notch_geometry` brings them to one unit when this is true.
const PER_SCREEN_SCALE: bool = cfg!(target_os = "macos");

/// The scale the pointer position is reported with (the main screen's on macOS).
fn pointer_scale(window: &WebviewWindow) -> f64 {
    window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .or_else(|| window.scale_factor().ok())
        .unwrap_or(1.0)
}

fn pointer_on_monitor(
    pointer: tauri::PhysicalPosition<f64>,
    pointer_scale: f64,
    monitor: &tauri::Monitor,
) -> bool {
    let position = monitor.position();
    let size = monitor.size();
    notch_geometry::pointer_on_monitor(
        (pointer.x, pointer.y),
        pointer_scale,
        (position.x as f64, position.y as f64),
        (size.width as f64, size.height as f64),
        monitor.scale_factor(),
        PER_SCREEN_SCALE,
    )
}

fn fit_panel(window: &WebviewWindow, settings: &Settings, align: bool) -> Result<(), String> {
    let monitor = if align {
        window.cursor_position().ok().and_then(|pointer| {
            let cursor_scale = pointer_scale(window);
            window
                .available_monitors()
                .ok()?
                .into_iter()
                .find(|monitor| pointer_on_monitor(pointer, cursor_scale, monitor))
        })
    } else {
        None
    }
    .or(window.current_monitor().map_err(|e| e.to_string())?);
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let width = settings
            .width
            .min(area.size.width as f64 / scale - 24.0)
            .max(1.0);
        let height = settings
            .height
            .min(area.size.height as f64 / scale - 24.0)
            .max(1.0);
        let minimum_width = 300.0_f64.min((area.size.width as f64 / scale - 24.0).max(1.0));
        let minimum_height = 360.0_f64.min((area.size.height as f64 / scale - 24.0).max(1.0));
        if let Some(desktop) = window.app_handle().try_state::<Desktop>() {
            *desktop.fitted_panel.lock().unwrap() = Some((width, height));
        }
        window
            .set_min_size(Some(tauri::LogicalSize::new(minimum_width, minimum_height)))
            .map_err(|e| e.to_string())?;
        window
            .set_max_size(Some(tauri::LogicalSize::new(
                600.0_f64.min((area.size.width as f64 / scale - 24.0).max(1.0)),
                (area.size.height as f64 / scale - 24.0).max(1.0),
            )))
            .map_err(|e| e.to_string())?;
        let origin = window.outer_position().map_err(|e| e.to_string())?;
        let old = window.outer_size().map_err(|e| e.to_string())?;
        let inset = (12.0 * scale).round() as i32;
        let right =
            area.position.x + area.size.width as i32 - (width * scale).round() as i32 - inset;
        let bottom =
            area.position.y + area.size.height as i32 - (height * scale).round() as i32 - inset;
        let x = if align {
            right
        } else {
            (origin.x + old.width as i32 - (width * scale).round() as i32)
                .clamp(area.position.x + inset, right.max(area.position.x + inset))
        };
        let y = if align {
            area.position.y + inset
        } else {
            origin
                .y
                .clamp(area.position.y + inset, bottom.max(area.position.y + inset))
        };
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        platform::configure(window, true, width, height)?;
    }
    Ok(())
}
#[tauri::command]
fn panel_show(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> Result<(), String> {
    panel_present(app, desktop, false)
}
/// How long the panel takes to fade in and out (SidePanelController: 0.16 s / 0.18 s).
const PANEL_FADE_IN: Duration = Duration::from_millis(160);
const PANEL_FADE_OUT: Duration = Duration::from_millis(180);

/// Window opacity at `progress` (0..1) through a fade: ease-out coming in, ease-in going out.
fn fade_alpha(fading_in: bool, progress: f64) -> f64 {
    let t = progress.clamp(0.0, 1.0);
    if fading_in {
        1.0 - (1.0 - t).powi(3)
    } else {
        1.0 - t * t
    }
}
fn panel_showing(app: &tauri::AppHandle) -> bool {
    let Some(window) = app.get_webview_window("panel") else {
        return false;
    };
    let visible = window.is_visible().unwrap_or(false);
    // Asked only for a window that is on screen: it is the costly half.
    panel_fade::showing(
        visible,
        visible && platform::on_active_space(&window),
        app.state::<Desktop>().panel_fade.is_hiding(),
    )
}
/// The notch needs to know: it does not open its quick look on hover while the panel is up.
fn announce_panel(app: &tauri::AppHandle, visible: bool) {
    let _ = app.emit_to("notch", "panel:visibility", json!({ "visible": visible }));
}
#[tauri::command]
fn panel_visible(app: tauri::AppHandle) -> bool {
    panel_showing(&app)
}
/// Set the panel's opacity, on the main thread, for generation `generation` only.
fn panel_alpha(window: &WebviewWindow, fade: &PanelFade, generation: u64, alpha: f64) {
    // Only macOS fades the window itself; Windows fades the page.
    if !cfg!(target_os = "macos") {
        return;
    }
    let target = window.clone();
    let _ = window.run_on_main_thread(fade.guarded(generation, move || {
        platform::set_alpha_now(&target, alpha)
    }));
}
fn panel_present(
    app: tauri::AppHandle,
    desktop: State<'_, Desktop>,
    focus_input: bool,
) -> Result<(), String> {
    let _ = app.emit_to("notch", "notch:collapse", ());
    let window = app.get_webview_window("panel").ok_or("Panel unavailable")?;
    let fade = desktop.panel_fade.clone();
    // Showing cancels a fade-out that is still running.
    let (generation, fading_out) = fade.present();
    // A panel ordered in on another Space is not up for the person looking at this one.
    let was_visible =
        window.is_visible().unwrap_or(false) && platform::on_active_space(&window);
    let reduced = platform::reduce_motion();
    // A snapshot: fit_panel waits on the main thread, and nothing may hold the lock meanwhile.
    let settings = desktop.settings.lock().unwrap().clone();
    let shown = (|| -> Result<(), String> {
        if !was_visible {
            // Only a hidden panel is placed; an open one keeps wherever the user dragged it.
            fit_panel(&window, &settings, true)?;
            platform::follow_virtual_desktop(&window);
            if !reduced {
                panel_alpha(&window, &fade, generation, 0.0);
            }
        } else {
            // An unfinished fade in or out must not leave the window translucent.
            panel_alpha(&window, &fade, generation, 1.0);
        }
        if focus_input {
            platform::allow_activation(&window)?;
            window.set_focusable(true).map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            window.as_ref().set_focus().map_err(|e| e.to_string())?;
            Ok(())
        } else {
            platform::show_without_activation(&window)
        }
    })();
    if let Err(error) = shown {
        // Never leave a window that is on screen invisible because a step failed.
        panel_alpha(&window, &fade, generation, 1.0);
        return Err(error);
    }
    if !was_visible || fading_out {
        announce_panel(&app, true);
        let _ = app.emit_to("panel", "panel:revealed", json!({ "replay": !was_visible && !reduced }));
    }
    if !was_visible && !reduced && cfg!(target_os = "macos") {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let start = Instant::now();
            loop {
                if !fade.is_current(generation) {
                    return;
                }
                let progress = start.elapsed().as_secs_f64() / PANEL_FADE_IN.as_secs_f64();
                if let Some(window) = handle.get_webview_window("panel") {
                    panel_alpha(&window, &fade, generation, fade_alpha(true, progress));
                }
                if progress >= 1.0 {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(16)).await;
            }
        });
    }
    Ok(())
}
/// Hide the panel the way the original does: a short fade (a window fade on macOS, a page fade on
/// Windows, where the WebView2 window cannot be layered), then ordering out. Showing again during
/// the fade cancels it, even a step that is already waiting for the main thread.
fn panel_hide_animated(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("panel") else {
        return;
    };
    let fade = app.state::<Desktop>().panel_fade.clone();
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let reduced = platform::reduce_motion();
    let Some(generation) = fade.start_hide(!reduced) else {
        return;
    };
    announce_panel(app, false);
    if reduced {
        let _ = window.hide();
        return;
    }
    let _ = app.emit_to("panel", "panel:hiding", ());
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let start = Instant::now();
        loop {
            if !fade.is_current(generation) {
                return;
            }
            let progress = start.elapsed().as_secs_f64() / PANEL_FADE_OUT.as_secs_f64();
            let Some(window) = handle.get_webview_window("panel") else {
                return;
            };
            if progress >= 1.0 {
                let target = window.clone();
                let _ = window.run_on_main_thread(fade.guarded_finish_hide(generation, move || {
                    let _ = target.hide();
                    platform::set_alpha_now(&target, 1.0);
                }));
                return;
            }
            panel_alpha(&window, &fade, generation, fade_alpha(false, progress));
            tokio::time::sleep(Duration::from_millis(16)).await;
        }
    });
}
fn panel_toggle(app: &tauri::AppHandle) {
    if panel_showing(app) {
        panel_hide_animated(app);
    } else {
        let _ = panel_present(app.clone(), app.state::<Desktop>(), false);
    }
}
#[tauri::command]
fn panel_hide(app: tauri::AppHandle) -> Result<(), String> {
    panel_hide_animated(&app);
    Ok(())
}
#[tauri::command]
fn panel_focus(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("panel").ok_or("Panel unavailable")?;
    platform::allow_activation(&window)?;
    window.set_focusable(true).map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    window.as_ref().set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
fn panel_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}
#[tauri::command]
fn panel_resize_macos(
    window: WebviewWindow,
    direction: String,
    width: f64,
    height: f64,
    delta: f64,
) -> Result<(), String> {
    if window.label() != "panel"
        || !["West", "South"].contains(&direction.as_str())
        || !width.is_finite()
        || !height.is_finite()
        || !delta.is_finite()
    {
        return Err("Invalid panel resize request".into());
    }
    #[cfg(target_os = "macos")]
    {
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let monitor = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("No panel monitor")?;
        let area = monitor.work_area();
        let origin = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let frame = panel_geometry::resize(
            direction == "West",
            (
                origin.x as f64,
                origin.y as f64,
                size.width as f64,
                size.height as f64,
            ),
            (
                area.position.x as f64,
                area.position.y as f64,
                area.size.width as f64,
                area.size.height as f64,
            ),
            scale,
            if direction == "West" {
                width - delta
            } else {
                height + delta
            },
        );
        window
            .set_size(tauri::LogicalSize::new(frame.2 / scale, frame.3 / scale))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(
                frame.0.round() as i32,
                frame.1.round() as i32,
            ))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    Err("macOS resize bridge unavailable on this platform".into())
}
/// What "reveal this task" asks the panel to do: show it, open its edit form, or ask to delete it.
fn reveal_target(id: &str, mode: Option<&str>) -> Result<Option<Target>, String> {
    if !export::valid_id(id) {
        return Err("Invalid task id".into());
    }
    match mode {
        None => Ok(None),
        Some("edit") => Ok(Some(Target::TaskEdit(id.into()))),
        Some("delete") => Ok(Some(Target::TaskDelete(id.into()))),
        Some(_) => Err("Invalid reveal mode".into()),
    }
}
#[tauri::command]
fn reveal_task(
    app: tauri::AppHandle,
    desktop: State<'_, Desktop>,
    id: String,
    mode: Option<String>,
) -> Result<(), String> {
    if let Some(target) = reveal_target(&id, mode.as_deref())? {
        // Routed like a link: held until the panel is ready, then opened with the keyboard.
        route_target(&app, target);
        return Ok(());
    }
    panel_show(app.clone(), desktop)?;
    app.emit_to("panel", "task:reveal", id)
        .map_err(|e| e.to_string())
}
/// Open the data folder in the file manager. The folder is the one this app is running on; the
/// renderer cannot name a path.
#[tauri::command]
fn open_data_dir(desktop: State<'_, Desktop>) -> Result<(), String> {
    export::open_directory(&desktop.home)
}
/// Save an attachment where the person chooses. The host fetches it from the runtime itself, so
/// the bytes never travel through the renderer, then shows the system save dialog, writes the file
/// and reveals it. `None` means the dialog was cancelled.
#[tauri::command]
async fn save_file(
    app: tauri::AppHandle,
    runtime: State<'_, Arc<Runtime>>,
    task_id: String,
    attachment_id: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if !export::valid_id(&task_id) || !export::valid_id(&attachment_id) {
        return Err("Invalid attachment".into());
    }
    let response = runtime
        .request(Request {
            method: "GET".into(),
            path: format!("/tasks/{task_id}/attachments/{attachment_id}"),
            body: None,
            idempotency_key: None,
        })
        .await?;
    let (name, bytes) = export::decode_attachment(&response)?;
    let dialog_app = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = dialog_app.dialog().file().set_file_name(name);
        if let Some(window) = dialog_app.get_webview_window("panel") {
            dialog = dialog.set_parent(&window);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    tokio::fs::write(&path, bytes).await.map_err(|e| e.to_string())?;
    export::reveal(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}
#[tauri::command]
fn notch_available(app: tauri::AppHandle, desktop: State<'_, Desktop>) -> bool {
    let settings = desktop.settings.lock().unwrap().clone();
    settings.notch_enabled
        && app
            .get_webview_window("notch")
            .is_some_and(|window| !(settings.quiet_fullscreen && platform::fullscreen(&window)))
}
#[tauri::command]
async fn notch_present(
    app: tauri::AppHandle,
    desktop: State<'_, Desktop>,
    mut state: NotchState,
) -> Result<bool, String> {
    if !state.width.is_finite() || !state.height.is_finite() {
        return Err("Invalid notch size".into());
    }
    state.width = state.width.clamp(88.0, 560.0);
    state.height = state.height.clamp(
        if cfg!(target_os = "macos") {
            18.0
        } else {
            24.0
        },
        560.0,
    );
    let window = app.get_webview_window("notch").ok_or("Notch unavailable")?;
    let settings = desktop.settings.lock().unwrap().clone();
    if !settings.notch_enabled || (settings.quiet_fullscreen && platform::fullscreen(&window)) {
        release_turn(&desktop.notch);
        let _ = window.set_focusable(false);
        window.hide().map_err(|e| e.to_string())?;
        return Ok(false);
    }
    let (previous, state) = take_turn(&desktop.notch, state);
    let release_keyboard = cfg!(target_os = "macos")
        && !state.expanded
        && previous.expanded
        && window.is_focused().unwrap_or(false);
    // Focusable only once the keyboard was asked for: hovering, and clicking card buttons, leave
    // the user's own application in front.
    window
        .set_focusable(state.keyboard)
        .map_err(|e| e.to_string())?;
    if release_keyboard {
        platform::release_notch_keyboard(&window)?;
    } else {
        window.show().map_err(|e| e.to_string())?;
    }
    // On Windows clear NOACTIVATE before requesting focus. Hover alone never activates.
    let current_size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    platform::configure(
        &window,
        state.keyboard,
        current_size.width,
        current_size.height,
    )?;
    if state.keyboard && !previous.keyboard {
        window.set_focus().map_err(|e| e.to_string())?;
        // The native key window and the renderer's first responder are separate on macOS.
        window.as_ref().set_focus().map_err(|e| e.to_string())?;
    }
    let changed = previous.width != state.width || previous.height != state.height;
    if changed {
        let generation = desktop.notch_animation.fetch_add(1, Ordering::SeqCst) + 1;
        let size = window
            .inner_size()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
        let start = Instant::now();
        loop {
            if desktop.notch_animation.load(Ordering::SeqCst) != generation {
                return Ok(false);
            }
            let elapsed = start.elapsed().as_secs_f64();
            let finished = state.reduced_motion || release_keyboard || elapsed >= 0.36;
            let progress = if finished {
                1.0
            } else {
                shell_progress(elapsed)
            };
            let width = size.width + (state.width - size.width) * progress;
            let height = size.height + (state.height - size.height) * progress;
            window
                .set_size(tauri::LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
            let interactive = desktop.notch.lock().unwrap().keyboard;
            platform::configure(&window, interactive, width, height)?;
            position_notch(&window)?;
            if finished {
                break;
            }
            tokio::time::sleep(Duration::from_millis(16)).await;
        }
    } else {
        // A second renderer measurement shares the in-flight animation instead of restarting it.
        for _ in 0..24 {
            let target = desktop.notch.lock().unwrap().clone();
            if target.width != state.width || target.height != state.height {
                return Ok(false);
            }
            let size = window
                .inner_size()
                .map_err(|e| e.to_string())?
                .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
            if (size.width - state.width).abs() <= 1.0 && (size.height - state.height).abs() <= 1.0
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(16)).await;
        }
    }
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    platform::configure(
        &window,
        desktop.notch.lock().unwrap().keyboard,
        size.width,
        size.height,
    )?;
    if release_keyboard {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(window.is_visible().unwrap_or(false)
        && size.width >= state.width - 1.0
        && size.height >= state.height - 1.0)
}
fn shell_progress(seconds: f64) -> f64 {
    let frequency = 2.0 * std::f64::consts::PI / 0.32;
    let damping = 0.86_f64;
    let residual = (1.0 - damping * damping).sqrt();
    1.0 - (-damping * frequency * seconds).exp()
        * ((frequency * residual * seconds).cos()
            + damping / residual * (frequency * residual * seconds).sin())
}
fn target_display(window: &WebviewWindow) -> Result<Option<notch_display::Display>, String> {
    let displays = notch_display::list(window)?;
    let settings = window.state::<Desktop>().settings.lock().unwrap().clone();
    let current = window.current_monitor().map_err(|e| e.to_string())?;
    let current_index = displays.iter().position(|d| current.as_ref().is_some_and(|m| m.position() == d.monitor.position()));
    let ids = displays.iter().map(|d| d.id.as_str()).collect::<Vec<_>>();
    let index = notch_display::selected_index(&ids, settings.notch_display.as_ref().map(|d| d.id.as_str()),
        current_index, displays.iter().position(|d| d.primary));
    Ok(index.map(|i| displays[i].clone()))
}

/// Whether the band sits in this screen's menu bar: the top band on a screen without a camera
/// housing, while its menu bar is visible.
fn in_menu_bar(display: &notch_display::Display, placement: &notch_display::Placement) -> bool {
    *placement == notch_display::Placement::Top
        && display.camera_height <= 0.0
        && display.menu_height >= notch_geometry::MIN_MENU_HEIGHT
}

/// Look at the menu bar icons on `display` and find the band's left edge, staying at `current`
/// while that still fits.
fn find_menu_slot(display: &notch_display::Display, placement: &notch_display::Placement, current: Option<f64>) -> Option<f64> {
    let scale = display.monitor.scale_factor();
    let screen = notch_geometry::Frame {
        x: display.monitor.position().x as f64 / scale,
        y: display.monitor.position().y as f64 / scale,
        width: display.monitor.size().width as f64 / scale,
        height: display.monitor.size().height as f64 / scale,
    };
    let width = notch_geometry::compact_width(display.camera_width, placement);
    platform::status_bar_windows()
        .and_then(|icons| notch_geometry::menu_bar_slot(screen, display.menu_height, &icons, width, current))
}

/// The band's center in points in the menu bar of `display`, or `None` to place it below the
/// menu bar. Uses the stored place; only a display without one is looked at here.
fn menu_bar_center(window: &WebviewWindow, display: &notch_display::Display) -> Option<f64> {
    let desktop = window.state::<Desktop>();
    let placement = desktop.settings.lock().unwrap().notch_placement.clone();
    if !in_menu_bar(display, &placement) {
        return None;
    }
    let mut stored = desktop.menu_slot.lock().unwrap();
    let left = match stored.as_ref().filter(|slot| slot.display == display.id) {
        Some(slot) => slot.left,
        None => {
            let left = find_menu_slot(display, &placement, None);
            *stored = Some(MenuSlot { display: display.id.clone(), left });
            left
        }
    };
    let width = notch_geometry::compact_width(display.camera_width, &placement);
    left.map(|left| left + width / 2.0)
}

/// Menu bar icons come and go: look for the collapsed band's place again. True when it moved.
fn refresh_menu_slot(window: &WebviewWindow) -> bool {
    let Ok(Some(display)) = target_display(window) else {
        return false;
    };
    let desktop = window.state::<Desktop>();
    let placement = desktop.settings.lock().unwrap().notch_placement.clone();
    let mut stored = desktop.menu_slot.lock().unwrap();
    if !in_menu_bar(&display, &placement) {
        *stored = None;
        return false;
    }
    let previous = stored.as_ref().filter(|slot| slot.display == display.id).map(|slot| slot.left);
    let left = find_menu_slot(&display, &placement, previous.flatten());
    *stored = Some(MenuSlot { display: display.id.clone(), left });
    previous != Some(left)
}

fn position_notch_on(window: &WebviewWindow, display: &notch_display::Display) -> Result<(), String> {
    let monitor = &display.monitor;
    let scale = monitor.scale_factor();
    let settings = window.state::<Desktop>().settings.lock().unwrap().clone();
    // Read logical size on the source screen, then convert using the destination scale.
    let size = window.outer_size().map_err(|e| e.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    let work = monitor.work_area();
    let area = notch_geometry::safe_work_area(monitor.position().y as f64, notch_geometry::Frame {
        x: work.position.x as f64, y: work.position.y as f64,
        width: work.size.width as f64, height: work.size.height as f64,
    }, display.safe_top, scale);
    let screen = notch_geometry::Frame {
        x: monitor.position().x as f64, y: monitor.position().y as f64,
        width: monitor.size().width as f64, height: monitor.size().height as f64,
    };
    let area = if settings.notch_placement == notch_display::Placement::Top {
        notch_geometry::camera_work_area(screen, area, display.camera_height)
    } else { area };
    let (x, y) = match menu_bar_center(window, display) {
        Some(center) => notch_geometry::menu_bar_layout(screen, center * scale, size.width * scale),
        None => notch_geometry::dock_layout(area, size.width * scale, size.height * scale, &settings.notch_placement),
    };
    // Tao converts physical positions with the *source* window scale on macOS. Use global
    // points explicitly when crossing displays, or a 1x/2x pair lands on the wrong screen.
    #[cfg(target_os = "macos")]
    let position = tauri::Position::Logical(tauri::LogicalPosition::new(x as f64 / scale, y as f64 / scale));
    #[cfg(not(target_os = "macos"))]
    let position = tauri::Position::Physical(tauri::PhysicalPosition::new(x, y));
    window.set_position(position).map_err(|e| e.to_string())
}

fn position_notch(window: &WebviewWindow) -> Result<(), String> {
    if let Some(display) = target_display(window)? {
        position_notch_on(window, &display)?;
    }
    Ok(())
}

#[tauri::command]
fn notch_displays(window: WebviewWindow) -> Result<Vec<notch_display::Display>, String> {
    notch_display::list(&window)
}

#[tauri::command]
fn notch_metrics(window: WebviewWindow) -> Result<NotchMetrics, String> {
    let (camera_width, camera_height, menu_height) = target_display(&window)?
        .map_or((0.0, 0.0, 0.0), |display| (display.camera_width, display.camera_height, display.menu_height));
    let placement = window.state::<Desktop>().settings.lock().unwrap().notch_placement.clone();
    Ok(NotchMetrics {
        band_height: notch_geometry::band_height(camera_height, menu_height, &placement),
        compact_width: notch_geometry::compact_width(camera_width, &placement),
        housing_width: notch_geometry::housing_width(camera_width, &placement),
    })
}
fn explicit_home() -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        let args: Vec<_> = std::env::args().collect();
        if let Some(pair) = args.windows(2).find(|pair| pair[0] == "--home") {
            return Some(PathBuf::from(&pair[1]));
        }
    }
    std::env::var_os("TODOCUE_HOME").map(PathBuf::from)
}

fn home() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let profile = bundled_macos_runtime()
            .then(macos_home::profile_path)
            .flatten();
        macos_home::resolve_launch_home(
            explicit_home(),
            profile.as_deref(),
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .expect("User home directory")
                .join(".todocue"),
            std::env::temp_dir().join("todocue-desktop-development"),
            bundled_macos_runtime(),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(value) = explicit_home() {
            return value;
        }
        #[cfg(windows)]
        if !cfg!(debug_assertions) {
            if let Some(profile) = std::env::var_os("USERPROFILE") {
                return PathBuf::from(profile).join(".todocue");
            }
        }
        // Preview builds never attach to or create the user's production task database.
        std::env::temp_dir().join("todocue-desktop-development")
    }
}

#[cfg(target_os = "macos")]
fn bundled_macos_runtime() -> bool {
    !cfg!(debug_assertions)
        && std::env::current_exe()
            .ok()
            .and_then(|exe| {
                exe.parent()?
                    .parent()
                    .map(|contents| contents.join("Resources/runtime/bin/node"))
            })
            .is_some_and(|node| node.is_file())
}

/// The main menu: an app menu whose Quit carries ⌘Q (the accessory app has no Dock icon to quit
/// from), and Edit so ⌘X ⌘C ⌘V ⌘A reach text fields. Undo is left out on purpose: ⌘Z belongs to
/// the undo toast.
#[cfg(target_os = "macos")]
fn install_edit_menu(app: &tauri::App, language: &str) -> tauri::Result<()> {
    use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
    let en = language == "en";
    let application = Submenu::with_items(
        app,
        "TodoCue",
        true,
        &[&PredefinedMenuItem::quit(app, Some(if en { "Quit TodoCue" } else { "退出 TodoCue" }))?],
    )?;
    let edit = Submenu::with_items(
        app,
        if en { "Edit" } else { "编辑" },
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&application, &edit])?)?;
    Ok(())
}

/// The panel's own "Quit TodoCue" entry. The background runtime keeps delivering reminders.
#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

const TRAY_ID: &str = "main";

/// The tray / menu-bar image: a black template on macOS (the system tints it), the signal orange
/// elsewhere so it reads on light and dark taskbars.
fn tray_image() -> tauri::image::Image<'static> {
    if cfg!(target_os = "macos") {
        tauri::image::Image::new_owned(tray_icon::mark_rgba(36, tray_icon::TEMPLATE_BLACK), 36, 36)
    } else {
        tauri::image::Image::new_owned(tray_icon::mark_rgba(64, tray_icon::ORANGE), 64, 64)
    }
}

fn tray_menu(
    app: &tauri::AppHandle,
    entries: &[host_tray::Entry],
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
    let menu = Menu::new(app)?;
    for entry in entries {
        match entry {
            host_tray::Entry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            host_tray::Entry::Item { id, label, enabled, checked: Some(checked) } => {
                menu.append(&CheckMenuItem::with_id(app, *id, label, *enabled, *checked, None::<&str>)?)?
            }
            host_tray::Entry::Item { id, label, enabled, checked: None } => {
                menu.append(&MenuItem::with_id(app, *id, label, *enabled, None::<&str>)?)?
            }
        }
    }
    Ok(menu)
}

/// Rebuild the tray menu, tooltip and (macOS) menu-bar number from the last pushed state.
fn refresh_tray(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let desktop = app.state::<Desktop>();
    let state = desktop.tray.lock().unwrap().clone();
    let language = desktop.settings.lock().unwrap().language.clone();
    // The saved language wins over the one in the last push, which can be a moment behind it.
    let state = state.map(|state| TrayState { language: language.clone(), ..state });
    let entries = match &state {
        Some(state) => {
            host_tray::entries(state, app.autolaunch().is_enabled().unwrap_or(false))
        }
        None => host_tray::startup_entries(&language),
    };
    if let Ok(menu) = tray_menu(app, &entries) {
        let _ = tray.set_menu(Some(menu));
    }
    if let Some(state) = &state {
        let _ = tray.set_tooltip(Some(host_tray::tooltip(state)));
        // Only macOS draws text beside the icon; Windows shows the count in the tooltip.
        #[cfg(target_os = "macos")]
        {
            let _ = tray.set_title(Some(host_tray::title(state)));
            // The icon's new width moves the icons beside the band once macOS lays them out again.
            desktop.menu_refresh.store(8, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
fn tray_update(app: tauri::AppHandle, desktop: State<'_, Desktop>, state: TrayState) {
    {
        let mut current = desktop.tray.lock().unwrap();
        if current.as_ref() == Some(&state) {
            return;
        }
        *current = Some(state);
    }
    refresh_tray(&app);
}

fn tray_menu_event(app: &tauri::AppHandle, id: &str) {
    match id {
        "open" => {
            let _ = panel_present(app.clone(), app.state::<Desktop>(), false);
        }
        "next" => {
            let next = app
                .state::<Desktop>()
                .tray
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|state| state.next_id.clone());
            if let Some(id) = next {
                route_target(app, Target::Task(id));
            }
        }
        "new_task" => route_target(app, Target::NewTask),
        "new_periodic" => route_target(app, Target::NewPeriodic),
        "periodic" => route_target(app, Target::PeriodicList),
        "settings" => route_target(app, Target::Settings),
        "reconnect" => {
            let _ = app.emit("tray:reconnect", ());
        }
        "login" => {
            let desktop = app.state::<Desktop>();
            let mut next = desktop.settings.lock().unwrap().clone();
            next.autostart = !app.autolaunch().is_enabled().unwrap_or(false);
            let _ = settings_save(app.clone(), desktop, next);
            refresh_tray(app);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn build_tray(app: &tauri::App, language: &str) -> tauri::Result<()> {
    let menu = tray_menu(app.handle(), &host_tray::startup_entries(language))?;
    let builder = tauri::tray::TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_image())
        .tooltip("TodoCue")
        .menu(&menu)
        .on_menu_event(|app, event| tray_menu_event(app, event.id.as_ref()));
    // macOS: the menu opens on a click and the icon is a template. Windows: the usual convention,
    // a left click toggles the panel and the menu belongs to the right button.
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true).show_menu_on_left_click(true);
    #[cfg(not(target_os = "macos"))]
    let builder = {
        // A double-click delivers two releases; only the first toggles the panel.
        let gate = Mutex::new(host_tray::ClickGate::default());
        builder
            .show_menu_on_left_click(false)
            .on_tray_icon_event(move |tray, event| {
                if let tauri::tray::TrayIconEvent::Click {
                    button: tauri::tray::MouseButton::Left,
                    button_state: tauri::tray::MouseButtonState::Up,
                    ..
                } = event
                {
                    if gate.lock().unwrap().release(Instant::now()) {
                        panel_toggle(tray.app_handle());
                    }
                }
            })
    };
    builder.build(app)?;
    Ok(())
}

/// Save the export in the system Downloads folder and show it in the file manager.
#[tauri::command]
async fn export_json(
    app: tauri::AppHandle,
    name: String,
    contents: String,
) -> Result<String, String> {
    let directory = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir().map(|home| home.join("Downloads")))
        .map_err(|e| e.to_string())?;
    // Written off the main thread: an export can be large.
    let path = export::save_async(directory, name, contents).await?;
    export::reveal(&path);
    Ok(path.to_string_lossy().into_owned())
}

pub fn run() {
    let context = tauri::generate_context!();
    let launch_home = home();
    let startup_name = "TodoCue".to_string();
    #[cfg(windows)]
    let (context, launch_home, startup_name) = {
        let mut context = context;
        let result = (|| -> Result<PathBuf, String> {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let root = exe
                .parent()
                .ok_or("App directory unavailable")?
                .join("runtime");
            let dir =
                windows_home::homes_directory().ok_or("Windows user directory unavailable")?;
            let args: Vec<_> = std::env::args().collect();
            // An explicit shell environment still takes precedence for ordinary launches.
            if std::env::var_os("TODOCUE_HOME").is_some()
                && !args.iter().any(|arg| arg.starts_with("todocue:"))
            {
                return Ok(launch_home.clone());
            }
            windows_home::launch_home(&args, launch_home.clone(), &root, &dir)
        })();
        let launch_home = result
            .and_then(|home| windows_home::resolve_home(&home))
            .unwrap_or_else(|error| {
                eprintln!("TodoCue route: {error}");
                std::process::exit(2)
            });
        let id = windows_home::home_id(&launch_home);
        // Each data directory has its own warm-instance route. Opening a toast
        // from another directory cannot reveal the wrong task or discard a draft.
        context
            .config_mut()
            .identifier
            .push_str(&format!(".home{id}"));
        (context, launch_home, format!("TodoCue {id}"))
    };
    let startup_args = vec![
        "--background".to_string(),
        "--home".to_string(),
        launch_home.to_string_lossy().into_owned(),
    ];
    tauri::Builder::default()
        // The original app has no main menu beyond Edit; tauri's default one adds ⌘Q, ⌘M, ⌘W,
        // ⌃⌘F and Undo (⌘Z belongs to the undo toast).
        .enable_macos_default_menu(false)
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(startup_name)
                .args(startup_args)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    panel_toggle(app);
                })
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let target = args
                .iter()
                .find_map(|arg| parse_target(arg))
                .unwrap_or(Target::Open);
            route_target(app, target);
        }))
        .invoke_handler(tauri::generate_handler![
            runtime_request,
            runtime_subscribe,
            settings_load,
            settings_save,
            panel_show,
            panel_focus,
            panel_hide,
            panel_drag,
            panel_resize_macos,
            reveal_task,
            notch_present,
            notch_available,
            notch_metrics,
            notch_displays,
            route_ready,
            panel_new_task,
            panel_visible,
            tray_update,
            app_quit,
            export_json,
            open_data_dir,
            save_file
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            #[cfg(target_os = "macos")]
            platform::check_legacy_client().map_err(std::io::Error::other)?;
            let home = launch_home.clone();
            #[cfg(target_os = "macos")]
            if bundled_macos_runtime() && explicit_home().is_some() {
                if let Some(profile) = macos_home::profile_path() {
                    if let Err(error) = macos_home::remember(&profile, &home) {
                        eprintln!("Unable to remember Preview data directory: {error}");
                    }
                }
            }
            let settings = std::fs::read(home.join("desktop-preview-settings.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
                .and_then(|mut settings| {
                    settings.validate().ok()?;
                    Some(settings)
                })
                .unwrap_or_default();
            app.manage(Arc::new(Runtime::new(home.clone())));
            let target = std::env::args().find_map(|arg| parse_target(&arg));
            app.manage(Desktop {
                home,
                settings: Mutex::new(settings.clone()),
                notch: Mutex::new(NotchState::default()),
                routing: Mutex::new(Routing {
                    ready: false,
                    pending: target,
                }),
                notch_animation: AtomicU64::new(0),
                panel_resize: AtomicU64::new(0),
                panel_fade: PanelFade::default(),
                fitted_panel: Mutex::new(None),
                tray: Mutex::new(None),
                menu_slot: Mutex::new(None),
                menu_refresh: AtomicU64::new(0),
            });
            if let Some(shortcut) = &settings.shortcut {
                if let Err(error) = app.global_shortcut().register(shortcut.as_str()) {
                    eprintln!("Global shortcut unavailable: {error}");
                }
            }
            #[cfg(any(windows, target_os = "macos"))]
            {
                let resources = app.path().resource_dir()?;
                let runtime = resources.join("runtime");
                let node = runtime.join(if cfg!(windows) {
                    "bin/node.exe"
                } else {
                    "bin/node"
                });
                if node.exists() {
                    let data = app.state::<Desktop>().home.clone();
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        let mut command = std::process::Command::new(node);
                        command
                            .arg(runtime.join("packages/cli/dist/index.js"))
                            .arg("--home")
                            .arg(data)
                            .arg("--json")
                            .arg("bootstrap");
                        #[cfg(windows)]
                        {
                            use std::os::windows::process::CommandExt;
                            command.creation_flags(0x08000000);
                        }
                        let error = match command.output() {
                            Ok(output) if output.status.success() => None,
                            Ok(output) => Some(format!(
                                "{}{}",
                                String::from_utf8_lossy(&output.stdout),
                                String::from_utf8_lossy(&output.stderr)
                            )),
                            Err(error) => Some(error.to_string()),
                        };
                        if let Some(message) = error {
                            eprintln!("Runtime bootstrap failed: {message}");
                            let runtime = handle.state::<Arc<Runtime>>().inner().clone();
                            tauri::async_runtime::block_on(
                                runtime.bootstrap_failed(&handle, message),
                            );
                        }
                    });
                }
            }
            let panel = app.get_webview_window("panel").unwrap();
            platform::glass(&panel).map_err(std::io::Error::other)?;
            platform::panel_spaces(&panel).map_err(std::io::Error::other)?;
            #[cfg(target_os = "macos")]
            install_edit_menu(app, &settings.language)?;
            fit_panel(&panel, &settings, true).map_err(std::io::Error::other)?;
            if !std::env::args().any(|arg| arg == "--background") {
                platform::show_without_activation(&panel).map_err(std::io::Error::other)?;
            }
            let notch = WebviewWindowBuilder::new(
                app,
                "notch",
                WebviewUrl::App("index.html?surface=notch".into()),
            )
            .title("TodoCue Notch")
            .inner_size(notch_geometry::DEFAULT_NOTCH_WIDTH, 32.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .focusable(false)
            .accept_first_mouse(true)
            .visible(false)
            .build()?;
            platform::notch_level(&notch).map_err(std::io::Error::other)?;
            let metrics = notch_metrics(notch.clone()).map_err(std::io::Error::other)?;
            notch.set_size(tauri::LogicalSize::new(metrics.compact_width, metrics.band_height))?;
            position_notch(&notch).map_err(std::io::Error::other)?;
            platform::configure(&notch, false, metrics.compact_width, metrics.band_height)
                .map_err(std::io::Error::other)?;
            if settings.notch_enabled {
                notch.show()?;
            }
            platform::monitor_notch_clicks(app.handle()).map_err(std::io::Error::other)?;
            build_tray(app, &settings.language)?;
            let handle = app.handle().clone();
            // Native pointer polling keeps screen-following independent of WebView focus.
            std::thread::spawn(move || {
                let mut other_since: Option<Instant> = None;
                let mut layout = String::new();
                let mut band_height = 0.0;
                let mut last_metrics = None;
                // The host reports whether the pointer is on the notch, as a fallback for a
                // WebView that gets no mouse events while the app is inactive. Switch it off with
                // TODOCUE_NOTCH_POINTER=0; the renderer then relies on DOM hover alone.
                let report_pointer = std::env::var("TODOCUE_NOTCH_POINTER").map_or(true, |v| v != "0");
                let mut pointer_inside: Option<bool> = None;
                let mut tick = 0_u32;
                let mut fullscreen_now = false;
                loop {
                    std::thread::sleep(Duration::from_millis(100));
                    tick = tick.wrapping_add(1);
                    let Some(window) = handle.get_webview_window("notch") else {
                        break;
                    };
                    let desktop = handle.state::<Desktop>();
                    let state = desktop.notch.lock().unwrap().clone();
                    let settings = desktop.settings.lock().unwrap().clone();
                    if let Ok(metrics) = notch_metrics(window.clone()) {
                        if last_metrics.as_ref() != Some(&metrics) {
                            band_height = metrics.band_height;
                            last_metrics = Some(metrics.clone());
                            let _ = handle.emit_to("notch", "notch:metrics", metrics);
                        }
                    }
                    let Ok(monitors) = window.available_monitors() else {
                        continue;
                    };
                    let current_layout = format!("{:?}:{:?}:{:?}", monitors, settings.notch_display, settings.notch_placement);
                    let layout_changed = current_layout != layout;
                    if layout_changed {
                        let width = if state.expanded || state.stack { state.width.max(128.0) }
                            else { last_metrics.as_ref().map_or(notch_geometry::DEFAULT_NOTCH_WIDTH, |metrics| metrics.compact_width) };
                        let height = if state.expanded || state.stack {
                            state.height.max(band_height)
                        } else {
                            band_height.max(18.0)
                        };
                        let _ = window.set_size(tauri::LogicalSize::new(width, height));
                        let _ = platform::configure(&window, state.keyboard, width, height);
                        // Screens moved or the setting changed: a stored menu bar place is stale.
                        *desktop.menu_slot.lock().unwrap() = None;
                        if position_notch(&window).is_ok() { layout = current_layout; }
                        if let Some(panel) = handle.get_webview_window("panel") {
                            if panel.is_visible().unwrap_or(false) {
                                let _ = fit_panel(&panel, &settings, false);
                            }
                        }
                    }
                    // Fullscreen detection reads the window list: twice a second is plenty.
                    if tick % 5 == 1 || layout_changed {
                        fullscreen_now = settings.quiet_fullscreen && platform::fullscreen(&window);
                    }
                    let should_show = settings.notch_enabled && !fullscreen_now;
                    if window.is_visible().ok() != Some(should_show) {
                        if should_show {
                            let _ = window.show();
                        } else {
                            release_turn(&desktop.notch);
                            let _ = window.set_focusable(false);
                            let _ = window.hide();
                        }
                    }
                    // Panel layout must recover even when the optional notch is hidden.
                    if !should_show { pointer_inside = None; }
                    if !settings.notch_enabled { continue; }
                    // Menu bar icons that come, go or change width move the collapsed band: twice a
                    // second, and on every tick for a moment after TodoCue's own icon changed.
                    // Only a band that has finished shrinking moves, so a closing card never hops.
                    let quick = desktop.menu_refresh.load(Ordering::SeqCst) > 0;
                    let at_rest = last_metrics.as_ref().is_none_or(|metrics| {
                        window.inner_size().ok().zip(window.scale_factor().ok()).is_some_and(|(size, scale)| {
                            let size = size.to_logical::<f64>(scale);
                            (size.width - metrics.compact_width).abs() <= 1.0
                                && (size.height - metrics.band_height).abs() <= 1.0
                        })
                    });
                    if should_show && at_rest && !(state.expanded || state.stack) && (tick % 5 == 1 || quick) {
                        if quick { desktop.menu_refresh.fetch_sub(1, Ordering::SeqCst); }
                        if refresh_menu_slot(&window) { let _ = position_notch(&window); }
                    }
                    if tick % 5 == 3 {
                        platform::follow_virtual_desktop(&window);
                    }
                    let cursor_scale = pointer_scale(&window);
                    if report_pointer && should_show {
                        if let (Ok(cursor), Ok(origin), Ok(size), Ok(window_scale)) = (
                            window.cursor_position(),
                            window.outer_position(),
                            window.outer_size(),
                            window.scale_factor(),
                        ) {
                            let inside = notch_geometry::pointer_in_window(
                                (cursor.x, cursor.y),
                                cursor_scale,
                                (origin.x as f64, origin.y as f64),
                                (size.width as f64, size.height as f64),
                                window_scale,
                                PER_SCREEN_SCALE,
                            );
                            if pointer_inside != Some(inside) {
                                pointer_inside = Some(inside);
                                let _ = handle.emit_to("notch", "notch:pointer", json!({ "inside": inside }));
                            }
                        }
                    }
                    if (state.expanded && should_show) || settings.notch_display.is_some() {
                        other_since = None;
                        continue;
                    }
                    let Ok(pointer) = window.cursor_position() else {
                        continue;
                    };
                    let target = monitors
                        .iter()
                        .find(|monitor| pointer_on_monitor(pointer, cursor_scale, monitor));
                    if let Some(monitor) = target {
                        if window
                            .current_monitor()
                            .ok()
                            .flatten()
                            .is_some_and(|current| current.position() == monitor.position())
                        {
                            other_since = None;
                            continue;
                        }
                        if state.stack
                            && other_since.get_or_insert_with(Instant::now).elapsed()
                                < Duration::from_millis(1500)
                        {
                            continue;
                        }
                        other_since = None;
                        if let Ok(displays) = notch_display::list(&window) {
                            if let Some(display) = displays.iter().find(|d| d.monitor.position() == monitor.position()) {
                                let _ = position_notch_on(&window, display);
                                // The new display may be in fullscreen; do not reuse the previous screen's result.
                                fullscreen_now = settings.quiet_fullscreen && platform::fullscreen(&window);
                                if fullscreen_now { let _ = window.hide(); }
                            }
                        }
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "notch" && matches!(event, tauri::WindowEvent::Focused(true)) {
                let _ = window.emit("notch:focus", ());
            }
            #[cfg(not(target_os = "macos"))]
            if window.label() == "notch" && matches!(event, tauri::WindowEvent::Focused(false)) {
                if let (Ok(pointer), Ok(origin), Ok(size)) = (
                    window.cursor_position(),
                    window.outer_position(),
                    window.outer_size(),
                ) {
                    // Candidate windows and keyboard focus changes can blur a WebView.
                    // An outside click must also be outside the native window bounds.
                    if pointer.x < origin.x as f64
                        || pointer.y < origin.y as f64
                        || pointer.x >= origin.x as f64 + size.width as f64
                        || pointer.y >= origin.y as f64 + size.height as f64
                    {
                        notch_outside(window.app_handle());
                    }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "panel" {
                    panel_hide_animated(window.app_handle());
                } else {
                    let _ = window.hide();
                }
            }
            if window.label() == "panel" {
                if let tauri::WindowEvent::Resized(size) = event {
                    let app = window.app_handle().clone();
                    let Some(desktop) = app.try_state::<Desktop>() else {
                        return;
                    };
                    let Ok(scale) = window.scale_factor() else {
                        return;
                    };
                    let logical = size.to_logical::<f64>(scale);
                    if let Some(panel) = app.get_webview_window("panel") {
                        let _ = platform::configure(&panel, true, logical.width, logical.height);
                    }
                    let mut expected = desktop.fitted_panel.lock().unwrap();
                    if expected.is_some_and(|(width, height)| {
                        (width - logical.width).abs() < 1.0 && (height - logical.height).abs() < 1.0
                    }) {
                        *expected = None;
                        desktop.panel_resize.fetch_add(1, Ordering::SeqCst);
                        return;
                    }
                    drop(expected);
                    let generation = desktop.panel_resize.fetch_add(1, Ordering::SeqCst) + 1;
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        let desktop = app.state::<Desktop>();
                        if desktop.panel_resize.load(Ordering::SeqCst) != generation {
                            return;
                        }
                        *desktop.fitted_panel.lock().unwrap() = None;
                        let mut current = desktop.settings.lock().unwrap();
                        if current.width == logical.width && current.height == logical.height {
                            return;
                        }
                        let mut next = current.clone();
                        next.width = logical.width;
                        next.height = logical.height;
                        if next.validate().is_err() {
                            return;
                        }
                        let path = desktop.home.join("desktop-preview-settings.json");
                        let temporary = path.with_extension("tmp");
                        if std::fs::create_dir_all(&desktop.home).is_ok()
                            && std::fs::write(&temporary, serde_json::to_vec_pretty(&next).unwrap())
                                .is_ok()
                            && std::fs::rename(temporary, path).is_ok()
                        {
                            *current = next.clone();
                            drop(current);
                            let _ = app.emit("settings:changed", next);
                        }
                    });
                }
            }
        })
        .build(context)
        .expect("TodoCue desktop host failed")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { ref urls } = event {
                for url in urls {
                    if let Some(target) = parse_target(url.as_str()) {
                        route_target(app, target);
                    }
                }
            }
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keyboard_is_granted_on_request_and_kept_until_the_quick_look_closes() {
        let open = |focus| NotchState { expanded: true, focus, ..NotchState::default() };
        // Hovering open, or clicking a card button, never asks for it.
        assert!(!latch_keyboard(false, &open(false)));
        // The field or the band was clicked.
        assert!(latch_keyboard(false, &open(true)));
        // Later measurements without the request keep it.
        assert!(latch_keyboard(true, &open(false)));
        // Closing releases it, even if the request flag is still set.
        let closed = NotchState { expanded: false, focus: true, ..NotchState::default() };
        assert!(!latch_keyboard(true, &closed));
    }
    fn open_state(focus: bool) -> NotchState {
        NotchState { width: 560.0, height: 200.0, expanded: true, focus, ..NotchState::default() }
    }
    #[test]
    fn a_later_measurement_starts_from_what_the_earlier_one_left() {
        let shared = Mutex::new(NotchState::default());
        let (before, first) = take_turn(&shared, open_state(true));
        assert!(!before.keyboard && first.keyboard);
        let (before, second) = take_turn(&shared, open_state(false));
        assert!(before.keyboard, "the second call sees the grant of the first");
        assert!(second.keyboard);
        assert!(shared.lock().unwrap().keyboard);
        // Closing hands the keyboard back; the next hover does not take it.
        let (_, closed) = take_turn(&shared, NotchState { focus: true, ..NotchState::default() });
        assert!(!closed.keyboard);
        let (_, hovered) = take_turn(&shared, open_state(false));
        assert!(!hovered.keyboard);
    }
    #[test]
    fn overlapping_present_calls_never_take_back_a_keyboard_grant() {
        use std::sync::atomic::{AtomicBool, AtomicUsize};
        let shared = Arc::new(Mutex::new(NotchState::default()));
        let granted = Arc::new(AtomicBool::new(false));
        let lost = Arc::new(AtomicUsize::new(0));
        let readers: Vec<_> = (0..4)
            .map(|_| {
                let (shared, granted, lost) = (shared.clone(), granted.clone(), lost.clone());
                std::thread::spawn(move || {
                    for _ in 0..20_000 {
                        let was_granted = granted.load(Ordering::SeqCst);
                        let (_, mine) = take_turn(&shared, open_state(false));
                        if was_granted && !mine.keyboard {
                            lost.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                })
            })
            .collect();
        std::thread::sleep(Duration::from_millis(2));
        let (_, grant) = take_turn(&shared, open_state(true));
        assert!(grant.keyboard);
        granted.store(true, Ordering::SeqCst);
        for reader in readers {
            reader.join().unwrap();
        }
        assert_eq!(lost.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn switching_the_notch_off_releases_the_keyboard_and_the_quick_look() {
        let shared = Mutex::new(NotchState::default());
        take_turn(&shared, open_state(true));
        release_turn(&shared);
        let stored = shared.lock().unwrap().clone();
        assert!(!stored.keyboard && !stored.expanded);
        // Back again with a plain hover: the keyboard is not taken on the strength of the old grant.
        let (_, hovered) = take_turn(&shared, open_state(false));
        assert!(!hovered.keyboard);
    }
    #[test]
    fn the_tray_is_rebuilt_when_the_language_or_the_login_item_changes() {
        assert!(tray_needs_refresh(true, false));
        assert!(tray_needs_refresh(false, true));
        assert!(tray_needs_refresh(true, true));
        // A resize or a shortcut change touches neither.
        assert!(!tray_needs_refresh(false, false));
    }
    #[test]
    fn panel_fades_ease_in_and_out_between_visible_and_hidden() {
        assert_eq!(fade_alpha(true, 0.0), 0.0);
        assert_eq!(fade_alpha(true, 1.0), 1.0);
        assert_eq!(fade_alpha(false, 0.0), 1.0);
        assert_eq!(fade_alpha(false, 1.0), 0.0);
        // Ease-out arrives early; ease-in leaves late.
        assert!(fade_alpha(true, 0.5) > 0.8);
        assert!(fade_alpha(false, 0.5) > 0.7);
        for step in 0..=10 {
            let t = step as f64 / 10.0;
            assert!(fade_alpha(true, t) <= fade_alpha(true, (t + 0.1).min(1.0)));
            assert!(fade_alpha(false, t) >= fade_alpha(false, (t + 0.1).min(1.0)));
        }
        assert_eq!(fade_alpha(true, 9.0), 1.0);
        assert_eq!(fade_alpha(false, -1.0), 1.0);
    }
    #[test]
    fn reveal_modes_route_to_edit_and_delete_and_reject_everything_else() {
        assert_eq!(reveal_target("t_1", None), Ok(None));
        assert_eq!(reveal_target("t_1", Some("edit")), Ok(Some(Target::TaskEdit("t_1".into()))));
        assert_eq!(reveal_target("t_1", Some("delete")), Ok(Some(Target::TaskDelete("t_1".into()))));
        assert!(reveal_target("t_1", Some("remove")).is_err());
        assert!(reveal_target("t_1", Some("")).is_err());
        assert!(reveal_target("../t", Some("edit")).is_err());
        assert!(reveal_target("", None).is_err());
        assert_eq!(
            serde_json::to_string(&Target::TaskEdit("t_1".into())).unwrap(),
            r#"{"kind":"task_edit","id":"t_1"}"#
        );
        assert_eq!(
            serde_json::to_string(&Target::TaskDelete("t_1".into())).unwrap(),
            r#"{"kind":"task_delete","id":"t_1"}"#
        );
    }
    #[test]
    fn tray_routes_serialize_for_the_panel() {
        for (target, expected) in [
            (Target::NewPeriodic, r#"{"kind":"new_periodic"}"#),
            (Target::PeriodicList, r#"{"kind":"periodic_list"}"#),
            (Target::Settings, r#"{"kind":"settings"}"#),
            (Target::Task("t_1".into()), r#"{"kind":"task","id":"t_1"}"#),
        ] {
            assert_eq!(serde_json::to_string(&target).unwrap(), expected);
        }
    }
    #[test]
    fn old_settings_migrate_to_a_safe_top_notch_and_follow_mode() {
        let settings: Settings = serde_json::from_str(r#"{"notchEnabled":true,"language":"en"}"#).unwrap();
        assert_eq!(settings.notch_placement, notch_display::Placement::Top);
        assert!(settings.notch_display.is_none());
        assert!(serde_json::from_str::<Settings>(r#"{"notchPlacement":"invalid"}"#).is_err());
    }
    #[test]
    fn pinned_display_and_side_placement_round_trip() {
        let mut settings = Settings::default();
        settings.notch_placement = notch_display::Placement::Right;
        settings.notch_display = Some(notch_display::Selection { id: "mac:stable-uuid".into(), name: "Studio Display".into() });
        let restored: Settings = serde_json::from_slice(&serde_json::to_vec(&settings).unwrap()).unwrap();
        assert_eq!(restored.notch_display, settings.notch_display);
        assert_eq!(restored.notch_placement, settings.notch_placement);
    }
    #[test]
    fn settings_reject_nan_and_clamp_sizes() {
        let mut settings = Settings {
            width: 999.0,
            height: 2.0,
            ..Settings::default()
        };
        settings.validate().unwrap();
        assert_eq!(settings.width, 600.0);
        assert_eq!(settings.height, 360.0);
        settings.width = f64::NAN;
        assert!(settings.validate().is_err());
    }
    #[test]
    fn protocol_routes_cold_and_warm_launches_without_accepting_untrusted_targets() {
        assert_eq!(
            parse_target("todocue://task/t_123"),
            Some(Target::Task("t_123".into()))
        );
        assert_eq!(
            parse_target("todocue://periodic/p_123"),
            Some(Target::Periodic("p_123".into()))
        );
        assert_eq!(parse_target("todocue://open"), Some(Target::Open));
        for value in [
            "https://task/t_123",
            "todocue://task/",
            "todocue://task/a/b",
            "todocue://task/%2e%2e",
            "todocue://user@task/t_123",
            "todocue://task/t_123?x=y",
        ] {
            assert!(parse_target(value).is_none());
        }
    }
}
