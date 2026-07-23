use std::fmt;
use std::io;
use std::path::Path;

use serde::Serialize;

macro_rules! define_desktop_error_codes {
    ($($variant:ident),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        #[serde(rename_all = "snake_case")]
        pub enum DesktopErrorCode {
            $($variant),+
        }

        impl DesktopErrorCode {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
        }
    };
}

define_desktop_error_codes!(
    InvalidWorkspaceId,
    WorkspaceNotRegistered,
    WorkspaceAlreadyRegistered,
    InvalidSelectedRoot,
    RootConfirmationRequired,
    InvalidRelativePath,
    PathOutsideWorkspace,
    SymlinkNotAllowed,
    PathNotFound,
    PermissionDenied,
    NotDirectory,
    NotFile,
    IoFailure,
    RegistryUnavailable,
    WindowNotFound,
    WindowCreateFailed,
    WindowFocusFailed,
    WindowTitleFailed,
    WindowCloseFailed,
    StateUnavailable,
    StateReadFailed,
    StateWriteFailed,
    StateBackupFailed,
    UnsupportedStateVersion,
    InvalidStateData,
    DialogUnavailable,
    UnsupportedMarkdownFile,
    SelectionNotFound,
    SelectionUnavailable,
    SelectionConfirmationRequired,
    RecentWorkspaceNotFound,
    ScanNotFound,
    ScanUnavailable,
    WatchNotFound,
    WatchUnavailable,
    FileChangedDuringRead,
    FileRevisionConflict,
    UnsupportedTextEncoding,
    FileTooLarge,
    SafeWriteUnavailable,
    SafeWriteFailed,
    RecoveryUnavailable,
    RecoveryReadFailed,
    RecoveryWriteFailed,
    RecoveryUnsupportedVersion,
    RecoverySnapshotNotFound,
    RecoverySnapshotCorrupt,
    RecoveryCapacityExceeded,
    RecoverySessionNotActive,
    RecoverySnapshotProtected,
    EditorSaveUnavailable,
    ConflictConfirmationNotFound,
    ConflictContentChanged,
    SaveCopyConfirmationNotFound,
    SaveCopyTargetChanged,
    SaveCopyFormatRequired,
    SaveCopyOverwriteConfirmationRequired,
    SaveCopyFailed,
    PreferencesUnavailable,
    PreferencesReadFailed,
    PreferencesWriteFailed,
    PreferencesBackupFailed,
    PreferencesUnsupportedVersion,
    InvalidPreferencesData,
    InvalidAssetDirectory,
    AssetUploadNotFound,
    AssetImportNotFound,
    AssetUnsupportedType,
    AssetMimeMismatch,
    AssetTooLarge,
    AssetPayloadInvalid,
    AssetTargetChanged,
    AssetWriteFailed,
    InvalidEntryName,
    ReservedEntryName,
    TargetAlreadyExists,
    CrossDeviceMove,
    InvalidMoveTarget,
    MutationUnavailable,
    TrashUnavailable,
    PermanentDeleteConfirmationNotFound,
    PermanentDeleteTargetChanged,
    PermanentDeleteFailed,
    RevealUnavailable,
);

