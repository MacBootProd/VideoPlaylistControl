use tauri::{Manager, Emitter};
use std::process::{Command, Child};
use std::sync::Mutex;
use std::io::{BufRead, BufReader, Write};
use std::thread;
use std::time::Duration;
use serde_json::Value;

#[cfg(target_os = "windows")]
use std::fs::OpenOptions;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const PIPE_PATH: &str = "\\\\.\\pipe\\vpc_mpv_pipe";
#[cfg(not(target_os = "windows"))]
const PIPE_PATH: &str = "/tmp/vpc_mpv_pipe";

struct AppState {
    mpv_child: Option<Child>,
    logs: Vec<String>,
}

use std::fs;
use std::path::PathBuf;

// Settings file path
fn get_settings_path() -> Option<PathBuf> {
    dirs::config_dir().map(|config_dir| {
        let vpc_dir = config_dir.join("VideoPlaylistControl");
        let _ = fs::create_dir_all(&vpc_dir);
        vpc_dir.join("vpc-settings.json")
    })
}

#[tauri::command]
fn load_settings() -> String {
    if let Some(path) = get_settings_path() {
        if path.exists() {
            if let Ok(contents) = fs::read_to_string(path) {
                return contents;
            }
        }
    }
    "{}".to_string()
}

#[tauri::command]
fn save_settings(content: String) {
    if let Some(path) = get_settings_path() {
        let _ = fs::write(path, content);
    }
}

// Get logs history
#[tauri::command]
fn get_all_logs(state: tauri::State<Mutex<AppState>>) -> Vec<String> {
    let app_state = state.lock().unwrap();
    app_state.logs.clone()
}

// Send log from JS to Rust
#[tauri::command]
fn write_log(app: tauri::AppHandle, state: tauri::State<Mutex<AppState>>, message: String) {
    let mut app_state = state.lock().unwrap();
    app_state.logs.push(message.clone());
    let _ = app.emit("new-log", message);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // --- NETTOYAGE CleanUp for macOS at launch ---
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-f", "vpc_mpv_pipe"])
            .spawn();
        let _ = std::fs::remove_file(PIPE_PATH);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(AppState { mpv_child: None, logs: Vec::new() }))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "logs" {
                    let _ = window.hide();
                    api.prevent_close();
                } else if window.label() == "main" {
                    // On demande poliment à MPV de quitter via le tuyau
                    #[cfg(target_os = "windows")]
                    {
                        if let Ok(mut file) = OpenOptions::new().write(true).open(PIPE_PATH) {
                            let _ = file.write_all(b"{\"command\": [\"quit\"]}\n");
                        }
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        use std::os::unix::net::UnixStream;
                        use std::io::Write;
                        if let Ok(mut stream) = UnixStream::connect(PIPE_PATH) {
                            let _ = stream.write_all(b"{\"command\": [\"quit\"]}\n");
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            toggle_viewer_window, 
            pick_video_files, 
            toggle_regie_fullscreen,
            toggle_logs,
            get_all_logs,
            write_log,
            mpv_command,
            get_black_screen_path,
            get_video_metadata,
            open_external_link,
            load_settings,
            save_settings,
            perform_mpv_cut,
            save_playlist,
            load_playlist
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // When app close
            if let tauri::RunEvent::Exit = event {
                #[cfg(target_os = "macos")]
                {
                    use std::os::unix::net::UnixStream;
                    use std::io::Write;
                    
                    // 1. Quit mpv
                    if let Ok(mut stream) = UnixStream::connect(PIPE_PATH) {
                        let _ = stream.write_all(b"{\"command\": [\"quit\"]}\n");
                    }
                    
                    // 2. Delay 300ms to let MPV save state and close its window
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    
                    // 3. MPV close windows signal (SIGTERM = 15)
                    let _ = std::process::Command::new("pkill")
                        .args(["-15", "-f", "vpc_mpv_pipe"])
                        .spawn();
                        
                    // 4. Clear socket file
                    let _ = std::fs::remove_file(PIPE_PATH);
                }
            }
        });
}

#[tauri::command]
fn mpv_command(state: tauri::State<Mutex<AppState>>, command: String) {
    let app_state = state.lock().unwrap();
    if app_state.mpv_child.is_some() {
        let json_cmd = format!("{}\n", command);
        
        #[cfg(target_os = "windows")]
        {
            if let Ok(mut file) = OpenOptions::new().write(true).open(PIPE_PATH) {
                let _ = file.write_all(json_cmd.as_bytes());
            }
        }
        
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::net::UnixStream;
            if let Ok(mut stream) = UnixStream::connect(PIPE_PATH) {
                let _ = stream.write_all(json_cmd.as_bytes());
            }
        }
    }
}

