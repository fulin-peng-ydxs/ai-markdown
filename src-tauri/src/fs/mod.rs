pub mod delete;
mod model;
pub mod mutate;
mod path;
pub mod read;
pub mod scan;
pub mod watch;

pub use model::{
    FileRevision, FsChildrenState, FsEntry, FsEntryKind, LineEnding, TextEncoding,
    WorkspaceDescriptor, WorkspaceId, WorkspaceRelativePath, WorkspaceRootResolution,
};
pub(crate) use path::serialize_public_path;
pub use path::{
    inspect_workspace_root, metadata_writable_hint, native_path_identity,
    resolve_existing_workspace_path, windows_path_identity, windows_public_path,
};
