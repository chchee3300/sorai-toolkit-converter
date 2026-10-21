use tauri::{
  plugin::{Builder, TauriPlugin},
  Runtime,
};

/// Plugin name: JS calls commands as `plugin:sorai-converter|<command>`,
/// the hub grants `sorai-converter:default`.
pub const NAME: &str = "sorai-converter";

/// Liveness reply; the hub's E2E smoke test checks it end to end.
pub fn pong(value: &str) -> String {
  format!("{NAME} pong: {value}")
}

#[tauri::command]
fn ping(value: String) -> String {
  pong(&value)
}

/// Registered by the hub: `.plugin(tauri_plugin_sorai_converter::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new(NAME)
    .invoke_handler(tauri::generate_handler![ping])
    .build()
}

#[cfg(test)]
mod tests {
  #[test]
  fn pong_echoes_value_with_plugin_name() {
    assert_eq!(super::pong("hi"), "sorai-converter pong: hi");
  }
}
