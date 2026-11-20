use crate::state::AppState;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::utils::{config::BundleType, platform::bundle_type};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASE_REPO: Option<&str> = option_env!("OPENIXSUIT_RELEASE_REPO");
const TAG_PREFIX: &str = "openixsuit-ce-v";
const UPDATE_MANIFEST: &str = "openixsuit-ce-update.json";

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum UpdateCheck {
    Unconfigured,
    Unavailable,
    Current,
    Available { version: String, installable: bool },
}

#[derive(Serialize, Clone)]
pub struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

fn desktop_release(release: GithubRelease) -> Option<(Version, String)> {
    if release.draft
        || release.prerelease
        || !release
            .assets
            .iter()
            .any(|asset| asset.name == UPDATE_MANIFEST)
    {
        return None;
    }
    let version = Version::parse(release.tag_name.strip_prefix(TAG_PREFIX)?).ok()?;
    (version.pre.is_empty() && version.build.is_empty()).then_some((version, release.tag_name))
}

fn can_install(app: &AppHandle) -> bool {
    let signed = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.is_empty());

    // DEB/RPM 仍由系统包管理器安装，AppImage 由更新器替换。
    let supported_bundle = matches!(
        bundle_type(),
        Some(BundleType::AppImage | BundleType::App | BundleType::Msi | BundleType::Nsis)
    );
    signed && supported_bundle
}

#[tauri::command]
pub fn desktop_update_enabled() -> bool {
    RELEASE_REPO.is_some()
}

#[tauri::command]
pub fn desktop_open_releases(app: AppHandle) -> Result<(), String> {
    let repo = RELEASE_REPO.ok_or_else(|| "No desktop release repository configured".to_owned())?;
    app.opener()
        .open_url(format!("https://github.com/{repo}/releases"), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_check_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<UpdateCheck, String> {
    *pending.0.lock().map_err(|error| error.to_string())? = None;
    let Some(repo) = RELEASE_REPO else {
        return Ok(UpdateCheck::Unconfigured);
    };
    let client = reqwest::Client::builder()
        .user_agent("OpenixSuit-CE")
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;
    let mut page = 1;
    let (version, tag) = loop {
        let response = client
            .get(format!(
                "https://api.github.com/repos/{repo}/releases?per_page=100&page={page}"
            ))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(UpdateCheck::Unavailable);
        }
        let releases: Vec<GithubRelease> = response
            .error_for_status()
            .map_err(|error| error.to_string())?
            .json()
            .await
            .map_err(|error| error.to_string())?;
        let has_more = releases.len() == 100;
        if let Some(release) = releases
            .into_iter()
            .filter_map(desktop_release)
            .max_by(|a, b| a.0.cmp(&b.0))
        {
            break release;
        }
        if !has_more {
            return Ok(UpdateCheck::Unavailable);
        }
        page += 1;
    };
    if version <= app.package_info().version {
        return Ok(UpdateCheck::Current);
    }
    let version = version.to_string();
    if !can_install(&app) {
        return Ok(UpdateCheck::Available {
            version,
            installable: false,
        });
    }
    let endpoint = format!("https://github.com/{repo}/releases/download/{tag}/{UPDATE_MANIFEST}")
        .parse::<reqwest::Url>()
        .map_err(|error| error.to_string())?;
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.timeout(Duration::from_secs(60)).build())
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .filter(|update| update.version == version)
        .ok_or_else(|| "Desktop tag and update manifest version do not match".to_owned())?;
    *pending.0.lock().map_err(|error| error.to_string())? = Some(update);
    Ok(UpdateCheck::Available {
        version,
        installable: true,
    })
}

#[tauri::command]
pub async fn desktop_install_update(
    app: AppHandle,
    state: State<'_, AppState>,
    pending: State<'_, PendingUpdate>,
    progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    let _busy = state.try_acquire_busy("desktop-update")?;
    let update = pending
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .take()
        .ok_or_else(|| "Check for updates again before installing".to_owned())?;
    let mut downloaded = 0;
    if let Err(error) = update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.send(UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
    {
        *pending.0.lock().map_err(|error| error.to_string())? = Some(update);
        return Err(error.to_string());
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, has_manifest: bool) -> GithubRelease {
        GithubRelease {
            tag_name: tag.into(),
            draft: false,
            prerelease: false,
            assets: has_manifest
                .then(|| GithubAsset {
                    name: UPDATE_MANIFEST.into(),
                })
                .into_iter()
                .collect(),
        }
    }

    #[test]
    fn selects_only_published_desktop_releases_with_a_manifest() {
        assert!(desktop_release(release("v0.2.5", true)).is_none());
        assert!(desktop_release(release("openixsuit-ce-v0.1.1", false)).is_none());
        assert!(desktop_release(release("openixsuit-ce-v0.1.1-rc.1", true)).is_none());
        let mut draft = release("openixsuit-ce-v0.1.1", true);
        draft.draft = true;
        assert!(desktop_release(draft).is_none());
        let mut preview = release("openixsuit-ce-v0.1.1", true);
        preview.prerelease = true;
        assert!(desktop_release(preview).is_none());
        assert_eq!(
            desktop_release(release("openixsuit-ce-v0.1.1", true))
                .unwrap()
                .0,
            Version::new(0, 1, 1)
        );
    }
}
