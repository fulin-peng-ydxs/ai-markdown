mod model;
mod path;

pub use model::{
    FileRevision, FsChildrenState, FsEntry, FsEntryKind, LineEnding, TextEncoding,
    WorkspaceDescriptor, WorkspaceId, WorkspaceRelativePath, WorkspaceRootResolution,
};
pub(crate) use path::serialize_public_path;
pub use path::{
    inspect_workspace_root, native_path_identity, resolve_existing_workspace_path,
    windows_path_identity, windows_public_path,
};
