mod liveview;
mod luna;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_process::init())
    .manage(luna::LunaState::default())
    .manage(liveview::LiveViewState::default())
    .invoke_handler(tauri::generate_handler![
      luna::luna_connect,
      luna::luna_disconnect,
      luna::luna_status,
      luna::luna_delete_files,
      luna::luna_command,
      luna::luna_transfer_started,
      luna::luna_transfer_finished,
      liveview::luna_liveview_start,
      liveview::luna_liveview_stop,
      liveview::luna_liveview_stats,
    ])
    .setup(|app| {
      // Auto-updater (desktop only)
      #[cfg(desktop)]
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
