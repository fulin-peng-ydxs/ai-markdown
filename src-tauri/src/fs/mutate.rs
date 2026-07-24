use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::error::{DesktopError, DesktopErrorCode};

use super::{
    metadata_writable_hint, resolve_existing_workspace_path, FsChildrenState, FsEntry, FsEntryKind,
    WorkspaceRelativePath,
};

const MAX_MOVE_RISK_SCAN_ENTRIES: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMutationKind {
    CreateFile,
    CreateDirectory,
    Rename,
    Move,
}

impl WorkspaceMutationKind {
    pub const ALL: &'static [Self] = &[
        Self::CreateFile,
        Self::CreateDirectory,
        Self::Rename,
        Self::Move,
    ];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMutationResult {
    pub kind: WorkspaceMutationKind,
    pub previous_path: Option<WorkspaceRelativePath>,
    pub entry: FsEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMoveRisk {
    pub entry_kind: FsEntryKind,
    pub configured_asset_directory_affected: bool,
    pub contains_supported_images: bool,
    pub inspection_limited: bool,
    pub may_break_image_links: bool,
}

#[derive(Debug, Clone, Default)]
pub struct WorkspaceMutationService {
    operation_lock: Arc<Mutex<()>>,
}

impl WorkspaceMutationService {
    pub(crate) fn operation_lock(&self) -> Arc<Mutex<()>> {
        Arc::clone(&self.operation_lock)
    }

    pub fn create_markdown_file(
        &self,
        canonical_root: &Path,
        parent: Option<&str>,
        requested_name: &str,
    ) -> Result<WorkspaceMutationResult, DesktopError> {
        let _guard = self.lock()?;
        let (parent_path, parent_relative) = resolve_parent(canonical_root, parent)?;
        let name = markdown_name(requested_name)?;
        let relative_path = join_relative(parent_relative.as_ref(), &name)?;
        let target = parent_path.join(&name);
        let metadata = create_empty_file(&target, fs::File::sync_all)?;
        Ok(mutation_result(
            WorkspaceMutationKind::CreateFile,
            None,
            relative_path,
            &metadata,
            FsEntryKind::MarkdownFile,
        ))
    }

    pub fn create_directory(
        &self,
        canonical_root: &Path,
        parent: Option<&str>,
        requested_name: &str,
    ) -> Result<WorkspaceMutationResult, DesktopError> {
        let _guard = self.lock()?;
        let (parent_path, parent_relative) = resolve_parent(canonical_root, parent)?;
        let name = validate_entry_name(requested_name)?;
        let relative_path = join_relative(parent_relative.as_ref(), &name)?;
        let target = parent_path.join(&name);
        fs::create_dir(&target).map_err(|error| map_mutation_error(error, &target))?;
        let metadata = match fs::metadata(&target) {
            Ok(metadata) => metadata,
            Err(error) => {
                let _ = fs::remove_dir(&target);
                return Err(map_mutation_error(error, &target));
            }
        };
        Ok(mutation_result(
            WorkspaceMutationKind::CreateDirectory,
            None,
            relative_path,
            &metadata,
            FsEntryKind::Directory,
        ))
    }

    pub fn rename(
        &self,
        canonical_root: &Path,
        source: &str,
        requested_name: &str,
    ) -> Result<WorkspaceMutationResult, DesktopError> {
        let _guard = self.lock()?;
        validate_mutation_root(canonical_root)?;
        let source_relative = WorkspaceRelativePath::parse(source)?;
        let source_path = resolve_existing_workspace_path(canonical_root, &source_relative)?;
        let metadata = fs::metadata(&source_path)
            .map_err(|error| DesktopError::from_io(&error, &source_path, true))?;
        let kind = supported_kind(&source_path, &metadata)?;
        let name = match kind {
            FsEntryKind::MarkdownFile => markdown_name(requested_name)?,
            FsEntryKind::Directory => validate_entry_name(requested_name)?,
        };
        let parent_relative = relative_parent(&source_relative);
        let target_relative = join_relative(parent_relative.as_ref(), &name)?;
        if target_relative == source_relative {
            return Err(invalid_move_target(&source_path));
        }
        let target = source_path
            .parent()
            .expect("a workspace entry always has a parent")
            .join(&name);
        rename_without_replace(&source_path, &target)?;
        Ok(mutation_result(
            WorkspaceMutationKind::Rename,
            Some(source_relative),
            target_relative,
            &metadata,
            kind,
        ))
    }

    pub fn move_entry(
        &self,
        canonical_root: &Path,
        source: &str,
        target_directory: Option<&str>,
    ) -> Result<WorkspaceMutationResult, DesktopError> {
        let _guard = self.lock()?;
        let source_relative = WorkspaceRelativePath::parse(source)?;
        let source_path = resolve_existing_workspace_path(canonical_root, &source_relative)?;
        let metadata = fs::metadata(&source_path)
            .map_err(|error| DesktopError::from_io(&error, &source_path, true))?;
        let kind = supported_kind(&source_path, &metadata)?;
        let (target_parent, target_parent_relative) =
            resolve_parent(canonical_root, target_directory)?;
        if kind == FsEntryKind::Directory
            && (target_parent == source_path || target_parent.starts_with(&source_path))
        {
            return Err(invalid_move_target(&source_path));
        }
        let name = source_relative
            .as_str()
            .rsplit('/')
            .next()
            .expect("relative path has at least one component");
        let target_relative = join_relative(target_parent_relative.as_ref(), name)?;
        if target_relative == source_relative {
            return Err(invalid_move_target(&source_path));
        }
        let target = target_parent.join(name);
        rename_without_replace(&source_path, &target)?;
        Ok(mutation_result(
            WorkspaceMutationKind::Move,
            Some(source_relative),
            target_relative,
            &metadata,
            kind,
        ))
    }

    pub fn inspect_move_risk(
        &self,
        canonical_root: &Path,
        source: &str,
        asset_directory: &WorkspaceRelativePath,
        preference_unavailable: bool,
    ) -> Result<WorkspaceMoveRisk, DesktopError> {
        let _guard = self.lock()?;
        validate_mutation_root(canonical_root)?;
        let source_relative = WorkspaceRelativePath::parse(source)?;
        let source_path = resolve_existing_workspace_path(canonical_root, &source_relative)?;
        let metadata = fs::metadata(&source_path)
            .map_err(|error| DesktopError::from_io(&error, &source_path, true))?;
        let entry_kind = supported_kind(&source_path, &metadata)?;
        if entry_kind != FsEntryKind::Directory {
            return Ok(WorkspaceMoveRisk {
                entry_kind,
                configured_asset_directory_affected: false,
                contains_supported_images: false,
                inspection_limited: false,
                may_break_image_links: false,
            });
        }

        let configured_asset_directory_affected =
            is_same_or_inside(asset_directory.as_str(), source_relative.as_str());
        let (contains_supported_images, directory_scan_limited) =
            inspect_directory_images(&source_path, MAX_MOVE_RISK_SCAN_ENTRIES);
        let inspection_limited = preference_unavailable || directory_scan_limited;
        Ok(WorkspaceMoveRisk {
            entry_kind,
            configured_asset_directory_affected,
            contains_supported_images,
            inspection_limited,
            may_break_image_links: configured_asset_directory_affected
                || contains_supported_images
                || inspection_limited,
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, DesktopError> {
        self.operation_lock
            .lock()
            .map_err(|_| DesktopError::new(DesktopErrorCode::MutationUnavailable, true, true))
    }
}

fn is_same_or_inside(path: &str, ancestor: &str) -> bool {
    path == ancestor
        || path
            .strip_prefix(ancestor)
            .is_some_and(|remainder| remainder.starts_with('/'))
}

fn inspect_directory_images(root: &Path, entry_limit: usize) -> (bool, bool) {
    let mut pending = vec![root.to_path_buf()];
    let mut inspected = 0_usize;
    let mut limited = false;

    while let Some(directory) = pending.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                limited = true;
                continue;
            }
        };
        for entry in entries {
            if inspected >= entry_limit {
                return (false, true);
            }
            inspected += 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    limited = true;
                    continue;
                }
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    limited = true;
                    continue;
                }
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() && is_supported_image_path(&entry.path()) {
                return (true, limited);
            }
        }
    }

    (false, limited)
}

