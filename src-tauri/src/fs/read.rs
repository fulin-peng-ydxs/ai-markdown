use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{DesktopError, DesktopErrorCode};

use super::{FileRevision, LineEnding, TextEncoding, WorkspaceRelativePath};

pub const MAX_INLINE_MARKDOWN_BYTES: u64 = 64 * 1024 * 1024;
const READ_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkdownReadStatus {
    Ready,
    UnsupportedEncoding,
    TooLarge,
}

impl MarkdownReadStatus {
    pub const ALL: &'static [Self] = &[Self::Ready, Self::UnsupportedEncoding, Self::TooLarge];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownReadResult {
    pub relative_path: WorkspaceRelativePath,
    pub status: MarkdownReadStatus,
    pub content: Option<String>,
    pub revision: FileRevision,
}

pub fn read_markdown_file(
    path: &Path,
    relative_path: WorkspaceRelativePath,
) -> Result<MarkdownReadResult, DesktopError> {
    read_markdown_file_with_limit(path, relative_path, MAX_INLINE_MARKDOWN_BYTES)
}

fn read_markdown_file_with_limit(
    path: &Path,
    relative_path: WorkspaceRelativePath,
    inline_limit: u64,
) -> Result<MarkdownReadResult, DesktopError> {
    if !is_markdown_path(path) {
        return Err(
            DesktopError::new(DesktopErrorCode::UnsupportedMarkdownFile, true, false)
                .with_path_hint(path),
        );
    }

    let selected_metadata = std::fs::symlink_metadata(path)
        .map_err(|error| DesktopError::from_io(&error, path, true))?;
    if selected_metadata.file_type().is_symlink() {
        return Err(
            DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                .with_path_hint(path),
        );
    }

    let file = File::open(path).map_err(|error| DesktopError::from_io(&error, path, true))?;
    let before = file
        .metadata()
        .map_err(|error| DesktopError::from_io(&error, path, true))?;
    if !before.is_file() {
        return Err(DesktopError::new(DesktopErrorCode::NotFile, true, false).with_path_hint(path));
    }

    let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, file);
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
    let mut retained = Vec::with_capacity(
        usize::try_from(before.len().min(inline_limit)).unwrap_or(READ_BUFFER_BYTES),
    );
    let mut digest = Sha256::new();
    let mut utf8 = Utf8StreamValidator::default();
    let mut endings = LineEndingCounter::default();
    let mut prefix = Vec::with_capacity(3);
    let mut total = 0_u64;

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| DesktopError::from_io(&error, path, true))?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        total = total.saturating_add(read as u64);
        digest.update(chunk);
        utf8.update(chunk);
        endings.update(chunk);
        if prefix.len() < 3 {
            let needed = 3 - prefix.len();
            prefix.extend_from_slice(&chunk[..chunk.len().min(needed)]);
        }
        if total <= inline_limit {
            retained.extend_from_slice(chunk);
        }
    }

    let after =
        std::fs::metadata(path).map_err(|error| DesktopError::from_io(&error, path, true))?;
    if before.len() != after.len() || modified_millis(&before) != modified_millis(&after) {
        return Err(
            DesktopError::new(DesktopErrorCode::FileChangedDuringRead, true, true)
                .with_path_hint(path),
        );
    }

    let valid_utf8 = utf8.finish();
    let has_bom = prefix.starts_with(&[0xEF, 0xBB, 0xBF]);
    let encoding = if !valid_utf8 {
        TextEncoding::Unsupported
    } else if has_bom {
        TextEncoding::Utf8Bom
    } else {
        TextEncoding::Utf8
    };
    let status = if total > inline_limit {
        MarkdownReadStatus::TooLarge
    } else if !valid_utf8 {
        MarkdownReadStatus::UnsupportedEncoding
    } else {
        MarkdownReadStatus::Ready
    };
    let content = if status == MarkdownReadStatus::Ready {
        if has_bom {
            retained.drain(..3);
        }
        Some(String::from_utf8(retained).expect("validated UTF-8 should decode"))
    } else {
        None
    };

    Ok(MarkdownReadResult {
        relative_path,
        status,
        content,
        revision: FileRevision {
            modified_at: modified_millis(&after),
            size: total,
            content_hash: format!("sha256:{:x}", digest.finalize()),
            encoding,
            line_ending: endings.finish(),
        },
    })
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

