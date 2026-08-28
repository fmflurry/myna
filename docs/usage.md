# Myna Usage Guide

Welcome to Myna, your local-first AI meeting recorder and summarizer. This guide walks you through the first run, recording a meeting, and using summary templates.

## First Run

### 1. Download Models

Myna requires two AI models (speech-to-text and summarization) and a voice-activity-detection model. Download them once at setup:

```bash
./scripts/download-models.sh
```

This fetches:
- **Parakeet-TDT v3** (640 MB) — speech-to-text in 25 European languages
- **Qwen2.5-Instruct** (2.0 GB) — on-device LLM for summaries
- **Silero VAD** (629 KB) — voice activity detection

Downloads are idempotent; running the script again checks what's already present and skips it.

### 2. Install Dependencies

```bash
npm install                    # Tauri dependencies
npm --prefix ui install        # Angular UI
```

### 3. Launch Myna

```bash
npx tauri dev
```

The Myna window opens. You are now ready to record.

## Choosing a Capture Source

Before recording, decide whether to capture audio from your microphone, system speakers, or both:

### Microphone Only (Recommended for Clarity)

- **Best for**: One-on-one calls where you are speaking.
- **What you capture**: Only your voice.
- **Quality**: No cross-talk, clean audio, optimal transcription.
- **No permission needed**: Works on all macOS versions.

### System Audio Only (Advanced)

- **Best for**: Recording a presentation, webinar, or screen-share playback.
- **What you capture**: Only audio from speaker output (Zoom, YouTube, etc.).
- **Quality**: Good for presentations; poor if you also need to speak (your voice is missing).
- **Requires permission**: macOS 14.4+. Grant system audio recording permission when prompted.

### Microphone + System Audio (Mixed Mode)

