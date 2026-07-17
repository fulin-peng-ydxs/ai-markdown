use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::{
    native_path_identity, resolve_existing_workspace_path, WorkspaceDescriptor, WorkspaceId,
    WorkspaceRelativePath,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAvailability {
    Unchecked,
    Available,
    Missing,
    PermissionDenied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    pub workspace_id: WorkspaceId,
    #[serde(serialize_with = "crate::fs::serialize_public_path")]
    pub canonical_root: PathBuf,
    pub display_name: String,
    pub last_opened_at: u64,
    pub availability: WorkspaceAvailability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionRoot {
    pub workspace_id: WorkspaceId,
    pub window_label: String,
    pub window_state_ref: Option<String>,
    pub last_active_at: u64,
}

#[derive(Debug, Default)]
pub struct WorkspaceRegistry {
    state: RwLock<RegistryState>,
}

#[derive(Debug, Default)]
struct RegistryState {
    by_id: HashMap<WorkspaceId, WorkspaceDescriptor>,
    by_canonical_root: HashMap<String, WorkspaceId>,
}

impl WorkspaceRegistry {
    pub fn register(&self, workspace: WorkspaceDescriptor) -> Result<(), DesktopError> {
        let root_identity = native_path_identity(workspace.canonical_root())?;
        let mut state = self.state.write().map_err(|_| registry_unavailable())?;
        if state.by_id.contains_key(workspace.id())
            || state.by_canonical_root.contains_key(&root_identity)
        {
            return Err(DesktopError::new(
                DesktopErrorCode::WorkspaceAlreadyRegistered,
                true,
                false,
            ));
        }

        state
            .by_canonical_root
            .insert(root_identity, workspace.id().clone());
        state.by_id.insert(workspace.id().clone(), workspace);
        Ok(())
    }

    pub fn workspace(&self, id: &WorkspaceId) -> Result<WorkspaceDescriptor, DesktopError> {
        let state = self.state.read().map_err(|_| registry_unavailable())?;
        state
            .by_id
            .get(id)
            .cloned()
            .ok_or_else(|| DesktopError::new(DesktopErrorCode::WorkspaceNotRegistered, true, false))
    }

    pub fn resolve_existing(
        &self,
        id: &WorkspaceId,
        relative_path: &str,
    ) -> Result<PathBuf, DesktopError> {
        let workspace = self.workspace(id)?;
        let relative_path = WorkspaceRelativePath::parse(relative_path)?;
        resolve_existing_workspace_path(workspace.canonical_root(), &relative_path)
    }
}

fn registry_unavailable() -> DesktopError {
    DesktopError::new(DesktopErrorCode::RegistryUnavailable, true, true)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::contract_test::assert_interface_matches;
    use crate::error::DesktopErrorCode;
    use crate::fs::{inspect_workspace_root, WorkspaceDescriptor, WorkspaceId};

    use super::WorkspaceRegistry;

    fn test_root() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("plainroot-registry-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).expect("root should be created");
        path
    }

    #[test]
    fn registry_requires_registered_id_and_relative_path() {
        let root = test_root();
        fs::write(root.join("README.md"), "# Plainroot").expect("fixture should be created");
        let id = WorkspaceId::parse("workspace-1").expect("id should be valid");
        let resolution = inspect_workspace_root(&root).expect("root should be valid");
        let descriptor =
            WorkspaceDescriptor::from_resolution(id.clone(), resolution, true, None, false)
                .expect("descriptor should be created");
        let registry = WorkspaceRegistry::default();
        registry
            .register(descriptor)
            .expect("workspace should register");

        assert_eq!(
            registry
                .resolve_existing(&id, "README.md")
                .expect("registered path should resolve"),
            fs::canonicalize(root.join("README.md")).unwrap()
        );
        assert_eq!(
            registry
                .resolve_existing(&id, "../secret.md")
                .expect_err("traversal must fail")
                .code,
            DesktopErrorCode::InvalidRelativePath
        );
        assert_eq!(
            registry
                .resolve_existing(&WorkspaceId::parse("workspace-2").unwrap(), "README.md")
                .expect_err("unregistered id must fail")
                .code,
            DesktopErrorCode::WorkspaceNotRegistered
        );

        fs::remove_dir_all(root).expect("fixture should be removed");
    }

    #[test]
    fn registry_rejects_duplicate_canonical_root() {
        let root = test_root();
        let resolution = inspect_workspace_root(&root).expect("root should be valid");
        let first = WorkspaceDescriptor::from_resolution(
            WorkspaceId::parse("workspace-1").unwrap(),
            resolution.clone(),
            true,
            None,
            false,
        )
        .unwrap();
        let second = WorkspaceDescriptor::from_resolution(
            WorkspaceId::parse("workspace-2").unwrap(),
            resolution,
            true,
            None,
            false,
        )
        .unwrap();
        let registry = WorkspaceRegistry::default();
        registry.register(first).unwrap();

        let error = registry
            .register(second)
            .expect_err("same canonical root must not register twice");
        assert_eq!(error.code, DesktopErrorCode::WorkspaceAlreadyRegistered);

        fs::remove_dir_all(root).expect("fixture should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn registry_deduplicates_selected_symlink_and_real_root() {
        use std::os::unix::fs::symlink;

        let parent = test_root();
        let real_root = parent.join("real-root");
        let linked_root = parent.join("linked-root");
        fs::create_dir(&real_root).expect("real root should be created");
        symlink(&real_root, &linked_root).expect("linked root should be created");
        let real = WorkspaceDescriptor::from_resolution(
            WorkspaceId::parse("workspace-real").unwrap(),
            inspect_workspace_root(&real_root).unwrap(),
            true,
            None,
            false,
        )
        .unwrap();
        let linked = WorkspaceDescriptor::from_resolution(
            WorkspaceId::parse("workspace-linked").unwrap(),
            inspect_workspace_root(&linked_root).unwrap(),
            true,
            None,
            true,
        )
        .unwrap();
        let registry = WorkspaceRegistry::default();
        registry.register(real).unwrap();

        let error = registry
            .register(linked)
            .expect_err("link and real root must share one identity");
        assert_eq!(error.code, DesktopErrorCode::WorkspaceAlreadyRegistered);

        fs::remove_dir_all(parent).expect("fixture should be removed");
    }

    #[test]
    fn persisted_state_serialization_matches_typescript_interfaces() {
        let workspace_id = WorkspaceId::parse("workspace-1").unwrap();
        let recent = super::RecentWorkspace {
            workspace_id: workspace_id.clone(),
            canonical_root: "/canonical/root".into(),
            display_name: "root".to_owned(),
            last_opened_at: 1_700_000_000_000,
            availability: super::WorkspaceAvailability::Available,
        };
        assert_interface_matches("RecentWorkspace", &recent);

        let session = super::WorkspaceSessionRoot {
            workspace_id,
            window_label: "workspace-window".to_owned(),
            window_state_ref: Some("window-state-1".to_owned()),
            last_active_at: 1_700_000_000_001,
        };
        assert_interface_matches("WorkspaceSessionRoot", &session);
    }
}