fn modified_millis(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

#[derive(Default)]
struct Utf8StreamValidator {
    valid: bool,
    initialized: bool,
    tail: Vec<u8>,
}

impl Utf8StreamValidator {
    fn update(&mut self, chunk: &[u8]) {
        if self.initialized && !self.valid {
            return;
        }
        self.initialized = true;
        self.valid = true;
        let mut bytes = std::mem::take(&mut self.tail);
        bytes.extend_from_slice(chunk);
        if let Err(error) = std::str::from_utf8(&bytes) {
            if error.error_len().is_some() {
                self.valid = false;
            } else {
                self.tail.extend_from_slice(&bytes[error.valid_up_to()..]);
            }
        }
    }

    fn finish(self) -> bool {
        (!self.initialized || self.valid) && self.tail.is_empty()
    }
}

#[derive(Default)]
struct LineEndingCounter {
    crlf: u64,
    lf: u64,
    cr: u64,
    pending_cr: bool,
}

impl LineEndingCounter {
    fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            if self.pending_cr {
                if *byte == b'\n' {
                    self.crlf += 1;
                    self.pending_cr = false;
                    continue;
                }
                self.cr += 1;
                self.pending_cr = false;
            }
            if *byte == b'\r' {
                self.pending_cr = true;
            } else if *byte == b'\n' {
                self.lf += 1;
            }
        }
    }

    fn finish(mut self) -> LineEnding {
        if self.pending_cr {
            self.cr += 1;
        }
        let kinds = u8::from(self.crlf > 0) + u8::from(self.lf > 0) + u8::from(self.cr > 0);
        match kinds {
            0 => LineEnding::None,
            1 if self.crlf > 0 => LineEnding::Crlf,
            1 if self.lf > 0 => LineEnding::Lf,
            1 => LineEnding::Cr,
            _ => LineEnding::Mixed,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use crate::contract_test::{assert_interface_matches, typescript_string_constant_values};
    use crate::fs::{LineEnding, TextEncoding, WorkspaceRelativePath};

    use super::{read_markdown_file_with_limit, MarkdownReadStatus};

    static SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn fixture(name: &str, bytes: &[u8]) -> (PathBuf, WorkspaceRelativePath) {
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("plainroot-read-{}-{sequence}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(name);
        fs::write(&path, bytes).unwrap();
        (path, WorkspaceRelativePath::parse(name).unwrap())
    }

    #[test]
    fn reads_utf8_bom_and_reports_revision_contract() {
        let (path, relative) = fixture("note.md", b"\xEF\xBB\xBF# Note\r\nline\r\n");
        let result = read_markdown_file_with_limit(&path, relative, 1024).unwrap();
        assert_eq!(result.status, MarkdownReadStatus::Ready);
        assert_eq!(result.content.as_deref(), Some("# Note\r\nline\r\n"));
        assert_eq!(result.revision.encoding, TextEncoding::Utf8Bom);
        assert_eq!(result.revision.line_ending, LineEnding::Crlf);
        assert!(result.revision.content_hash.starts_with("sha256:"));
        assert_interface_matches("MarkdownReadResult", &result);
        assert_interface_matches("FileRevision", &result.revision);
        let rust_statuses = super::MarkdownReadStatus::ALL
            .iter()
            .map(|status| {
                serde_json::to_value(status)
                    .expect("read status should serialize")
                    .as_str()
                    .expect("read status should be a string")
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            rust_statuses,
            typescript_string_constant_values("MARKDOWN_READ_STATUSES"),
            "Rust and TypeScript Markdown read statuses drifted"
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn unsupported_encoding_and_large_content_are_not_exposed_for_editing() {
        let (invalid_path, invalid_relative) = fixture("invalid.md", &[0xff, b'\n']);
        let invalid = read_markdown_file_with_limit(&invalid_path, invalid_relative, 1024).unwrap();
        assert_eq!(invalid.status, MarkdownReadStatus::UnsupportedEncoding);
        assert_eq!(invalid.content, None);
        assert_eq!(invalid.revision.encoding, TextEncoding::Unsupported);

        let (large_path, large_relative) = fixture("large.md", b"12345\n");
        let large = read_markdown_file_with_limit(&large_path, large_relative, 4).unwrap();
        assert_eq!(large.status, MarkdownReadStatus::TooLarge);
        assert_eq!(large.content, None);
        assert_eq!(large.revision.size, 6);
        assert_eq!(large.revision.line_ending, LineEnding::Lf);
        let _ = fs::remove_dir_all(invalid_path.parent().unwrap());
        let _ = fs::remove_dir_all(large_path.parent().unwrap());
    }

    #[test]
    fn detects_mixed_and_cr_line_endings() {
        let (path, relative) = fixture("mixed.md", b"a\rb\nc\r\nd");
        let result = read_markdown_file_with_limit(&path, relative, 1024).unwrap();
        assert_eq!(result.revision.line_ending, LineEnding::Mixed);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn validates_utf8_sequences_split_across_read_buffers() {
        let mut bytes = vec![b'a'; super::READ_BUFFER_BYTES - 1];
        bytes.extend_from_slice("文\n".as_bytes());
        let (path, relative) = fixture("boundary.md", &bytes);
        let result = read_markdown_file_with_limit(&path, relative, 128 * 1024).unwrap();
        assert_eq!(result.status, MarkdownReadStatus::Ready);
        assert_eq!(result.revision.encoding, TextEncoding::Utf8);
        assert_eq!(result.revision.line_ending, LineEnding::Lf);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
