//! Domain model for Myna meetings and summaries.

pub mod meeting;
pub mod summary;

pub use meeting::{Meeting, MeetingId};
pub use summary::{Summary, SummaryRef};