#[tauri::command]
fn toggle_viewer_window(app: tauri::AppHandle, state: tauri::State<Mutex<AppState>>, program_path: String, start_time: f64, is_paused: bool) -> u8 {
    let mut app_state = state.lock().unwrap();

    if app_state.mpv_child.is_some() {
        return 2; 
    }

    // --- VIEWER SETTINGS VIEWER ---
    let settings_json = load_settings();
    let settings: Value = serde_json::from_str(&settings_json).unwrap_or(Value::Object(serde_json::Map::new()));

    let img_duration = settings["image_display_duration"].as_f64().unwrap_or(5.0);
    
    let viewer_screen = settings["viewer_screen"].as_str().unwrap_or("extended");
    let viewer_mode = settings["viewer_mode"].as_str().unwrap_or("fullscreen");
    
    // --- Screen disply logic ---
    let target_screen_index = if let Some(main_window) = app.get_webview_window("main") {
        let monitors = main_window.available_monitors().unwrap_or_default();
        let current_monitor = main_window.current_monitor().ok().flatten();
        let current_pos = current_monitor.map(|cm| *cm.position());
        
        let current_screen_index = if let Some(pos) = current_pos {
            monitors.iter().position(|m| *m.position() == pos).unwrap_or(0)
        } else {
            0
        };

        if viewer_screen == "same" {
            current_screen_index
        } else {
            if monitors.len() > 1 {
                if current_screen_index == 0 { 1 } else { 0 }
            } else {
                0
            }
        }
    } else {
        0
    };
    
    let screen_id = target_screen_index.to_string();

    // --- PATH MPV (DEV + PROD + MACOS .APP) ---
    let mpv_exe_name = if cfg!(target_os = "windows") { "mpv.exe" } else { "mpv" };
    
    // 1. PROD Directory
    let prod_mpv_dir = std::env::current_exe()
        .ok()
        .and_then(|exe_path| exe_path.parent().map(|p| p.to_path_buf()))
        .map(|parent_dir| parent_dir.join("mpv"));

    // 2. DEV Directory
    let dev_mpv_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("mpv");

    // 3. CHOOSE Directory
    let mpv_dir = if let Some(dir) = &prod_mpv_dir {
        // Sur Mac, on vérifie si mpv.app ou le binaire mpv existe
        #[cfg(target_os = "macos")]
        {
            if dir.join("mpv.app/Contents/MacOS/mpv").exists() || dir.join("mpv").exists() {
                dir.clone()
            } else {
                dev_mpv_dir
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            if dir.join(mpv_exe_name).exists() {
                dir.clone()
            } else {
                dev_mpv_dir
            }
        }
    } else {
        dev_mpv_dir
    };
    
    // 4. MPV path, also for macOS
    let mpv_exe_path = if cfg!(target_os = "macos") {
        let app_path = mpv_dir.join("mpv.app/Contents/MacOS/mpv");
        let raw_path = mpv_dir.join("mpv");
        if app_path.exists() {
            app_path
        } else if raw_path.exists() {
            raw_path
        } else {
            raw_path // Retourne le chemin brut pour que le message d'erreur soit logique
        }
    } else {
        mpv_dir.join(mpv_exe_name)
    };

    // 5. Check
    if !mpv_exe_path.exists() {
        let error_msg = format!("[FATAL] MPV executable not found at: {}", mpv_exe_path.display());
        eprintln!("{}", error_msg);
        
        app_state.logs.push(error_msg.clone());
        let _ = app.emit("new-log", error_msg.clone());
        
        if let Some(log_window) = app.get_webview_window("logs") {
            let _ = log_window.show();
            let _ = log_window.set_focus();
        }
        
        if let Some(exe) = std::env::current_exe().ok().and_then(|p| p.parent().map(|par| par.to_path_buf())) {
            let _ = std::fs::write(exe.join("vpc_error.log"), &error_msg);
        }
        return 0; 
    }

    // --- MPV ARGUMENTS ---
    let mut args: Vec<String> = vec![
        "--script-opts=osc-idlescreen=no".to_string(),
        "--idle=yes".to_string(),
        "--force-window=yes".to_string(),
        "--no-terminal".to_string(),
        "--keep-open=yes".to_string(),
        "--hwdec=auto".to_string(),
        "--profile=fast".to_string(),
        "--sub-visibility=yes".to_string(),
        "--volume=100".to_string(),
        "--volume-max=200".to_string(),
        format!("--image-display-duration={}", img_duration),
        "--title=${media-title}".to_string(),
        format!("--input-ipc-server={}", PIPE_PATH),
        format!("--screen={}", screen_id),
    ];
    
    if viewer_mode == "fullscreen" {
        args.push("--fullscreen".to_string());
    }

// --- LAUNCH MPV ---
    let mut command = Command::new(&mpv_exe_path);
    command.current_dir(&mpv_dir);
    command.args(&args);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match command.spawn() {
        Ok(child) => {
            app_state.mpv_child = Some(child);
            let _ = app.emit("viewer-visibility", false);
            
            let app_handle = app.clone();
            let path_to_load = program_path.clone();
            
            thread::spawn(move || {
                use std::io::Write;

                // Connexion to IPC pipe
                #[cfg(target_os = "windows")]
                let reader_opt = {
                    let mut file_opt = None;
                    for _ in 0..100 {
                        if let Ok(f) = OpenOptions::new().read(true).write(true).open(PIPE_PATH) {
                            file_opt = Some(f);
                            break;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    file_opt.map(BufReader::new)
                };

                #[cfg(not(target_os = "windows"))]
                let reader_opt = {
                    use std::os::unix::net::UnixStream;
                    let mut stream_opt = None;
                    for _ in 0..100 {
                        if let Ok(s) = UnixStream::connect(PIPE_PATH) {
                            stream_opt = Some(s);
                            break;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    stream_opt.map(BufReader::new)
                };

                if let Some(mut reader) = reader_opt {
                    #[cfg(target_os = "windows")]
                    let mut writer = reader.get_ref().try_clone().unwrap();
                    #[cfg(not(target_os = "windows"))]
                    let mut writer = reader.get_ref().try_clone().unwrap();

                    if !path_to_load.is_empty() {
                        let safe_path = path_to_load.replace('\\', "/");
                        let load_cmd = format!("{{\"command\": [\"loadfile\", \"{}\", \"replace\"]}}\n", safe_path);
                        let _ = writer.write_all(load_cmd.as_bytes());
                    }

                    thread::sleep(Duration::from_millis(100));

                    if start_time > 0.0 {
                        let seek_cmd = format!("{{\"command\": [\"seek\", {}, \"absolute\"]}}\n", start_time);
                        let _ = writer.write_all(seek_cmd.as_bytes());
                    }

                    let pause_cmd = format!("{{\"command\": [\"set_property\", \"pause\", {}]}}\n", is_paused);
                    let _ = writer.write_all(pause_cmd.as_bytes());

                    let _ = writer.write_all(b"{\"command\": [\"observe_property\", 1, \"time-pos\"]}\n");
                    let _ = writer.write_all(b"{\"command\": [\"observe_property\", 2, \"pause\"]}\n");
                    let _ = writer.write_all(b"{\"command\": [\"observe_property\", 3, \"eof-reached\"]}\n");
                    let _ = writer.write_all(b"{\"command\": [\"observe_property\", 4, \"duration\"]}\n");
                    
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match reader.read_line(&mut line) {
                            Ok(0) => break,
                            Ok(_) => {
                                if let Ok(json) = serde_json::from_str::<Value>(&line) {
                                    if json["event"] == "property-change" {
                                        let id = json["id"].as_i64().unwrap_or(0);
                                        let data = &json["data"];
                                        if id == 1 { if let Some(time) = data.as_f64() { let _ = app_handle.emit("mpv-time-update", time); } }
                                        else if id == 2 { if let Some(p) = data.as_bool() { let _ = app_handle.emit("mpv-pause-update", p); } }
                                        else if id == 3 { if let Some(eof) = data.as_bool() { if eof { let _ = app_handle.emit("mpv-ended", true); } } }
                                        else if id == 4 { if let Some(dur) = data.as_f64() { let _ = app_handle.emit("mpv-duration-update", dur); } }
                                    }
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
                
                let _ = app_handle.emit("viewer-visibility", false);
                let state = app_handle.state::<Mutex<AppState>>();
                let mut app_state = state.lock().unwrap();
                if let Some(mut child) = app_state.mpv_child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            });
            2
        },
        Err(e) => {
            let error_msg = format!("[FATAL] Failed to start MPV: {}", e);
            eprintln!("{}", error_msg);
            app_state.logs.push(error_msg.clone());
            let _ = app.emit("new-log", error_msg.clone());
            if let Some(log_window) = app.get_webview_window("logs") {
                let _ = log_window.show();
                let _ = log_window.set_focus();
            }
            0
        }
    }
}

#[tauri::command]
fn toggle_regie_fullscreen(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let is_fullscreen = window.is_fullscreen().unwrap_or(false);
        let _ = window.set_fullscreen(!is_fullscreen);
    }
}

#[tauri::command]
fn toggle_logs(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("logs") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
fn pick_video_files(app: tauri::AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file()
        .add_filter("Media", &["mp4", "mov", "mkv", "avi", "mxf", "m4v", "webm", "wmv", "png", "jpg", "jpeg", "bmp", "tif", "tiff", "gif", "webp", "mp3", "m4a", "wav", "aif", "aiff"])
        .pick_files(move |file_paths| {
            if let Some(paths) = file_paths {
                let path_strings: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
                let _ = app.emit("files-picked", path_strings);
            }
        });
}

#[tauri::command]
fn get_black_screen_path() -> String {
    if let Ok(exe) = std::env::current_exe() {
        let prod_path = exe.parent().unwrap().join("black.png");
        if prod_path.exists() {
            return prod_path.to_string_lossy().to_string();
        }
    }
    
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/black.png");
    if dev_path.exists() {
        return dev_path.to_string_lossy().to_string();
    }
    
    "black.png".to_string()
}

#[tauri::command]
fn get_video_metadata(app: tauri::AppHandle, state: tauri::State<Mutex<AppState>>, path: String) -> String {
    let ffprobe_name = if cfg!(target_os = "windows") { "ffprobe.exe" } else { "ffprobe" };
    
    let prod_mpv_dir = std::env::current_exe()
        .ok()
        .and_then(|exe_path| exe_path.parent().map(|p| p.to_path_buf()))
        .map(|parent_dir| parent_dir.join("mpv"));

    let dev_mpv_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("mpv");

    let mpv_dir = if let Some(dir) = &prod_mpv_dir {
        if dir.join(ffprobe_name).exists() {
            dir.clone()
        } else {
            dev_mpv_dir
        }
    } else {
        dev_mpv_dir
    };
    
    let ffprobe_path = mpv_dir.join(ffprobe_name);

    if !ffprobe_path.exists() {
        let error_msg = format!("[FATAL] ffprobe not found at: {}", ffprobe_path.display());
        eprintln!("{}", error_msg);
        {
            let mut app_state = state.lock().unwrap();
            app_state.logs.push(error_msg.clone());
        }
        let _ = app.emit("new-log", error_msg.clone());
        if let Some(log_window) = app.get_webview_window("logs") {
            let _ = log_window.show();
            let _ = log_window.set_focus();
        }
        return "{}".to_string();
    }

    let mut command = Command::new(&ffprobe_path);
    
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    {
        let mut app_state = state.lock().unwrap();
        app_state.logs.push(format!("[INFO] Analyzing video: {}", path));
    }
    let _ = app.emit("new-log", format!("[INFO] Analyzing video: {}", path));

    match command.args([
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,codec_name,color_transfer,color_primaries",
        "-show_entries", "format=duration",
        "-of", "json",
        &path
    ]).output() {
        Ok(o) => {
            if o.status.success() {
                let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                {
                    let mut app_state = state.lock().unwrap();
                    app_state.logs.push(format!("[INFO] ffprobe success for: {}", path));
                }
                let _ = app.emit("new-log", format!("[INFO] ffprobe success for: {}", path));
                return stdout;
            } else {
                let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                let error_msg = format!("[ERROR] ffprobe failed for {}: {}", path, stderr);
                {
                    let mut app_state = state.lock().unwrap();
                    app_state.logs.push(error_msg.clone());
                }
                let _ = app.emit("new-log", error_msg.clone());
                return "{}".to_string();
            }
        },
        Err(e) => {
            let error_msg = format!("[FATAL] Failed to execute ffprobe: {}", e);
            {
                let mut app_state = state.lock().unwrap();
                app_state.logs.push(error_msg.clone());
            }
            let _ = app.emit("new-log", error_msg.clone());
            "{}".to_string()
        }
    }
}

#[tauri::command]
fn save_playlist(app: tauri::AppHandle, content: String, title: String) {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file()
        .set_title(title)
        .add_filter("VPC Playlist", &["json"])
        .set_file_name("vpc_playlist.json")
        .save_file(move |file_path| {
            if let Some(path) = file_path {
                let path_str = path.to_string();
                let final_path = if path_str.ends_with(".json") { path_str } else { format!("{}.json", path_str) };
                let _ = std::fs::write(final_path, content);
            }
        });
}

#[tauri::command]
fn load_playlist(app: tauri::AppHandle, title: String) {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file()
        .set_title(title)
        .add_filter("VPC Playlist", &["json"])
        .pick_file(move |file_path| {
            if let Some(path) = file_path {
                let path_str = path.to_string();
                if let Ok(content) = std::fs::read_to_string(path_str) {
                    let _ = app.emit("playlist-loaded", content);
                }
            }
        });
}

#[tauri::command]
fn open_external_link(url: String) {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .ok();
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&url).spawn().ok();
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&url).spawn().ok();
    }
}

#[tauri::command]
fn perform_mpv_cut(app: tauri::AppHandle, program_path: String, start_time: f64, volume: f64, is_muted: bool, loop_a: f64, loop_b: f64, is_looping: bool) {
    let mut cmds = Vec::new();
    
    if start_time > 0.0 {
        let opts = serde_json::json!({ "start": start_time.to_string() });
        cmds.push(serde_json::json!({
            "command": ["loadfile", program_path, "replace", 0, opts]
        }).to_string());
    } else {
        cmds.push(serde_json::json!({
            "command": ["loadfile", program_path, "replace"]
        }).to_string());
    }
    
    if is_looping {
        cmds.push(serde_json::json!({"command": ["set_property", "ab-loop-a", loop_a]}).to_string());
        cmds.push(serde_json::json!({"command": ["set_property", "ab-loop-b", loop_b]}).to_string());
        cmds.push(serde_json::json!({"command": ["set_property", "demuxer-readahead-secs", 30]}).to_string());
    } else {
        cmds.push(serde_json::json!({"command": ["set_property", "ab-loop-a", "no"]}).to_string());
        cmds.push(serde_json::json!({"command": ["set_property", "ab-loop-b", "no"]}).to_string());
    }

    cmds.push(serde_json::json!({"command": ["set_property", "volume", volume]}).to_string());
    cmds.push(serde_json::json!({"command": ["set_property", "mute", is_muted]}).to_string());
    cmds.push(serde_json::json!({"command": ["set_property", "pause", false]}).to_string());
    
    let batch = cmds.join("\n") + "\n";
    
    let app_clone = app.clone();
    
    // read & write in separate thread
    std::thread::spawn(move || {
        #[cfg(target_os = "windows")]
        {
            use std::fs::OpenOptions;
            use std::io::{Write, Read};
            if let Ok(mut file) = OpenOptions::new().read(true).write(true).open(PIPE_PATH) {
                let _ = file.write_all(batch.as_bytes());
                
                // MPV response: listen
                let mut buf = [0; 4096];
                if let Ok(n) = file.read(&mut buf) {
                    if n > 0 {
                        let response = String::from_utf8_lossy(&buf[..n]).to_string();
                        let log_msg = format!("[MPV RESPONSE] {}", response);
                        if let Some(state) = app_clone.try_state::<Mutex<AppState>>() {
                            if let Ok(mut s) = state.lock() { s.logs.push(log_msg.clone()); }
                        }
                        let _ = app_clone.emit("new-log", log_msg);
                    } else {
                        let _ = app_clone.emit("new-log", "[MPV ERROR] Aucune réponse de MPV (Windows)".to_string());
                    }
                }
            } else {
                let _ = app_clone.emit("new-log", "[MPV ERROR] Impossible de se connecter au tuyau IPC (Windows)".to_string());
            }
        }
        
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::net::UnixStream;
            use std::io::{Write, Read};
            if let Ok(mut stream) = UnixStream::connect(PIPE_PATH) {
                // On dit à Rust d'abandonner la lecture après 500ms si MPV ne répond pas
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
                
                let _ = stream.write_all(batch.as_bytes());
                
                let mut response = String::new();
                let mut buf = [0; 4096];
                
                // MPV response: read
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 { break; }
                    response.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if response.lines().filter(|l| l.trim().starts_with('{')).count() >= cmds.len() {
                        break;
                    }
                }
                
                if !response.is_empty() {
                    let log_msg = format!("[MPV RESPONSE] {}", response);
                    if let Some(state) = app_clone.try_state::<Mutex<AppState>>() {
                        if let Ok(mut s) = state.lock() { s.logs.push(log_msg.clone()); }
                    }
                    let _ = app_clone.emit("new-log", log_msg);
                } else {
                    let _ = app_clone.emit("new-log", "[MPV WARNING] Aucune réponse reçue de MPV (Mac)".to_string());
                }
            } else {
                let _ = app_clone.emit("new-log", "[MPV ERROR] Impossible de se connecter au tuyau IPC (Mac)".to_string());
            }
        }
    });
}