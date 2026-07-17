use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;

use crate::error::{DesktopError, DesktopErrorCode};

use super::{FsChildrenState, FsEntry, FsEntryKind, WorkspaceId, WorkspaceRelativePath};

const SCAN_BATCH_SIZE: usize = 128;
const SCAN_CHANNEL_CAPACITY: usize = 4;
const MAX_ACTIVE_SCANS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceScanStart {
    pub scan_id: String,
    pub workspace_id: WorkspaceId,
    pub directory: Option<WorkspaceRelativePath>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceScanBatch {
    pub scan_id: String,
    pub processed: u64,
    pub entries: Vec<FsEntry>,
    pub issues: Vec<DesktopError>,
    pub complete: bool,
    pub cancelled: bool,
}

struct ScanSession {
    key: String,
    receiver: Receiver<WorkspaceScanBatch>,
    cancel: Arc<AtomicBool>,
    processed: u64,
}

#[derive(Default)]
pub struct WorkspaceScanService {
    sessions: Mutex<HashMap<String, ScanSession>>,
    next_id: AtomicU64,
}

impl WorkspaceScanService {
    pub fn start(
        &self,
        workspace_id: WorkspaceId,
        directory: Option<WorkspaceRelativePath>,
        directory_path: PathBuf,
    ) -> Result<WorkspaceScanStart, DesktopError> {
        let key = format!(
            "{}:{}",
            workspace_id.as_str(),
            directory.as_ref().map_or("", WorkspaceRelativePath::as_str)
        );
        let mut sessions = self.sessions.lock().map_err(|_| scan_unavailable())?;
        if let Some(previous_id) = sessions
            .iter()
            .find_map(|(id, session)| (session.key == key).then(|| id.clone()))
        {
            if let Some(previous) = sessions.remove(&previous_id) {
                previous.cancel.store(true, Ordering::Release);
            }
        }
        if sessions.len() >= MAX_ACTIVE_SCANS {
            return Err(scan_unavailable());
        }

        let sequence = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let scan_id = format!("scan-{}-{sequence}", std::process::id());
        let cancel = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::sync_channel(SCAN_CHANNEL_CAPACITY);
        let worker_scan_id = scan_id.clone();
        let worker_directory = directory.clone();
        let worker_cancel = Arc::clone(&cancel);
        thread::Builder::new()
            .name("plainroot-directory-scan".to_owned())
            .spawn(move || {
                scan_directory(
                    worker_scan_id,
                    worker_directory,
                    directory_path,
                    worker_cancel,
                    sender,
                );
            })
            .map_err(|_| scan_unavailable())?;

        sessions.insert(
            scan_id.clone(),
            ScanSession {
                key,
                receiver,
                cancel,
                processed: 0,
            },
        );
        Ok(WorkspaceScanStart {
            scan_id,
            workspace_id,
            directory,
        })
    }

    pub fn poll(&self, scan_id: &str) -> Result<WorkspaceScanBatch, DesktopError> {
        let mut sessions = self.sessions.lock().map_err(|_| scan_unavailable())?;
        let session = sessions.get_mut(scan_id).ok_or_else(scan_not_found)?;
        match session.receiver.try_recv() {
            Ok(batch) => {
                session.processed = batch.processed;
                if batch.complete {
                    sessions.remove(scan_id);
                }
                Ok(batch)
            }
            Err(TryRecvError::Empty) => Ok(WorkspaceScanBatch {
                scan_id: scan_id.to_owned(),
                processed: session.processed,
                entries: Vec::new(),
                issues: Vec::new(),
                complete: false,
                cancelled: false,
            }),
            Err(TryRecvError::Disconnected) => {
                sessions.remove(scan_id);
                Err(scan_not_found())
            }
        }
    }

    pub fn cancel(&self, scan_id: &str) -> Result<bool, DesktopError> {
        let mut sessions = self.sessions.lock().map_err(|_| scan_unavailable())?;
        let Some(session) = sessions.remove(scan_id) else {
            return Ok(false);
        };
        session.cancel.store(true, Ordering::Release);
        Ok(true)
    }
}

fn scan_directory(
    scan_id: String,
    directory: Option<WorkspaceRelativePath>,
    directory_path: PathBuf,
    cancel: Arc<AtomicBool>,
    sender: SyncSender<WorkspaceScanBatch>,
) {
    let mut processed = 0_u64;
    let mut entries = Vec::with_capacity(SCAN_BATCH_SIZE);
    let mut issues = Vec::new();
    let selected_metadata = match fs::symlink_metadata(&directory_path) {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = send_terminal_issue(
                &sender,
                &cancel,
                scan_id,
                DesktopError::from_io(&error, &directory_path, true),
            );
            return;
        }
    };
    if selected_metadata.file_type().is_symlink() {
        let _ = send_terminal_issue(
            &sender,
            &cancel,
            scan_id,
            DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                .with_path_hint(&directory_path),
        );
        return;
    }
    if !selected_metadata.is_dir() {
        let _ = send_terminal_issue(
            &sender,
            &cancel,
            scan_id,
            DesktopError::new(DesktopErrorCode::NotDirectory, true, false)
                .with_path_hint(&directory_path),
        );
        return;
    }
    let iterator = match fs::read_dir(&directory_path) {
        Ok(iterator) => iterator,
        Err(error) => {
            let batch = WorkspaceScanBatch {
                scan_id,
                processed,
                entries,
                issues: vec![DesktopError::from_io(&error, &directory_path, true)],
                complete: true,
                cancelled: false,
            };
            let _ = send_batch(&sender, batch, &cancel);
            return;
        }
    };

    for item in iterator {
        if cancel.load(Ordering::Acquire) {
            let _ = send_batch(
                &sender,
                WorkspaceScanBatch {
                    scan_id: scan_id.clone(),
                    processed,
                    entries,
                    issues,
                    complete: true,
                    cancelled: true,
                },
                &cancel,
            );
            return;
        }
        processed += 1;
        let item = match item {
            Ok(item) => item,
            Err(error) => {
                issues.push(DesktopError::new(
                    match error.kind() {
                        std::io::ErrorKind::PermissionDenied => DesktopErrorCode::PermissionDenied,
                        _ => DesktopErrorCode::IoFailure,
                    },
                    true,
                    true,
                ));
                continue;
            }
        };
        let path = item.path();
        let name = match item.file_name().into_string() {
            Ok(name) => name,
            Err(_) => {
                issues.push(
                    DesktopError::new(DesktopErrorCode::InvalidRelativePath, true, false)
                        .with_path_hint(&path),
                );
                continue;
            }
        };
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                issues.push(DesktopError::from_io(&error, &path, true));
                continue;
            }
        };
        if is_hidden(&name, &metadata) {
            continue;
        }
        if metadata.file_type().is_symlink() {
            issues.push(
                DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                    .with_path_hint(&path),
            );
            continue;
        }
        let kind = if metadata.is_dir() {
            FsEntryKind::Directory
        } else if metadata.is_file() && is_markdown_name(&name) {
            FsEntryKind::MarkdownFile
        } else {
            continue;
        };
        let relative = directory.as_ref().map_or_else(
            || name.clone(),
            |parent| format!("{}/{}", parent.as_str(), name),
        );
        let relative_path = match WorkspaceRelativePath::parse(&relative) {
            Ok(relative_path) => relative_path,
            Err(error) => {
                issues.push(error);
                continue;
            }
        };
        entries.push(FsEntry {
            relative_path,
            name,
            kind,
            writable: !metadata.permissions().readonly(),
            symlink: false,
            children_state: if kind == FsEntryKind::Directory {
                FsChildrenState::NotLoaded
            } else {
                FsChildrenState::Loaded
            },
        });

        if entries.len() + issues.len() >= SCAN_BATCH_SIZE {
            let batch = WorkspaceScanBatch {
                scan_id: scan_id.clone(),
                processed,
                entries: std::mem::replace(&mut entries, Vec::with_capacity(SCAN_BATCH_SIZE)),
                issues: std::mem::take(&mut issues),
                complete: false,
                cancelled: false,
            };
            if !send_batch(&sender, batch, &cancel) {
                return;
            }
        }
    }
    let _ = send_batch(
        &sender,
        WorkspaceScanBatch {
            scan_id,
            processed,
            entries,
            issues,
            complete: true,
            cancelled: false,
        },
        &cancel,
    );
}

