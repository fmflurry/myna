//! `myna-stt` CLI: offline Parakeet-TDT decode and VAD-segmented simulated
//! streaming transcription.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use sherpa_onnx::DisplayManager;

use myna_stt::{Cli, SimulatedStreamer, SttConfig, SttEngine, SttError, SttEvent, VadConfig};

fn main() {
    let cli = match Cli::try_parse_from(std::env::args_os()) {
        Ok(cli) => cli,
        Err(err) => err.exit(),
    };

    let result = if cli.stream {
        run_stream(&cli)
    } else {
        run_offline(&cli)
    };

    if let Err(err) = result {
        eprintln!("myna-stt: {err}");
        std::process::exit(1);
    }
}

/// Decodes a WAV file offline and prints the resulting transcript text.
fn run_offline(cli: &Cli) -> Result<(), SttError> {
    let engine = SttEngine::load(&SttConfig {
        model_dir: cli.model.clone(),
        blank_penalty: cli.blank_penalty,
        decoding_method: cli.decoding_method.clone(),
        ..SttConfig::default()
    })?;
    let transcript = engine.transcribe_wav(Path::new(&cli.input))?;
    println!("{}", transcript.full_text());
    Ok(())
}

/// Streams from the default microphone, rendering live partial and final
/// transcript events until Ctrl-C is pressed.
fn run_stream(cli: &Cli) -> Result<(), SttError> {
    let engine = SttEngine::load(&SttConfig {
        model_dir: cli.model.clone(),
        blank_penalty: cli.blank_penalty,
        decoding_method: cli.decoding_method.clone(),
        ..SttConfig::default()
    })?;
    let vad_cfg = VadConfig {
        model_path: cli.vad_model_path(),
        ..VadConfig::default()
    };
    let mut streamer = SimulatedStreamer::new(Arc::new(engine), &vad_cfg)?;

    let stop = Arc::new(AtomicBool::new(false));
    ctrlc::set_handler({
        let stop = Arc::clone(&stop);
        move || stop.store(true, Ordering::Relaxed)
    })
    .expect("failed to install Ctrl-C handler");

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let capture_thread = spawn_capture(Arc::clone(&stop), tx);

    let mut display = DisplayManager::new();
    for samples in rx {
        for event in streamer.push(&samples)? {
            render_event(&mut display, event);
        }
    }
    for event in streamer.finish()? {
        render_event(&mut display, event);
    }

    capture_thread.join().expect("capture thread panicked")?;
    Ok(())
}

/// Runs `myna_audio::capture` on a dedicated thread (it blocks until `stop`
/// is set), forwarding every normalized sample block over `tx`.
fn spawn_capture(
    stop: Arc<AtomicBool>,
    tx: mpsc::Sender<Vec<f32>>,
) -> thread::JoinHandle<Result<(), SttError>> {
    thread::spawn(move || {
        let device = myna_audio::default_input_device()?;
        myna_audio::capture(
            &device,
            &myna_audio::CaptureConfig::default(),
            stop,
            move |samples: &[f32]| {
                let _ = tx.send(samples.to_vec());
            },
        )?;
        Ok(())
    })
}

/// Feeds one [`SttEvent`] into the terminal [`DisplayManager`].
fn render_event(display: &mut DisplayManager, event: SttEvent) {
    match event {
        SttEvent::Partial { text } => display.update_text(&text),
        SttEvent::Final { segment } => {
            display.update_text(&segment.text);
            display.finalize_sentence();
        }
    }
    display.render();
}
