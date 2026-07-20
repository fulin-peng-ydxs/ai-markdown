use std::fs;
use std::path::{Path, PathBuf};

use serde::{Serialize, Serializer};

use crate::error::{DesktopError, DesktopErrorCode};

use super::{WorkspaceRelativePath, WorkspaceRootResolution};

#[cfg(not(windows))]
pub fn metadata_writable_hint(metadata: &fs::Metadata) -> bool {
    !metadata.permissions().readonly()
}

#[cfg(windows)]
pub fn metadata_writable_hint(_metadata: &fs::Metadata) -> bool {
    // The Windows readonly attribute is not an ACL writability decision. Actual mutations remain
    // authoritative and return their filesystem error instead of presenting a false read-only UI.
    true
}

pub fn inspect_workspace_root(
    selected_root: &Path,
) -> Result<WorkspaceRootResolution, DesktopError> {
    if !selected_root.is_absolute() {
        return Err(
            DesktopError::new(DesktopErrorCode::InvalidSelectedRoot, true, false)
                .with_path_hint(selected_root),
        );
    }

    let selected_metadata = fs::symlink_metadata(selected_root)
        .map_err(|error| DesktopError::from_io(&error, selected_root, true))?;
    let root_is_symlink = selected_metadata.file_type().is_symlink();
    let canonical_root = fs::canonicalize(selected_root)
        .map_err(|error| DesktopError::from_io(&error, selected_root, true))?;
    let canonical_metadata = fs::metadata(&canonical_root)
        .map_err(|error| DesktopError::from_io(&error, selected_root, true))?;
    if !canonical_metadata.is_dir() {
        return Err(
            DesktopError::new(DesktopErrorCode::NotDirectory, true, false)
                .with_path_hint(selected_root),
        );
    }

    // Opening the directory verifies readability now instead of inferring it from mode bits.
    fs::read_dir(&canonical_root)
        .map_err(|error| DesktopError::from_io(&error, selected_root, true))?;

    let display_name = selected_root
        .file_name()
        .or_else(|| canonical_root.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| canonical_root.to_string_lossy().into_owned());

    Ok(WorkspaceRootResolution::new(
        selected_root.to_path_buf(),
        canonical_root,
        display_name,
        root_is_symlink,
    ))
}

pub fn resolve_existing_workspace_path(
    canonical_root: &Path,
    relative_path: &WorkspaceRelativePath,
) -> Result<PathBuf, DesktopError> {
    if !canonical_root.is_absolute() {
        return Err(DesktopError::new(
            DesktopErrorCode::InvalidSelectedRoot,
            true,
            false,
        ));
    }

    let mut candidate = canonical_root.to_path_buf();
    for segment in relative_path.as_str().split('/') {
        candidate.push(segment);
        let metadata = fs::symlink_metadata(&candidate)
            .map_err(|error| DesktopError::from_io(&error, &candidate, true))?;
        if metadata.file_type().is_symlink() {
            return Err(
                DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                    .with_path_hint(&candidate),
            );
        }
    }

    // Commands must resolve immediately before I/O as well; this final canonical check closes
    // lexical traversal and detects a component replacement that occurred during validation.
    let resolved = fs::canonicalize(&candidate)
        .map_err(|error| DesktopError::from_io(&error, &candidate, true))?;
    if !resolved.starts_with(canonical_root) {
        return Err(
            DesktopError::new(DesktopErrorCode::PathOutsideWorkspace, true, false)
                .with_path_hint(&candidate),
        );
    }

    Ok(resolved)
}

pub fn windows_path_identity(path: &str) -> Result<String, DesktopError> {
    if path.trim().is_empty() {
        return Err(DesktopError::new(
            DesktopErrorCode::InvalidSelectedRoot,
            true,
            false,
        ));
    }

    let without_extended_prefix = windows_public_path(path);

    if !is_absolute_windows_path(&without_extended_prefix) {
        return Err(DesktopError::new(
            DesktopErrorCode::InvalidSelectedRoot,
            true,
            false,
        ));
    }

    let mut identity = without_extended_prefix.to_lowercase();
    while identity.ends_with('\\') && !is_windows_root(&identity) {
        identity.pop();
    }
    Ok(identity)
}

pub fn windows_public_path(path: &str) -> String {
    let slashes = path.replace('/', "\\");
    if slashes
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("\\\\?\\UNC\\"))
    {
        format!("\\\\{}", &slashes[8..])
    } else if slashes
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("\\\\?\\"))
    {
        slashes[4..].to_owned()
    } else {
        slashes
    }
}

pub(crate) fn serialize_public_path<S>(path: &Path, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let path = path.to_string_lossy();
    #[cfg(windows)]
    let path = windows_public_path(&path);
    path.serialize(serializer)
}

fn is_absolute_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive_absolute =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    let unc_parts = path
        .strip_prefix("\\\\")
        .map(|rest| {
            rest.split('\\')
                .filter(|segment| !segment.is_empty())
                .count()
        })
        .unwrap_or_default();
    drive_absolute || unc_parts >= 2
}

fn is_windows_root(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() == 3 && bytes[1] == b':' && bytes[2] == b'\\')
        || (path.starts_with("\\\\") && path.trim_start_matches('\\').split('\\').count() <= 2)
}

