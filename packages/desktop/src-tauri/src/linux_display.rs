use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::constants::{LEGACY_SETTINGS_STORE, SETTINGS_STORE};

pub const LINUX_DISPLAY_CONFIG_KEY: &str = "linuxDisplayConfig";

#[derive(Default, Serialize, Deserialize)]
struct DisplayConfig {
    wayland: Option<bool>,
}

fn dirs() -> Option<Vec<PathBuf>> {
    let data = dirs::data_dir()?;
    Some(if cfg!(debug_assertions) {
        vec![
            data.join("ai.openfds.desktop.dev"),
            data.join("ai.opencode.desktop.dev"),
        ]
    } else {
        vec![data.join("ai.openfds.desktop"), data.join("ai.opencode.desktop")]
    })
}

fn paths() -> Option<Vec<PathBuf>> {
    dirs().map(|dirs| {
        let mut list = Vec::with_capacity(dirs.len() * 2);
        for dir in dirs {
            list.push(dir.join(SETTINGS_STORE));
            list.push(dir.join(LEGACY_SETTINGS_STORE));
        }
        list
    })
}

pub fn read_wayland() -> Option<bool> {
    for p in paths()? {
        let raw = match std::fs::read_to_string(p) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let root = match serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.get(LINUX_DISPLAY_CONFIG_KEY).cloned())
        {
            Some(root) => root,
            None => continue,
        };
        if let Some(v) = serde_json::from_value::<DisplayConfig>(root).ok().and_then(|cfg| cfg.wayland) {
            return Some(v);
        }
    }
    None
}

pub fn write_wayland(app: &AppHandle, value: bool) -> Result<(), String> {
    let store = app
        .store(SETTINGS_STORE)
        .map_err(|e| format!("Failed to open settings store: {}", e))?;

    store.set(
        LINUX_DISPLAY_CONFIG_KEY,
        json!(DisplayConfig {
            wayland: Some(value),
        }),
    );
    store
        .save()
        .map_err(|e| format!("Failed to save settings store: {}", e))?;

    Ok(())
}
