use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::{WorkspaceId, WorkspaceRelativePath};

const PREFERENCES_FILE_NAME: &str = "plainroot-preferences-v1.json";
const PREFERENCES_SCHEMA_VERSION: u32 = 1;
const MAX_PREFERENCES_FILE_BYTES: usize = 1024 * 1024;
const MAX_PREFERENCE_WORKSPACES: usize = 1_000;
const MAX_ASSET_DIRECTORY_BYTES: usize = 1_024;
const MAX_ASSET_DIRECTORY_SEGMENTS: usize = 32;
const DEFAULT_ASSET_DIRECTORY: &str = "assets";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAssetPreference {
    pub workspace_id: WorkspaceId,
    pub asset_directory: WorkspaceRelativePath,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkspacePreferences {
    asset_directory: WorkspaceRelativePath,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlainrootPreferencesV1 {
    schema_version: u32,
    workspaces: BTreeMap<String, StoredWorkspacePreferences>,
}

impl Default for PlainrootPreferencesV1 {
    fn default() -> Self {
        Self {
            schema_version: PREFERENCES_SCHEMA_VERSION,
            workspaces: BTreeMap::new(),
        }
    }
}

impl PlainrootPreferencesV1 {
    fn validate(&self) -> Result<(), DesktopError> {
        if self.schema_version != PREFERENCES_SCHEMA_VERSION
            || self.workspaces.len() > MAX_PREFERENCE_WORKSPACES
        {
            return Err(preferences_error(
                DesktopErrorCode::InvalidPreferencesData,
                false,
            ));
        }
        for (workspace_id, preferences) in &self.workspaces {
            WorkspaceId::parse(workspace_id.clone())?;
            validate_asset_directory_value(&preferences.asset_directory)?;
        }
        Ok(())
    }
}

#[derive(Debug)]
enum PreferencesState {
    Ready(PlainrootPreferencesV1),
    Unavailable(DesktopError),
}

#[derive(Debug)]
pub struct PreferencesRepository {
    store: PreferencesStore,
    state: Mutex<PreferencesState>,
    startup_issue: Option<DesktopError>,
}

impl PreferencesRepository {
    pub fn initialize_for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Self {
        match crate::app_data_directory(app) {
            Ok(directory) => Self::initialize_at(directory),
            Err(_) => Self::unavailable(
                PathBuf::from(PREFERENCES_FILE_NAME),
                preferences_error(DesktopErrorCode::PreferencesUnavailable, true),
            ),
        }
    }

    pub(crate) fn initialize_at(app_data: PathBuf) -> Self {
        let store = PreferencesStore::new(app_data.join(PREFERENCES_FILE_NAME));
        match store.load_or_initialize() {
            Ok((preferences, startup_issue)) => Self {
                store,
                state: Mutex::new(PreferencesState::Ready(preferences)),
                startup_issue,
            },
            Err(error) => Self {
                store,
                state: Mutex::new(PreferencesState::Unavailable(error.clone())),
                startup_issue: Some(error),
            },
        }
    }

    fn unavailable(path: PathBuf, error: DesktopError) -> Self {
        Self {
            store: PreferencesStore::new(path),
            state: Mutex::new(PreferencesState::Unavailable(error.clone())),
            startup_issue: Some(error),
        }
    }

    pub fn current_error(&self) -> Option<DesktopError> {
        self.startup_issue.clone()
    }

    pub fn get(
        &self,
        workspace_id: &WorkspaceId,
    ) -> Result<WorkspaceAssetPreference, DesktopError> {
        let state = self.lock_state()?;
        let preferences = ready_preferences(&state)?;
        let asset_directory = preferences
            .workspaces
            .get(workspace_id.as_str())
            .map(|value| value.asset_directory.clone())
            .unwrap_or_else(default_asset_directory);
        Ok(WorkspaceAssetPreference {
            workspace_id: workspace_id.clone(),
            asset_directory,
        })
    }

    pub fn set_asset_directory(
        &self,
        workspace_id: WorkspaceId,
        asset_directory: WorkspaceRelativePath,
    ) -> Result<WorkspaceAssetPreference, DesktopError> {
        validate_asset_directory_value(&asset_directory)?;
        let mut state = self.lock_state()?;
        let current = ready_preferences(&state)?;
        let mut next = current.clone();
        next.workspaces.insert(
            workspace_id.as_str().to_owned(),
            StoredWorkspacePreferences {
                asset_directory: asset_directory.clone(),
            },
        );
        self.store.save(&next)?;
        *state = PreferencesState::Ready(next);
        Ok(WorkspaceAssetPreference {
            workspace_id,
            asset_directory,
        })
    }

    pub fn reset_asset_directory(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<WorkspaceAssetPreference, DesktopError> {
        let mut state = self.lock_state()?;
        let current = ready_preferences(&state)?;
        let mut next = current.clone();
        next.workspaces.remove(workspace_id.as_str());
        self.store.save(&next)?;
        *state = PreferencesState::Ready(next);
        Ok(WorkspaceAssetPreference {
            workspace_id,
            asset_directory: default_asset_directory(),
        })
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, PreferencesState>, DesktopError> {
        self.state
            .lock()
            .map_err(|_| preferences_error(DesktopErrorCode::PreferencesUnavailable, true))
    }
}

fn ready_preferences(state: &PreferencesState) -> Result<&PlainrootPreferencesV1, DesktopError> {
    match state {
        PreferencesState::Ready(preferences) => Ok(preferences),
        PreferencesState::Unavailable(error) => Err(error.clone()),
    }
}

pub fn default_asset_directory() -> WorkspaceRelativePath {
    WorkspaceRelativePath::parse(DEFAULT_ASSET_DIRECTORY)
        .expect("the built-in asset directory is valid")
}

pub fn parse_asset_directory(value: &str) -> Result<WorkspaceRelativePath, DesktopError> {
    let relative = WorkspaceRelativePath::parse(value)
        .map_err(|_| preferences_error(DesktopErrorCode::InvalidAssetDirectory, false))?;
    validate_asset_directory_value(&relative)?;
    Ok(relative)
}

pub fn validate_asset_directory(
    canonical_root: &Path,
    relative: &WorkspaceRelativePath,
) -> Result<(), DesktopError> {
    validate_asset_directory_value(relative)?;
    let root_metadata = fs::symlink_metadata(canonical_root)
        .map_err(|error| DesktopError::from_io(&error, canonical_root, true))?;
    if root_metadata.file_type().is_symlink() {
        return Err(
            DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                .with_path_hint(canonical_root),
        );
    }
    if !root_metadata.is_dir() {
        return Err(
            DesktopError::new(DesktopErrorCode::NotDirectory, true, false)
                .with_path_hint(canonical_root),
        );
    }

    let mut current = canonical_root.to_path_buf();
    for segment in relative.as_str().split('/') {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(
                    DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                        .with_path_hint(&current),
                );
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(
                    DesktopError::new(DesktopErrorCode::NotDirectory, true, false)
                        .with_path_hint(&current),
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(DesktopError::from_io(&error, &current, true)),
        }
    }
    Ok(())
}

fn validate_asset_directory_value(relative: &WorkspaceRelativePath) -> Result<(), DesktopError> {
    let value = relative.as_str();
    if value.len() > MAX_ASSET_DIRECTORY_BYTES
        || value.split('/').count() > MAX_ASSET_DIRECTORY_SEGMENTS
        || value.split('/').any(invalid_asset_directory_segment)
    {
        return Err(preferences_error(
            DesktopErrorCode::InvalidAssetDirectory,
            false,
        ));
    }
    Ok(())
}

fn invalid_asset_directory_segment(segment: &str) -> bool {
    let invalid = segment.is_empty()
        || segment != segment.trim()
        || segment.ends_with(['.', ' '])
        || segment.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        || segment.len() > 255
        || segment.encode_utf16().count() > 255;
    if invalid {
        return true;
    }
    let base = segment.split('.').next().unwrap_or(segment);
    let upper = base.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
    ) || reserved_numbered_name(&upper, "COM")
        || reserved_numbered_name(&upper, "LPT")
}

fn reserved_numbered_name(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|suffix| matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
}

#[derive(Debug)]
struct PreferencesStore {
    path: PathBuf,
    #[cfg(test)]
    fail_before_replace: bool,
}

impl PreferencesStore {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            #[cfg(test)]
            fail_before_replace: false,
        }
    }

    #[cfg(test)]
    fn with_failure_before_replace(mut self) -> Self {
        self.fail_before_replace = true;
        self
    }

    fn load_or_initialize(
        &self,
    ) -> Result<(PlainrootPreferencesV1, Option<DesktopError>), DesktopError> {
        let bytes = match File::open(&self.path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take((MAX_PREFERENCES_FILE_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|_| {
                        preferences_error(DesktopErrorCode::PreferencesReadFailed, true)
                            .with_path_hint(&self.path)
                    })?;
                bytes
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let preferences = PlainrootPreferencesV1::default();
                self.save(&preferences)?;
                return Ok((preferences, None));
            }
            Err(_) => {
                return Err(
                    preferences_error(DesktopErrorCode::PreferencesReadFailed, true)
                        .with_path_hint(&self.path),
                );
            }
        };
        if bytes.len() > MAX_PREFERENCES_FILE_BYTES {
            return self.recover_corrupt();
        }
        let value = match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => value,
            Err(_) => return self.recover_corrupt(),
        };
        let Some(version) = value.get("schemaVersion").and_then(Value::as_u64) else {
            return self.recover_corrupt();
        };
        if version != u64::from(PREFERENCES_SCHEMA_VERSION) {
            return Err(preferences_error(
                DesktopErrorCode::PreferencesUnsupportedVersion,
                false,
            ));
        }
        let preferences = match serde_json::from_value::<PlainrootPreferencesV1>(value) {
            Ok(preferences) if preferences.validate().is_ok() => preferences,
            _ => return self.recover_corrupt(),
        };
        Ok((preferences, None))
    }

    fn recover_corrupt(
        &self,
    ) -> Result<(PlainrootPreferencesV1, Option<DesktopError>), DesktopError> {
        let backup = self.next_corrupt_backup_path();
        fs::rename(&self.path, &backup).map_err(|_| {
            preferences_error(DesktopErrorCode::PreferencesBackupFailed, true)
                .with_path_hint(&self.path)
        })?;
        let preferences = PlainrootPreferencesV1::default();
        self.save(&preferences)?;
        Ok((
            preferences,
            Some(
                preferences_error(DesktopErrorCode::InvalidPreferencesData, false)
                    .with_path_hint(&backup),
            ),
        ))
    }

    fn next_corrupt_backup_path(&self) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        for collision in 0_u32.. {
            let suffix = if collision == 0 {
                format!(".corrupt-{timestamp}")
            } else {
                format!(".corrupt-{timestamp}-{collision}")
            };
            let candidate = self
                .path
                .with_file_name(format!("{PREFERENCES_FILE_NAME}{suffix}"));
            if !candidate.exists() {
                return candidate;
            }
        }
        unreachable!("corrupt backup name space is unbounded")
    }

    fn save(&self, preferences: &PlainrootPreferencesV1) -> Result<(), DesktopError> {
        preferences.validate()?;
        let parent = self
            .path
            .parent()
            .ok_or_else(|| preferences_error(DesktopErrorCode::PreferencesWriteFailed, true))?;
        fs::create_dir_all(parent).map_err(|_| {
            preferences_error(DesktopErrorCode::PreferencesWriteFailed, true)
                .with_path_hint(&self.path)
        })?;
        let mut bytes = serde_json::to_vec_pretty(preferences)
            .map_err(|_| preferences_error(DesktopErrorCode::InvalidPreferencesData, false))?;
        bytes.push(b'\n');
        if bytes.len() > MAX_PREFERENCES_FILE_BYTES {
            return Err(preferences_error(
                DesktopErrorCode::InvalidPreferencesData,
                false,
            ));
        }

        let (mut file, temp_path) = create_temp_file(&self.path)?;
        let mut guard = TempGuard::new(temp_path.clone());
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                preferences_error(DesktopErrorCode::PreferencesWriteFailed, true)
                    .with_path_hint(&self.path)
            })?;
        drop(file);

        #[cfg(test)]
        if self.fail_before_replace {
            return Err(
                preferences_error(DesktopErrorCode::PreferencesWriteFailed, true)
                    .with_path_hint(&self.path),
            );
        }

        crate::fs::atomic::replace_existing(&temp_path, &self.path).map_err(|_| {
            preferences_error(DesktopErrorCode::PreferencesWriteFailed, true)
                .with_path_hint(&self.path)
        })?;
        guard.disarm();
        let _ = crate::fs::atomic::sync_parent_directory(&self.path);
        Ok(())
    }
}

