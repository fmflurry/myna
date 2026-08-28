use std::path::PathBuf;

use myna_stt::Cli;

#[test]
fn parses_documented_offline_decode_command() {
    let cli = Cli::try_parse_from([
        "myna-stt",
        "--model",
        "models/parakeet-tdt-0.6b-v2-int8",
        "--input",
        "recordings/meeting.wav",
    ])
    .expect("offline command line should parse");

    assert_eq!(cli.model, PathBuf::from("models/parakeet-tdt-0.6b-v2-int8"));
    assert_eq!(cli.input, "recordings/meeting.wav");
    assert!(!cli.stream);
}

#[test]
fn parses_documented_streaming_mic_command() {
    let cli = Cli::try_parse_from([
        "myna-stt",
        "--model",
        "models/parakeet-tdt-0.6b-v2-int8",
        "--stream",
        "--input",
        "mic",
    ])
    .expect("streaming command line should parse");

    assert_eq!(cli.input, "mic");
    assert!(cli.stream);
}

#[test]
fn rejects_stream_flag_with_non_mic_input() {
    let result = Cli::try_parse_from([
        "myna-stt",
        "--model",
        "models/parakeet-tdt-0.6b-v2-int8",
        "--stream",
        "--input",
        "recordings/meeting.wav",
    ]);

    assert!(result.is_err());
}

#[test]
fn rejects_mic_input_without_stream_flag() {
    let result = Cli::try_parse_from([
        "myna-stt",
        "--model",
        "models/parakeet-tdt-0.6b-v2-int8",
        "--input",
        "mic",
    ]);

    assert!(result.is_err());
}