impl DesktopErrorCode {
    pub const fn message_key(self) -> &'static str {
        match self {
            Self::InvalidWorkspaceId => "error.workspace.invalidId",
            Self::WorkspaceNotRegistered => "error.workspace.notRegistered",
            Self::WorkspaceAlreadyRegistered => "error.workspace.alreadyRegistered",
            Self::InvalidSelectedRoot => "error.workspace.invalidRoot",
            Self::RootConfirmationRequired => "error.workspace.rootConfirmationRequired",
            Self::InvalidRelativePath => "error.path.invalidRelativePath",
            Self::PathOutsideWorkspace => "error.path.outsideWorkspace",
            Self::SymlinkNotAllowed => "error.path.symlinkNotAllowed",
            Self::PathNotFound => "error.path.notFound",
            Self::PermissionDenied => "error.path.permissionDenied",
            Self::NotDirectory => "error.path.notDirectory",
            Self::NotFile => "error.path.notFile",
            Self::IoFailure => "error.io.failure",
            Self::RegistryUnavailable => "error.workspace.registryUnavailable",
            Self::WindowNotFound => "error.window.notFound",
            Self::WindowCreateFailed => "error.window.createFailed",
            Self::WindowFocusFailed => "error.window.focusFailed",
            Self::WindowTitleFailed => "error.window.titleFailed",
            Self::WindowCloseFailed => "error.window.closeFailed",
            Self::StateUnavailable => "error.state.unavailable",
            Self::StateReadFailed => "error.state.readFailed",
            Self::StateWriteFailed => "error.state.writeFailed",
            Self::StateBackupFailed => "error.state.backupFailed",
            Self::UnsupportedStateVersion => "error.state.unsupportedVersion",
            Self::InvalidStateData => "error.state.invalidData",
            Self::DialogUnavailable => "error.dialog.unavailable",
            Self::UnsupportedMarkdownFile => "error.selection.unsupportedMarkdownFile",
            Self::SelectionNotFound => "error.selection.notFound",
            Self::SelectionUnavailable => "error.selection.unavailable",
            Self::SelectionConfirmationRequired => "error.selection.confirmationRequired",
            Self::RecentWorkspaceNotFound => "error.workspace.recentNotFound",
            Self::ScanNotFound => "error.scan.notFound",
            Self::ScanUnavailable => "error.scan.unavailable",
            Self::WatchNotFound => "error.watch.notFound",
            Self::WatchUnavailable => "error.watch.unavailable",
            Self::FileChangedDuringRead => "error.file.changedDuringRead",
            Self::FileRevisionConflict => "error.file.revisionConflict",
            Self::UnsupportedTextEncoding => "error.file.unsupportedTextEncoding",
            Self::FileTooLarge => "error.file.tooLarge",
            Self::SafeWriteUnavailable => "error.file.safeWriteUnavailable",
            Self::SafeWriteFailed => "error.file.safeWriteFailed",
            Self::RecoveryUnavailable => "error.recovery.unavailable",
            Self::RecoveryReadFailed => "error.recovery.readFailed",
            Self::RecoveryWriteFailed => "error.recovery.writeFailed",
            Self::RecoveryUnsupportedVersion => "error.recovery.unsupportedVersion",
            Self::RecoverySnapshotNotFound => "error.recovery.snapshotNotFound",
            Self::RecoverySnapshotCorrupt => "error.recovery.snapshotCorrupt",
            Self::RecoveryCapacityExceeded => "error.recovery.capacityExceeded",
            Self::RecoverySessionNotActive => "error.recovery.sessionNotActive",
            Self::RecoverySnapshotProtected => "error.recovery.snapshotProtected",
            Self::EditorSaveUnavailable => "error.editorSave.unavailable",
            Self::ConflictConfirmationNotFound => "error.conflict.confirmationNotFound",
            Self::ConflictContentChanged => "error.conflict.contentChanged",
            Self::SaveCopyConfirmationNotFound => "error.saveCopy.confirmationNotFound",
            Self::SaveCopyTargetChanged => "error.saveCopy.targetChanged",
            Self::SaveCopyFormatRequired => "error.saveCopy.formatRequired",
            Self::SaveCopyOverwriteConfirmationRequired => {
                "error.saveCopy.overwriteConfirmationRequired"
            }
            Self::SaveCopyFailed => "error.saveCopy.failed",
            Self::PreferencesUnavailable => "error.preferences.unavailable",
            Self::PreferencesReadFailed => "error.preferences.readFailed",
            Self::PreferencesWriteFailed => "error.preferences.writeFailed",
            Self::PreferencesBackupFailed => "error.preferences.backupFailed",
            Self::PreferencesUnsupportedVersion => "error.preferences.unsupportedVersion",
            Self::InvalidPreferencesData => "error.preferences.invalidData",
            Self::InvalidAssetDirectory => "error.asset.invalidDirectory",
            Self::AssetUploadNotFound => "error.asset.uploadNotFound",
            Self::AssetImportNotFound => "error.asset.importNotFound",
            Self::AssetUnsupportedType => "error.asset.unsupportedType",
            Self::AssetMimeMismatch => "error.asset.mimeMismatch",
            Self::AssetTooLarge => "error.asset.tooLarge",
            Self::AssetPayloadInvalid => "error.asset.payloadInvalid",
            Self::AssetTargetChanged => "error.asset.targetChanged",
            Self::AssetWriteFailed => "error.asset.writeFailed",
            Self::InvalidEntryName => "error.file.invalidName",
            Self::ReservedEntryName => "error.file.reservedName",
            Self::TargetAlreadyExists => "error.file.targetAlreadyExists",
            Self::CrossDeviceMove => "error.file.crossDeviceMove",
            Self::InvalidMoveTarget => "error.file.invalidMoveTarget",
            Self::MutationUnavailable => "error.file.mutationUnavailable",
            Self::TrashUnavailable => "error.file.trashUnavailable",
            Self::PermanentDeleteConfirmationNotFound => {
                "error.file.permanentDeleteConfirmationNotFound"
            }
            Self::PermanentDeleteTargetChanged => "error.file.permanentDeleteTargetChanged",
            Self::PermanentDeleteFailed => "error.file.permanentDeleteFailed",
            Self::RevealUnavailable => "error.file.revealUnavailable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopError {
    pub code: DesktopErrorCode,
    pub message_key: String,
    pub path_hint: Option<String>,
    pub content_safe: bool,
    pub retryable: bool,
}

impl DesktopError {
    pub fn new(code: DesktopErrorCode, content_safe: bool, retryable: bool) -> Self {
        Self {
            code,
            message_key: code.message_key().to_owned(),
            path_hint: None,
            content_safe,
            retryable,
        }
    }

