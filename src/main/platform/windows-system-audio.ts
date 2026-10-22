import type { Result } from '../../shared/contracts/common'
import type { AudioObservation } from '../../shared/contracts/tools'
import type { LocalExecutionOptions } from '../ports'
import { failure, parseJson } from './app-control-support'
import type { CommandRunner } from './command-runner'
import type { SystemAudioPort } from './ports'
import { isPercent, verifyAudio } from './system-audio-support'
import type { AudioState } from './system-audio-support'

/**
 * The volume and mute of the default playback device through the Core Audio endpoint interface.
 * A script gets a level and a mute value as its only inputs; the C# side wraps the COM calls.
 */
const AUDIO_PRELUDE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr notify);
  int UnregisterControlChangeNotify(IntPtr notify);
  int GetChannelCount(out uint count);
  int SetMasterVolumeLevel(float level, ref Guid context);
  int SetMasterVolumeLevelScalar(float level, ref Guid context);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
  int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
  int GetChannelVolumeLevel(uint channel, out float level);
  int GetChannelVolumeLevelScalar(uint channel, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int context, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int flow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorCom { }
public static class JarvisAudio {
  static IAudioEndpointVolume Endpoint() {
    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
    IMMDevice device;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object endpoint;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out endpoint));
    return (IAudioEndpointVolume)endpoint;
  }
  public static int Level() {
    float level;
    Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out level));
    return (int)Math.Round(level * 100.0);
  }
  public static bool Muted() {
    bool muted;
    Marshal.ThrowExceptionForHR(Endpoint().GetMute(out muted));
    return muted;
  }
  public static void SetLevel(int percent) {
    Guid context = Guid.Empty;
    Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar((float)(percent / 100.0), ref context));
  }
  public static void SetMuted(bool muted) {
    Guid context = Guid.Empty;
    Marshal.ThrowExceptionForHR(Endpoint().SetMute(muted, ref context));
  }
}
'@
`

const AUDIO_APPLY = `
if ($level -ne $null) { [JarvisAudio]::SetLevel($level) }
if ($muted -ne $null) { [JarvisAudio]::SetMuted($muted) }
ConvertTo-Json -Compress ([pscustomobject]@{ level = [JarvisAudio]::Level(); muted = [JarvisAudio]::Muted() })
`

/** Core Audio keeps a float, so a requested percentage may come back one point away. */
const LEVEL_TOLERANCE = 1

interface WindowsSystemAudioOptions {
  runner: CommandRunner
  /** The Windows directory, where PowerShell lives. */
  systemRoot?: string
}

const near = (actual: number, wanted: number) => Math.abs(actual - wanted) <= LEVEL_TOLERANCE

/**
 * System volume for Windows. Only validated integers and booleans are ever placed in a script,
 * and the script is passed as one encoded argument (no shell).
 */
export class WindowsSystemAudio implements SystemAudioPort {
  constructor(private readonly options: WindowsSystemAudioOptions) {}

  async setVolume(
    level: number,
    options?: LocalExecutionOptions
  ): Promise<Result<AudioObservation>> {
    if (!isPercent(level))
      return failure('invalid_input', '볼륨은 0에서 100 사이의 정수여야 합니다.')
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const changed = await this.apply({ level }, options)
    if (!changed.ok) return changed
    return this.verify(options, (state) => (state.level === null ? null : near(state.level, level)))
  }

  async adjustVolume(
    delta: number,
    options?: LocalExecutionOptions
  ): Promise<Result<AudioObservation>> {
    if (!Number.isInteger(delta) || delta < -100 || delta > 100)
      return failure('invalid_input', '볼륨 변화량은 -100에서 100 사이의 정수여야 합니다.')
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const current = await this.read(options)
    if (!current.ok) return current
    if (current.value.level === null)
      return failure('unavailable', '이 출력 장치는 볼륨을 읽을 수 없어 올리거나 내릴 수 없습니다.')
    const target = Math.min(100, Math.max(0, current.value.level + delta))
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const changed = await this.apply({ level: target }, options)
    if (!changed.ok) return changed
    return this.verify(options, (state) =>
      state.level === null ? null : near(state.level, target)
    )
  }

  async setMuted(
    muted: boolean,
    options?: LocalExecutionOptions
  ): Promise<Result<AudioObservation>> {
    if (typeof muted !== 'boolean')
      return failure('invalid_input', '음소거 값이 올바르지 않습니다.')
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const changed = await this.apply({ muted }, options)
    if (!changed.ok) return changed
    return this.verify(options, (state) => (state.muted === null ? null : state.muted === muted))
  }

  // --- internals -------------------------------------------------------------------------------

  private verify(
    options: LocalExecutionOptions | undefined,
    check: (state: AudioState) => boolean | null
  ): Promise<Result<AudioObservation>> {
    return verifyAudio(() => this.read(options), check)
  }

  private read(options?: LocalExecutionOptions): Promise<Result<AudioState>> {
    return this.apply({}, options)
  }

  /** Applies the given change (if any) and returns the state the device reports afterwards. */
  private async apply(
    change: { level?: number; muted?: boolean },
    options?: LocalExecutionOptions
  ): Promise<Result<AudioState>> {
    const source =
      `${AUDIO_PRELUDE}\n$level = ${change.level === undefined ? '$null' : change.level}\n` +
      `$muted = ${change.muted === undefined ? '$null' : change.muted ? '$true' : '$false'}\n` +
      AUDIO_APPLY
    const result = await this.options.runner.run(
      `${this.options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(source, 'utf16le').toString('base64')
      ],
      { ...(options?.signal ? { signal: options.signal } : {}), timeoutMs: 10_000 }
    )
    if (!result.ok) return result
    if (result.value.code !== 0)
      return failure(
        'unavailable',
        '시스템 볼륨을 읽거나 바꾸지 못했습니다. 재생 장치를 확인해 주세요.'
      )
    const state = parseJson<{ level?: unknown; muted?: unknown }>(result.value.stdout.trim())
    if (!state || !isPercent(state.level) || typeof state.muted !== 'boolean')
      return failure('unavailable', '시스템 볼륨 상태를 읽지 못했습니다.')
    return { ok: true, value: { level: state.level, muted: state.muted } }
  }
}
