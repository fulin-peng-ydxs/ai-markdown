use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::error::{DesktopError, DesktopErrorCode};

use super::delete::DeleteResult;
use super::mutate::WorkspaceMutationResult;
use super::{WorkspaceId, WorkspaceRelativePath};

const RAW_EVENT_CAPACITY: usize = 1024;
const WATCH_BATCH_CAPACITY: usize = 8;
const MAX_ACTIVE_WATCHES: usize = 16;
const MAX_PENDING_EVENTS: usize = 512;
const MAX_SELF_CHANGES: usize = 128;
const EVENT_DEBOUNCE: Duration = Duration::from_millis(120);
const EVENT_MAX_LATENCY: Duration = Duration::from_millis(500);
const ROOT_HEALTH_INTERVAL: Duration = Duration::from_millis(250);
const SELF_CHANGE_LIFETIME: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceWatchChangeKind {
    Create,
    Modify,
    Remove,
    Rename,
    Other,
    RescanRequired,
}

impl WorkspaceWatchChangeKind {
    pub const ALL: &'static [Self] = &[
        Self::Create,
        Self::Modify,
        Self::Remove,
        Self::Rename,
        Self::Other,
        Self::RescanRequired,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceWatchEventSource {
    External,
    Application,
    Mixed,
}

impl WorkspaceWatchEventSource {
    pub const ALL: &'static [Self] = &[Self::External, Self::Application, Self::Mixed];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceWatchStatus {
    Watching,
    RootMissing,
    PermissionDenied,
    Failed,
}

impl WorkspaceWatchStatus {
    pub const ALL: &'static [Self] = &[
        Self::Watching,
        Self::RootMissing,
        Self::PermissionDenied,
        Self::Failed,
    ];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWatchStart {
    pub watch_id: String,
    pub workspace_id: WorkspaceId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWatchEvent {
    pub kind: WorkspaceWatchChangeKind,
    pub paths: Vec<WorkspaceRelativePath>,
    pub source: WorkspaceWatchEventSource,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWatchBatch {
    pub watch_id: String,
    pub sequence: u64,
    pub events: Vec<WorkspaceWatchEvent>,
    pub rescan_directories: Vec<Option<WorkspaceRelativePath>>,
    pub status: WorkspaceWatchStatus,
    pub issue: Option<DesktopError>,
    pub overflowed: bool,
    pub complete: bool,
}

struct WatchSession {
    workspace_id: WorkspaceId,
    receiver: Receiver<WorkspaceWatchBatch>,
    cancel: Arc<AtomicBool>,
    sequence: u64,
}

#[derive(Debug, Clone)]
struct SelfChange {
    created_at: Instant,
    workspace_id: WorkspaceId,
    operation_id: String,
    paths: Vec<String>,
}

#[derive(Default)]
pub struct WorkspaceWatchService {
    sessions: Mutex<HashMap<String, WatchSession>>,
    self_changes: Arc<Mutex<VecDeque<SelfChange>>>,
    next_watch_id: AtomicU64,
    next_operation_id: AtomicU64,
}

impl Drop for WorkspaceWatchService {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for (_, session) in sessions.drain() {
                session.cancel.store(true, Ordering::Release);
            }
        }
    }
}

impl WorkspaceWatchService {
    pub fn start(
        &self,
        workspace_id: WorkspaceId,
        canonical_root: PathBuf,
    ) -> Result<WorkspaceWatchStart, DesktopError> {
        validate_watch_root(&canonical_root)?;
        let mut sessions = self.sessions.lock().map_err(|_| watch_unavailable())?;
        if let Some(previous_id) = sessions
            .iter()
            .find_map(|(id, session)| (session.workspace_id == workspace_id).then(|| id.clone()))
        {
            if let Some(previous) = sessions.remove(&previous_id) {
                previous.cancel.store(true, Ordering::Release);
            }
        }
        if sessions.len() >= MAX_ACTIVE_WATCHES {
            return Err(watch_unavailable());
        }

        let sequence = self.next_watch_id.fetch_add(1, Ordering::Relaxed) + 1;
        let watch_id = format!("watch-{}-{sequence}", std::process::id());
        let cancel = Arc::new(AtomicBool::new(false));
        let overflowed = Arc::new(AtomicBool::new(false));
        let (raw_sender, raw_receiver) = mpsc::sync_channel(RAW_EVENT_CAPACITY);
        let callback_overflow = Arc::clone(&overflowed);
        let mut watcher = RecommendedWatcher::new(
            move |result| match raw_sender.try_send(result) {
                Ok(()) | Err(TrySendError::Disconnected(_)) => {}
                Err(TrySendError::Full(_)) => {
                    callback_overflow.store(true, Ordering::Release);
                }
            },
            Config::default(),
        )
        .map_err(|_| watch_unavailable())?;
        watcher
            .watch(&canonical_root, RecursiveMode::Recursive)
            .map_err(|_| watch_unavailable_with_hint(&canonical_root))?;

        let (sender, receiver) = mpsc::sync_channel(WATCH_BATCH_CAPACITY);
        let worker_watch_id = watch_id.clone();
        let worker_workspace_id = workspace_id.clone();
        let worker_cancel = Arc::clone(&cancel);
        let self_changes = Arc::clone(&self.self_changes);
        thread::Builder::new()
            .name("plainroot-workspace-watch".to_owned())
            .spawn(move || {
                watch_workspace(
                    worker_watch_id,
                    worker_workspace_id,
                    canonical_root,
                    watcher,
                    raw_receiver,
                    sender,
                    worker_cancel,
                    overflowed,
                    self_changes,
                );
            })
            .map_err(|_| watch_unavailable())?;

        sessions.insert(
            watch_id.clone(),
            WatchSession {
                workspace_id: workspace_id.clone(),
                receiver,
                cancel,
                sequence: 0,
            },
        );
        Ok(WorkspaceWatchStart {
            watch_id,
            workspace_id,
        })
    }