    pub fn with_path_hint(mut self, path: &Path) -> Self {
        self.path_hint = safe_path_hint(path);
        self
    }

    pub fn from_io(error: &io::Error, path: &Path, content_safe: bool) -> Self {
        let (code, retryable) = match error.kind() {
            io::ErrorKind::NotFound => (DesktopErrorCode::PathNotFound, true),
            io::ErrorKind::PermissionDenied => (DesktopErrorCode::PermissionDenied, true),
            _ => (DesktopErrorCode::IoFailure, true),
        };
        Self::new(code, content_safe, retryable).with_path_hint(path)
    }
}

fn safe_path_hint(path: &Path) -> Option<String> {
    path.file_name()
        .or_else(|| path.components().next_back().map(|part| part.as_os_str()))
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
}

impl fmt::Display for DesktopError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message_key)
    }
}

impl std::error::Error for DesktopError {}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use crate::contract_test::{assert_interface_matches, typescript_string_constant_values};

    use super::{DesktopError, DesktopErrorCode};

    #[test]
    fn serialized_error_uses_stable_camel_case_contract_without_absolute_path() {
        let error = DesktopError::new(DesktopErrorCode::PermissionDenied, true, true)
            .with_path_hint(Path::new("/Users/alice/private/notes"));

        let json = serde_json::to_string(&error).expect("error should serialize");

        assert!(json.contains("\"code\":\"permission_denied\""));
        assert!(json.contains("\"messageKey\":\"error.path.permissionDenied\""));
        assert!(json.contains("\"pathHint\":\"notes\""));
        assert!(!json.contains("/Users/alice"));
        assert_interface_matches("DesktopError", &error);

        let rust_codes = DesktopErrorCode::ALL
            .iter()
            .map(|code| {
                serde_json::to_value(code)
                    .expect("error code should serialize")
                    .as_str()
                    .expect("error code should serialize to a string")
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            rust_codes,
            typescript_string_constant_values("DESKTOP_ERROR_CODES"),
            "Rust and TypeScript desktop error code lists drifted"
        );
    }
}
