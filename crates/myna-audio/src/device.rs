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