    pub fn poll(&self, watch_id: &str) -> Result<WorkspaceWatchBatch, DesktopError> {
        let mut sessions = self.sessions.lock().map_err(|_| watch_unavailable())?;
        let session = sessions.get_mut(watch_id).ok_or_else(watch_not_found)?;
        match session.receiver.try_recv() {
            Ok(batch) => {
                session.sequence = batch.sequence;
                if batch.complete {
                    sessions.remove(watch_id);
                }
                Ok(batch)
            }
            Err(TryRecvError::Empty) => Ok(WorkspaceWatchBatch {
                watch_id: watch_id.to_owned(),
                sequence: session.sequence,
                events: Vec::new(),
                rescan_directories: Vec::new(),
                status: WorkspaceWatchStatus::Watching,
                issue: None,
                overflowed: false,
                complete: false,
            }),
            Err(TryRecvError::Disconnected) => {
                sessions.remove(watch_id);
                Err(watch_not_found())
            }
        }
    }

    pub fn stop(&self, watch_id: &str) -> Result<bool, DesktopError> {
        let mut sessions = self.sessions.lock().map_err(|_| watch_unavailable())?;
        let Some(session) = sessions.remove(watch_id) else {
            return Ok(false);
        };
        session.cancel.store(true, Ordering::Release);
        Ok(true)
    }

    pub fn record_mutation(&self, workspace_id: &WorkspaceId, result: &WorkspaceMutationResult) {
        let mut paths = Vec::with_capacity(2);
        if let Some(previous) = &result.previous_path {
            paths.push(previous.as_str().to_owned());
        }
        paths.push(result.entry.relative_path.as_str().to_owned());
        self.record_self_change(workspace_id, paths);
    }

    pub fn record_delete(&self, workspace_id: &WorkspaceId, result: &DeleteResult) {
        self.record_self_change(workspace_id, vec![result.relative_path.as_str().to_owned()]);
    }

    pub fn record_write(&self, workspace_id: &WorkspaceId, relative_path: &WorkspaceRelativePath) {
        self.record_self_change(workspace_id, vec![relative_path.as_str().to_owned()]);
    }

