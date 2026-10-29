import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import Feedback from './Feedback.jsx'
import { audioToBase64, useAudioRecorder } from './useAudioRecorder.js'

function Mic() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></svg>
}

export default function VoiceAnswer({ conversation, active, disabled, onReviewed, onBusyChange, questionId, onSelectQuestion, checkFirst }) {
  const questions = conversation.questions ?? []
  const reviewedIds = new Set(conversation.messages.filter((item) => item.kind === 'answer-review' && item.role === 'user').map((item) => item.questionId))
  const [visited, setVisited] = useState([])
  const [busy, setBusy] = useState(false)
  const [draftIds, setDraftIds] = useState(new Set())
  const selectedRef = useRef(null)
  const position = questions.findIndex((item) => item.id === questionId)
  const completed = questions.filter((item) => reviewedIds.has(item.id)).length
  const nextQuestion = [...questions.slice(position + 1), ...questions.slice(0, position)].find((item) => !reviewedIds.has(item.id))

  useEffect(() => {
    if (!questionId || !active) return
    setVisited((items) => items.includes(questionId) ? items : [...items, questionId])
    requestAnimationFrame(() => {
      selectedRef.current?.focus({ preventScroll: true })
      selectedRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }, [questionId, active])

  function choose(id) {
    if (!id || busy || disabled) return
    onSelectQuestion(id)
    if (id === questionId) requestAnimationFrame(() => selectedRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }

  function reportBusy(value) { setBusy(value); onBusyChange(value) }

  return (
    <section className={`exercise-workspace ${questionId ? '' : 'choosing-question'}`} aria-label="Practice exercises">
      <aside className="exercise-sidebar">
        <div className="exercise-list-title"><h2>This session</h2><span>{completed}/{questions.length}</span></div>
        {!questionId && <div className="choose-question-intro"><h1>Choose a question</h1><p>Click the question text to open its voice answer.</p></div>}
        <progress value={completed} max={questions.length || 1} aria-label="Exercises completed" />
        <div className="exercise-list" role="group" aria-label="Choose an exercise">
          {questions.map((item, index) => <button key={item.id} type="button" className={`exercise-choice ${item.id === questionId ? 'selected' : ''}`} aria-label={`Exercise ${index + 1}: ${item.text}`} aria-pressed={item.id === questionId} disabled={busy || disabled} onClick={() => choose(item.id)}>
            <span className={`exercise-index ${reviewedIds.has(item.id) ? 'complete' : ''}`}>{reviewedIds.has(item.id) ? '✓' : String(index + 1).padStart(2, '0')}</span><span className="exercise-preview">{item.text}</span>{draftIds.has(item.id) && !reviewedIds.has(item.id) && <span className="draft-indicator" title="Draft answer" />}
          </button>)}
        </div>
        <span className="session-progress-copy">{completed === questions.length ? 'Session complete' : `${questions.length - completed} left to practice`}</span>
      </aside>
      <div className="exercise-content" ref={selectedRef} tabIndex="-1" hidden={!questionId}>
        {questions.filter((item) => visited.includes(item.id)).map((question) => <div key={question.id} hidden={question.id !== questionId}>
          <Exercise conversation={conversation} question={question} position={position} total={questions.length} active={active && question.id === questionId} disabled={disabled} onReviewed={onReviewed} onBusyChange={reportBusy}
            checkFirst={checkFirst} onClose={() => onSelectQuestion(null)}
            onDraft={(value) => setDraftIds((old) => { const ids = new Set(old); if (value) ids.add(question.id); else ids.delete(question.id); return ids })}
            onPrevious={() => choose(questions[position - 1]?.id)} onSkip={() => choose(questions[position + 1]?.id)}
            onNext={() => choose(nextQuestion?.id)} hasNext={Boolean(nextQuestion)} />
        </div>)}
      </div>
    </section>
  )
}

function Exercise({ conversation, question, position, total, active, disabled, onReviewed, onBusyChange, onDraft, checkFirst, onClose, onPrevious, onSkip, onNext, hasNext }) {
  const lastIndex = conversation.messages.findLastIndex((item) => item.kind === 'answer-review' && item.role === 'user' && item.questionId === question.id)
  const savedAnswer = conversation.messages[lastIndex]
  const reply = lastIndex >= 0 ? conversation.messages[lastIndex + 1] : null
  const feedback = reply?.kind === 'answer-review' && reply.role === 'assistant' ? reply : null
  const [answer, setAnswer] = useState(savedAnswer?.answer ?? '')
  const [reviewed, setReviewed] = useState(Boolean(feedback))
  const [mode, setMode] = useState('voice')
  const [stage, setStage] = useState('idle')
  const [error, setError] = useState(null)
  const recorder = useAudioRecorder(active)
  const processed = useRef(null)
  const textareaRef = useRef(null)
  const audioRef = useRef(null)
  const callbacks = useRef({ onBusyChange, onDraft })
  callbacks.current = { onBusyChange, onDraft }
  const recording = recorder.status === 'recording'
  const recordingBusy = ['connecting', 'recording', 'stopping'].includes(recorder.status)
  const busy = stage !== 'idle' || recordingBusy
  const locked = disabled || busy
  const time = `${Math.floor(recorder.seconds / 60)}:${String(recorder.seconds % 60).padStart(2, '0')}`

  useEffect(() => { if (active) callbacks.current.onBusyChange(busy) }, [active, busy])
  useEffect(() => { callbacks.current.onDraft(!reviewed && Boolean(answer.trim() || recorder.recording)) }, [answer, recorder.recording, reviewed])
  useEffect(() => {
    if (!active) { recorder.disconnect(); audioRef.current?.pause() }
  }, [active])
  useEffect(() => {
    if (!recorder.recording) { processed.current = null; return }
    if (processed.current === recorder.recording) return
    processed.current = recorder.recording
    transcribe()
  }, [recorder.recording])
  useEffect(() => {
    if (!active) return
    const onKey = (event) => {
      if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.target.closest('input, textarea, select, button, summary, a, [contenteditable="true"]')) return
      if (mode === 'type' || reviewed || disabled) return
      if (recording || !busy) { event.preventDefault(); if (recording) recorder.stop(); else start() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, recording, busy, mode, reviewed, disabled])

  async function start() {
    if (locked) return
    setError(null)
    audioRef.current?.pause()
    if (await recorder.start()) { setReviewed(false); setMode('voice') }
  }

  async function submit(value = answer) {
    if (!value.trim()) return
    setStage('reviewing')
    setError(null)
    try {
      const result = await api.reviewAnswer(conversation.id, question.id, value.trim())
      onReviewed(result.conversation)
      setReviewed(true)
      setMode('voice')
    } catch (err) { setError({ step: 'review', message: err.message }) }
    finally { setStage('idle') }
  }

  async function transcribe() {
    setStage('transcribing')
    setError(null)
    try {
      const data = await audioToBase64(recorder.recording.blob)
      const result = await api.transcribeAudio(conversation.id, { data, format: recorder.recording.format })
      if (!result.text?.trim()) throw new Error('No speech was detected. Try again or type your answer.')
      setAnswer(result.text)
      setReviewed(false)
      if (checkFirst) { setMode('type'); setStage('idle'); requestAnimationFrame(() => textareaRef.current?.focus()) }
      else await submit(result.text)
    } catch (err) { setError({ step: 'transcribe', message: err.message }); setStage('idle') }
  }

  function typeAnswer() {
    setMode('type')
    setReviewed(false)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  return (
    <section className={`exercise ${reviewed ? 'exercise-reviewed' : ''}`} aria-label="Current exercise">
      <header className="exercise-toolbar">
        <span className="exercise-kicker">EXERCISE {String(position + 1).padStart(2, '0')} <span>/ {String(total).padStart(2, '0')}</span></span>
        <button className="quiet-button" type="button" aria-label="Close voice answer" onClick={onClose} disabled={locked}>Close ×</button>
      </header>

      <div className="exercise-prompt"><h1>{question.text}</h1></div>

      {reviewed && feedback ? <div className="exercise-result">
        <div className="result-heading"><span className="result-check">✓</span><h2>Feedback</h2><button className="quiet-button" type="button" onClick={typeAnswer}>Edit answer</button></div>
        <div className="feedback-copy"><Feedback>{feedback.content}</Feedback></div>
        <details className="answer-details"><summary>Your answer</summary><p>{answer}</p>{recorder.recording && <audio ref={audioRef} controls src={recorder.recording.url} aria-label="Your recording" />}</details>
        <div className="result-actions">{hasNext ? <button className="practice-primary" type="button" onClick={onNext}>Next exercise <span aria-hidden="true">→</span></button> : <div className="session-complete" role="status">Session complete. Every exercise answered.</div>}<button className="quiet-button" type="button" onClick={() => { setReviewed(false); setMode('voice') }}>Try again</button></div>
      </div> : <div className="exercise-response">
        {mode === 'type' && !recordingBusy ? <form className="typed-answer" onSubmit={(event) => { event.preventDefault(); if (!locked) submit() }}>
          <label htmlFor={`answer-${question.id}`}>Your answer</label><textarea ref={textareaRef} id={`answer-${question.id}`} value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={locked} rows="3" maxLength="50000" placeholder="Write your answer…" />
          <button className="practice-primary" disabled={locked || !answer.trim()} type="submit">{stage === 'reviewing' ? 'Checking your answer…' : 'Check answer'}<span aria-hidden="true">→</span></button>
          <button className="quiet-button" type="button" disabled={locked} onClick={() => setMode('voice')}>Use my voice instead</button>
        </form> : <div className={`voice-action ${recording ? 'live' : ''}`}>
          {stage !== 'idle' || recorder.status === 'stopping' ? <div className="voice-processing" role="status"><span className="spinner dark" /><h2>{stage === 'reviewing' ? 'Checking your answer…' : 'Listening back…'}</h2><p>{stage === 'reviewing' ? 'Your feedback is on its way.' : 'Turning your recording into words.'}</p></div> : <>
            <button className={`record-orb ${recording ? 'is-recording' : ''}`} type="button" aria-label={recording ? 'Finish answer' : 'Record answer'} onClick={recording ? recorder.stop : start} disabled={disabled || recorder.status === 'connecting' || !recorder.supported}>
              {recording ? <span className="stop-symbol" /> : recorder.status === 'connecting' ? <span className="spinner" /> : <Mic />}
            </button>
            <h2>{recording ? 'Finish when you’re ready' : recorder.status === 'connecting' ? 'Allow microphone access' : 'Answer out loud'}</h2>
            {recording ? <div className="live-recording"><div className="audio-level" aria-label="Microphone input level" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(recorder.level * 100)}>{[0.4, 0.7, 1, 0.6, 0.9, 0.5, 0.8].map((scale, index) => <i key={index} style={{ height: `${4 + recorder.level * scale * 28}px` }} />)}</div><span role="timer" aria-label="Recording duration">{time}</span><button className="quiet-button" type="button" onClick={recorder.clear}>Cancel</button></div> : <p className="voice-instruction">Tap the mic or press <kbd>space</kbd>. Finish to get feedback.</p>}
            {!recordingBusy && <button className="quiet-button type-instead" type="button" onClick={typeAnswer}>Type instead <span aria-hidden="true">↗</span></button>}
            {recorder.status === 'connecting' && <button className="quiet-button" type="button" onClick={recorder.clear}>Cancel</button>}
          </>}
        </div>}
        {(error || recorder.error || !recorder.supported) && <div className="exercise-error" role="alert"><p>{error?.message || recorder.error || 'Voice is unavailable in this browser. You can type your answer instead.'}</p><div>
          {error && <button className="quiet-button" type="button" disabled={locked} onClick={() => error.step === 'transcribe' ? transcribe() : submit()}>{error.step === 'transcribe' ? 'Retry transcription' : 'Retry feedback'}</button>}
          {mode !== 'type' && <button className="quiet-button" type="button" disabled={locked} onClick={typeAnswer}>Type an answer</button>}
          {recorder.recording && <details><summary>Listen to recording</summary><audio ref={audioRef} controls src={recorder.recording.url} /></details>}
        </div></div>}
      </div>}
      <footer className="exercise-footer"><button className="quiet-button" type="button" disabled={locked || position === 0} onClick={onPrevious}>← Previous</button><span>{busy ? 'Your answer stays with this exercise' : 'One exercise. Your own words.'}</span><button className="quiet-button" type="button" disabled={locked || position === total - 1} onClick={onSkip}>Skip →</button></footer>
    </section>
  )
}
