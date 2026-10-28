fn main() {
    // 웹앱(GitHub Pages, 원격 주소)이 부를 수 있는 앱 명령 — 원격 화면은 capabilities 에 허락한 명령만 부를 수 있다
    //   download : 사진 · 파일을 '다운로드' 폴더에 바로 저장 (브라우저로 넘기지 않고)
    //   idle     : 컴퓨터를 마지막으로 만진 뒤 지난 초 (PC 를 쓰는 동안 휴대폰 알림을 쉬게)
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["download", "idle"])),
    )
    .expect("tauri-build 실패");
}