fn is_supported_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp"
            )
        })
}

fn create_empty_file(
    target: &Path,
    sync: impl FnOnce(&fs::File) -> io::Result<()>,
) -> Result<fs::Metadata, DesktopError> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| map_mutation_error(error, target))?;
    if let Err(error) = sync(&file) {
        drop(file);
        let _ = fs::remove_file(target);
        return Err(map_mutation_error(error, target));
    }
    match file.metadata() {
        Ok(metadata) => Ok(metadata),
        Err(error) => {
            drop(file);
            let _ = fs::remove_file(target);
            Err(map_mutation_error(error, target))
        }
    }
}

fn resolve_parent(
    canonical_root: &Path,
    parent: Option<&str>,
) -> Result<(PathBuf, Option<WorkspaceRelativePath>), DesktopError> {
    validate_mutation_root(canonical_root)?;
    let Some(parent) = parent else {
        return Ok((canonical_root.to_path_buf(), None));
    };
    let relative = WorkspaceRelativePath::parse(parent)?;
    let path = resolve_existing_workspace_path(canonical_root, &relative)?;
    let metadata =
        fs::metadata(&path).map_err(|error| DesktopError::from_io(&error, &path, true))?;
    if !metadata.is_dir() {
        return Err(
            DesktopError::new(DesktopErrorCode::NotDirectory, true, false).with_path_hint(&path),
        );
    }
    Ok((path, Some(relative)))
}

