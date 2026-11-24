use super::get_server_device;
use adb_client::{ADBListItem, ADBListItemType, ADBServerDevice};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum DownloadDestination {
    File { path: PathBuf },
    Directory { path: PathBuf, name: String },
}

impl DownloadDestination {
    fn into_path(self) -> Result<(PathBuf, bool), String> {
        match self {
            Self::File { path } => Ok((path, true)),
            Self::Directory { path, name } => Ok((local_child(&path, &name)?, false)),
        }
    }
}

fn local_child(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(part)) if part == name)
        || components.next().is_some()
        || (cfg!(windows) && (name.contains([':', '\\']) || name.ends_with(['.', ' '])))
    {
        return Err(format!("Invalid local filename: {name}"));
    }
    Ok(parent.join(name))
}

struct DownloadProgress {
    channel: Channel<u64>,
    bytes: u64,
    last_update: Instant,
}

impl DownloadProgress {
    fn new(channel: Channel<u64>) -> Self {
        Self {
            channel,
            bytes: 0,
            last_update: Instant::now(),
        }
    }
}

struct DownloadWriter<'a> {
    file: &'a mut std::fs::File,
    progress: &'a mut DownloadProgress,
}

impl Write for DownloadWriter<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let written = self.file.write(data)?;
        self.progress.bytes += written as u64;
        if self.progress.last_update.elapsed() >= Duration::from_millis(100) {
            self.progress.last_update = Instant::now();
            let _ = self.progress.channel.send(self.progress.bytes);
        }
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

fn save_download(
    destination: DownloadDestination,
    progress: &mut DownloadProgress,
    receive: impl FnOnce(&mut dyn Write) -> Result<(), String>,
) -> Result<(), String> {
    let (path, replace) = destination.into_path()?;
    let parent = path
        .parent()
        .filter(|_| path.is_absolute())
        .ok_or("Expected an absolute output path")?;
    let mut file = tempfile::Builder::new()
        .prefix(".openix-download-")
        .tempfile_in(parent)
        .map_err(|error| error.to_string())?;
    receive(&mut DownloadWriter {
        file: file.as_file_mut(),
        progress,
    })?;
    if replace {
        file.persist(path).map_err(|error| error.to_string())?;
    } else {
        file.persist_noclobber(path)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn adb_download_file(
    serial: String,
    remote_path: String,
    destination: DownloadDestination,
    progress: Channel<u64>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut device = get_server_device(&serial)?;
        let mut progress = DownloadProgress::new(progress);
        save_download(destination, &mut progress, |writer| {
            device
                .pull(&remote_path, writer)
                .map_err(|error| error.to_string())
        })?;
        Ok(progress.bytes)
    })
    .await
    .map_err(|error| error.to_string())?
}

trait DirectorySource {
    fn entries(&mut self, path: &str) -> Result<Vec<ADBListItem>, String>;
    fn receive(&mut self, path: &str, writer: &mut dyn Write) -> Result<(), String>;
}

impl DirectorySource for ADBServerDevice {
    fn entries(&mut self, path: &str) -> Result<Vec<ADBListItem>, String> {
        let entries = self.list(path).map_err(|error| error.to_string())?;
        if entries.is_empty() {
            let dot = self
                .stat(format!("{}/.", path.trim_end_matches('/')))
                .map_err(|error| error.to_string())?;
            if dot.file_perm & 0o170000 != 0o040000 {
                return Err("Cannot read remote directory".into());
            }
        }
        Ok(entries)
    }

    fn receive(&mut self, path: &str, writer: &mut dyn Write) -> Result<(), String> {
        self.pull(&path, writer).map_err(|error| error.to_string())
    }
}

#[derive(Serialize)]
pub(crate) struct FolderDownload {
    skipped_links: usize,
}

fn download_tree(
    source: &mut impl DirectorySource,
    remote: &str,
    target: PathBuf,
    progress: &mut DownloadProgress,
) -> Result<FolderDownload, String> {
    if !target.is_absolute() {
        return Err("Expected an absolute output path".into());
    }
    let mut folders = vec![(remote.to_owned(), target)];
    let mut skipped_links = 0;
    while let Some((remote, local)) = folders.pop() {
        let entries = source
            .entries(&remote)
            .map_err(|error| format!("{remote}: {error}"))?;
        fs::create_dir(&local).map_err(|error| format!("{}: {error}", local.display()))?;
        for entry in entries {
            if matches!(entry.name.as_str(), "." | "..") {
                continue;
            }
            let path = format!("{}/{}", remote.trim_end_matches('/'), entry.name);
            match entry.item_type {
                ADBListItemType::Directory => {
                    folders.push((path, local_child(&local, &entry.name)?))
                }
                ADBListItemType::File => {
                    let destination = DownloadDestination::Directory {
                        path: local.clone(),
                        name: entry.name,
                    };
                    save_download(destination, progress, |writer| {
                        source.receive(&path, writer)
                    })
                    .map_err(|error| format!("{path}: {error}"))?;
                }
                ADBListItemType::Symlink => skipped_links += 1,
            }
        }
    }
    Ok(FolderDownload { skipped_links })
}

