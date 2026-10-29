import { useEffect } from 'react'
import { useAudioRecorder } from './useAudioRecorder.js'

export default function AudioSettings({ active, checkFirst, onCheckFirst }) {
  const recorder = useAudioRecorder(active)

  useEffect(() => {
    if (active) recorder.refreshDevices()
    else recorder.disconnect()
  }, [active])

  async function enableMicrophone() {
    await recorder.connect()
    recorder.disconnect()
  }

  return (
    <section className="audio-settings-page" aria-labelledby="audio-settings-title">
      <header><p className="eyebrow">PREFERENCES</p><h1 id="audio-settings-title">Settings</h1><p>App-wide microphone and voice-answer preferences. Saved in this browser and used in every conversation.</p></header>
      <div className="settings-card">
        <h2>Microphone</h2>
        <label className="field"><span>Recording device</span><select aria-label="Recording device" value={recorder.deviceId} disabled={!recorder.supported || recorder.status === 'connecting'} onChange={(event) => recorder.chooseDevice(event.target.value)}>
          <option value="">System default</option>
          {recorder.deviceId && !recorder.devices.some((device) => device.deviceId === recorder.deviceId) && <option value={recorder.deviceId}>Selected microphone unavailable</option>}
          {recorder.devices.filter((device) => device.deviceId).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
        </select><small>This device is used across all your topics and conversations.</small></label>
        <div className="settings-actions"><button className="secondary-button" type="button" disabled={!recorder.supported || recorder.status === 'connecting'} onClick={enableMicrophone}>{recorder.status === 'connecting' ? 'Waiting for permission…' : 'Allow microphone access'}</button><button className="quiet-button" type="button" disabled={!recorder.supported} onClick={recorder.refreshDevices}>Refresh devices</button></div>
        <p className="settings-help">Allow access to see microphone names. Recording only starts when you press the record button on a question.</p>
        {(recorder.error || !recorder.supported) && <p className="voice-error" role="alert">{recorder.error || 'Voice recording requires a supported browser on localhost or HTTPS.'}</p>}
      </div>
      <div className="settings-card"><h2>Answer review</h2><label className="check-transcript-setting"><input type="checkbox" checked={checkFirst} onChange={(event) => onCheckFirst(event.target.checked)} /><span><strong>Check the transcript before feedback</strong><small>When off, finishing a recording automatically transcribes and reviews your answer.</small></span></label></div>
    </section>
  )
}