fn validate_mutation_root(canonical_root: &Path) -> Result<(), DesktopError> {
    let metadata = fs::symlink_metadata(canonical_root)
        .map_err(|error| DesktopError::from_io(&error, canonical_root, true))?;
    if metadata.file_type().is_symlink() {
        return Err(
            DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                .with_path_hint(canonical_root),
        );
    }
    if !metadata.is_dir() {
        return Err(
            DesktopError::new(DesktopErrorCode::NotDirectory, true, false)
                .with_path_hint(canonical_root),
        );
    }
    Ok(())
}

pub(crate) fn supported_kind(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<FsEntryKind, DesktopError> {
    if metadata.is_dir() {
        Ok(FsEntryKind::Directory)
    } else if metadata.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        Ok(FsEntryKind::MarkdownFile)
    } else if metadata.is_file() {
        Err(
            DesktopError::new(DesktopErrorCode::UnsupportedMarkdownFile, true, false)
                .with_path_hint(path),
        )
    } else {
        Err(DesktopError::new(DesktopErrorCode::NotFile, true, false).with_path_hint(path))
    }
}

fn validate_entry_name(requested: &str) -> Result<String, DesktopError> {
    let invalid = requested.is_empty()
        || requested != requested.trim()
        || requested.starts_with('.')
        || requested.ends_with(['.', ' '])
        || requested.split('.').any(|segment| segment.ends_with(' '))
        || matches!(requested, "." | "..")
        || requested.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        || requested.len() > 255
        || requested.encode_utf16().count() > 255;
    if invalid {
        return Err(DesktopError::new(
            DesktopErrorCode::InvalidEntryName,
            true,
            false,
        ));
    }
    let base = requested.split('.').next().unwrap_or(requested);
    let upper = base.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || reserved_numbered_name(&upper, "COM")
        || reserved_numbered_name(&upper, "LPT");
    if reserved {
        return Err(DesktopError::new(
            DesktopErrorCode::ReservedEntryName,
            true,
            false,
        ));
    }
    Ok(requested.to_owned())
}