#[cfg(windows)]
pub fn native_path_identity(canonical_path: &Path) -> Result<String, DesktopError> {
    windows_path_identity(&canonical_path.to_string_lossy())
}

#[cfg(not(windows))]
pub fn native_path_identity(canonical_path: &Path) -> Result<String, DesktopError> {
    if !canonical_path.is_absolute() {
        return Err(DesktopError::new(
            DesktopErrorCode::InvalidSelectedRoot,
            true,
            false,
        ));
    }
    Ok(canonical_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::error::DesktopErrorCode;

    use super::{inspect_workspace_root, resolve_existing_workspace_path, windows_path_identity};
    use crate::fs::WorkspaceRelativePath;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("plainroot-{label}-{}-{nonce}", std::process::id()));
            fs::create_dir_all(&path).expect("test directory should be created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn windows_identity_normalizes_extended_prefix_separator_and_case() {
        let examples = [
            r"\\?\C:\Users\Alice\Notes\",
            r"c:/USERS/ALICE/NOTES",
            r"C:\users\alice\notes",
        ];
        let identities =
            examples.map(|path| windows_path_identity(path).expect("path should normalize"));
        assert!(identities
            .iter()
            .all(|path| path == r"c:\users\alice\notes"));

        assert_eq!(
            windows_path_identity(r"\\?\UNC\Server\Share\Notes\")
                .expect("UNC path should normalize"),
            r"\\server\share\notes"
        );
        for invalid in ["notes", r"C:notes", r"\\server"] {
            assert!(
                windows_path_identity(invalid).is_err(),
                "{invalid} is not an absolute Windows path"
            );
        }
        assert_eq!(
            super::windows_public_path(r"\\?\C:\Users\Alice\Notes"),
            r"C:\Users\Alice\Notes"
        );
        assert_eq!(
            super::windows_public_path(r"\\?\UNC\Server\Share\Notes"),
            r"\\Server\Share\Notes"
        );
    }

    #[test]
    fn existing_path_resolves_inside_canonical_root() {
        let directory = TestDirectory::create("inside-root");
        fs::create_dir_all(directory.path().join("docs")).expect("docs should be created");
        fs::write(directory.path().join("docs/guide.md"), "# Guide")
            .expect("fixture should be written");
        let root = fs::canonicalize(directory.path()).expect("root should canonicalize");
        let relative = WorkspaceRelativePath::parse("docs/guide.md").expect("valid path");

        let resolved = resolve_existing_workspace_path(&root, &relative)
            .expect("path inside root should resolve");

        assert_eq!(resolved, root.join("docs/guide.md"));
    }

    #[test]
    fn missing_root_maps_to_stable_error_without_absolute_path() {
        let directory = TestDirectory::create("missing-root");
        let missing = directory.path().join("private/secret-workspace");

        let error = inspect_workspace_root(&missing).expect_err("missing root must fail");
        let json = serde_json::to_string(&error).expect("error should serialize");

        assert_eq!(error.code, DesktopErrorCode::PathNotFound);
        assert_eq!(error.path_hint.as_deref(), Some("secret-workspace"));
        assert!(!json.contains(&directory.path().to_string_lossy().to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn selected_symlink_root_requires_confirmation_and_uses_canonical_target() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::create("root-link");
        let target = directory.path().join("target");
        let selected = directory.path().join("selected");
        fs::create_dir(&target).expect("target should be created");
        symlink(&target, &selected).expect("root symlink should be created");

        let resolution = inspect_workspace_root(&selected).expect("root should resolve");

        assert_eq!(resolution.selected_path(), selected);
        assert_eq!(
            resolution.canonical_root(),
            fs::canonicalize(target).unwrap()
        );
        assert!(resolution.root_is_symlink());
        assert!(resolution.requires_confirmation());
    }

    #[cfg(unix)]
    #[test]
    fn internal_symlinks_outside_root_and_loops_are_rejected_without_following() {
        use std::os::unix::fs::symlink;

        let workspace = TestDirectory::create("inner-links");
        let outside = TestDirectory::create("outside-root");
        fs::write(outside.path().join("secret.md"), "secret").expect("fixture should exist");
        symlink(outside.path(), workspace.path().join("outside-link"))
            .expect("outside link should exist");
        symlink("loop", workspace.path().join("loop")).expect("loop should exist");
        let root = fs::canonicalize(workspace.path()).expect("root should canonicalize");

        for relative in ["outside-link/secret.md", "loop"] {
            let relative = WorkspaceRelativePath::parse(relative).expect("path should parse");
            let error = resolve_existing_workspace_path(&root, &relative)
                .expect_err("internal symlink must not be followed");
            assert_eq!(error.code, DesktopErrorCode::SymlinkNotAllowed);
        }
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_root_maps_to_permission_denied() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::create("unreadable-root");
        let unreadable = directory.path().join("unreadable");
        fs::create_dir(&unreadable).expect("directory should be created");
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000))
            .expect("permissions should change");

        let result = inspect_workspace_root(&unreadable);
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o700))
            .expect("permissions should be restored");

        let error = result.expect_err("unreadable root must fail");
        assert_eq!(error.code, DesktopErrorCode::PermissionDenied);
    }
}
