use std::path::{Path, PathBuf};

use serde::{de, Deserialize, Deserializer, Serialize};

use crate::error::{DesktopError, DesktopErrorCode};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct WorkspaceId(String);

impl WorkspaceId {
    pub fn parse(value: impl Into<String>) -> Result<Self, DesktopError> {
        let value = value.into();
        let valid = !value.is_empty()
            && value.len() <= 128
            && value.bytes().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, b'-' | b'_')
            });
        if !valid {
            return Err(DesktopError::new(
                DesktopErrorCode::InvalidWorkspaceId,
                true,
                false,
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for WorkspaceId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::parse(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct WorkspaceRelativePath(String);

impl WorkspaceRelativePath {
    pub fn parse(value: &str) -> Result<Self, DesktopError> {
        if value.is_empty() || value.contains('\0') {
            return Err(invalid_relative_path(value));
        }

        let normalized = value.replace('\\', "/");
        let bytes = normalized.as_bytes();
        let has_drive_prefix =
            bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
        if normalized.starts_with('/') || has_drive_prefix {
            return Err(invalid_relative_path(value));
        }

        let segments = normalized.split('/').collect::<Vec<_>>();
        // A colon is legal on some POSIX file systems but is rejected deliberately so the same
        // relative contract cannot address an NTFS alternate data stream on Windows.
        if segments.iter().any(|segment| {
            segment.is_empty() || matches!(*segment, "." | "..") || segment.contains(':')
        }) {
            return Err(invalid_relative_path(value));
        }

        Ok(Self(segments.join("/")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn to_path_buf(&self) -> PathBuf {
        self.0.split('/').collect()
    }
}

impl<'de> Deserialize<'de> for WorkspaceRelativePath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(de::Error::custom)
    }
}

fn invalid_relative_path(path: &str) -> DesktopError {
    DesktopError::new(DesktopErrorCode::InvalidRelativePath, true, false)
        .with_path_hint(Path::new(path))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRootResolution {
    #[serde(serialize_with = "super::path::serialize_public_path")]
    selected_path: PathBuf,
    #[serde(serialize_with = "super::path::serialize_public_path")]
    canonical_root: PathBuf,
    display_name: String,
    root_is_symlink: bool,
    requires_confirmation: bool,
}

impl WorkspaceRootResolution {
    pub(super) fn new(
        selected_path: PathBuf,
        canonical_root: PathBuf,
        display_name: String,
        root_is_symlink: bool,
    ) -> Self {
        Self {
            selected_path,
            canonical_root,
            display_name,
            root_is_symlink,
            requires_confirmation: root_is_symlink,
        }
    }

    pub fn selected_path(&self) -> &Path {
        &self.selected_path
    }

    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn root_is_symlink(&self) -> bool {
        self.root_is_symlink
    }

    pub fn requires_confirmation(&self) -> bool {
        self.requires_confirmation
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDescriptor {
    id: WorkspaceId,
    #[serde(serialize_with = "super::path::serialize_public_path")]
    selected_path: PathBuf,
    #[serde(serialize_with = "super::path::serialize_public_path")]
    canonical_root: PathBuf,
    display_name: String,
    writable: bool,
    initial_file: Option<WorkspaceRelativePath>,
}

impl WorkspaceDescriptor {
    pub fn from_resolution(
        id: WorkspaceId,
        resolution: WorkspaceRootResolution,
        writable: bool,
        initial_file: Option<WorkspaceRelativePath>,
        root_resolution_confirmed: bool,
    ) -> Result<Self, DesktopError> {
        if resolution.requires_confirmation && !root_resolution_confirmed {
            return Err(
                DesktopError::new(DesktopErrorCode::RootConfirmationRequired, true, false)
                    .with_path_hint(&resolution.selected_path),
            );
        }

        Ok(Self {
            id,
            selected_path: resolution.selected_path,
            canonical_root: resolution.canonical_root,
            display_name: resolution.display_name,
            writable,
            initial_file,
        })
    }

    pub fn id(&self) -> &WorkspaceId {
        &self.id
    }

    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn writable(&self) -> bool {
        self.writable
    }

    pub fn initial_file(&self) -> Option<&WorkspaceRelativePath> {
        self.initial_file.as_ref()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FsEntryKind {
    MarkdownFile,
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FsChildrenState {
    NotLoaded,
    Loading,
    Loaded,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub relative_path: WorkspaceRelativePath,
    pub name: String,
    pub kind: FsEntryKind,
    pub writable: bool,
    pub symlink: bool,
    pub children_state: FsChildrenState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineEnding {
    None,
    Lf,
    Crlf,
    Cr,
    Mixed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRevision {
    pub modified_at: u64,
    pub size: u64,
    pub content_hash: String,
    pub encoding: TextEncoding,
    pub line_ending: LineEnding,
}

#[cfg(test)]
mod tests {
    use crate::contract_test::assert_interface_matches;

    use super::{FileRevision, LineEnding, TextEncoding, WorkspaceId, WorkspaceRelativePath};

    #[test]
    fn relative_path_normalizes_platform_separator() {
        let path = WorkspaceRelativePath::parse("docs\\guide.md").expect("path should be valid");
        assert_eq!(path.as_str(), "docs/guide.md");
    }

    #[test]
    fn relative_path_rejects_parent_absolute_and_windows_prefix_injection() {
        for invalid in [
            "../secret.md",
            "docs/../../secret.md",
            "/etc/passwd",
            "C:\\Users\\alice\\secret.md",
            "\\\\server\\share\\secret.md",
            "docs//secret.md",
            "./secret.md",
            "notes.md:alternate-stream",
            "docs/name:stream.md",
        ] {
            assert!(
                WorkspaceRelativePath::parse(invalid).is_err(),
                "{invalid} must be rejected"
            );
        }
    }

    #[test]
    fn workspace_id_accepts_stable_id_and_rejects_path_text() {
        assert!(WorkspaceId::parse("workspace_01-a").is_ok());
        assert!(WorkspaceId::parse("../workspace").is_err());
        assert!(WorkspaceId::parse("").is_err());
        assert!(serde_json::from_str::<WorkspaceId>("\"../workspace\"").is_err());
        assert!(serde_json::from_str::<WorkspaceRelativePath>("\"../secret.md\"").is_err());
    }

    #[test]
    fn file_revision_serializes_with_frontend_field_names() {
        let revision = FileRevision {
            modified_at: 1_700_000_000_000,
            size: 42,
            content_hash: "sha256:example".to_owned(),
            encoding: TextEncoding::Utf8,
            line_ending: LineEnding::Crlf,
        };

        let json = serde_json::to_value(&revision).expect("revision should serialize");
        assert_eq!(json["modifiedAt"], 1_700_000_000_000_u64);
        assert_eq!(json["contentHash"], "sha256:example");
        assert_eq!(json["lineEnding"], "crlf");
        assert_interface_matches("FileRevision", &revision);
    }

    #[test]
    fn symlink_root_cannot_create_descriptor_without_confirmation() {
        let resolution = super::WorkspaceRootResolution::new(
            "/selected/root".into(),
            "/canonical/root".into(),
            "root".to_owned(),
            true,
        );

        let error = super::WorkspaceDescriptor::from_resolution(
            WorkspaceId::parse("workspace-1").unwrap(),
            resolution,
            true,
            None,
            false,
        )
        .expect_err("symlink root must require confirmation");

        assert_eq!(
            error.code,
            crate::error::DesktopErrorCode::RootConfirmationRequired
        );
    }

    #[test]
    fn workspace_and_entry_serialization_match_typescript_interfaces() {
        let resolution = super::WorkspaceRootResolution::new(
            "/selected/root".into(),
            "/canonical/root".into(),
            "root".to_owned(),
            false,
        );
        assert_interface_matches("WorkspaceRootResolution", &resolution);

        let descriptor = super::WorkspaceDescriptor::from_resolution(
            WorkspaceId::parse("workspace-1").unwrap(),
            resolution,
            true,
            Some(WorkspaceRelativePath::parse("README.md").unwrap()),
            false,
        )
        .unwrap();
        assert_interface_matches("WorkspaceDescriptor", &descriptor);

        let entry = super::FsEntry {
            relative_path: WorkspaceRelativePath::parse("docs/guide.md").unwrap(),
            name: "guide.md".to_owned(),
            kind: super::FsEntryKind::MarkdownFile,
            writable: true,
            symlink: false,
            children_state: super::FsChildrenState::NotLoaded,
        };
        assert_interface_matches("FsEntry", &entry);
    }
}
