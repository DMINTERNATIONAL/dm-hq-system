// DM 본사 앱 PC · 맥 설치판.
// 화면은 GitHub Pages 의 웹앱을 그대로 연다(기능을 두 번 만들지 않으려고). 이 프로그램이 더하는 것:
//   - 창을 닫아도 꺼지지 않고 작업 표시줄 · 메뉴 막대에 남는다 (알림을 계속 받으려고)
//   - 컴퓨터를 켜면 자동 실행
//   - 하나만 실행 (두 번 열면 기존 창을 앞으로)
//   - 켤 때 새 버전이 있으면 받아서 다시 시작 (GitHub 릴리스의 latest.json)
//   - 창 크기 · 위치를 기억해 다음에 그대로 연다 (웹앱의 '작게 보기 / 크게 보기'로 바꾼 크기 포함)
//   - 채팅방을 새 창으로 여러 개 띄울 수 있다 (웹앱이 room-{방} 창을 만든다, ?solo=1#comm/{방})
//   - 사진 · 파일 '저장'을 다운로드 폴더에 바로 (download 명령)
//   - 파일을 창에 끌어다 놓으면 웹 화면이 받는다 (dragDropEnabled: false — 채팅방에 파일 보내기)
//   - 컴퓨터를 쓰고 있는지 (idle 명령 — 웹앱이 PC 사용 중이면 휴대폰 알림을 쉬게 한다)
// 알림 · 아이콘 숫자는 웹앱이 window.__TAURI__ 로 직접 띄운다 (index.html 의 cmDesk*).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

/// 사진 · 파일 저장: 웹앱이 받아 둔 내용과 이름(x-name, 주소 인코딩)을 넘기면
/// '다운로드' 폴더에 같은 이름이 있으면 '이름 (1).jpg' 처럼 바꿔 저장하고 저장한 경로를 돌려준다.
/// 내용은 { b64: "base64 글자" } 로 받는다 — 웹앱은 원격 주소(GitHub Pages)라 Tauri 가 바이트를 그대로 못 넘기고
/// JSON 으로 바꿔 보내서(postMessage), v0.1.4 까지 '바이트만 받기'로는 늘 실패했다. 바이트 · 숫자 배열도 받는다.
#[tauri::command]
fn download(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(v) => {
            if let Some(t) = v.get("b64").and_then(|x| x.as_str()) {
                b64_decode(t).ok_or_else(|| "파일 내용이 올바르지 않아요".to_string())?
            } else if let Some(a) = v.as_array() {
                a.iter().map(|x| x.as_u64().unwrap_or(0) as u8).collect()
            } else {
                return Err("저장할 내용이 없어요".into());
            }
        }
    };
    let raw = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("DM");
    let name = clean_name(&pct_decode(raw));
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let path = unique_path(&dir, &name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3 + 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v: u32 = match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a') as u32 + 26,
            b'0'..=b'9' => (c - b'0') as u32 + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => return None,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1u32 << bits) - 1;
        }
    }
    Some(out)
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 폴더 구분자 · 제어 문자 · 맨 앞 점을 빼고 120자로 자른다
fn clean_name(s: &str) -> String {
    let n: String = s
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .take(120)
        .collect();
    let n = n.trim().trim_start_matches('.').to_string();
    if n.is_empty() { "DM".into() } else { n }
}

fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1..1000 {
        let q = dir.join(format!("{stem} ({n}){ext}"));
        if !q.exists() {
            return q;
        }
    }
    p
}

/// 컴퓨터(키보드 · 마우스)를 마지막으로 만진 뒤 지난 초 — 다른 프로그램을 쓰는 것도 센다
#[tauri::command]
fn idle() -> f64 {
    idle_secs()
}

#[cfg(target_os = "macos")]
fn idle_secs() -> f64 {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState = 0, kCGAnyInputEventType = ~0
    unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) }
}

#[cfg(target_os = "windows")]
fn idle_secs() -> f64 {
    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }
    let mut li = LastInputInfo { cb_size: std::mem::size_of::<LastInputInfo>() as u32, dw_time: 0 };
    unsafe {
        if GetLastInputInfo(&mut li) == 0 {
            return 0.0;
        }
        GetTickCount().wrapping_sub(li.dw_time) as f64 / 1000.0
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn idle_secs() -> f64 {
    0.0
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![download, idle])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "DM 열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "DM 끝내기", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("dm")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("DM")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = e
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // 처음 한 번 '컴퓨터 켤 때 자동 실행'을 켠다. 끄고 싶으면 OS 설정에서 끄면 된다.
            {
                use tauri_plugin_autostart::ManagerExt;
                let al = app.autolaunch();
                if !al.is_enabled().unwrap_or(false) {
                    let _ = al.enable();
                }
            }

            // 새 버전 확인 → 받아서 설치 → 다시 시작
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_updater::UpdaterExt;
                if let Ok(updater) = handle.updater() {
                    if let Ok(Some(update)) = updater.check().await {
                        if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                            handle.restart();
                        }
                    }
                }
            });
            Ok(())
        })
        // 메인 창 닫기 = 숨기기 (프로그램은 계속 돌며 알림을 받는다)
        // 채팅방 새 창(room-*, 웹앱의 '새 창'으로 연 것)은 그냥 닫힌다
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                // 지금 창 크기 · 위치를 저장 (메인은 끄지 않고 숨기기만 하므로 여기서 저장해야 한다)
                use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                let _ = w.app_handle().save_window_state(StateFlags::all());
                if w.label() == "main" {
                    let _ = w.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("DM 앱을 시작하지 못했습니다");

    app.run(|_app, _event| {
        // 맥: 독(Dock) 아이콘을 누르면 숨긴 창을 다시 연다
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            show_main(_app);
        }
    });
}