fn reserved_numbered_name(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|suffix| matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
}

fn markdown_name(requested: &str) -> Result<String, DesktopError> {
    let validated = validate_entry_name(requested)?;
    match Path::new(&validated)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        None => Ok(format!("{validated}.md")),
        Some(extension) if extension.eq_ignore_ascii_case("md") => {
            let stem = Path::new(&validated)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default();
            if stem.is_empty() {
                Err(DesktopError::new(
                    DesktopErrorCode::InvalidEntryName,
                    true,
                    false,
                ))
            } else {
                Ok(validated)
            }
        }
        Some(_) => Err(DesktopError::new(
            DesktopErrorCode::UnsupportedMarkdownFile,
            true,
            false,
        )),
    }
}

fn join_relative(
    parent: Option<&WorkspaceRelativePath>,
    name: &str,
) -> Result<WorkspaceRelativePath, DesktopError> {
    WorkspaceRelativePath::parse(&parent.map_or_else(
        || name.to_owned(),
        |parent| format!("{}/{name}", parent.as_str()),
    ))
}

fn relative_parent(path: &WorkspaceRelativePath) -> Option<WorkspaceRelativePath> {
    path.as_str()
        .rsplit_once('/')
        .map(|(parent, _)| WorkspaceRelativePath::parse(parent).expect("validated parent path"))
}

fn mutation_result(
    kind: WorkspaceMutationKind,
    previous_path: Option<WorkspaceRelativePath>,
    relative_path: WorkspaceRelativePath,
    metadata: &fs::Metadata,
    entry_kind: FsEntryKind,
) -> WorkspaceMutationResult {
    WorkspaceMutationResult {
        kind,
        previous_path,
        entry: FsEntry {
            name: relative_path
                .as_str()
                .rsplit('/')
                .next()
                .expect("relative path has a name")
                .to_owned(),
            relative_path,
            kind: entry_kind,
            writable: metadata_writable_hint(metadata),
            symlink: false,
            children_state: if entry_kind == FsEntryKind::Directory {
                FsChildrenState::NotLoaded
            } else {
                FsChildrenState::Loaded
            },
        },
    }
}

fn invalid_move_target(path: &Path) -> DesktopError {
    DesktopError::new(DesktopErrorCode::InvalidMoveTarget, true, false).with_path_hint(path)
}

fn map_mutation_error(error: io::Error, path: &Path) -> DesktopError {
    if error.kind() == io::ErrorKind::AlreadyExists || is_target_exists_error(&error) {
        DesktopError::new(DesktopErrorCode::TargetAlreadyExists, true, false).with_path_hint(path)
    } else if is_cross_device_error(&error) {
        DesktopError::new(DesktopErrorCode::CrossDeviceMove, true, false).with_path_hint(path)
    } else {
        DesktopError::from_io(&error, path, true)
    }
}

#[cfg(windows)]
fn is_target_exists_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(80 | 183))
}

#[cfg(not(windows))]
fn is_target_exists_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(17)
}

#[cfg(windows)]
fn is_cross_device_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(17)
}

#[cfg(not(windows))]
fn is_cross_device_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(18)
}