fn send_terminal_issue(
    sender: &SyncSender<WorkspaceScanBatch>,
    cancel: &AtomicBool,
    scan_id: String,
    issue: DesktopError,
) -> bool {
    send_batch(
        sender,
        WorkspaceScanBatch {
            scan_id,
            processed: 0,
            entries: Vec::new(),
            issues: vec![issue],
            complete: true,
            cancelled: false,
        },
        cancel,
    )
}

fn send_batch(
    sender: &SyncSender<WorkspaceScanBatch>,
    mut batch: WorkspaceScanBatch,
    cancel: &AtomicBool,
) -> bool {
    loop {
        match sender.try_send(batch) {
            Ok(()) => return true,
            Err(TrySendError::Disconnected(_)) => return false,
            Err(TrySendError::Full(returned)) => {
                if cancel.load(Ordering::Acquire) {
                    return false;
                }
                batch = returned;
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

fn is_markdown_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

#[cfg(not(windows))]
fn is_hidden(name: &str, _metadata: &fs::Metadata) -> bool {
    name.starts_with('.')
}

#[cfg(windows)]
fn is_hidden(name: &str, metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN;

    name.starts_with('.') || metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

fn scan_not_found() -> DesktopError {
    DesktopError::new(DesktopErrorCode::ScanNotFound, true, false)
}

fn scan_unavailable() -> DesktopError {
    DesktopError::new(DesktopErrorCode::ScanUnavailable, true, true)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::Duration;

    use crate::contract_test::assert_interface_matches;
    use crate::fs::{FsEntryKind, WorkspaceId, WorkspaceRelativePath};

    use super::{WorkspaceScanBatch, WorkspaceScanService};

    static SEQUENCE: AtomicU64 = AtomicU64::new(1);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("plainroot-scan-{}-{sequence}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
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

    fn collect(service: &WorkspaceScanService, scan_id: &str) -> Vec<WorkspaceScanBatch> {
        let mut batches = Vec::new();
        for _ in 0..2000 {
            let batch = service.poll(scan_id).unwrap();
            let complete = batch.complete;
            if !batch.entries.is_empty() || !batch.issues.is_empty() || complete {
                batches.push(batch);
            }
            if complete {
                return batches;
            }
            thread::sleep(Duration::from_millis(1));
        }
        panic!("scan did not complete");
    }

    #[test]
    fn scans_markdown_and_directories_in_batches_without_hidden_or_other_files() {
        let root = Fixture::new();
        fs::create_dir(root.path().join("docs")).unwrap();
        fs::write(root.path().join("note.MD"), "# Note").unwrap();
        fs::write(root.path().join("image.png"), "x").unwrap();
        fs::write(root.path().join(".hidden.md"), "x").unwrap();
        let service = WorkspaceScanService::default();
        let start = service
            .start(
                WorkspaceId::parse("ws").unwrap(),
                None,
                root.path().to_path_buf(),
            )
            .unwrap();
        assert_interface_matches("WorkspaceScanStart", &start);
        let batches = collect(&service, &start.scan_id);
        let entries = batches
            .iter()
            .flat_map(|batch| &batch.entries)
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 2);
        assert!(entries
            .iter()
            .any(|entry| entry.kind == FsEntryKind::Directory));
        assert!(entries.iter().any(|entry| entry.name == "note.MD"));
        assert_interface_matches("WorkspaceScanBatch", batches.last().unwrap());
    }

    #[test]
    fn empty_directory_completes_without_entries_or_issues() {
        let root = Fixture::new();
        let service = WorkspaceScanService::default();
        let start = service
            .start(
                WorkspaceId::parse("ws-empty").unwrap(),
                None,
                root.path().to_path_buf(),
            )
            .unwrap();
        let batches = collect(&service, &start.scan_id);
        let final_batch = batches.last().unwrap();
        assert!(final_batch.complete);
        assert!(final_batch.entries.is_empty());
        assert!(final_batch.issues.is_empty());
    }

    #[test]
    fn directory_failure_is_terminal_and_does_not_claim_successful_entries() {
        let root = Fixture::new();
        let missing = root.path().join("removed");
        let service = WorkspaceScanService::default();
        let start = service
            .start(WorkspaceId::parse("ws-missing").unwrap(), None, missing)
            .unwrap();
        let batches = collect(&service, &start.scan_id);
        let final_batch = batches.last().unwrap();
        assert!(final_batch.complete);
        assert!(final_batch.entries.is_empty());
        assert_eq!(final_batch.issues.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_directory_is_a_local_permission_issue() {
        use std::os::unix::fs::PermissionsExt;

        let root = Fixture::new();
        let restricted = root.path().join("restricted");
        fs::create_dir(&restricted).unwrap();
        fs::set_permissions(&restricted, fs::Permissions::from_mode(0o000)).unwrap();
        let service = WorkspaceScanService::default();
        let start = service
            .start(
                WorkspaceId::parse("ws-restricted").unwrap(),
                None,
                restricted.clone(),
            )
            .unwrap();
        let batches = collect(&service, &start.scan_id);
        fs::set_permissions(&restricted, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(batches
            .iter()
            .flat_map(|batch| &batch.issues)
            .any(|issue| issue.code == crate::error::DesktopErrorCode::PermissionDenied));
        assert!(batches
            .iter()
            .flat_map(|batch| &batch.entries)
            .next()
            .is_none());
    }

    #[test]
    fn thousand_files_are_progressive_and_child_directory_is_lazy() {
        let root = Fixture::new();
        fs::create_dir(root.path().join("deep")).unwrap();
        fs::write(root.path().join("deep/child.md"), "x").unwrap();
        for index in 0..1000 {
            fs::write(root.path().join(format!("{index}.md")), "x").unwrap();
        }
        let service = WorkspaceScanService::default();
        let start = service
            .start(
                WorkspaceId::parse("ws-large").unwrap(),
                None,
                root.path().to_path_buf(),
            )
            .unwrap();
        let batches = collect(&service, &start.scan_id);
        assert!(batches.len() > 1);
        assert_eq!(
            batches
                .iter()
                .map(|batch| batch.entries.len())
                .sum::<usize>(),
            1001
        );
        assert_eq!(batches.last().unwrap().processed, 1001);

        let relative = WorkspaceRelativePath::parse("deep").unwrap();
        let child = service
            .start(
                WorkspaceId::parse("ws-large").unwrap(),
                Some(relative),
                root.path().join("deep"),
            )
            .unwrap();
        let child_batches = collect(&service, &child.scan_id);
        assert_eq!(
            child_batches
                .iter()
                .map(|batch| batch.entries.len())
                .sum::<usize>(),
            1
        );
    }

    #[test]
    fn refresh_replaces_previous_scan_and_cancel_is_idempotent() {
        let root = Fixture::new();
        fs::write(root.path().join("note.md"), "x").unwrap();
        let service = WorkspaceScanService::default();
        let first = service
            .start(
                WorkspaceId::parse("ws-refresh").unwrap(),
                None,
                root.path().to_path_buf(),
            )
            .unwrap();
        let second = service
            .start(
                WorkspaceId::parse("ws-refresh").unwrap(),
                None,
                root.path().to_path_buf(),
            )
            .unwrap();
        assert!(service.poll(&first.scan_id).is_err());
        assert!(service.cancel(&second.scan_id).unwrap());
        assert!(!service.cancel(&second.scan_id).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_reported_and_never_followed() {
        use std::os::unix::fs::symlink;
        let root = Fixture::new();
        fs::create_dir(root.path().join("real")).unwrap();
        symlink(root.path().join("real"), root.path().join("loop")).unwrap();
        let service = WorkspaceScanService::default();
        let start = service
            .start(
                WorkspaceId::parse("ws-link").unwrap(),
                None,
                root.path().to_path_buf(),
            )
            .unwrap();
        let batches = collect(&service, &start.scan_id);
        assert!(batches
            .iter()
            .flat_map(|batch| &batch.issues)
            .any(|issue| issue.code == crate::error::DesktopErrorCode::SymlinkNotAllowed));
        assert!(!batches
            .iter()
            .flat_map(|batch| &batch.entries)
            .any(|entry| entry.name == "loop"));
    }
}