    fn record_self_change(&self, workspace_id: &WorkspaceId, paths: Vec<String>) {
        let Ok(mut changes) = self.self_changes.lock() else {
            return;
        };
        let now = Instant::now();
        prune_self_changes(&mut changes, now);
        while changes.len() >= MAX_SELF_CHANGES {
            changes.pop_front();
        }
        let sequence = self.next_operation_id.fetch_add(1, Ordering::Relaxed) + 1;
        changes.push_back(SelfChange {
            created_at: now,
            workspace_id: workspace_id.clone(),
            operation_id: format!("operation-{}-{sequence}", std::process::id()),
            paths,
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn watch_workspace(
    watch_id: String,
    workspace_id: WorkspaceId,
    canonical_root: PathBuf,
    _watcher: RecommendedWatcher,
    raw_receiver: Receiver<notify::Result<Event>>,
    sender: SyncSender<WorkspaceWatchBatch>,
    cancel: Arc<AtomicBool>,
    overflowed: Arc<AtomicBool>,
    self_changes: Arc<Mutex<VecDeque<SelfChange>>>,
) {
    let mut sequence = 0_u64;
    let mut pending = Vec::new();
    let mut first_pending_at = None;
    let mut last_event_at = None;
    let mut last_root_check = Instant::now();

    loop {
        if cancel.load(Ordering::Acquire) {
            return;
        }
        match raw_receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(Ok(event)) if !matches!(event.kind, EventKind::Access(_)) => {
                let now = Instant::now();
                first_pending_at.get_or_insert(now);
                last_event_at = Some(now);
                pending.push(event);
            }
            Ok(Ok(_)) => {}
            Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                sequence += 1;
                let (status, issue) = watch_root_issue(&canonical_root).unwrap_or_else(|| {
                    (
                        WorkspaceWatchStatus::Failed,
                        watch_unavailable_with_hint(&canonical_root),
                    )
                });
                let batch = terminal_batch(&watch_id, sequence, status, issue);
                let _ = send_watch_batch(&sender, batch, &cancel);
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if last_root_check.elapsed() >= ROOT_HEALTH_INTERVAL {
            last_root_check = Instant::now();
            if let Some((status, issue)) = watch_root_issue(&canonical_root) {
                sequence += 1;
                let batch = terminal_batch(&watch_id, sequence, status, issue);
                let _ = send_watch_batch(&sender, batch, &cancel);
                return;
            }
        }

        let did_overflow =
            overflowed.swap(false, Ordering::AcqRel) || pending.len() > MAX_PENDING_EVENTS;
        let flush_due = did_overflow
            || last_event_at.is_some_and(|time| time.elapsed() >= EVENT_DEBOUNCE)
            || first_pending_at.is_some_and(|time| time.elapsed() >= EVENT_MAX_LATENCY);
        if flush_due && (!pending.is_empty() || did_overflow) {
            sequence += 1;
            let batch = normalize_events(
                &watch_id,
                sequence,
                &workspace_id,
                &canonical_root,
                std::mem::take(&mut pending),
                did_overflow,
                &self_changes,
            );
            first_pending_at = None;
            last_event_at = None;
            if !send_watch_batch(&sender, batch, &cancel) {
                return;
            }
        }
    }
}

fn normalize_events(
    watch_id: &str,
    sequence: u64,
    workspace_id: &WorkspaceId,
    canonical_root: &Path,
    raw_events: Vec<Event>,
    overflowed: bool,
    self_changes: &Mutex<VecDeque<SelfChange>>,
) -> WorkspaceWatchBatch {
    let mut grouped = BTreeMap::<WorkspaceWatchChangeKind, BTreeSet<String>>::new();
    let mut requires_root_rescan = overflowed;

    for event in raw_events {
        let kind = watch_change_kind(&event.kind);
        let paths = grouped.entry(kind).or_default();
        for path in event.paths {
            match relative_watch_path(canonical_root, &path) {
                RelativeWatchPath::Root => {
                    requires_root_rescan = true;
                }
                RelativeWatchPath::Path(relative) => {
                    if is_hidden_relative(&relative) {
                        continue;
                    }
                    paths.insert(relative);
                }
                RelativeWatchPath::Unsupported => {
                    requires_root_rescan = true;
                }
            }
        }
    }
    if requires_root_rescan {
        grouped
            .entry(WorkspaceWatchChangeKind::RescanRequired)
            .or_default();
    }

    let mut events = Vec::new();
    let mut external_directories = BTreeSet::new();
    let mut consumed_operations = BTreeSet::new();
    for (kind, paths) in grouped {
        let paths = paths.into_iter().collect::<Vec<_>>();
        let (source, operation_id) =
            classify_source(workspace_id, &paths, self_changes, &mut consumed_operations);
        if source != WorkspaceWatchEventSource::Application {
            if requires_root_rescan {
                external_directories.insert(String::new());
            } else {
                external_directories.extend(paths.iter().map(|path| relative_parent(path)));
            }
        }
        events.push(WorkspaceWatchEvent {
            kind,
            paths: paths
                .iter()
                .filter_map(|path| WorkspaceRelativePath::parse(path).ok())
                .collect(),
            source,
            operation_id,
        });
    }
    consume_self_changes(self_changes, &consumed_operations);

    WorkspaceWatchBatch {
        watch_id: watch_id.to_owned(),
        sequence,
        events,
        rescan_directories: external_directories
            .into_iter()
            .map(|path| {
                if path.is_empty() {
                    None
                } else {
                    WorkspaceRelativePath::parse(&path).ok()
                }
            })
            .collect(),
        status: WorkspaceWatchStatus::Watching,
        issue: None,
        overflowed,
        complete: false,
    }
}

fn classify_source(
    workspace_id: &WorkspaceId,
    paths: &[String],
    self_changes: &Mutex<VecDeque<SelfChange>>,
    consumed_operations: &mut BTreeSet<String>,
) -> (WorkspaceWatchEventSource, Option<String>) {
    if paths.is_empty() {
        return (WorkspaceWatchEventSource::External, None);
    }
    let Ok(mut changes) = self_changes.lock() else {
        return (WorkspaceWatchEventSource::External, None);
    };
    prune_self_changes(&mut changes, Instant::now());
    let matching = paths
        .iter()
        .map(|path| {
            changes.iter().find(|change| {
                change.workspace_id == *workspace_id
                    && change.paths.iter().any(|expected| {
                        path == expected || path.starts_with(&format!("{expected}/"))
                    })
            })
        })
        .collect::<Vec<_>>();
    consumed_operations.extend(
        matching
            .iter()
            .filter_map(|change| change.map(|change| change.operation_id.clone())),
    );
    if matching.iter().all(Option::is_some) {
        let first_id = matching[0].map(|change| change.operation_id.as_str());
        if matching
            .iter()
            .all(|change| change.map(|item| item.operation_id.as_str()) == first_id)
        {
            return (
                WorkspaceWatchEventSource::Application,
                first_id.map(str::to_owned),
            );
        }
        return (WorkspaceWatchEventSource::Application, None);
    }
    if matching.iter().any(Option::is_some) {
        (WorkspaceWatchEventSource::Mixed, None)
    } else {
        (WorkspaceWatchEventSource::External, None)
    }
}

fn consume_self_changes(
    self_changes: &Mutex<VecDeque<SelfChange>>,
    consumed_operations: &BTreeSet<String>,
) {
    if consumed_operations.is_empty() {
        return;
    }
    if let Ok(mut changes) = self_changes.lock() {
        changes.retain(|change| !consumed_operations.contains(&change.operation_id));
    }
}

fn prune_self_changes(changes: &mut VecDeque<SelfChange>, now: Instant) {
    changes.retain(|change| now.duration_since(change.created_at) <= SELF_CHANGE_LIFETIME);
}

fn watch_change_kind(kind: &EventKind) -> WorkspaceWatchChangeKind {
    match kind {
        EventKind::Create(_) => WorkspaceWatchChangeKind::Create,
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => WorkspaceWatchChangeKind::Rename,
        EventKind::Modify(_) => WorkspaceWatchChangeKind::Modify,
        EventKind::Remove(_) => WorkspaceWatchChangeKind::Remove,
        _ => WorkspaceWatchChangeKind::Other,
    }
}

enum RelativeWatchPath {
    Root,
    Path(String),
    Unsupported,
}

fn relative_watch_path(canonical_root: &Path, path: &Path) -> RelativeWatchPath {
    let Ok(relative) = path.strip_prefix(canonical_root) else {
        return RelativeWatchPath::Unsupported;
    };
    if relative.as_os_str().is_empty() {
        return RelativeWatchPath::Root;
    }
    let Some(relative) = relative.to_str() else {
        return RelativeWatchPath::Unsupported;
    };
    let normalized = relative.replace('\\', "/");
    match WorkspaceRelativePath::parse(&normalized) {
        Ok(relative) => RelativeWatchPath::Path(relative.as_str().to_owned()),
        Err(_) => RelativeWatchPath::Unsupported,
    }
}

fn is_hidden_relative(path: &str) -> bool {
    path.split('/').any(|component| component.starts_with('.'))
}

fn relative_parent(path: &str) -> String {
    path.rsplit_once('/')
        .map_or_else(String::new, |(parent, _)| parent.to_owned())
}

fn terminal_batch(
    watch_id: &str,
    sequence: u64,
    status: WorkspaceWatchStatus,
    issue: DesktopError,
) -> WorkspaceWatchBatch {
    WorkspaceWatchBatch {
        watch_id: watch_id.to_owned(),
        sequence,
        events: Vec::new(),
        rescan_directories: Vec::new(),
        status,
        issue: Some(issue),
        overflowed: false,
        complete: true,
    }
}

fn send_watch_batch(
    sender: &SyncSender<WorkspaceWatchBatch>,
    mut batch: WorkspaceWatchBatch,
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

fn validate_watch_root(canonical_root: &Path) -> Result<(), DesktopError> {
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
    fs::read_dir(canonical_root)
        .map(|_| ())
        .map_err(|error| DesktopError::from_io(&error, canonical_root, true))
}

fn watch_root_issue(canonical_root: &Path) -> Option<(WorkspaceWatchStatus, DesktopError)> {
    match fs::symlink_metadata(canonical_root) {
        Ok(metadata) if metadata.file_type().is_symlink() => Some((
            WorkspaceWatchStatus::Failed,
            DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                .with_path_hint(canonical_root),
        )),
        Ok(metadata) if !metadata.is_dir() => Some((
            WorkspaceWatchStatus::Failed,
            DesktopError::new(DesktopErrorCode::NotDirectory, true, false)
                .with_path_hint(canonical_root),
        )),
        Ok(_) => match fs::read_dir(canonical_root) {
            Ok(_) => None,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Some((
                WorkspaceWatchStatus::PermissionDenied,
                DesktopError::from_io(&error, canonical_root, true),
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some((
                WorkspaceWatchStatus::RootMissing,
                DesktopError::from_io(&error, canonical_root, true),
            )),
            Err(error) => Some((
                WorkspaceWatchStatus::Failed,
                DesktopError::from_io(&error, canonical_root, true),
            )),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some((
            WorkspaceWatchStatus::RootMissing,
            DesktopError::from_io(&error, canonical_root, true),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Some((
            WorkspaceWatchStatus::PermissionDenied,
            DesktopError::from_io(&error, canonical_root, true),
        )),
        Err(error) => Some((
            WorkspaceWatchStatus::Failed,
            DesktopError::from_io(&error, canonical_root, true),
        )),
    }
}

fn watch_not_found() -> DesktopError {
    DesktopError::new(DesktopErrorCode::WatchNotFound, true, false)
}

fn watch_unavailable() -> DesktopError {
    DesktopError::new(DesktopErrorCode::WatchUnavailable, true, true)
}

fn watch_unavailable_with_hint(path: &Path) -> DesktopError {
    watch_unavailable().with_path_hint(path)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::Duration;

    use notify::{
        event::{CreateKind, DataChange, ModifyKind},
        EventKind,
    };

    use crate::contract_test::{assert_interface_matches, typescript_string_constant_values};
    use crate::fs::mutate::WorkspaceMutationService;
    use crate::fs::WorkspaceId;

    use super::{
        normalize_events, WorkspaceWatchBatch, WorkspaceWatchChangeKind, WorkspaceWatchEventSource,
        WorkspaceWatchService, WorkspaceWatchStatus,
    };

    static SEQUENCE: AtomicU64 = AtomicU64::new(1);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("plainroot-watch-{}-{sequence}", std::process::id()));
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

    fn wait_for_batch(
        service: &WorkspaceWatchService,
        watch_id: &str,
        predicate: impl Fn(&WorkspaceWatchBatch) -> bool,
    ) -> WorkspaceWatchBatch {
        for _ in 0..250 {
            let batch = service.poll(watch_id).unwrap();
            if predicate(&batch) {
                return batch;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("watch batch did not reach the expected state");
    }

    #[test]
    fn external_markdown_change_emits_relative_rescan_without_absolute_path() {
        let root = Fixture::new();
        let service = WorkspaceWatchService::default();
        let start = service
            .start(
                WorkspaceId::parse("ws-external").unwrap(),
                root.path().to_path_buf(),
            )
            .unwrap();
        fs::write(root.path().join("note.md"), "# external").unwrap();

        let batch = wait_for_batch(&service, &start.watch_id, |batch| {
            batch.rescan_directories == vec![None]
        });
        // macOS FSEvents may report only the watched root, while Windows/Linux commonly include
        // the changed file. Both must converge through the same root rescan contract.
        assert!(batch
            .events
            .iter()
            .any(|event| event.source == WorkspaceWatchEventSource::External));
        assert_eq!(batch.rescan_directories, vec![None]);
        let json = serde_json::to_string(&batch).unwrap();
        assert!(!json.contains(root.path().to_string_lossy().as_ref()));
        service.stop(&start.watch_id).unwrap();
    }

    #[test]
    fn self_mutation_is_annotated_and_does_not_schedule_duplicate_rescan() {
        let root = Fixture::new();
        let service = WorkspaceWatchService::default();
        let workspace_id = WorkspaceId::parse("ws-self").unwrap();
        let mutations = WorkspaceMutationService::default();
        let result = mutations
            .create_markdown_file(root.path(), None, "self.md")
            .unwrap();
        service.record_mutation(&workspace_id, &result);
        let event = notify::Event::new(EventKind::Create(CreateKind::File))
            .add_path(root.path().join("self.md"));

        let batch = normalize_events(
            "watch-test",
            1,
            &workspace_id,
            root.path(),
            vec![event],
            false,
            &service.self_changes,
        );
        assert_eq!(batch.events.len(), 1);
        assert_eq!(
            batch.events[0].source,
            WorkspaceWatchEventSource::Application
        );
        assert!(batch.events[0].operation_id.is_some());
        assert!(batch.rescan_directories.is_empty());

        let external_event = notify::Event::new(EventKind::Create(CreateKind::File))
            .add_path(root.path().join("self.md"));
        let external_batch = normalize_events(
            "watch-test",
            2,
            &workspace_id,
            root.path(),
            vec![external_event],
            false,
            &service.self_changes,
        );
        assert_eq!(
            external_batch.events[0].source,
            WorkspaceWatchEventSource::External,
            "a later same-path external event must not reuse the consumed operation"
        );
        assert_eq!(external_batch.rescan_directories, vec![None]);
    }

    #[test]
    fn multiple_self_operations_remain_application_sourced_when_coalesced() {
        let root = Fixture::new();
        let service = WorkspaceWatchService::default();
        let workspace_id = WorkspaceId::parse("ws-self-batch").unwrap();
        let mutations = WorkspaceMutationService::default();
        let first = mutations
            .create_markdown_file(root.path(), None, "one.md")
            .unwrap();
        service.record_mutation(&workspace_id, &first);
        let second = mutations
            .create_markdown_file(root.path(), None, "two.md")
            .unwrap();
        service.record_mutation(&workspace_id, &second);
        let event = notify::Event::new(EventKind::Create(CreateKind::Any))
            .add_path(root.path().join("one.md"))
            .add_path(root.path().join("two.md"));

        let batch = normalize_events(
            "watch-test",
            1,
            &workspace_id,
            root.path(),
            vec![event],
            false,
            &service.self_changes,
        );
        assert_eq!(
            batch.events[0].source,
            WorkspaceWatchEventSource::Application
        );
        assert!(batch.events[0].operation_id.is_none());
        assert!(batch.rescan_directories.is_empty());
    }

    #[test]
    fn saved_path_suppresses_one_multi_kind_batch_but_not_a_later_external_change() {
        let root = Fixture::new();
        let service = WorkspaceWatchService::default();
        let workspace_id = WorkspaceId::parse("ws-save-batch").unwrap();
        let relative = crate::fs::WorkspaceRelativePath::parse("saved.md").unwrap();
        service.record_write(&workspace_id, &relative);
        let created = notify::Event::new(EventKind::Create(CreateKind::File))
            .add_path(root.path().join("saved.md"));
        let modified = notify::Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
            .add_path(root.path().join("saved.md"));

        let application_batch = normalize_events(
            "watch-test",
            1,
            &workspace_id,
            root.path(),
            vec![created, modified],
            false,
            &service.self_changes,
        );
        assert!(application_batch
            .events
            .iter()
            .all(|event| event.source == WorkspaceWatchEventSource::Application));
        assert!(application_batch.rescan_directories.is_empty());

        let external = notify::Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
            .add_path(root.path().join("saved.md"));
        let external_batch = normalize_events(
            "watch-test",
            2,
            &workspace_id,
            root.path(),
            vec![external],
            false,
            &service.self_changes,
        );
        assert_eq!(
            external_batch.events[0].source,
            WorkspaceWatchEventSource::External
        );
        assert_eq!(external_batch.rescan_directories, vec![None]);
    }

    #[test]
    fn event_storm_is_coalesced_into_bounded_kinds_and_directories() {
        let root = Fixture::new();
        let service = WorkspaceWatchService::default();
        let start = service
            .start(
                WorkspaceId::parse("ws-storm").unwrap(),
                root.path().to_path_buf(),
            )
            .unwrap();
        for index in 0..200 {
            fs::write(root.path().join(format!("{index}.md")), "x").unwrap();
        }

        let batch = wait_for_batch(&service, &start.watch_id, |batch| {
            !batch.events.is_empty() || batch.overflowed
        });
        assert!(batch.events.len() <= WorkspaceWatchChangeKind::ALL.len());
        assert!(batch.rescan_directories.len() <= 1);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 200);
        service.stop(&start.watch_id).unwrap();
    }

    #[test]
    fn root_removal_stops_watch_with_retryable_terminal_state() {
        let root = Fixture::new();
        let service = WorkspaceWatchService::default();
        let start = service
            .start(
                WorkspaceId::parse("ws-removed").unwrap(),
                root.path().to_path_buf(),
            )
            .unwrap();
        fs::remove_dir_all(root.path()).unwrap();

        let batch = wait_for_batch(&service, &start.watch_id, |batch| batch.complete);
        assert_eq!(batch.status, WorkspaceWatchStatus::RootMissing);
        assert!(batch.issue.as_ref().is_some_and(|issue| issue.retryable));
        assert!(service.poll(&start.watch_id).is_err());
    }

    #[test]
    fn restarting_workspace_replaces_stale_watch_session() {
        let root = Fixture::new();
        let service = WorkspaceWatchService::default();
        let workspace_id = WorkspaceId::parse("ws-restart").unwrap();
        let first = service
            .start(workspace_id.clone(), root.path().to_path_buf())
            .unwrap();
        let second = service
            .start(workspace_id, root.path().to_path_buf())
            .unwrap();

        assert_ne!(first.watch_id, second.watch_id);
        assert!(service.poll(&first.watch_id).is_err());
        assert_eq!(
            service.poll(&second.watch_id).unwrap().status,
            WorkspaceWatchStatus::Watching
        );
        service.stop(&second.watch_id).unwrap();
    }

    #[test]
    fn watch_contracts_and_enum_values_match_typescript() {
        let root = Fixture::new();
        let service = WorkspaceWatchService::default();
        let workspace_id = WorkspaceId::parse("ws-contract").unwrap();
        let start = service
            .start(workspace_id.clone(), root.path().to_path_buf())
            .unwrap();
        assert_interface_matches("WorkspaceWatchStart", &start);

        let event = notify::Event::new(EventKind::Create(CreateKind::File))
            .add_path(root.path().join("contract.md"));
        let batch = normalize_events(
            &start.watch_id,
            1,
            &workspace_id,
            root.path(),
            vec![event],
            false,
            &service.self_changes,
        );
        assert_interface_matches("WorkspaceWatchBatch", &batch);
        assert_interface_matches("WorkspaceWatchEvent", &batch.events[0]);
        assert_eq!(
            enum_values(WorkspaceWatchChangeKind::ALL),
            typescript_string_constant_values("WORKSPACE_WATCH_CHANGE_KINDS")
        );
        assert_eq!(
            enum_values(WorkspaceWatchEventSource::ALL),
            typescript_string_constant_values("WORKSPACE_WATCH_EVENT_SOURCES")
        );
        assert_eq!(
            enum_values(WorkspaceWatchStatus::ALL),
            typescript_string_constant_values("WORKSPACE_WATCH_STATUSES")
        );
        service.stop(&start.watch_id).unwrap();
    }

    fn enum_values<T: serde::Serialize>(values: &[T]) -> Vec<String> {
        values
            .iter()
            .map(|value| {
                serde_json::to_value(value)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect()
    }
}