fn rename_without_replace(source: &Path, target: &Path) -> Result<(), DesktopError> {
    let source_metadata = fs::symlink_metadata(source)
        .map_err(|error| DesktopError::from_io(&error, source, true))?;
    if source_metadata.file_type().is_symlink() {
        return Err(
            DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                .with_path_hint(source),
        );
    }
    match fs::symlink_metadata(target) {
        Ok(target_metadata)
            if same_file_identity(source, &source_metadata, target, &target_metadata) => {}
        Ok(_) => {
            return Err(
                DesktopError::new(DesktopErrorCode::TargetAlreadyExists, true, false)
                    .with_path_hint(target),
            )
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(DesktopError::from_io(&error, target, true)),
    }
    super::atomic::rename_without_replace(source, target)
        .map_err(|error| map_mutation_error(error, target))
}

#[cfg(unix)]
fn same_file_identity(
    _source_path: &Path,
    source: &fs::Metadata,
    _target_path: &Path,
    target: &fs::Metadata,
) -> bool {
    use std::os::unix::fs::MetadataExt;

    source.dev() == target.dev() && source.ino() == target.ino()
}

#[cfg(windows)]
fn same_file_identity(
    source_path: &Path,
    _source: &fs::Metadata,
    target_path: &Path,
    _target: &fs::Metadata,
) -> bool {
    let Ok(source_identity) = super::windows_file_identity(source_path) else {
        return false;
    };
    let Ok(target_identity) = super::windows_file_identity(target_path) else {
        return false;
    };
    source_identity == target_identity
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;

    use crate::contract_test::{assert_interface_matches, typescript_string_constant_values};
    use crate::error::DesktopErrorCode;
    use crate::fs::WorkspaceRelativePath;

    use super::{WorkspaceMutationKind, WorkspaceMutationService};

    static SEQUENCE: AtomicU64 = AtomicU64::new(1);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "plainroot-mutate-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(fs::canonicalize(root).unwrap())
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_empty_markdown_with_default_extension_and_directory() {
        let root = Fixture::new();
        let service = WorkspaceMutationService::default();
        let file = service
            .create_markdown_file(root.path(), None, "Notes")
            .unwrap();
        assert_eq!(file.entry.relative_path.as_str(), "Notes.md");
        assert_eq!(fs::read(root.path().join("Notes.md")).unwrap(), b"");
        assert_interface_matches("WorkspaceMutationResult", &file);
        let directory = service
            .create_directory(root.path(), None, "Research")
            .unwrap();
        assert!(root.path().join("Research").is_dir());
        assert_eq!(directory.kind, WorkspaceMutationKind::CreateDirectory);
    }

    #[test]
    fn rejects_invalid_reserved_hidden_and_unsupported_names() {
        let root = Fixture::new();
        let service = WorkspaceMutationService::default();
        for name in [
            "", " bad", "bad ", ".hidden", "a/b", "bad?", "end.", "name .md",
        ] {
            assert_eq!(
                service
                    .create_directory(root.path(), None, name)
                    .unwrap_err()
                    .code,
                DesktopErrorCode::InvalidEntryName,
                "{name:?} should be invalid"
            );
        }
        for name in ["CON", "con.md", "LPT1", "COM9.txt", "NUL"] {
            assert_eq!(
                service
                    .create_directory(root.path(), None, name)
                    .unwrap_err()
                    .code,
                DesktopErrorCode::ReservedEntryName,
                "{name:?} should be reserved on every platform"
            );
        }
        assert_eq!(
            service
                .create_markdown_file(root.path(), None, "note.txt")
                .unwrap_err()
                .code,
            DesktopErrorCode::UnsupportedMarkdownFile
        );
    }

    #[test]
    fn rename_and_move_preserve_content_and_never_replace_target() {
        let root = Fixture::new();
        fs::create_dir(root.path().join("archive")).unwrap();
        fs::write(root.path().join("note.md"), "safe").unwrap();
        let service = WorkspaceMutationService::default();
        let renamed = service.rename(root.path(), "note.md", "renamed").unwrap();
        assert_eq!(renamed.entry.relative_path.as_str(), "renamed.md");
        assert_eq!(
            fs::read_to_string(root.path().join("renamed.md")).unwrap(),
            "safe"
        );
        let moved = service
            .move_entry(root.path(), "renamed.md", Some("archive"))
            .unwrap();
        assert_eq!(moved.entry.relative_path.as_str(), "archive/renamed.md");
        assert_eq!(
            fs::read_to_string(root.path().join("archive/renamed.md")).unwrap(),
            "safe"
        );

        fs::write(root.path().join("other.md"), "source").unwrap();
        fs::write(root.path().join("archive/other.md"), "target").unwrap();
        assert_eq!(
            service
                .move_entry(root.path(), "other.md", Some("archive"))
                .unwrap_err()
                .code,
            DesktopErrorCode::TargetAlreadyExists
        );
        assert_eq!(
            fs::read_to_string(root.path().join("other.md")).unwrap(),
            "source"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("archive/other.md")).unwrap(),
            "target"
        );
    }

    #[test]
    fn case_only_rename_is_allowed_for_the_same_file() {
        let root = Fixture::new();
        fs::write(root.path().join("case.md"), "safe").unwrap();
        let service = WorkspaceMutationService::default();
        let renamed = service.rename(root.path(), "case.md", "CASE.md").unwrap();
        assert_eq!(renamed.entry.relative_path.as_str(), "CASE.md");
        assert_eq!(
            fs::read_to_string(root.path().join("CASE.md")).unwrap(),
            "safe"
        );
    }

    #[test]
    fn directory_cannot_move_into_itself_or_descendant() {
        let root = Fixture::new();
        fs::create_dir_all(root.path().join("docs/child")).unwrap();
        let service = WorkspaceMutationService::default();
        for target in ["docs", "docs/child"] {
            assert_eq!(
                service
                    .move_entry(root.path(), "docs", Some(target))
                    .unwrap_err()
                    .code,
                DesktopErrorCode::InvalidMoveTarget
            );
        }
        assert!(root.path().join("docs/child").is_dir());
    }

    #[test]
    fn move_risk_detects_configured_asset_directory_and_nested_images() {
        let root = Fixture::new();
        fs::create_dir_all(root.path().join("guides/media/nested")).unwrap();
        fs::write(root.path().join("guides/media/nested/cover.PNG"), b"image").unwrap();
        let service = WorkspaceMutationService::default();
        let asset_directory = WorkspaceRelativePath::parse("guides/media").unwrap();

        let risk = service
            .inspect_move_risk(root.path(), "guides", &asset_directory, false)
            .unwrap();

        assert!(risk.configured_asset_directory_affected);
        assert!(risk.contains_supported_images);
        assert!(!risk.inspection_limited);
        assert!(risk.may_break_image_links);
        assert_interface_matches("WorkspaceMoveRisk", &risk);
    }

    #[test]
    fn move_risk_does_not_warn_for_directory_without_images() {
        let root = Fixture::new();
        fs::create_dir_all(root.path().join("guides/nested")).unwrap();
        fs::write(root.path().join("guides/nested/readme.md"), b"# safe").unwrap();
        let service = WorkspaceMutationService::default();
        let asset_directory = WorkspaceRelativePath::parse("assets").unwrap();

        let risk = service
            .inspect_move_risk(root.path(), "guides", &asset_directory, false)
            .unwrap();

        assert!(!risk.configured_asset_directory_affected);
        assert!(!risk.contains_supported_images);
        assert!(!risk.inspection_limited);
        assert!(!risk.may_break_image_links);
    }

    #[test]
    fn move_risk_does_not_apply_directory_preference_failures_to_files() {
        let root = Fixture::new();
        fs::write(root.path().join("note.md"), b"# safe").unwrap();
        let service = WorkspaceMutationService::default();
        let asset_directory = WorkspaceRelativePath::parse("assets").unwrap();

        let risk = service
            .inspect_move_risk(root.path(), "note.md", &asset_directory, true)
            .unwrap();

        assert_eq!(risk.entry_kind, crate::fs::FsEntryKind::MarkdownFile);
        assert!(!risk.inspection_limited);
        assert!(!risk.may_break_image_links);
    }

    #[test]
    fn incomplete_move_risk_inspection_fails_safe_without_claiming_an_image() {
        let root = Fixture::new();
        fs::create_dir_all(root.path().join("guides/nested")).unwrap();
        fs::write(root.path().join("guides/nested/readme.md"), b"# safe").unwrap();

        let (contains_supported_images, inspection_limited) =
            super::inspect_directory_images(&root.path().join("guides"), 1);

        assert!(!contains_supported_images);
        assert!(inspection_limited);
    }

    #[test]
    fn parent_and_target_paths_cannot_escape_the_authorized_root() {
        let root = Fixture::new();
        fs::write(root.path().join("note.md"), "safe").unwrap();
        let service = WorkspaceMutationService::default();
        assert_eq!(
            service
                .create_directory(root.path(), Some("../outside"), "docs")
                .unwrap_err()
                .code,
            DesktopErrorCode::InvalidRelativePath
        );
        assert_eq!(
            service
                .move_entry(root.path(), "note.md", Some("../outside"))
                .unwrap_err()
                .code,
            DesktopErrorCode::InvalidRelativePath
        );
        assert_eq!(
            fs::read_to_string(root.path().join("note.md")).unwrap(),
            "safe"
        );
    }

    #[cfg(unix)]
    #[test]
    fn readonly_parent_rejects_create_without_tree_success() {
        use std::os::unix::fs::PermissionsExt;

        let root = Fixture::new();
        let restricted = root.path().join("restricted");
        fs::create_dir(&restricted).unwrap();
        fs::set_permissions(&restricted, fs::Permissions::from_mode(0o500)).unwrap();
        let service = WorkspaceMutationService::default();
        let error = service
            .create_markdown_file(root.path(), Some("restricted"), "note")
            .unwrap_err();
        fs::set_permissions(&restricted, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(error.code, DesktopErrorCode::PermissionDenied);
        assert!(!restricted.join("note.md").exists());
    }

    #[test]
    fn concurrent_duplicate_create_has_one_success_and_one_stable_error() {
        let root = Fixture::new();
        let service = Arc::new(WorkspaceMutationService::default());
        let barrier = Arc::new(Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let service = Arc::clone(&service);
                let barrier = Arc::clone(&barrier);
                let root = root.path().to_path_buf();
                thread::spawn(move || {
                    barrier.wait();
                    service.create_markdown_file(&root, None, "same")
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results.iter().any(|result| {
            result
                .as_ref()
                .is_err_and(|error| error.code == DesktopErrorCode::TargetAlreadyExists)
        }));
    }

    #[test]
    fn mutation_kind_values_match_typescript_contract() {
        let rust_values = WorkspaceMutationKind::ALL
            .iter()
            .map(|kind| {
                serde_json::to_value(kind)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            rust_values,
            typescript_string_constant_values("WORKSPACE_MUTATION_KINDS")
        );
    }

    #[test]
    fn platform_error_numbers_map_without_cross_device_and_exists_collision() {
        let path = Path::new("target.md");
        #[cfg(windows)]
        let (exists, cross_device) = (183, 17);
        #[cfg(not(windows))]
        let (exists, cross_device) = (17, 18);
        assert_eq!(
            super::map_mutation_error(std::io::Error::from_raw_os_error(exists), path).code,
            DesktopErrorCode::TargetAlreadyExists
        );
        assert_eq!(
            super::map_mutation_error(std::io::Error::from_raw_os_error(cross_device), path).code,
            DesktopErrorCode::CrossDeviceMove
        );
    }

    #[test]
    fn failed_new_file_sync_removes_the_uncommitted_file() {
        let root = Fixture::new();
        let target = root.path().join("failed.md");
        let error = super::create_empty_file(&target, |_| {
            Err(std::io::Error::other("injected sync failure"))
        })
        .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::IoFailure);
        assert!(!target.exists());
    }
}
