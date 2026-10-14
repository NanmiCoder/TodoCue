use std::{
    path::PathBuf,
    process::{Command, Stdio},
};
fn main() {
    let result = (|| -> Result<i32, Box<dyn std::error::Error>> {
        let executable = std::env::current_exe()?;
        let directory = executable.parent().ok_or("CLI directory unavailable")?;
        let installed = directory.join("todocue-runtime-path.txt").exists();
        let root = if installed {
            PathBuf::from(
                std::fs::read_to_string(directory.join("todocue-runtime-path.txt"))?.trim(),
            )
        } else {
            directory.join("runtime")
        };
        let node = root
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let mut command = Command::new(node);
        // The user-bin shim belongs to this home. Explicit CLI --home still wins
        // over this fallback in resolveHome, and an existing environment wins here.
        if installed && std::env::var_os("TODOCUE_HOME").is_none() {
            command.env(
                "TODOCUE_HOME",
                directory.parent().ok_or("CLI home unavailable")?,
            );
        }
        let status = command
            .arg(root.join("packages/cli/dist/index.js"))
            .args(std::env::args_os().skip(1))
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()?;
        Ok(status.code().unwrap_or(1))
    })();
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("TodoCue CLI: {error}");
            std::process::exit(1);
        }
    }
}
