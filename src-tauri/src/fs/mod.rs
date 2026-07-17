mod model;
mod path;

pub use model::{
    FileRevision, FsChildrenState, FsEntry, FsEntryKind, LineEnding, TextEncoding,
    WorkspaceDescriptor, WorkspaceId, WorkspaceRelativePath, WorkspaceRootResolution,
};
pub use path::{
    inspect_workspace_root, native_path_identity, resolve_existing_workspace_path,
    windows_path_identity,
};
