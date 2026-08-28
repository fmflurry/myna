//! Throwaway manual-verification tool: prints the current
//! `list_system_audio_sources()` enumeration, one line per source. Not part
//! of the crate's public surface or test suite — used to eyeball real
//! before/after enumeration output on a real machine.
fn main() {
    let sources = myna_audio::list_system_audio_sources();
    println!("{} source(s):", sources.len());
    for source in &sources {
        println!("{:<45} {}", source.id, source.name);
    }
}
