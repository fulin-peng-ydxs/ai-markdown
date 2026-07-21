use std::fs;
use std::io;
use std::path::Path;

#[cfg(target_os = "macos")]
use std::ffi::CString;

pub(crate) fn replace_existing(source: &Path, target: &Path) -> io::Result<()> {
    platform_replace_existing(source, target)
}

pub(crate) fn rename_without_replace(source: &Path, target: &Path) -> io::Result<()> {
    platform_rename_without_replace(source, target)
}

#[cfg(not(windows))]
fn platform_replace_existing(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn platform_replace_existing(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = wide_path(source);
    let target = wide_path(target);
    // SAFETY: both buffers are owned, NUL-terminated UTF-16 strings and remain alive for the
    // duration of the Windows API call. These flags replace only the named destination and ask
    // Windows to flush the move before returning.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn platform_rename_without_replace(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;

    const RENAME_EXCL: u32 = 0x0000_0004;
    unsafe extern "C" {
        fn renamex_np(from: *const c_char, to: *const c_char, flags: u32) -> c_int;
    }
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    // SAFETY: both pointers come from live NUL-terminated CString values and remain valid for the
    // duration of the call. RENAME_EXCL is the documented macOS no-replace flag.
    let result = unsafe { renamex_np(source.as_ptr(), target.as_ptr(), RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn platform_rename_without_replace(source: &Path, target: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source = wide_path(source);
    let target = wide_path(target);
    // SAFETY: both buffers are NUL-terminated and remain alive for the duration of the call. The
    // absence of MOVEFILE_REPLACE_EXISTING is the required no-overwrite contract.
    let result = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if result != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_rename_without_replace(source: &Path, target: &Path) -> io::Result<()> {
    // Plainroot targets macOS and Windows. This fallback keeps development tests portable; callers
    // still perform an existence check and hold the shared in-process mutation lock.
    fs::rename(source, target)
}

#[cfg(unix)]
pub(crate) fn sync_parent_directory(target: &Path) -> io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent"))?;
    fs::File::open(parent)?.sync_all()
}

#[cfg(windows)]
pub(crate) fn sync_parent_directory(_target: &Path) -> io::Result<()> {
    // MoveFileExW is called with MOVEFILE_WRITE_THROUGH on Windows.
    Ok(())
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use crate::test_support::TestDirectory;

    #[test]
    fn replacing_an_existing_file_commits_the_source_bytes() {
        let root = TestDirectory::create("atomic-replace");
        let source = root.path().join("source.tmp");
        let target = root.path().join("target.md");
        fs::write(&source, b"new").unwrap();
        fs::write(&target, b"old").unwrap();

        super::replace_existing(&source, &target).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!source.exists());
    }

    #[test]
    fn rename_without_replace_preserves_an_existing_target() {
        let root = TestDirectory::create("atomic-no-replace");
        let source = root.path().join("source.md");
        let target = root.path().join("target.md");
        fs::write(&source, b"source").unwrap();
        fs::write(&target, b"target").unwrap();

        assert!(super::rename_without_replace(&source, &target).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert_eq!(fs::read(&target).unwrap(), b"target");
    }

    #[cfg(windows)]
    #[test]
    fn windows_replace_failure_preserves_source_and_locked_target() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = TestDirectory::create("atomic-locked-target");
        let source = root.path().join("source.tmp");
        let target = root.path().join("target.md");
        fs::write(&source, b"new").unwrap();
        fs::write(&target, b"old").unwrap();
        // share_mode(0) prevents MoveFileExW from deleting/replacing the open destination.
        let locked_target = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();

        assert!(super::replace_existing(&source, &target).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"new");
        drop(locked_target);
        assert_eq!(fs::read(&target).unwrap(), b"old");
    }
}
