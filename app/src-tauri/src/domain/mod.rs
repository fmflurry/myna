//! Domain model for Myna meetings and summaries.

pub mod folder;
pub mod meeting;
pub mod placement;
pub mod summary;

pub use folder::{Folder, FolderId};
pub use meeting::{Meeting, MeetingId};
pub use placement::{effective_position, resolve_placement, Placement, RANK_GAP};
pub use summary::{Summary, SummaryRef};