#[tauri::command]
pub(crate) async fn adb_download_directory(
    serial: String,
    remote_path: String,
    local_directory: PathBuf,
    name: String,
    progress: Channel<u64>,
) -> Result<FolderDownload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = local_child(&local_directory, &name)?;
        let mut device = get_server_device(&serial)?;
        let mode = device
            .stat(&remote_path)
            .map_err(|error| error.to_string())?
            .file_perm;
        if mode & 0o170000 != 0o040000 {
            return Err(format!("{remote_path}: expected a directory"));
        }
        download_tree(
            &mut device,
            &remote_path,
            target,
            &mut DownloadProgress::new(progress),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixtureDirectory;

    impl DirectorySource for FixtureDirectory {
        fn entries(&mut self, path: &str) -> Result<Vec<ADBListItem>, String> {
            use ADBListItemType::{Directory, File, Symlink};
            let children = match path {
                "/logs" => vec![
                    (".", Directory),
                    ("empty", Directory),
                    ("nested", Directory),
                    ("root.log", File),
                    ("linked", Symlink),
                ],
                "/logs/nested" => vec![("debug.log", File)],
                "/logs/empty" => vec![],
                _ => return Err(format!("Unexpected directory {path}")),
            };
            Ok(children
                .into_iter()
                .map(|(name, item_type)| ADBListItem {
                    name: name.to_owned(),
                    item_type,
                    time: 0,
                    permissions: 0,
                    size: 0,
                })
                .collect())
        }

        fn receive(&mut self, path: &str, writer: &mut dyn Write) -> Result<(), String> {
            writer
                .write_all(path.as_bytes())
                .map_err(|error| error.to_string())
        }
    }

    #[test]
    fn downloads_nested_files_and_empty_folders_without_following_links() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("logs");
        let mut progress = DownloadProgress::new(Channel::new(|_| Ok(())));
        let result = download_tree(
            &mut FixtureDirectory,
            "/logs",
            target.clone(),
            &mut progress,
        )
        .unwrap();
        assert_eq!(result.skipped_links, 1);
        assert!(target.join("empty").is_dir());
        assert_eq!(
            fs::read(target.join("nested/debug.log")).unwrap(),
            b"/logs/nested/debug.log"
        );
        assert_eq!(
            fs::read(target.join("root.log")).unwrap(),
            b"/logs/root.log"
        );
        assert!(!target.join("linked").exists());
        assert_eq!(
            progress.bytes,
            ("/logs/nested/debug.log".len() + "/logs/root.log".len()) as u64
        );
        assert!(download_tree(
            &mut FixtureDirectory,
            "/logs",
            target.clone(),
            &mut progress
        )
        .is_err());
        assert_eq!(
            fs::read(target.join("root.log")).unwrap(),
            b"/logs/root.log"
        );
    }

    #[test]
    fn failed_transfer_preserves_original_and_cleans_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.log");
        std::fs::write(&path, b"original").unwrap();
        let result = save_download(
            DownloadDestination::File { path: path.clone() },
            &mut DownloadProgress::new(Channel::new(|_| Ok(()))),
            |writer| {
                writer.write_all(b"partial").unwrap();
                Err("disconnected".into())
            },
        );
        assert_eq!(result.unwrap_err(), "disconnected");
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn successful_batch_counts_bytes_and_rejects_a_duplicate_filename() {
        let dir = tempfile::tempdir().unwrap();
        let destination = || DownloadDestination::Directory {
            path: dir.path().to_owned(),
            name: "device.log".into(),
        };
        let write = |data: &[u8]| {
            let mut progress = DownloadProgress::new(Channel::new(|_| Ok(())));
            save_download(destination(), &mut progress, |writer| {
                writer.write_all(data).map_err(|error| error.to_string())
            })
            .map(|()| progress.bytes)
        };
        assert_eq!(write(b"new data").unwrap(), 8);
        assert!(write(b"overwritten").is_err());
        assert_eq!(
            std::fs::read(dir.path().join("device.log")).unwrap(),
            b"new data"
        );
    }
}
