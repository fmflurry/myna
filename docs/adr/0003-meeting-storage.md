# ADR 0003: Filesystem JSON Storage over SQLite

**Status**: Decided (Phase 2)  
**Date**: 2026-08-25  
**Context**: Myna records meetings and stores transcripts, summaries, and metadata. We need a storage layer for the immutable domain model (`Meeting` aggregate). Options: SQLite (embedded, relational) or filesystem JSON (distributed, schema-free).

## Decision

Use **filesystem JSON** for meeting storage:
- **Data root**: `~/myna/` (user's home directory). Override via `MYNA_DATA_DIR` environment variable for development and tests.
- **Layout**:
  ```
  ~/myna/
  └── meetings/
      └── <id>/
          ├── meeting.json              # Meeting metadata, transcript, summary template refs
          ├── audio.wav                 # 16 kHz, 16-bit mono (WAV; uncompressed)
          └── summaries/
              ├── key-points.md
              ├── action-items.md
              ├── meeting-notes.md
              └── decisions.md
  ```
- **Meeting ID**: UUID v4 or short slug (e.g., `meeting-2026-08-25-0`, `5f1c9a2d`).
- **Atomicity**: Write to temporary file, then rename atomically to the target path (`tmp -> meeting.json`).

## Rationale

1. **Simplicity (KISS)**: Filesystem JSON is human-readable, requires no SQL schema design, and has zero SQL injection attack surface. Files are self-contained; no database lock contention.

2. **User ownership**: `~/myna/` is the user's machine; they can inspect files in a text editor, back them up trivially, and migrate data between machines by copying a directory.

3. **No migration burden (YAGNI)**: SQLite would require schema versioning, migration scripts, and upgrading logic. Filesystem JSON evolves naturally: new files in the directory structure, no schema synchronization.

4. **Distributed by nature**: Meeting data is per-user, per-machine. No synchronization, no conflict resolution — a meeting is stored where it was recorded.

5. **Audio storage efficiency**: WAV files (uncompressed 16 kHz, 16-bit mono) are ~115 MB per hour but are immutable and can be archived, deleted, or uploaded to external storage independently of metadata.

## Options Considered

### SQLite
- **Pros**: Structured queries, full-text search over transcripts, backup/restore as single file.
- **Cons**: Schema migration overhead, more complex initialization, overkill for per-user, per-machine data storage.
- **Rejected**: YAGNI. Myna is a local-first app, not a multi-user SaaS. Filesystem JSON handles the current requirement and scales naturally.

### Cloud sync (e.g., iCloud Drive, OneDrive, Dropbox)
- **Pros**: Automatic backup, cross-device sync.
- **Cons**: Sync conflicts, PII exposure to cloud provider, not fully local-first.
- **Rejected**: Violates the "no data sent to the cloud" mandate. Sync is a future extension, not Phase 2.

### Embedded graph database (RocksDB, LevelDB)
- **Pros**: Key-value performance, better than files for random access.
- **Cons**: Extra dependency, format is binary (not human-readable), no standard tooling.
- **Rejected**: Filesystem JSON is good enough; binary formats don't improve the UX for a single-user app.

## Consequences

### Positive
- Transparent and portable: users can back up, inspect, and migrate data without tool knowledge.
- No schema migration scripts to maintain.
- Atomic writes (via tmp+rename) prevent corruption on crash.
- Each meeting is independent; delete one without affecting others.

### Negative
- **Audio size**: A 1-hour meeting is ~115 MB. Users should expect to manage disk space (or implement per-meeting deletion). Mitigation: add a "delete meeting" UI action and storage quota warning.
- **No query performance**: Finding meetings by keyword requires iterating all `meeting.json` files. Mitigation: build an in-memory index on app startup (fast for typical user libraries of 10–100 meetings).
- **No built-in conflict resolution**: If the user opens Myna on two machines and records simultaneously, both writes go to separate directories (no conflict). If a file is edited manually and the app simultaneously writes, the last write wins (standard filesystem behavior).

## Implementation Notes

- **Atomic writes**: All writes via tmp file + `fs.rename()` or equivalent. Never write directly to target path.
- **Data root initialization**: The implementation resolves the user's home directory and joins `myna` to create the data root path (e.g., `/Users/user/myna` on macOS, `C:\Users\user\myna` on Windows, `/home/user/myna` on Linux). This approach is used identically across all platforms — no OS-specific conventions (e.g., macOS `~/Library/Application Support/`) are invoked. This is intentional: the user wants their recordings in a visible, easy-to-back-up location. The `MYNA_DATA_DIR` environment variable can override this path for development and testing.
- **Meeting.json schema**: JSON structure encodes immutable domain model:
  ```json
  {
    "id": "meeting-2026-08-25-0",
    "title": "Q3 Planning",
    "startedAt": "2026-08-25T10:00:00Z",
    "durationSeconds": 3600,
    "language": "en",
    "transcriptUtf8": "...",
    "summaryTemplates": ["key-points", "action-items"],
    "createdAt": "2026-08-25T10:00:00Z",
    "updatedAt": "2026-08-25T11:30:00Z"
  }
  ```
- **Summary files**: Markdown (`.md`), one file per template. Idempotent writes; regenerating a summary overwrites the file.
- **Audio file**: WAV format (immutable after write). No re-encoding or compression.

## References

- Stack proposal section 3 (Audio Capture): ../stack-proposal.md
- Atomic file operations: POSIX rename guarantee (atomic at OS level)
