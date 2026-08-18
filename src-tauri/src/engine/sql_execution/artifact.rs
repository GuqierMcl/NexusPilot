use std::collections::{hash_map::Entry, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use tempfile::NamedTempFile;
use uuid::Uuid;

use crate::error::{IpcError, IpcResult};

pub(crate) const RAW_ARTIFACT_MAX_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const RAW_ARTIFACT_PREVIEW_BYTES: usize = 1024 * 1024;
pub(crate) const RAW_ARTIFACT_BINARY_PREVIEW_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RawArtifactLimits {
    pub max_bytes: u64,
    pub preview_bytes: usize,
    pub binary_preview_bytes: usize,
}

impl Default for RawArtifactLimits {
    fn default() -> Self {
        Self {
            max_bytes: RAW_ARTIFACT_MAX_BYTES,
            preview_bytes: RAW_ARTIFACT_PREVIEW_BYTES,
            binary_preview_bytes: RAW_ARTIFACT_BINARY_PREVIEW_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawArtifactOwner {
    pub profile_id: String,
    pub tab_id: String,
    pub execution_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RawArtifactPreviewMode {
    Text,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawArtifactDescriptor {
    pub artifact_id: String,
    pub byte_length: u64,
    pub preview: String,
    pub preview_truncated: bool,
}

struct RawArtifactEntry {
    path: PathBuf,
    writer: Option<BufWriter<File>>,
    byte_length: u64,
    preview: Vec<u8>,
    completed: bool,
}

struct RawArtifactRecord {
    owner: RawArtifactOwner,
    entry: Mutex<RawArtifactEntry>,
}

#[derive(Clone)]
pub(crate) struct RawArtifactStore {
    root: Arc<PathBuf>,
    limits: RawArtifactLimits,
    entries: Arc<RwLock<HashMap<String, Arc<RawArtifactRecord>>>>,
}

pub(crate) struct RawArtifactWriter {
    store: RawArtifactStore,
    artifact_id: String,
    finished: bool,
}

impl RawArtifactStore {
    pub(crate) fn production() -> Self {
        Self::new(
            std::env::temp_dir()
                .join("NexusPilot")
                .join("sql-execution"),
            RawArtifactLimits::default(),
        )
    }

    fn new(root: PathBuf, limits: RawArtifactLimits) -> Self {
        Self {
            root: Arc::new(root),
            limits,
            entries: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) fn start(&self, owner: RawArtifactOwner) -> IpcResult<RawArtifactWriter> {
        fs::create_dir_all(self.root.as_ref()).map_err(|_| artifact_io_error("create"))?;
        for _ in 0..16 {
            let artifact_id = Uuid::new_v4().to_string();
            let path = self.root.join(&artifact_id);
            let file = match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err(artifact_io_error("create")),
            };
            let record = Arc::new(RawArtifactRecord {
                owner: owner.clone(),
                entry: Mutex::new(RawArtifactEntry {
                    path: path.clone(),
                    writer: Some(BufWriter::new(file)),
                    byte_length: 0,
                    preview: Vec::with_capacity(
                        self.limits
                            .preview_bytes
                            .max(self.limits.binary_preview_bytes),
                    ),
                    completed: false,
                }),
            });
            let mut entries = self
                .entries
                .write()
                .map_err(|_| artifact_lock_error("start"))?;
            match entries.entry(artifact_id.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(record);
                }
                Entry::Occupied(_) => {
                    drop(entries);
                    let _ = fs::remove_file(path);
                    continue;
                }
            }
            return Ok(RawArtifactWriter {
                store: self.clone(),
                artifact_id,
                finished: false,
            });
        }
        Err(artifact_io_error("create"))
    }

    pub(crate) fn save_completed(
        &self,
        owner: &RawArtifactOwner,
        artifact_id: &str,
        destination: &Path,
    ) -> IpcResult<()> {
        let record = self.record(artifact_id)?;
        if &record.owner != owner {
            return Err(artifact_not_found());
        }
        let entry = record
            .entry
            .lock()
            .map_err(|_| artifact_lock_error("save"))?;
        if !entry.completed || entry.writer.is_some() {
            return Err(IpcError::resource_conflict(
                "Raw SQL artifact is not ready to save",
            ));
        }
        validate_destination(self.root.as_ref(), destination)?;
        let parent = destination.parent().ok_or_else(|| {
            IpcError::validation_failed("Raw SQL artifact destination must be a file path")
        })?;
        let mut source = File::open(&entry.path).map_err(|_| artifact_io_error("read"))?;
        let mut sibling = NamedTempFile::new_in(parent).map_err(|_| artifact_io_error("save"))?;
        io::copy(&mut source, &mut sibling).map_err(|_| artifact_io_error("save"))?;
        sibling.flush().map_err(|_| artifact_io_error("save"))?;
        sibling
            .as_file()
            .sync_all()
            .map_err(|_| artifact_io_error("save"))?;
        sibling
            .persist(destination)
            .map_err(|_| artifact_io_error("save"))?;
        Ok(())
    }

    pub(crate) fn release_execution(&self, owner: &RawArtifactOwner) -> IpcResult<()> {
        self.release_matching(|candidate| candidate == owner)
    }

    pub(crate) fn release_tab(&self, tab_id: &str) -> IpcResult<()> {
        self.release_matching(|candidate| candidate.tab_id == tab_id)
    }

    pub(crate) fn release_profile(&self, profile_id: &str) -> IpcResult<()> {
        self.release_matching(|candidate| candidate.profile_id == profile_id)
    }

    pub(crate) fn release_all(&self) -> IpcResult<()> {
        self.release_matching(|_| true)
    }

    fn record(&self, artifact_id: &str) -> IpcResult<Arc<RawArtifactRecord>> {
        self.entries
            .read()
            .map_err(|_| artifact_lock_error("lookup"))?
            .get(artifact_id)
            .cloned()
            .ok_or_else(artifact_not_found)
    }

    fn release_matching(&self, matches: impl Fn(&RawArtifactOwner) -> bool) -> IpcResult<()> {
        let removed = {
            let mut entries = self
                .entries
                .write()
                .map_err(|_| artifact_lock_error("release"))?;
            let ids = entries
                .iter()
                .filter(|(_, record)| matches(&record.owner))
                .map(|(artifact_id, _)| artifact_id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|artifact_id| entries.remove(&artifact_id))
                .collect::<Vec<_>>()
        };
        let mut first_error = None;
        for record in removed {
            if let Err(error) = remove_record_file(&record) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn abort_artifact(&self, artifact_id: &str) -> IpcResult<()> {
        let removed = self
            .entries
            .write()
            .map_err(|_| artifact_lock_error("abort"))?
            .remove(artifact_id);
        if let Some(record) = removed {
            remove_record_file(&record)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn for_test(root: PathBuf, limits: RawArtifactLimits) -> Self {
        Self::new(root, limits)
    }

    #[cfg(test)]
    pub(crate) fn entry_count_for_test(&self) -> usize {
        self.entries
            .read()
            .expect("Raw artifact entries lock")
            .len()
    }
}

impl RawArtifactWriter {
    pub(crate) fn write_chunk(&mut self, chunk: &[u8]) -> IpcResult<()> {
        let record = self.store.record(&self.artifact_id).map_err(|error| {
            if error.code == crate::error::ErrorCode::ResourceNotFound {
                artifact_canceled()
            } else {
                error
            }
        })?;
        let mut entry = record
            .entry
            .lock()
            .map_err(|_| artifact_lock_error("write"))?;
        if entry.completed {
            return Err(artifact_canceled());
        }
        let next_length = entry
            .byte_length
            .checked_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX))
            .ok_or_else(artifact_limit_error)?;
        if next_length > self.store.limits.max_bytes {
            drop(entry);
            self.store.abort_artifact(&self.artifact_id)?;
            return Err(artifact_limit_error());
        }
        let preview_limit = self
            .store
            .limits
            .preview_bytes
            .max(self.store.limits.binary_preview_bytes);
        if entry.preview.len() < preview_limit {
            let remaining = preview_limit - entry.preview.len();
            entry
                .preview
                .extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        }
        let writer = entry.writer.as_mut().ok_or_else(artifact_canceled)?;
        writer
            .write_all(chunk)
            .map_err(|_| artifact_io_error("write"))?;
        entry.byte_length = next_length;
        Ok(())
    }

    pub(crate) fn finish(
        mut self,
        mode: RawArtifactPreviewMode,
    ) -> IpcResult<RawArtifactDescriptor> {
        let record = self.store.record(&self.artifact_id)?;
        let mut entry = record
            .entry
            .lock()
            .map_err(|_| artifact_lock_error("finish"))?;
        let mut writer = entry.writer.take().ok_or_else(artifact_canceled)?;
        writer.flush().map_err(|_| artifact_io_error("finish"))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|_| artifact_io_error("finish"))?;
        drop(writer);
        entry.completed = true;
        let (preview, preview_truncated) =
            build_preview(&entry.preview, entry.byte_length, mode, self.store.limits);
        self.finished = true;
        Ok(RawArtifactDescriptor {
            artifact_id: self.artifact_id.clone(),
            byte_length: entry.byte_length,
            preview,
            preview_truncated,
        })
    }

    pub(crate) fn abort(mut self) -> IpcResult<()> {
        self.store.abort_artifact(&self.artifact_id)?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for RawArtifactWriter {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.store.abort_artifact(&self.artifact_id);
        }
    }
}

fn build_preview(
    bytes: &[u8],
    byte_length: u64,
    mode: RawArtifactPreviewMode,
    limits: RawArtifactLimits,
) -> (String, bool) {
    if mode == RawArtifactPreviewMode::Binary {
        return build_hex_preview(bytes, byte_length, limits.binary_preview_bytes);
    }
    let text_bytes = &bytes[..bytes.len().min(limits.preview_bytes)];
    match std::str::from_utf8(text_bytes) {
        Ok(text) => (
            text.to_string(),
            byte_length > u64::try_from(text_bytes.len()).unwrap_or(u64::MAX),
        ),
        Err(error) if error.error_len().is_none() => {
            let valid = &text_bytes[..error.valid_up_to()];
            (
                std::str::from_utf8(valid).unwrap_or_default().to_string(),
                true,
            )
        }
        Err(_) => build_hex_preview(bytes, byte_length, limits.binary_preview_bytes),
    }
}

fn build_hex_preview(bytes: &[u8], byte_length: u64, limit: usize) -> (String, bool) {
    let shown = &bytes[..bytes.len().min(limit)];
    let encoded = shown
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(" ");
    let preview = if encoded.is_empty() {
        "[hex]".to_string()
    } else {
        format!("[hex] {encoded}")
    };
    (
        preview,
        byte_length > u64::try_from(shown.len()).unwrap_or(u64::MAX),
    )
}

fn validate_destination(root: &Path, destination: &Path) -> IpcResult<()> {
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err(IpcError::validation_failed(
            "Raw SQL artifact destination must be an absolute file path",
        ));
    }
    let parent = destination.parent().ok_or_else(|| {
        IpcError::validation_failed("Raw SQL artifact destination must be a file path")
    })?;
    if !parent.is_dir() {
        return Err(IpcError::validation_failed(
            "Raw SQL artifact destination directory does not exist",
        ));
    }
    let canonical_root = fs::canonicalize(root).map_err(|_| artifact_io_error("validate"))?;
    let canonical_parent = fs::canonicalize(parent).map_err(|_| artifact_io_error("validate"))?;
    let candidate = if destination.exists() {
        fs::canonicalize(destination).map_err(|_| artifact_io_error("validate"))?
    } else {
        canonical_parent.join(
            destination
                .file_name()
                .expect("validated destination filename"),
        )
    };
    if candidate.starts_with(canonical_root) {
        return Err(IpcError::validation_failed(
            "Raw SQL artifact cannot be saved inside internal storage",
        ));
    }
    Ok(())
}

fn remove_record_file(record: &RawArtifactRecord) -> IpcResult<()> {
    let (path, writer) = {
        let mut entry = record
            .entry
            .lock()
            .map_err(|_| artifact_lock_error("release"))?;
        (entry.path.clone(), entry.writer.take())
    };
    drop(writer);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(artifact_io_error("release")),
    }
}

fn artifact_not_found() -> IpcError {
    IpcError::resource_not_found("Raw SQL artifact is not available")
}

fn artifact_canceled() -> IpcError {
    IpcError::operation_canceled(
        "Raw SQL artifact ownership was released",
        "artifact writer is no longer active",
    )
}

fn artifact_limit_error() -> IpcError {
    IpcError::validation_failed("Raw SQL result exceeds the 512 MiB artifact limit")
}

fn artifact_lock_error(operation: &str) -> IpcError {
    IpcError::system_internal(
        "Raw SQL artifact store is unavailable",
        format!("artifact {operation} lock failed"),
    )
}

fn artifact_io_error(operation: &str) -> IpcError {
    IpcError::system_internal(
        "Raw SQL artifact operation failed",
        format!("artifact {operation} filesystem operation failed"),
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use tempfile::TempDir;
    use uuid::Uuid;

    use super::*;
    use crate::error::ErrorCode;

    fn owner(profile_id: &str, tab_id: &str, execution_id: &str) -> RawArtifactOwner {
        RawArtifactOwner {
            profile_id: profile_id.to_string(),
            tab_id: tab_id.to_string(),
            execution_id: execution_id.to_string(),
        }
    }

    fn limits(
        max_bytes: u64,
        preview_bytes: usize,
        binary_preview_bytes: usize,
    ) -> RawArtifactLimits {
        RawArtifactLimits {
            max_bytes,
            preview_bytes,
            binary_preview_bytes,
        }
    }

    fn store(root: &TempDir, limits: RawArtifactLimits) -> RawArtifactStore {
        RawArtifactStore::for_test(root.path().to_path_buf(), limits)
    }

    fn complete(
        store: &RawArtifactStore,
        owner: RawArtifactOwner,
        bytes: &[u8],
        mode: RawArtifactPreviewMode,
    ) -> RawArtifactDescriptor {
        let mut writer = store.start(owner).expect("start artifact");
        writer.write_chunk(bytes).expect("write artifact");
        writer.finish(mode).expect("finish artifact")
    }

    #[test]
    fn writer_enforces_byte_limit_and_removes_the_partial_file() {
        let root = tempfile::tempdir().expect("artifact root");
        let store = store(&root, limits(8, 4, 2));
        let mut writer = store
            .start(owner("profile-1", "tab-1", "execution-1"))
            .expect("start artifact");

        writer.write_chunk(b"abcd").expect("first chunk");
        let error = writer
            .write_chunk(b"efghi")
            .expect_err("artifact must reject bytes over the cap");

        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert_eq!(store.entry_count_for_test(), 0);
        assert!(fs::read_dir(root.path())
            .expect("read artifact root")
            .next()
            .is_none());
    }

    #[test]
    fn finish_builds_lossless_text_and_bounded_hex_previews() {
        let text_root = tempfile::tempdir().expect("text root");
        let text_store = store(&text_root, limits(32, 4, 2));
        let text = complete(
            &text_store,
            owner("profile-1", "tab-text", "execution-text"),
            b"hello",
            RawArtifactPreviewMode::Text,
        );
        assert_eq!(text.byte_length, 5);
        assert_eq!(text.preview, "hell");
        assert!(text.preview_truncated);

        let binary_root = tempfile::tempdir().expect("binary root");
        let binary_store = store(&binary_root, limits(32, 8, 2));
        let binary = complete(
            &binary_store,
            owner("profile-1", "tab-binary", "execution-binary"),
            &[0x00, 0xff, 0x10],
            RawArtifactPreviewMode::Binary,
        );
        assert_eq!(binary.byte_length, 3);
        assert_eq!(binary.preview, "[hex] 00 ff");
        assert!(binary.preview_truncated);

        let invalid_root = tempfile::tempdir().expect("invalid utf8 root");
        let invalid_store = store(&invalid_root, limits(32, 8, 8));
        let invalid = complete(
            &invalid_store,
            owner("profile-1", "tab-invalid", "execution-invalid"),
            &[0xf0, 0x28, 0x8c, 0x28],
            RawArtifactPreviewMode::Text,
        );
        assert_eq!(invalid.preview, "[hex] f0 28 8c 28");
        assert!(!invalid.preview_truncated);
    }

    #[test]
    fn text_preview_never_emits_a_partial_utf8_code_point() {
        let root = tempfile::tempdir().expect("artifact root");
        let store = store(&root, limits(32, 3, 2));
        let descriptor = complete(
            &store,
            owner("profile-1", "tab-1", "execution-1"),
            "é好".as_bytes(),
            RawArtifactPreviewMode::Text,
        );

        assert_eq!(descriptor.preview, "é");
        assert!(descriptor.preview_truncated);
    }

    #[test]
    fn artifact_filename_is_only_an_opaque_uuid() {
        let root = tempfile::tempdir().expect("artifact root");
        let store = store(&root, limits(32, 8, 4));
        let mut writer = store
            .start(owner(
                "sensitive-profile",
                "sensitive-tab",
                "sensitive-execution",
            ))
            .expect("start artifact");
        writer.write_chunk(b"data").expect("write artifact");

        let entry = fs::read_dir(root.path())
            .expect("read root")
            .next()
            .expect("artifact file")
            .expect("artifact entry");
        let filename = entry.file_name().to_string_lossy().into_owned();
        Uuid::parse_str(&filename).expect("artifact filename must be a UUID");
        assert!(!filename.contains("sensitive"));
    }

    #[test]
    fn active_cleanup_closes_the_file_before_delete_and_stops_the_writer() {
        let root = tempfile::tempdir().expect("artifact root");
        let store = store(&root, limits(64, 16, 8));
        let mut writer = store
            .start(owner("profile-1", "tab-1", "execution-1"))
            .expect("start artifact");
        writer.write_chunk(b"partial").expect("write partial");

        store.release_tab("tab-1").expect("release tab");

        assert_eq!(
            writer
                .write_chunk(b"late")
                .expect_err("released writer must stop")
                .code,
            ErrorCode::OperationCanceled,
        );
        assert_eq!(store.entry_count_for_test(), 0);
        assert!(fs::read_dir(root.path())
            .expect("read root")
            .next()
            .is_none());
    }

    #[test]
    fn save_requires_matching_completed_owner_and_keeps_source_for_retries() {
        let root = tempfile::tempdir().expect("artifact root");
        let destination_root = tempfile::tempdir().expect("destination root");
        let store = store(&root, limits(64, 16, 8));
        let artifact_owner = owner("profile-1", "tab-1", "execution-1");
        let descriptor = complete(
            &store,
            artifact_owner.clone(),
            b"hello",
            RawArtifactPreviewMode::Text,
        );
        let first = destination_root.path().join("result.csv");
        let second = destination_root.path().join("result-again.csv");

        let mismatch = owner("profile-1", "tab-1", "other-execution");
        assert_eq!(
            store
                .save_completed(&mismatch, &descriptor.artifact_id, &first)
                .expect_err("owner mismatch must fail")
                .code,
            ErrorCode::ResourceNotFound,
        );
        store
            .save_completed(&artifact_owner, &descriptor.artifact_id, &first)
            .expect("first save");
        store
            .save_completed(&artifact_owner, &descriptor.artifact_id, &second)
            .expect("second save");

        assert_eq!(fs::read(first).expect("first bytes"), b"hello");
        assert_eq!(fs::read(second).expect("second bytes"), b"hello");
        assert_eq!(store.entry_count_for_test(), 1);
    }

    #[test]
    fn save_rejects_unsafe_destinations_and_atomically_replaces_an_existing_file() {
        let root = tempfile::tempdir().expect("artifact root");
        let destination_root = tempfile::tempdir().expect("destination root");
        let store = store(&root, limits(64, 16, 8));
        let artifact_owner = owner("profile-1", "tab-1", "execution-1");
        let descriptor = complete(
            &store,
            artifact_owner.clone(),
            b"new bytes",
            RawArtifactPreviewMode::Text,
        );

        let relative = PathBuf::from("relative-result.csv");
        assert_eq!(
            store
                .save_completed(&artifact_owner, &descriptor.artifact_id, &relative)
                .expect_err("relative destination must fail")
                .code,
            ErrorCode::ValidationFailed,
        );
        let internal = root.path().join("export.csv");
        assert_eq!(
            store
                .save_completed(&artifact_owner, &descriptor.artifact_id, &internal)
                .expect_err("internal destination must fail")
                .code,
            ErrorCode::ValidationFailed,
        );
        let missing_parent = destination_root.path().join("missing").join("result.csv");
        assert_eq!(
            store
                .save_completed(&artifact_owner, &descriptor.artifact_id, &missing_parent)
                .expect_err("missing parent must fail")
                .code,
            ErrorCode::ValidationFailed,
        );

        let destination = destination_root.path().join("replace.csv");
        fs::write(&destination, b"old bytes").expect("write old destination");
        store
            .save_completed(&artifact_owner, &descriptor.artifact_id, &destination)
            .expect("replace destination");
        assert_eq!(fs::read(destination).expect("replaced bytes"), b"new bytes");
        assert_eq!(store.entry_count_for_test(), 1);
    }

    #[test]
    fn save_failure_does_not_consume_the_source_artifact() {
        let root = tempfile::tempdir().expect("artifact root");
        let destination_root = tempfile::tempdir().expect("destination root");
        let store = store(&root, limits(64, 16, 8));
        let artifact_owner = owner("profile-1", "tab-1", "execution-1");
        let descriptor = complete(
            &store,
            artifact_owner.clone(),
            b"retryable",
            RawArtifactPreviewMode::Text,
        );

        let directory_destination = destination_root.path().join("directory");
        fs::create_dir(&directory_destination).expect("create destination directory");
        store
            .save_completed(
                &artifact_owner,
                &descriptor.artifact_id,
                &directory_destination,
            )
            .expect_err("saving over a directory must fail");

        let retry = destination_root.path().join("retry.bin");
        store
            .save_completed(&artifact_owner, &descriptor.artifact_id, &retry)
            .expect("retry save");
        assert_eq!(fs::read(retry).expect("retry bytes"), b"retryable");
    }

    #[test]
    fn release_execution_tab_profile_and_all_remove_only_matching_artifacts() {
        let root = tempfile::tempdir().expect("artifact root");
        let store = store(&root, limits(64, 16, 8));
        let first = owner("profile-1", "tab-1", "execution-1");
        let second = owner("profile-1", "tab-2", "execution-2");
        let third = owner("profile-2", "tab-3", "execution-3");
        complete(&store, first.clone(), b"one", RawArtifactPreviewMode::Text);
        complete(&store, second.clone(), b"two", RawArtifactPreviewMode::Text);
        complete(
            &store,
            third.clone(),
            b"three",
            RawArtifactPreviewMode::Text,
        );

        store.release_execution(&first).expect("release execution");
        assert_eq!(store.entry_count_for_test(), 2);
        store.release_tab("tab-2").expect("release tab");
        assert_eq!(store.entry_count_for_test(), 1);
        store.release_profile("profile-2").expect("release profile");
        assert_eq!(store.entry_count_for_test(), 0);

        complete(&store, first, b"again", RawArtifactPreviewMode::Text);
        complete(&store, second, b"again", RawArtifactPreviewMode::Text);
        store.release_all().expect("release all");
        assert_eq!(store.entry_count_for_test(), 0);
        assert!(fs::read_dir(root.path())
            .expect("read root")
            .next()
            .is_none());
    }
}