- **Best for**: Capturing both you and remote participants in high fidelity.
- **What you capture**: Your voice + speaker output (remote participants, slides audio, etc.).
- **Quality**: High; two independent audio streams mixed at −3 dB per source to avoid clipping.
- **Requires permission**: macOS 14.4+. Grant system audio recording permission when prompted.
- **⚠️ Important**: Wear headphones or use an external speaker (not your Mac's speaker). Without headphones, remote participants are transcribed twice — once from system audio, once from mic echo — degrading transcript quality. Headphones prevent the echo.
- **Why twice on speakers?** When Zoom plays a remote participant's audio through your speaker, Myna captures that audio both from system audio and from your microphone (which picks up the speaker sound). We can't yet suppress this duplication without acoustic echo cancellation.

## Recording a Meeting

### Start Recording

1. Choose your capture source (mic only, system audio only, or mixed).
2. Click the **Record** button in the main window.
3. On first run with system audio or mixed mode:
   - **macOS 14.4+**: Myna will prompt you to grant system audio recording permission. To manage it later, go to System Settings → Privacy & Security → **Screen & System Audio Recording**, where Myna appears under **"System Audio Recording Only"** (note: Myna captures audio only, not video — that's why the pane mentions "Screen"). After granting, **restart Myna** for the change to take effect (macOS caches permissions per process).
   - **macOS 13–14.3**: System audio capture is not available; Myna silently records microphone-only. You will see a notification in the UI.
4. Myna begins recording, displaying a live transcript as you speak.
5. If you requested system audio but permission was denied, Myna silently falls back to microphone-only. You will see a notification in the UI.

### Live Captions

As you record, you see partial captions in real-time. Captions are finalized on voice-activity boundaries (when you pause for ~300ms). This is VAD-segmented simulated streaming: your speech is buffered in short windows, transcribed offline, and partial results are shown immediately.

### Stop Recording

Click the **Stop** button. Myna saves:
- `~/myna/meetings/<id>/audio.wav` — your recording (uncompressed 16 kHz mono WAV).
- `~/myna/meetings/<id>/meeting.json` — metadata (title, start time, transcript).

## Summary Templates

### Built-in Templates

After recording, choose a summary template:

- **Key Points** — extract the main topics discussed.
- **Action Items** — pull out concrete next steps and who owns them.
- **Meeting Notes** — generate structured notes (agenda, discussion, outcomes).
- **Decisions** — highlight decisions made and any dissent.

### Generate a Summary

1. Select a meeting from the list.
2. Click **Summarize**.
3. Choose a template.
4. Myna runs Qwen2.5-Instruct on your transcript and generates a summary.
5. The summary is saved to `~/myna/meetings/<id>/summaries/<template>.md`.

### Custom Templates

You can add your own summary templates without recompiling Myna. Templates are JSON files in `templates/`:

```json
{
  "name": "executive-summary",
  "description": "One-paragraph summary for executives",
  "prompt": "Summarize this meeting transcript in a single paragraph for a C-level audience:\n\n{transcript}",
  "sections": [
    {
      "name": "summary",
      "instructions": "Write the one-paragraph summary here"
    }
  ]
}
```

Placeholders available:
- `{transcript}` — the full meeting transcript
- `{duration}` — meeting duration in seconds
- `{title}` — meeting title
- `{language}` — detected language code (e.g., `en`, `de`, `fr`)

After adding a template, restart Myna and it appears in the summary dropdown.

## Exporting Data

### Manual Export

Myna stores everything in `~/myna/` (your home directory). You can manually copy or backup:

```bash
cp -r ~/myna ~/backups/myna-$(date +%Y%m%d)
```

### Export a Meeting

(UI feature coming soon: export as PDF, DOCX, or ZIP.)

## Where Data Lives

All meeting data is stored locally at:

```
~/myna/meetings/<id>/
├── meeting.json              # Metadata and transcript
├── audio.wav                 # Recording (16 kHz, 16-bit mono)
└── summaries/
    ├── key-points.md
    ├── action-items.md
    ├── meeting-notes.md
    └── decisions.md
```

**Nothing is uploaded to the cloud.** Your recordings and summaries stay on your machine.

### Override Data Location (Development)

For testing or development, set the `MYNA_DATA_DIR` environment variable:

```bash
export MYNA_DATA_DIR=/tmp/myna-test
npx tauri dev
```

## Storage Considerations

A 1-hour meeting at 16 kHz 16-bit mono produces a ~115 MB WAV file. Myna keeps recordings by default (you can delete them from the UI). If disk space becomes an issue, you can manually delete old meetings:

```bash
rm -rf ~/myna/meetings/<id>
```

## Supported Languages

Parakeet-TDT v3 supports:

- **Germanic**: English, German, Dutch, Swedish, Norwegian, Danish, Faroese, Icelandic
- **Romance**: French, Spanish, Italian, Portuguese, Romanian
- **Slavic**: Polish, Czech, Slovak, Slovene, Croatian, Bulgarian
- **Other European**: Hungarian, Finnish, Greek, Lithuanian, Latvian, Estonian

If your meeting is in any of these languages, Myna transcribes with high accuracy. Unsupported languages fall back to English recognition (suboptimal; consider using Myna with English meetings or contributing language-specific models upstream to sherpa-onnx).

## Troubleshooting

### Microphone Permission Denied (macOS)

Myna requires microphone access. If you denied permission on first run:

1. Open **System Settings > Privacy & Security > Microphone**.
2. Find **Myna** and toggle it on.
3. Restart Myna.

### Slow Transcription

- **First run**: Parakeet v3 (640 MB) is loaded into memory on first use; expect 5–10s latency on first recording.
- **Subsequent recordings**: Model stays in memory; transcription is real-time.

### Slow Summary Generation

- **First run**: Qwen2.5-Instruct (2.0 GB) loads into memory; expect 20–30s latency on first summarization.
- **Subsequent summaries**: Model stays in memory; generation is faster.

To speed up both, consider running on a machine with:
- **Metal acceleration** (macOS) — automatically detected by llama.cpp.
- **CUDA acceleration** (Windows/Linux with NVIDIA GPU) — compile llama.cpp with CUDA support (advanced; not in current Tauri build).

### Recording Not Starting

1. Verify microphone is connected and working (test in **System Preferences > Sound**).
2. Ensure `~/myna/` directory is writable: `ls -ld ~/myna/` should show `drwx------` or similar with your username.
3. Check Myna logs (Windows: `%APPDATA%\Myna\logs/`; macOS: `~/Library/Caches/com.myna/logs/`).

## License

Myna is released under the **MIT** License.

Third-party model licenses:
- **Parakeet-TDT weights** — CC-BY-4.0 (attribution required)
- **sherpa-onnx runtime** — Apache-2.0
- **llama.cpp runtime** — MIT
- **Qwen2.5-Instruct model** — Qwen research model agreement (see `https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF`)

When using Myna, you implicitly accept these licenses. Attribution to Parakeet-TDT is required if you distribute Myna or derived works; Myna's README and source code include the required notices.

## Next Steps

- Read the [Architecture & Decisions](../docs/adr/) for how Myna was designed.
- Check [CLAUDE.md](../CLAUDE.md) for developer commands (offline decode, LLM inference, etc.).
- Explore [GitHub Issues](https://github.com/fmflurry/myna) to report bugs or request features.

Enjoy using Myna!
