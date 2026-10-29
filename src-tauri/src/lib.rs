use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::{fs, path::{Path, PathBuf}, process::Command, sync::Mutex};
use sysinfo::{Disks, Gpus, Networks, System};
use tauri::Manager;

#[derive(Serialize)]
struct DashboardData {
    items: serde_json::Value,
    background: Option<String>,
}

struct SystemMonitor {
    system: System,
    disks: Disks,
    networks: Networks,
    gpus: Option<Gpus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuStats { name: String, usage: Option<f32>, used_memory: Option<u64>, total_memory: Option<u64> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkStats { interface: String, ip: String, mac: String, received_per_second: u64, transmitted_per_second: u64, total_received: u64, total_transmitted: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemStats {
    cpu_usage: f32,
    cpu_name: String,
    memory_used: u64,
    memory_total: u64,
    swap_used: u64,
    swap_total: u64,
    disk_used: u64,
    disk_total: u64,
    gpu: Option<GpuStats>,
    network: Option<NetworkStats>,
    operating_system: String,
}

impl SystemMonitor {
    fn new() -> Result<Self, String> {
        Ok(Self {
            system: System::new_all().map_err(|error| error.to_string())?,
            disks: Disks::new_with_refreshed_list().map_err(|error| error.to_string())?,
            networks: Networks::new_with_refreshed_list().map_err(|error| error.to_string())?,
            gpus: Gpus::new_with_refreshed_list().ok(),
        })
    }

    fn snapshot(&mut self) -> SystemStats {
        self.system.refresh_cpu_all();
        self.system.refresh_memory();
        self.disks.refresh(true);
        self.networks.refresh(true);
        if let Some(gpus) = &mut self.gpus { gpus.refresh(true); }

        let disk_total = self.disks.iter().map(|disk| disk.total_space()).sum::<u64>();
        let disk_available = self.disks.iter().map(|disk| disk.available_space()).sum::<u64>();
        let gpu = self.gpus.as_ref().and_then(|gpus| gpus.first()).map(|gpu| GpuStats {
            name: gpu.model().or_else(|| gpu.vendor()).unwrap_or("GPU").to_owned(),
            usage: gpu.usage(),
            used_memory: gpu.used_memory(),
            total_memory: gpu.total_memory(),
        });
        let network = self.networks.iter()
            .filter(|(name, data)| {
                let name = name.to_string_lossy().to_ascii_lowercase();
                !matches!(name.as_str(), "lo" | "lo0") && data.ip_networks().iter().any(|ip| !ip.addr.is_loopback())
            })
            .max_by_key(|(_, data)| data.received() + data.transmitted())
            .map(|(name, data)| NetworkStats {
                interface: name.to_string_lossy().into_owned(),
                ip: data.ip_networks().iter().find(|ip| !ip.addr.is_loopback()).map(ToString::to_string).unwrap_or_default(),
                mac: data.mac_address().to_string(),
                received_per_second: data.received(),
                transmitted_per_second: data.transmitted(),
                total_received: data.total_received(),
                total_transmitted: data.total_transmitted(),
            });

        SystemStats {
            cpu_usage: self.system.global_cpu_usage(),
            cpu_name: self.system.cpus().first().map(|cpu| cpu.brand().to_owned()).unwrap_or_else(|| "CPU".into()),
            memory_used: self.system.used_memory(),
            memory_total: self.system.total_memory(),
            swap_used: self.system.used_swap(),
            swap_total: self.system.total_swap(),
            disk_used: disk_total.saturating_sub(disk_available),
            disk_total,
            gpu,
            network,
            operating_system: System::long_os_version().unwrap_or_else(|_| std::env::consts::OS.into()),
        }
    }
}

fn data_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("dashboard.json"))
}

#[tauri::command]
fn load_dashboard(app: tauri::AppHandle) -> Result<DashboardData, String> {
    let path = data_path(&app)?;
    if !path.exists() {
        return Ok(DashboardData { items: serde_json::json!([]), background: None });
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(DashboardData {
        items: value.get("items").cloned().unwrap_or_else(|| serde_json::json!([])),
        background: value.get("background").and_then(|v| v.as_str()).map(str::to_owned),
    })
}

#[tauri::command]
fn save_dashboard(app: tauri::AppHandle, items: serde_json::Value, background: Option<String>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({"items": items, "background": background}))
        .map_err(|e| e.to_string())?;
    fs::write(data_path(&app)?, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn launch_application(target: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = Command::new("cmd").args(["/C", "start", "", &target]).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&target).spawn();
    #[cfg(target_os = "linux")]
    let result = Command::new("xdg-open").arg(&target).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_local_image(path: String) -> Result<String, String> {
    let path = Path::new(&path);
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return Err("Formato immagine non supportato".into()),
    };
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > 30 * 1024 * 1024 {
        return Err("L'immagine supera il limite di 30 MB".into());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
fn get_system_stats(monitor: tauri::State<'_, Mutex<SystemMonitor>>) -> Result<SystemStats, String> {
    monitor.lock().map_err(|_| "Monitor di sistema non disponibile".to_owned()).map(|mut monitor| monitor.snapshot())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let monitor = SystemMonitor::new().expect("impossibile inizializzare il monitor di sistema");
    tauri::Builder::default()
        .manage(Mutex::new(monitor))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![load_dashboard, save_dashboard, launch_application, read_local_image, get_system_stats])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio di Lucifer Dashboard");
}
