//! Input device enumeration.

use cpal::traits::{DeviceTrait, HostTrait};

use crate::error::AudioError;

/// A minimal, serializable description of an audio input device.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DeviceInfo {
    pub name: String,
}

/// Lists all available audio input devices on the default host.
pub fn list_input_devices() -> Result<Vec<DeviceInfo>, AudioError> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|err| AudioError::Stream(err.to_string()))?;

    let mut infos = Vec::new();
    for device in devices {
        let name = device
            .name()
            .map_err(|err| AudioError::Stream(err.to_string()))?;
        infos.push(DeviceInfo { name });
    }

    Ok(infos)
}

/// Substrings (lowercased) identifying a Bluetooth / Hands-Free Profile
/// input. Opening one for capture flips most headsets (e.g. AirPods) from
/// A2DP music quality to SCO call quality — live output goes quiet even
/// though the recorded tracks look loud — while the system-audio tap alone
/// never touches the input side.
const BLUETOOTH_INPUT_NEEDLES: &[&str] = &[
    "airpod",
    "bluetooth",
    "hands-free",
    "handsfree",
    "hands free",
    "hfp",
];

/// Name parts (lowercased) marking a built-in microphone, preferred when
/// routing away from a Bluetooth input.
const BUILTIN_MIC_NEEDLES: &[&str] = &["built-in", "builtin", "built in", "macbook", "internal"];

/// Returns `true` when `name` looks like a Bluetooth / HFP input — see
/// [`BLUETOOTH_INPUT_NEEDLES`].
pub fn is_bluetooth_input(name: &str) -> bool {
    let lower = name.to_lowercase();
    BLUETOOTH_INPUT_NEEDLES
        .iter()
        .any(|needle| lower.contains(needle))
}

fn is_builtin_mic(name: &str) -> bool {
    let lower = name.to_lowercase();
    BUILTIN_MIC_NEEDLES
        .iter()
        .any(|needle| lower.contains(needle))
}

/// First non-Bluetooth input in `devices`, preferring a built-in
/// microphone; `None` when every (or no) device is a Bluetooth input.
pub fn find_non_bluetooth_mic(devices: &[DeviceInfo]) -> Option<&DeviceInfo> {
    devices
        .iter()
        .find(|device| !is_bluetooth_input(&device.name) && is_builtin_mic(&device.name))
        .or_else(|| {
            devices
                .iter()
                .find(|device| !is_bluetooth_input(&device.name))
        })
}

/// Returns the host's default audio input device.
pub fn default_input_device() -> Result<DeviceInfo, AudioError> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or(AudioError::NoDefaultDevice)?;
    let name = device
        .name()
        .map_err(|err| AudioError::Stream(err.to_string()))?;

    Ok(DeviceInfo { name })
}

/// Lists all available audio output devices on the default host.
pub fn list_output_devices() -> Result<Vec<DeviceInfo>, AudioError> {
    let host = cpal::default_host();
    let devices = host
        .output_devices()
        .map_err(|err| AudioError::Stream(err.to_string()))?;

    let mut infos = Vec::new();
    for device in devices {
        let name = device
            .name()
            .map_err(|err| AudioError::Stream(err.to_string()))?;
        infos.push(DeviceInfo { name });
    }

    Ok(infos)
}

/// Returns the host's default audio output device.
pub fn default_output_device() -> Result<DeviceInfo, AudioError> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or(AudioError::NoDefaultDevice)?;
    let name = device
        .name()
        .map_err(|err| AudioError::Stream(err.to_string()))?;

    Ok(DeviceInfo { name })
}

/// Resolves a `cpal::Device` matching the given `DeviceInfo` by name.
///
/// Used internally by `capture` to re-locate a device after it was
/// enumerated, since `cpal::Device` handles are not `Send + 'static` in a
/// way that survives across the capture API boundary described elsewhere.
pub(crate) fn resolve_device(info: &DeviceInfo) -> Result<cpal::Device, AudioError> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|err| AudioError::Stream(err.to_string()))?;

    for device in devices {
        let name = device
            .name()
            .map_err(|err| AudioError::Stream(err.to_string()))?;
        if name == info.name {
            return Ok(device);
        }
    }

    Err(AudioError::DeviceNotFound(info.name.clone()))
}
