// DM 본사 앱 PC · 맥 설치판.
// 화면은 GitHub Pages 의 웹앱을 그대로 연다(기능을 두 번 만들지 않으려고). 이 프로그램이 더하는 것:
//   - 창을 닫아도 꺼지지 않고 작업 표시줄 · 메뉴 막대에 남는다 (알림을 계속 받으려고)
//   - 컴퓨터를 켜면 자동 실행
//   - 하나만 실행 (두 번 열면 기존 창을 앞으로)
//   - 켤 때 새 버전이 있으면 받아서 다시 시작 (GitHub 릴리스의 latest.json)
//   - 창 크기 · 위치를 기억해 다음에 그대로 연다 (웹앱의 '작게 보기 / 크게 보기'로 바꾼 크기 포함)
//   - 채팅방을 새 창으로 여러 개 띄울 수 있다 (웹앱이 room-{방} 창을 만든다, ?solo=1#comm/{방})
// 알림 · 아이콘 숫자는 웹앱이 window.__TAURI__ 로 직접 띄운다 (index.html 의 cmDesktop*).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

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
