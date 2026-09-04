use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

pub struct Sidecar(pub Mutex<Option<CommandChild>>);

fn data_dir() -> PathBuf {
    for k in ["OWN_API_DATA_DIR", "LLM_DATA_DIR"] {
        if let Some(v) = std::env::var_os(k) {
            if !v.is_empty() {
                return PathBuf::from(v);
            }
        }
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .unwrap_or_else(|| ".".into());
    PathBuf::from(home).join(".own-api")
}

fn read_session() -> Option<(u16, String)> {
    let raw = fs::read_to_string(data_dir().join("last-session.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let port = v.get("port")?.as_u64()? as u16;
    let token = v.get("token")?.as_str()?.to_string();
    Some((port, token))
}

fn healthy(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 无 AppHandle 依赖的系统级动作（可安全离开主线程）
fn open_url(url: &str) {
    #[cfg(target_os = "macos")]
    let _ = StdCommand::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let _ = StdCommand::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let _ = StdCommand::new("xdg-open").arg(url).spawn();
}

fn open_path(path: &str) {
    #[cfg(target_os = "macos")]
    let _ = StdCommand::new("open").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let _ = StdCommand::new("explorer").arg(path).spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let _ = StdCommand::new("xdg-open").arg(path).spawn();
}

/// 服务已就绪就开控制台，返回是否成功
fn open_console_now() -> Result<(), String> {
    let (port, token) = read_session().ok_or_else(|| "no session".to_string())?;
    if !healthy(port) {
        return Err(format!("port {port} down"));
    }
    open_url(&format!("http://127.0.0.1:{}/#token={}", port, urlencode(&token)));
    Ok(())
}

/// 主线程调用：健康则直接开；否则拉侧车并交给无状态线程等待就绪后开浏览器
fn ensure_running<R: Runtime>(app: &AppHandle<R>) {
    if open_console_now().is_ok() {
        return;
    }
    let sidecar = app
        .shell()
        .sidecar("own-api")
        .and_then(|c| c.env("OWN_API_PPID", std::process::id().to_string()).spawn());
    match sidecar {
        Ok((_rx, child)) => {
            *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
        }
        Err(e) => {
            eprintln!("[own-api] 侧车启动失败：{e}");
            return;
        }
    }
    std::thread::spawn(|| {
        for _ in 0..120 {
            std::thread::sleep(Duration::from_millis(250));
            if open_console_now().is_ok() {
                return;
            }
        }
        eprintln!("[own-api] 30 秒内服务未就绪");
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            ensure_running(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open_item = MenuItem::with_id(app, "open", "打开控制台", true, None::<&str>)?;
            let data_item = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart_item = MenuItem::with_id(
                app,
                "autostart",
                if autostart_on { "停用开机自动启动" } else { "开机自动启动" },
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 own-api", true, None::<&str>)?;
            let menu = MenuBuilder::new(app)
                .item(&open_item)
                .item(&data_item)
                .item(&PredefinedMenuItem::separator(app)?)
                .item(&autostart_item)
                .item(&PredefinedMenuItem::separator(app)?)
                .item(&quit_item)
                .build()?;
            // 注意：回调须 Send+Sync——只准吃参数、禁止捕获非 Send 句柄（macOS tao 内部是 Rc）
            let _ = &menu;
            TrayIconBuilder::with_id("tray")
                .menu(&menu)
                .menu_on_left_click(true)
                .tooltip("own-api · 个人 LLM 网关")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => ensure_running(app),
                    "data" => open_path(&data_dir().to_string_lossy()),
                    "autostart" => {
                        let now = !app.autolaunch().is_enabled().unwrap_or(false);
                        if now {
                            let _ = app.autolaunch().enable();
                        } else {
                            let _ = app.autolaunch().disable();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            // 首启/开机自启：拉起服务并自动开一次控制台（双击即用的最后一步）
            ensure_running(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("own-api 桌面壳构建失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
