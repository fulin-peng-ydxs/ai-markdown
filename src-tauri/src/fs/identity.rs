use std::fs;
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsFileIdentity {
    pub volume_serial: u32,
    pub file_index: u64,
}

pub(crate) fn windows_file_identity(path: &Path) -> io::Result<WindowsFileIdentity> {
    let handle = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the raw handle is owned by `handle` and remains valid for the call; the output
    // structure is initialized and exclusively borrowed until the API returns.
    let result = unsafe {
        GetFileInformationByHandle(
            handle.as_raw_handle().cast(),
            std::ptr::addr_of_mut!(information),
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(WindowsFileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use crate::test_support::TestDirectory;

    #[test]
    fn file_identity_is_stable_and_distinguishes_entries() {
        let root = TestDirectory::create("windows-file-identity");
        let first = root.path().join("first.md");
        let second = root.path().join("second.md");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();

        let first_identity = super::windows_file_identity(&first).unwrap();
        assert_eq!(
            first_identity,
            super::windows_file_identity(&first).unwrap()
        );
        assert_ne!(
            first_identity,
            super::windows_file_identity(&second).unwrap()
        );
    }
}
