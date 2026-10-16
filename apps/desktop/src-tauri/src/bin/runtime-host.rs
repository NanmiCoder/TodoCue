#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(windows)]
#[path = "../windows_home.rs"]
mod windows_home;
#[cfg(windows)]
fn main() {
    use serde::Deserialize;
    use std::{
        fs,
        os::windows::{io::AsRawHandle, process::CommandExt},
        process::{Command, Stdio},
        time::Duration,
    };
    use windows::{
        core::HSTRING,
        Win32::{
            Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE},
            System::{JobObjects::*, Threading::CreateMutexW},
        },
    };
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Spec {
        home: String,
        node_path: String,
        cli_entry: String,
        notifier_path: String,
        port: Option<u16>,
    }
    let args: Vec<_> = std::env::args().collect();
    let Some(home) = args
        .windows(2)
        .find(|pair| pair[0] == "--home")
        .map(|pair| pair[1].clone())
    else {
        std::process::exit(2);
    };
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let spec: Spec = serde_json::from_slice(&fs::read(
            std::path::Path::new(&home).join("windows-runtime.json"),
        )?)?;
        let mutex = unsafe {
            CreateMutexW(
                None,
                true,
                &HSTRING::from(format!(
                    "Local\\TodoCue-TodoCue-Runtime-{}",
                    windows_home::home_id(std::path::Path::new(&home))
                )),
            )?
        };
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                let _ = CloseHandle(mutex);
            }
            return Ok(());
        }
        struct Guard(HANDLE);
        impl Drop for Guard {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
        let _mutex = Guard(mutex);
        let job = Guard(unsafe { CreateJobObjectW(None, None)? });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )?;
        }
        fs::create_dir_all(std::path::Path::new(&home).join("logs"))?;
        loop {
            let log = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(std::path::Path::new(&home).join("logs/windows-runtime.log"))?;
            let mut command = Command::new(&spec.node_path);
            command
                .arg(&spec.cli_entry)
                .arg("--home")
                .arg(&spec.home)
                .arg("serve")
                .env("TODOCUE_NOTIFIER", &spec.notifier_path)
                .env("TODOCUE_HOME", &spec.home)
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone()?))
                .stderr(Stdio::from(log))
                .creation_flags(0x08000000);
            if let Some(port) = spec.port {
                command.arg("--port").arg(port.to_string());
            }
            let mut child = command.spawn()?;
            if unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) }.is_err() {
                let _ = child.kill();
                return Err("Could not supervise runtime process".into());
            }
            let _ = child.wait()?;
            std::thread::sleep(Duration::from_secs(3));
        }
    })();
    if result.is_err() {
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows runtime host is only available on Windows");
    std::process::exit(2);
}
