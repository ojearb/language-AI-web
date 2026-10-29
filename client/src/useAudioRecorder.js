import { useCallback, useEffect, useRef, useState } from 'react'

export const MAX_RECORDING_SECONDS = 300
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export function audioFormat(mimeType) {
  const type = mimeType.split(';')[0].toLowerCase()
  return { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'video/mp4': 'm4a',
    'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' }[type]
}

export function audioToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the recording. Try recording again.'))
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1))
    reader.readAsDataURL(blob)
  })
}

function microphoneError(error) {
  if (error.name === 'NotAllowedError') return 'Microphone access was blocked. Allow microphone access in your browser’s site settings, then connect again.'
  if (error.name === 'NotFoundError') return 'No microphone was found. Connect a microphone and refresh the device list.'
  if (error.name === 'NotReadableError') return 'The microphone is unavailable. Check whether another app is using it, then connect again.'
  if (error.name === 'OverconstrainedError') return 'The selected microphone is unavailable. Refresh the list and choose another microphone.'
  return error.message || 'Could not connect to the microphone.'
}

export function useAudioRecorder(active = true) {
  const [devices, setDevices] = useState([])
  const [deviceId, setDeviceId] = useState(() => {
    try { return localStorage.getItem('threadspace.microphone') || '' } catch { return '' }
  })
  const [status, setStatus] = useState('idle')
  const [recording, setRecording] = useState(null)
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')
  const streamRef = useRef(null)
  const recorderRef = useRef(null)
  const timerRef = useRef(null)
  const generationRef = useRef(0)

  const supported = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder)

  // A device chosen on another question is still the session's preferred microphone.
  useEffect(() => {
    if (!active) return
    try { setDeviceId(localStorage.getItem('threadspace.microphone') || '') } catch { /* Keep the current device. */ }
  }, [active])

  const release = useCallback(() => {
    clearInterval(timerRef.current)
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const found = await navigator.mediaDevices.enumerateDevices()
      setDevices(found.filter((device) => device.kind === 'audioinput'))
    } catch (err) { setError(microphoneError(err)) }
  }, [])

  useEffect(() => {
    refreshDevices()
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices)
    return () => {
      generationRef.current += 1
      release()
      navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices)
    }
  }, [refreshDevices, release])

  useEffect(() => {
    if (!recording) return
    return () => URL.revokeObjectURL(recording.url)
  }, [recording])

  useEffect(() => {
    setLevel(0)
    if (status !== 'recording' || !streamRef.current) return
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) return
    let context
    let interval
    try {
      context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      context.createMediaStreamSource(streamRef.current).connect(analyser)
      context.resume().catch(() => {})
      const samples = new Uint8Array(analyser.fftSize)
      interval = setInterval(() => {
        analyser.getByteTimeDomainData(samples)
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length)
        setLevel(Math.min(1, rms * 5))
      }, 100)
    } catch { /* The level meter is optional; recording can still continue. */ }
    return () => { clearInterval(interval); context?.close().catch(() => {}) }
  }, [status])

  function disconnect() {
    generationRef.current += 1
    release()
    setStatus('idle')
  }

  function chooseDevice(value) {
    disconnect()
    setDeviceId(value)
    setError('')
    try { localStorage.setItem('threadspace.microphone', value) } catch { /* Device choice still works. */ }
  }

  async function acquire() {
    if (!supported) throw new Error('Voice recording needs a supported browser on localhost or HTTPS.')
    if (streamRef.current?.getAudioTracks().some((track) => track.readyState === 'live')) return streamRef.current
    const generation = generationRef.current
    setStatus('connecting')
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true },
    })
    if (generation !== generationRef.current) {
      stream.getTracks().forEach((track) => track.stop())
      return null
    }
    streamRef.current = stream
    stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => {
      if (generation !== generationRef.current) return
      const recorder = recorderRef.current
      if (recorder?.state === 'recording') {
        setStatus('stopping')
        recorder.stop()
      } else {
        release()
        setStatus('idle')
      }
      setError('The microphone disconnected. Reconnect it before recording again.')
    }, { once: true }))
    await refreshDevices()
    return stream
  }

  async function connect() {
    setError('')
    const generation = generationRef.current
    try {
      if (await acquire() && generation === generationRef.current) setStatus('ready')
    } catch (err) {
      if (generation !== generationRef.current) return
      release()
      setStatus('idle')
      setError(microphoneError(err))
    }
  }

  async function start() {
    setError('')
    const generation = generationRef.current
    try {
      const stream = await acquire()
      if (!stream || generation !== generationRef.current) return false
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
        .find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64_000 })
      if (!audioFormat(recorder.mimeType)) throw new Error('This browser’s recording format is unsupported. Try Chrome, Edge, Firefox, or Safari.')
      const chunks = []
      let bytes = 0
      let failed = false
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return
        chunks.push(event.data)
        bytes += event.data.size
        if (bytes > MAX_AUDIO_BYTES && recorder.state === 'recording') {
          setStatus('stopping')
          recorder.stop()
        }
      }
      recorder.onerror = () => {
        if (generation !== generationRef.current) return
        failed = true
        setError('Recording failed. Reconnect your microphone and try again.')
        release()
        setStatus('idle')
      }
      recorder.onstop = () => {
        if (generation !== generationRef.current) return
        release()
        setStatus('idle')
        if (failed) return
        const blob = new Blob(chunks, { type: recorder.mimeType })
        if (!blob.size || blob.size > MAX_AUDIO_BYTES) {
          setError(blob.size ? 'The recording is too large. Record a shorter answer.' : 'No audio was recorded. Try again.')
          return
        }
        setRecording({ blob, url: URL.createObjectURL(blob), format: audioFormat(blob.type) })
      }
      recorder.start(1000)
      setRecording(null)
      setSeconds(0)
      setStatus('recording')
      const startedAt = Date.now()
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000)
        setSeconds(Math.min(elapsed, MAX_RECORDING_SECONDS))
        if (elapsed >= MAX_RECORDING_SECONDS && recorder.state === 'recording') {
          setStatus('stopping')
          recorder.stop()
        }
      }, 250)
      return true
    } catch (err) {
      if (generation !== generationRef.current) return false
      release()
      setStatus('idle')
      setError(microphoneError(err))
      return false
    }
  }

  function stop() {
    if (recorderRef.current?.state !== 'recording') return
    setStatus('stopping')
    recorderRef.current.stop()
  }

  function clear() {
    disconnect()
    setRecording(null)
    setSeconds(0)
    setError('')
  }

  return { devices, deviceId, status, recording, seconds, level, error, supported,
    refreshDevices, chooseDevice, connect, disconnect, start, stop, clear }
}