fn create_temp_file(target: &Path) -> Result<(File, PathBuf), DesktopError> {
    for _ in 0..100 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temp = target.with_file_name(format!(
            ".{PREFERENCES_FILE_NAME}.tmp-{}-{sequence}",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temp) {
            Ok(file) => return Ok((file, temp)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                return Err(
                    preferences_error(DesktopErrorCode::PreferencesWriteFailed, true)
                        .with_path_hint(target),
                );
            }
        }
    }
    Err(preferences_error(
        DesktopErrorCode::PreferencesWriteFailed,
        true,
    ))
}

#[derive(Debug)]
struct TempGuard {
    path: Option<PathBuf>,
}

impl TempGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn preferences_error(code: DesktopErrorCode, retryable: bool) -> DesktopError {
    DesktopError::new(code, true, retryable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract_test::assert_interface_matches;
    use crate::test_support::TestDirectory;

    #[test]
    fn default_set_reload_and_reset_form_a_complete_preference_cycle() {
        let root = TestDirectory::create("preferences-cycle");
        let workspace_id = WorkspaceId::parse("workspace-preferences").unwrap();
        let repository = PreferencesRepository::initialize_at(root.path().to_path_buf());
        assert_eq!(
            repository.get(&workspace_id).unwrap().asset_directory,
            default_asset_directory()
        );

        let configured = WorkspaceRelativePath::parse("media/images").unwrap();
        repository
            .set_asset_directory(workspace_id.clone(), configured.clone())
            .unwrap();
        let reloaded = PreferencesRepository::initialize_at(root.path().to_path_buf());
        assert_eq!(
            reloaded.get(&workspace_id).unwrap().asset_directory,
            configured
        );

        reloaded
            .reset_asset_directory(workspace_id.clone())
            .unwrap();
        assert_eq!(
            reloaded.get(&workspace_id).unwrap().asset_directory,
            default_asset_directory()
        );
        assert_interface_matches(
            "WorkspaceAssetPreference",
            &reloaded.get(&workspace_id).unwrap(),
        );
    }

    #[test]
    fn invalid_and_symlinked_asset_directories_are_rejected() {
        let root = TestDirectory::create("preferences-validation");
        let workspace = root.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        for invalid in ["/absolute", "../escape", "a//b", "CON", "bad:name"] {
            let parsed = parse_asset_directory(invalid);
            if let Ok(relative) = &parsed {
                assert_eq!(
                    validate_asset_directory(&workspace, relative)
                        .unwrap_err()
                        .code,
                    DesktopErrorCode::InvalidAssetDirectory
                );
            } else {
                assert_eq!(
                    parsed.unwrap_err().code,
                    DesktopErrorCode::InvalidAssetDirectory
                );
            }
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = root.path().join("outside");
            fs::create_dir_all(&outside).unwrap();
            symlink(&outside, workspace.join("linked")).unwrap();
            let relative = WorkspaceRelativePath::parse("linked/images").unwrap();
            assert_eq!(
                validate_asset_directory(&workspace, &relative)
                    .unwrap_err()
                    .code,
                DesktopErrorCode::SymlinkNotAllowed
            );
        }
    }

    #[test]
    fn corrupt_file_is_backed_up_while_unknown_version_is_preserved() {
        let corrupt_root = TestDirectory::create("preferences-corrupt");
        let path = corrupt_root.path().join(PREFERENCES_FILE_NAME);
        fs::write(&path, b"not-json").unwrap();
        let recovered = PreferencesRepository::initialize_at(corrupt_root.path().to_path_buf());
        assert!(recovered.current_error().is_some());
        assert_eq!(
            recovered
                .get(&WorkspaceId::parse("workspace").unwrap())
                .unwrap()
                .asset_directory,
            default_asset_directory()
        );
        assert!(fs::read_dir(corrupt_root.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".corrupt-")));

        let unknown_root = TestDirectory::create("preferences-unknown");
        let unknown_path = unknown_root.path().join(PREFERENCES_FILE_NAME);
        fs::write(&unknown_path, br#"{"schemaVersion":2,"workspaces":{}}"#).unwrap();
        let original = fs::read(&unknown_path).unwrap();
        let repository = PreferencesRepository::initialize_at(unknown_root.path().to_path_buf());
        assert_eq!(
            repository
                .get(&WorkspaceId::parse("workspace").unwrap())
                .unwrap_err()
                .code,
            DesktopErrorCode::PreferencesUnsupportedVersion
        );
        assert_eq!(fs::read(unknown_path).unwrap(), original);
    }

    #[test]
    fn failed_atomic_replace_preserves_disk_and_memory_preference() {
        let root = TestDirectory::create("preferences-failure");
        let path = root.path().join(PREFERENCES_FILE_NAME);
        let initial = PlainrootPreferencesV1::default();
        PreferencesStore::new(path.clone()).save(&initial).unwrap();
        let repository = PreferencesRepository {
            store: PreferencesStore::new(path.clone()).with_failure_before_replace(),
            state: Mutex::new(PreferencesState::Ready(initial)),
            startup_issue: None,
        };
        let workspace_id = WorkspaceId::parse("workspace").unwrap();
        let before = fs::read(&path).unwrap();
        assert_eq!(
            repository
                .set_asset_directory(
                    workspace_id.clone(),
                    WorkspaceRelativePath::parse("images").unwrap(),
                )
                .unwrap_err()
                .code,
            DesktopErrorCode::PreferencesWriteFailed
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(
            repository.get(&workspace_id).unwrap().asset_directory,
            default_asset_directory()
        );
    }
}
