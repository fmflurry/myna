//! Detokenizes sherpa-onnx subword pieces into words.
//!
//! Parakeet-TDT's `tokens.txt` vocabulary is SentencePiece-style on disk:
//! word-initial pieces carry a leading `▁` (U+2581 LOWER ONE EIGHTH BLOCK)
//! marker (e.g. `"▁not"`), and pieces that continue a word (or attach
//! punctuation) do not. But `OfflineRecognizerResult.tokens` — what this
//! module actually receives at runtime — is sherpa-onnx's own
//! already-normalized *display* form of those pieces, where `▁` has been
//! converted to a plain leading space (e.g. `[" A", "sk", " not", "."]`,
//! never `["▁A", ...]`). Checking only for `▁` therefore never matches
//! anything beyond a token's very first character in practice, and the
//! entire result collapses into a single "word" — the leading spaces
//! embedded in the individual pieces still make the *concatenated* text
//! look correctly spaced, which is why this silently produced plausible
//! output while destroying every per-word boundary. [`strip_word_boundary`]
//! checks for a plain leading space first (the form actually observed at
//! runtime), falling back to the raw `▁` for vocabularies/paths that might
//! still surface it unconverted. Naively space-joining the raw pieces
//! would also shatter every multi-piece word (`"▁dem" "ande" "z"` ->
//! `"dem ande z"` instead of `"demandez"`) and detach punctuation from the
//! word it follows — this module assembles pieces back into words instead.
const WORD_BOUNDARY_MARKER: char = '\u{2581}';

/// Strips a word-boundary marker from the front of `token`, returning the
/// remaining piece text if `token` starts a new word — see the module docs
/// for why both forms must be checked.
fn strip_word_boundary(token: &str) -> Option<&str> {
    token
        .strip_prefix(' ')
        .or_else(|| token.strip_prefix(WORD_BOUNDARY_MARKER))
}

/// One detokenized word, with the timing of its first and last constituent
/// piece.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub text: String,
    pub start_sec: f32,
    pub end_sec: f32,
}

/// Detokenizes subword `tokens` into words, using each piece's `timestamps`
/// (start time) and `durations` (length) to derive every word's start/end
/// time.
///
/// A piece beginning with a word-boundary marker (see
/// [`strip_word_boundary`]) starts a new word (the marker is stripped);
/// any other piece — including punctuation — is appended directly to the
/// current word with no separator. The very first piece always starts a
/// word, even if it lacks the marker, so a stray leading punctuation token
/// is never lost.
///
/// `tokens`, `timestamps`, and `durations` are expected to be the same
/// length; if they differ, pieces beyond the shortest of the three are
/// ignored.
pub fn detokenize(tokens: &[String], timestamps: &[f32], durations: &[f32]) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();

    for ((token, start), duration) in tokens.iter().zip(timestamps.iter()).zip(durations.iter()) {
        let end = *start + *duration;
        let (starts_new_word, piece) = match strip_word_boundary(token) {
            Some(rest) => (true, rest),
            None => (false, token.as_str()),
        };

        if starts_new_word || words.is_empty() {
            words.push(Word {
                text: piece.to_string(),
                start_sec: *start,
                end_sec: end,
            });
        } else if let Some(current) = words.last_mut() {
            current.text.push_str(piece);
            current.end_sec = end;
        }
    }

    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_multi_piece_word_with_no_separator() {
        // Arrange: "demandez" split as sherpa would emit it — only the first
        // piece carries the word-boundary marker.
        let tokens = vec!["▁dem".to_string(), "ande".to_string(), "z".to_string()];
        let timestamps = vec![1.0, 1.2, 1.5];
        let durations = vec![0.2, 0.3, 0.1];

        // Act
        let words = detokenize(&tokens, &timestamps, &durations);

        // Assert
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "demandez");
        assert_eq!(words[0].start_sec, 1.0);
        assert_eq!(words[0].end_sec, 1.6);
    }

    #[test]
    fn splits_words_on_a_plain_leading_space_as_sherpa_onnx_actually_returns_them() {
        // Arrange: `OfflineRecognizerResult.tokens` for Parakeet-TDT, as
        // actually observed at runtime — the SentencePiece `▁` marker
        // already normalized to a plain leading space, not the raw
        // U+2581 character. This is the exact shape that used to collapse
        // into a single "word" (see the module docs).
        let tokens = vec![
            " A".to_string(),
            "sk".to_string(),
            " not".to_string(),
            ".".to_string(),
        ];
        let timestamps = vec![0.0, 0.2, 0.5, 0.9];
        let durations = vec![0.2, 0.1, 0.3, 0.05];

        // Act
        let words = detokenize(&tokens, &timestamps, &durations);

        // Assert
        assert_eq!(
            words.len(),
            2,
            "must split into two words, not collapse into one"
        );
        assert_eq!(words[0].text, "Ask");
        assert_eq!(words[1].text, "not.");
    }

    #[test]
    fn starts_a_new_word_at_each_boundary_marker() {
        // Arrange
        let tokens = vec!["▁Ne".to_string(), "▁vous".to_string()];
        let timestamps = vec![0.0, 0.5];
        let durations = vec![0.2, 0.3];

        // Act
        let words = detokenize(&tokens, &timestamps, &durations);

        // Assert
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "Ne");
        assert_eq!(words[1].text, "vous");
    }

    #[test]
    fn attaches_punctuation_to_the_previous_word_without_a_space() {
        // Arrange: punctuation pieces never carry the boundary marker.
        let tokens = vec!["▁vous".to_string(), ".".to_string()];
        let timestamps = vec![2.0, 2.4];
        let durations = vec![0.3, 0.05];

        // Act
        let words = detokenize(&tokens, &timestamps, &durations);

        // Assert
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "vous.");
        assert_eq!(words[0].end_sec, 2.45);
    }

    #[test]
    fn treats_a_markerless_first_piece_as_the_start_of_a_word() {
        // Arrange: no piece here carries the boundary marker, so the first
        // one must still start a word rather than being silently dropped.
        let tokens = vec!["Hi".to_string()];
        let timestamps = vec![0.0];
        let durations = vec![0.4];

        // Act
        let words = detokenize(&tokens, &timestamps, &durations);

        // Assert
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "Hi");
    }

    #[test]
    fn returns_no_words_for_empty_input() {
        // Arrange
        let tokens: Vec<String> = vec![];
        let timestamps: Vec<f32> = vec![];
        let durations: Vec<f32> = vec![];

        // Act
        let words = detokenize(&tokens, &timestamps, &durations);

        // Assert
        assert!(words.is_empty());
    }

    #[test]
    fn reconstructs_a_full_sentence_across_many_pieces() {
        // Arrange: "Ask not what" with "not" split into two pieces.
        let tokens = vec![
            "▁Ask".to_string(),
            "▁no".to_string(),
            "t".to_string(),
            "▁what".to_string(),
        ];
        let timestamps = vec![0.0, 0.3, 0.5, 0.6];
        let durations = vec![0.2, 0.15, 0.05, 0.25];

        // Act
        let words = detokenize(&tokens, &timestamps, &durations);
        let sentence = words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        // Assert
        assert_eq!(sentence, "Ask not what");
    }
}
