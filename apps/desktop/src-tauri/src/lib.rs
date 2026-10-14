mod notch_geometry;
#[cfg(any(target_os = "macos", test))]
mod panel_geometry;
mod platform;
mod runtime;
mod windows_home;

use runtime::{Request, Runtime, Status};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    language: String,
    width: f64,
    height: f64,
    notch_enabled: bool,
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
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotchMetrics {
    band_height: f64,
}
#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
enum Target {
    Task(String),
    Periodic(String),
    NewTask,
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
    fitted_panel: Mutex<Option<(f64, f64)>>,
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
    let focus_input = matches!(target, Target::NewTask);
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
    if let Some(panel) = app.get_webview_window("panel") {
        fit_panel(&panel, &settings, false)?;
    }
    if let Some(notch) = app.get_webview_window("notch") {
        if settings.notch_enabled {
            notch.show().map_err(|e| e.to_string())?;
        } else {
            notch.hide().map_err(|e| e.to_string())?;
        }
    }
    app.emit("settings:changed", settings)
        .map_err(|e| e.to_string())
}
fn fit_panel(window: &WebviewWindow, settings: &Settings, align: bool) -> Result<(), String> {
    let monitor = if align {
        window.cursor_position().ok().and_then(|pointer| {
            window
                .available_monitors()
                .ok()?
                .into_iter()
                .find(|monitor| {
                    let p = monitor.position();
                    let s = monitor.size();
                    pointer.x >= p.x as f64
                        && pointer.x < p.x as f64 + s.width as f64
                        && pointer.y >= p.y as f64
                        && pointer.y < p.y as f64 + s.height as f64
                })
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
fn panel_present(
    app: tauri::AppHandle,
    desktop: State<'_, Desktop>,
    focus_input: bool,
) -> Result<(), String> {
    let _ = app.emit_to("notch", "notch:collapse", ());
    let window = app.get_webview_window("panel").ok_or("Panel unavailable")?;
    fit_panel(&window, &desktop.settings.lock().unwrap(), true)?;
    if focus_input {
        window.set_focusable(true).map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        window.as_ref().set_focus().map_err(|e| e.to_string())
    } else {
        platform::show_without_activation(&window)
    }
}
#[tauri::command]
fn panel_hide(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}
#[tauri::command]
fn panel_focus(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("panel").ok_or("Panel unavailable")?;
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
#[tauri::command]
fn reveal_task(
    app: tauri::AppHandle,
    desktop: State<'_, Desktop>,
    id: String,
) -> Result<(), String> {
    if id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("Invalid task id".into());
    }
    panel_show(app.clone(), desktop)?;
    app.emit_to("panel", "task:reveal", id)
        .map_err(|e| e.to_string())
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
    state.width = state.width.clamp(185.0, 560.0);
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
        window.hide().map_err(|e| e.to_string())?;
        return Ok(false);
    }
    let previous = desktop.notch.lock().unwrap().clone();
    let release_keyboard = cfg!(target_os = "macos")
        && !state.expanded
        && previous.expanded
        && window.is_focused().unwrap_or(false);
    window
        .set_focusable(state.expanded)
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
        state.pinned,
        current_size.width,
        current_size.height,
    )?;
    if state.pinned && !previous.pinned {
        window.set_focus().map_err(|e| e.to_string())?;
        // The native key window and the renderer's first responder are separate on macOS.
        window.as_ref().set_focus().map_err(|e| e.to_string())?;
    }
    let changed = previous.width != state.width || previous.height != state.height;
    *desktop.notch.lock().unwrap() = state.clone();
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
            let interactive = desktop.notch.lock().unwrap().pinned;
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
        desktop.notch.lock().unwrap().pinned,
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
fn position_notch(window: &WebviewWindow) -> Result<(), String> {
    if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? {
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let layout = notch_layout(&monitor, size.width);
        window
            .set_position(tauri::PhysicalPosition::new(layout.x, layout.y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn notch_layout(monitor: &tauri::Monitor, width: u32) -> notch_geometry::Layout {
    let position = monitor.position();
    let work = monitor.work_area();
    notch_geometry::layout(
        notch_geometry::Rect {
            x: position.x,
            y: position.y,
            width: monitor.size().width,
        },
        notch_geometry::Rect {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width,
        },
        width,
        monitor.scale_factor(),
        cfg!(target_os = "macos"),
    )
}
#[tauri::command]
fn notch_metrics(window: WebviewWindow) -> Result<NotchMetrics, String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("Notch monitor unavailable")?;
    Ok(NotchMetrics {
        band_height: notch_layout(&monitor, 0).band_height,
    })
}
fn home() -> PathBuf {
    #[cfg(not(windows))]
    {
        let args: Vec<_> = std::env::args().collect();
        if let Some(pair) = args.windows(2).find(|pair| pair[0] == "--home") {
            return PathBuf::from(&pair[1]);
        }
    }
    if let Some(value) = std::env::var_os("TODOCUE_HOME") {
        return PathBuf::from(value);
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

pub fn run() {
    let context = tauri::generate_context!();
    let launch_home = home();
    let startup_name = "TodoCue Preview".to_string();
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
        (context, launch_home, format!("TodoCue Preview {id}"))
    };
    let startup_args = vec![
        "--background".to_string(),
        "--home".to_string(),
        launch_home.to_string_lossy().into_owned(),
    ];
    tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(startup_name)
                .args(startup_args)
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if let Some(panel) = app.get_webview_window("panel") {
                        if panel.is_visible().unwrap_or(false) {
                            let _ = panel.hide();
                        } else {
                            let _ = panel_show(app.clone(), app.state::<Desktop>());
                        }
                    }
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
            route_ready,
            panel_new_task
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let home = launch_home.clone();
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
                fitted_panel: Mutex::new(None),
            });
            if let Some(shortcut) = &settings.shortcut {
                if let Err(error) = app.global_shortcut().register(shortcut.as_str()) {
                    eprintln!("Global shortcut unavailable: {error}");
                }
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let resources = app.path().resource_dir()?;
                let runtime = resources.join("runtime");
                if runtime.join("bin/node.exe").exists() {
                    let data = app.state::<Desktop>().home.clone();
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        let output = std::process::Command::new(runtime.join("bin/node.exe"))
                            .arg(runtime.join("packages/cli/dist/index.js"))
                            .arg("--home")
                            .arg(data)
                            .arg("--json")
                            .arg("bootstrap")
                            .creation_flags(0x08000000)
                            .output();
                        if let Ok(output) = output {
                            if !output.status.success() {
                                let _ = handle.emit(
                                    "runtime:state",
                                    Status {
                                        online: false,
                                        message: Some(
                                            String::from_utf8_lossy(&output.stderr).into_owned(),
                                        ),
                                        generation: None,
                                    },
                                );
                            }
                        }
                    });
                }
            }
            let panel = app.get_webview_window("panel").unwrap();
            platform::glass(&panel).map_err(std::io::Error::other)?;
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
            .inner_size(273.0, 24.0)
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
            let band_height = notch_metrics(notch.clone())
                .map_err(std::io::Error::other)?
                .band_height;
            notch.set_size(tauri::LogicalSize::new(273.0, band_height))?;
            position_notch(&notch).map_err(std::io::Error::other)?;
            platform::configure(&notch, false, 273.0, band_height)
                .map_err(std::io::Error::other)?;
            if settings.notch_enabled {
                notch.show()?;
            }
            platform::monitor_notch_clicks(app.handle()).map_err(std::io::Error::other)?;
            let open =
                tauri::menu::MenuItem::with_id(app, "open", "Open TodoCue", true, None::<&str>)?;
            let quit =
                tauri::menu::MenuItem::with_id(app, "quit", "Quit preview", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&open, &quit])?;
            tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        let _ = panel_show(app.clone(), app.state::<Desktop>());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            let handle = app.handle().clone();
            // Native pointer polling keeps screen-following independent of WebView focus.
            std::thread::spawn(move || {
                let mut other_since: Option<Instant> = None;
                let mut layout = String::new();
                let mut band_height = 0.0;
                loop {
                    std::thread::sleep(Duration::from_millis(100));
                    let Some(window) = handle.get_webview_window("notch") else {
                        break;
                    };
                    let desktop = handle.state::<Desktop>();
                    let state = desktop.notch.lock().unwrap().clone();
                    let settings = desktop.settings.lock().unwrap().clone();
                    if let Ok(metrics) = notch_metrics(window.clone()) {
                        if band_height != metrics.band_height {
                            band_height = metrics.band_height;
                            let _ = handle.emit_to("notch", "notch:metrics", metrics);
                        }
                    }
                    let should_show = settings.notch_enabled
                        && !(settings.quiet_fullscreen && platform::fullscreen(&window));
                    if window.is_visible().ok() != Some(should_show) {
                        if should_show {
                            let _ = window.show();
                        } else {
                            let _ = window.hide();
                        }
                    }
                    let Ok(monitors) = window.available_monitors() else {
                        continue;
                    };
                    let current_layout = format!("{:?}", monitors);
                    if current_layout != layout {
                        layout = current_layout;
                        let width = state.width.max(273.0);
                        let height = if state.expanded || state.stack {
                            state.height.max(band_height)
                        } else {
                            band_height.max(18.0)
                        };
                        let _ = window.set_size(tauri::LogicalSize::new(width, height));
                        let _ = platform::configure(&window, state.pinned, width, height);
                        let _ = position_notch(&window);
                        if let Some(panel) = handle.get_webview_window("panel") {
                            if panel.is_visible().unwrap_or(false) {
                                let _ = fit_panel(&panel, &settings, false);
                            }
                        }
                    }
                    // Panel layout must recover even when the optional notch is hidden.
                    if !should_show {
                        continue;
                    }
                    if state.expanded {
                        other_since = None;
                        continue;
                    }
                    let Ok(pointer) = window.cursor_position() else {
                        continue;
                    };
                    let target = monitors.iter().find(|monitor| {
                        let position = monitor.position();
                        let size = monitor.size();
                        pointer.x >= position.x as f64
                            && pointer.x < position.x as f64 + size.width as f64
                            && pointer.y >= position.y as f64
                            && pointer.y < position.y as f64 + size.height as f64
                    });
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
                        let width =
                            (state.width.max(273.0) * monitor.scale_factor()).round() as i32;
                        let layout = notch_layout(monitor, width as u32);
                        let _ =
                            window.set_position(tauri::PhysicalPosition::new(layout.x, layout.y));
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
                let _ = window.hide();
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
        .run(context)
        .expect("TodoCue desktop host failed");
}

#[cfg(test)]
mod tests {
    use super::*;
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
