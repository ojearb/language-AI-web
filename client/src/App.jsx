import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import VoiceAnswer from './VoiceAnswer.jsx'
import AudioSettings from './AudioSettings.jsx'
import Feedback from './Feedback.jsx'

const DEFAULT_EVALUATION_PROMPT = "Evaluate only the learner's answer to the selected exercise using the original practice instructions and relevant target grammar. Distinguish accuracy of meaning from use of the requested grammar. Start with a clear verdict: correct, partially correct, or incorrect. Explain what worked and any specific changes needed, with a corrected example only when helpful. Accept valid alternatives and do not invent mistakes. Be encouraging, specific, and concise. Use readable Markdown. Judge the transcribed text only; do not claim to assess pronunciation or audio quality."

const Icons = {
  ArrowLeft: (props) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="m15 18-6-6 6-6" /></svg>
  ),
  Plus: (props) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M12 5v14M5 12h14" /></svg>
  ),
  Send: (props) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="m5 12 14-7-4 14-3-6-7-1Z" /><path d="m12 13 7-8" /></svg>
  ),
  Trash: (props) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>
  ),
  Spark: (props) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M12 3c.5 4.8 3.2 7.5 8 8-4.8.5-7.5 3.2-8 8-.5-4.8-3.2-7.5-8-8 4.8-.5 7.5-3.2 8-8Z" /></svg>
  ),
  Sliders: (props) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M4 7h10M18 7h2M4 17h2m4 0h10M14 4v6M6 14v6" /></svg>
  ),
  Play: (props) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="m9 6 9 6-9 6V6Z" /></svg>
  ),
  Clock: (props) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><circle cx="12" cy="12" r="8" /><path d="M12 8v5l3 2" /></svg>
  ),
  Close: (props) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="m6 6 12 12M18 6 6 18" /></svg>
  ),
}

function getIdFromLocation() {
  const match = window.location.pathname.match(/^\/conversations\/([^/]+)\/?$/)
  return match ? decodeURIComponent(match[1]) : null
}

function navigate(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function navigateTabs(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]:not(:disabled)')]
  const current = tabs.indexOf(document.activeElement)
  if (current < 0) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[next]?.focus()
  tabs[next]?.click()
}

function relativeDate(value) {
  if (!value) return 'Just now'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const elapsed = Date.now() - date.getTime()
  if (elapsed < 60_000) return 'Just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function Brand() {
  return (
    <a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate('/') }}>
      <span className="brand-mark"><Icons.Spark /></span>
      <span>Threadspace</span>
    </a>
  )
}

function ErrorPanel({ message, onRetry }) {
  return (
    <div className="error-panel" role="alert">
      <div><strong>Something went wrong.</strong><p>{message}</p></div>
      {onRetry && <button type="button" onClick={onRetry}>Try again</button>}
    </div>
  )
}

function LoadingCards() {
  return (
    <div className="configuration-grid" aria-label="Loading prompt configurations">
      {Array.from({ length: 4 }, (_, index) => <div className="card skeleton" key={index} />)}
    </div>
  )
}

function ConfigurationCard({ configuration, index, starting, onStart, onEdit }) {
  return (
    <article className={`card configuration-card accent-${index % 4}`}>
      <button
        className="configuration-launch"
        type="button"
        onClick={() => onStart(configuration)}
        disabled={starting}
        aria-label={`Start a new ${configuration.name} chat`}
      >
        <span className="card-topline">
          <span className="prompt-icon"><Icons.Spark /></span>
          <span className={`storage-badge ${configuration.saveChats ? 'saved' : ''}`}>
            {configuration.saveChats ? `${configuration.savedConversationCount || 0} saved` : 'Fresh every time'}
          </span>
        </span>
        <span className="card-body">
          <span className="card-title">{configuration.name}</span>
          <span className="card-preview">{configuration.prompt}</span>
        </span>
        <span className="launch-label">
          {starting ? <><span className="spinner dark" /> Preparing exercises...</> : <>Start practicing <span aria-hidden="true">↗</span></>}
        </span>
      </button>
      <button
        className="card-settings"
        type="button"
        onClick={() => onEdit(configuration)}
        aria-label={`Settings for ${configuration.name}`}
      >
        <Icons.Sliders />
      </button>
    </article>
  )
}

function Home({ configurations, loading, error, startingId, onRetry, onCreate, onEdit, onStart, checkFirst, onCheckFirst }) {
  const [view, setView] = useState('library')
  const [search, setSearch] = useState('')
  const filtered = configurations.filter((item) => `${item.name} ${item.category ?? ''}`.toLowerCase().includes(search.toLowerCase().trim()))
  const categorizedConfigurations = filtered.reduce((groups, configuration) => {
    const category = configuration.category?.trim() || 'Uncategorized'
    const items = groups.get(category) ?? []
    items.push(configuration)
    groups.set(category, items)
    return groups
  }, new Map())
  const categoryGroups = [...categorizedConfigurations.entries()].sort(([first], [second]) => {
    if (first === 'Uncategorized') return 1
    if (second === 'Uncategorized') return -1
    return first.localeCompare(second)
  })

  return (
    <div className="home-page">
      <header className="site-header">
        <Brand />
        <nav className="home-navigation" aria-label="App views"><div role="tablist" aria-label="App" onKeyDown={navigateTabs}>
          <button id="library-tab" role="tab" aria-controls="library-panel" aria-selected={view === 'library'} tabIndex={view === 'library' ? 0 : -1} type="button" onClick={() => setView('library')}>Your topics</button>
          <button id="settings-tab" role="tab" aria-controls="settings-panel" aria-selected={view === 'settings'} tabIndex={view === 'settings' ? 0 : -1} type="button" onClick={() => setView('settings')}>Settings</button>
        </div></nav>
      </header>

      <main className="home-content">
        <div id="library-panel" role="tabpanel" aria-labelledby="library-tab" hidden={view !== 'library'}>
        <section className="hero" aria-labelledby="page-title">
          <p className="eyebrow">YOUR PRACTICE SPACE</p>
          <h1 id="page-title">What will you practice today?</h1>
          <p className="hero-copy">Pick a topic. Answer one exercise at a time. Build your confidence.</p>
        </section>

        {error ? (
          <ErrorPanel message={error} onRetry={onRetry} />
        ) : loading ? (
          <LoadingCards />
        ) : (
          <section aria-label="Prompt configurations">
            <div className="section-heading">
              <div>
                <h2>Your topics <span className="topic-count">{configurations.length}</span></h2>
              </div>
              <div className="library-tools"><input className="topic-search" type="search" aria-label="Find a topic" placeholder="Find a topic…" value={search} onChange={(event) => setSearch(event.target.value)} /><button className="add-configuration-button" type="button" onClick={onCreate}><Icons.Plus /> New topic</button></div>
            </div>
            {configurations.length === 0 ? (
              <button className="card new-card empty-library-card" type="button" onClick={onCreate}>
                <span className="new-card-icon"><Icons.Plus /></span>
                <span className="card-title">Create your first template</span>
                <span className="card-preview">Name it, add it to a category, and write its starting prompt</span>
              </button>
            ) : !filtered.length ? <p className="empty-search">No topics match “{search}”. Try a different name.</p> : categoryGroups.map(([category, items]) => (
              <section className="category-section" aria-label={`${category} templates`} key={category}>
                <div className="category-heading">
                  <h3>{category === 'Uncategorized' ? 'Ready when you are' : category}</h3>
                  <span>{items.length} {items.length === 1 ? 'template' : 'templates'}</span>
                </div>
                <div className="configuration-grid">
                  {items.map((configuration) => (
                    <ConfigurationCard
                      key={configuration.id}
                      configuration={configuration}
                      index={configurations.indexOf(configuration)}
                      starting={startingId === configuration.id}
                      onStart={onStart}
                      onEdit={onEdit}
                    />
                  ))}
                </div>
              </section>
            ))}
          </section>
        )}
        </div>
        <div id="settings-panel" role="tabpanel" aria-labelledby="settings-tab" hidden={view !== 'settings'}><AudioSettings active={view === 'settings'} checkFirst={checkFirst} onCheckFirst={onCheckFirst} /></div>
      </main>
      <footer className="home-footer">Small steps. Real progress.</footer>
    </div>
  )
}

function ConfigurationModal({ mode, configuration, categories, saving, onClose, onSave, onDelete, onHistoryChanged }) {
  const [name, setName] = useState(configuration?.name ?? '')
  const [category, setCategory] = useState(configuration?.category ?? '')
  const [prompt, setPrompt] = useState(configuration?.prompt ?? '')
  const [evaluationPrompt, setEvaluationPrompt] = useState(configuration?.evaluationPrompt ?? DEFAULT_EVALUATION_PROMPT)
  const [saveChats, setSaveChats] = useState(configuration?.saveChats ?? false)
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(Boolean(configuration?.savedConversationCount))
  const [localError, setLocalError] = useState('')
  const nameRef = useRef(null)

  useEffect(() => {
    nameRef.current?.focus()
    const closeOnEscape = (event) => { if (event.key === 'Escape' && !saving) onClose() }
    document.addEventListener('keydown', closeOnEscape)
    document.body.classList.add('modal-open')
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      document.body.classList.remove('modal-open')
    }
  }, [onClose, saving])

  useEffect(() => {
    if (!configuration?.savedConversationCount) return
    let active = true
    api.listConfigurationConversations(configuration.id)
      .then((items) => { if (active) setHistory(items) })
      .catch((error) => { if (active) setLocalError(error.message) })
      .finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [configuration])

  async function submit(event) {
    event.preventDefault()
    setLocalError('')
    try {
      await onSave({ name: name.trim(), category: category.trim(), prompt: prompt.trim(), evaluationPrompt: evaluationPrompt.trim(), saveChats })
    } catch (error) {
      setLocalError(error.message)
    }
  }

  async function removeConversation(event, conversationId) {
    event.stopPropagation()
    if (!window.confirm('Delete this saved chat?')) return
    try {
      await api.deleteConversation(conversationId)
      setHistory((items) => items.filter((item) => item.id !== conversationId))
      onHistoryChanged()
    } catch (error) {
      setLocalError(error.message)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}>
      <section className="configuration-modal" role="dialog" aria-modal="true" aria-labelledby="configuration-title">
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">{mode === 'create' ? 'New prompt' : 'Configuration settings'}</p>
            <h2 id="configuration-title">{mode === 'create' ? 'Create a configuration' : 'Edit your configuration'}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Close"><Icons.Close /></button>
        </div>

        <form onSubmit={submit}>
          <label className="field">
            <span>Name</span>
            <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} maxLength="100" placeholder="Integer practice" required />
            <small>This is the title shown in your library.</small>
          </label>

          <label className="field">
            <span>Category <em>Optional</em></span>
            <input value={category} onChange={(event) => setCategory(event.target.value)} maxLength="80" list="category-options" placeholder="Evening classes" />
            <datalist id="category-options">
              {categories.map((item) => <option value={item} key={item} />)}
            </datalist>
            <small>Templates with the same category appear together under this title.</small>
          </label>

          <label className="field">
            <span>Starting prompt</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength="50000" rows="7" placeholder="Give me a series of integer problems to solve, one at a time..." required />
            <small>This is sent automatically whenever you start this configuration.</small>
          </label>

          <label className="field">
            <span>Answer evaluation prompt</span>
            <textarea value={evaluationPrompt} onChange={(event) => setEvaluationPrompt(event.target.value)} maxLength="50000" rows="5" placeholder="Describe how the AI should judge answers and give feedback..." required />
            <small>Reviews use the original practice instructions, relevant target grammar, selected question, and your answer. Customize the feedback language or grading style here.</small>
          </label>

          <label className="storage-setting">
            <span className="setting-copy">
              <strong>Save chat history</strong>
              <small>{saveChats ? 'Sessions are stored and can be reopened below.' : 'Each session is temporary; the configuration still stays saved.'}</small>
            </span>
            <input type="checkbox" checked={saveChats} onChange={(event) => setSaveChats(event.target.checked)} />
            <span className="toggle" aria-hidden="true"><span /></span>
          </label>

          {localError && <div className="inline-error modal-error" role="alert">{localError}</div>}

          <div className="modal-actions">
            {mode === 'edit' && <button className="danger-text" type="button" onClick={onDelete} disabled={saving}><Icons.Trash /> Delete configuration</button>}
            <span className="action-spacer" />
            <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-button" type="submit" disabled={saving || !name.trim() || !prompt.trim() || !evaluationPrompt.trim()}>
              {saving ? <><span className="spinner" /> Saving...</> : mode === 'create' ? 'Create configuration' : 'Save changes'}
            </button>
          </div>
        </form>

        {mode === 'edit' && (historyLoading || history.length > 0) && (
          <div className="history-section">
            <div className="history-heading"><h3>Saved chats</h3><span>{history.length}</span></div>
            {historyLoading ? (
              <div className="history-loading"><span className="spinner dark" /> Loading saved chats...</div>
            ) : history.map((conversation) => (
              <div className="history-row" key={conversation.id}>
                <button type="button" className="history-open" onClick={() => { onClose(); navigate(`/conversations/${encodeURIComponent(conversation.id)}`) }}>
                  <Icons.Clock />
                  <span><strong>{relativeDate(conversation.updatedAt)}</strong><small>{conversation.preview || `${conversation.messageCount} messages`}</small></span>
                </button>
                <button type="button" className="history-delete" onClick={(event) => removeConversation(event, conversation.id)} aria-label="Delete saved chat"><Icons.Trash /></button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function LaunchingOverlay({ configuration }) {
  if (!configuration) return null
  return (
    <div className="launching-overlay" role="status" aria-live="polite">
      <div className="launching-panel">
        <span className="launching-spark"><Icons.Spark /></span>
        <span className="spinner dark large" />
        <h2>Starting {configuration.name}</h2>
        <p>The prompt is being sent and your fresh session will open as soon as the assistant responds.</p>
      </div>
    </div>
  )
}

function Message({ message, isStartingPrompt, articleRef, questions = [], onSelectQuestion, disabled }) {
  const isUser = message.role === 'user'
  return (
    <article ref={articleRef} className={`message-row ${isUser ? 'user-message' : 'assistant-message'}`}>
      {!isUser && <span className="avatar"><Icons.Spark /></span>}
      <div className="message-content">
        <span className="message-author">{message.kind === 'answer-review' ? (isUser ? 'Your answer for review' : 'Answer review') : isUser ? (isStartingPrompt ? 'Starting prompt' : 'You') : 'Assistant'}</span>
        {isStartingPrompt ? <details className="starting-prompt"><summary>View practice instructions</summary><div className="message-bubble">{message.content}</div></details> : questions.length ? <div className="message-questions"><p>Click a question to answer by voice.</p>{questions.map((question) => <button type="button" className="message-question" key={question.id} disabled={disabled} onClick={() => onSelectQuestion(question.id)}>{question.text}</button>)}<details className="starting-prompt"><summary>View original message</summary><div className="message-bubble">{message.content}</div></details></div> : <div className="message-bubble">{!isUser ? <Feedback>{message.content}</Feedback> : message.content}</div>}
      </div>
    </article>
  )
}

function ThinkingMessage() {
  return (
    <article className="message-row assistant-message" aria-label="Assistant is thinking">
      <span className="avatar"><Icons.Spark /></span>
      <div className="message-content"><span className="message-author">Assistant</span><div className="thinking"><i /><i /><i /></div></div>
    </article>
  )
}

function Chat({ id, onDeleted, checkFirst }) {
  const [conversation, setConversation] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [view, setView] = useState('practice')
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [selectedQuestionId, setSelectedQuestionId] = useState(null)
  const endRef = useRef(null)
  const reviewRef = useRef(null)
  const textareaRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try { setConversation(await api.getConversation(id)) }
    catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (view !== 'chat') return
    const target = conversation?.messages?.at(-1)?.kind === 'answer-review' && reviewRef.current
      ? reviewRef.current : endRef.current
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [conversation?.messages?.length, sending, view])

  async function submit(event) {
    event.preventDefault()
    const content = draft.trim()
    if (!content || sending || voiceBusy) return

    const optimistic = { id: `local-${Date.now()}`, role: 'user', content }
    setConversation((current) => ({ ...current, messages: [...(current?.messages ?? []), optimistic] }))
    setDraft('')
    setSending(true)
    setError('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    try {
      const result = await api.sendMessage(id, content)
      setConversation(result.conversation ?? result)
    } catch (err) {
      setError(err.message)
      setConversation((current) => ({ ...current, messages: (current?.messages ?? []).filter((item) => item.id !== optimistic.id) }))
      setDraft(content)
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  function handleDraft(event) {
    setDraft(event.target.value)
    event.target.style.height = 'auto'
    event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  function selectQuestion(questionId) {
    if (voiceBusy || sending || deleting) return
    setSelectedQuestionId(questionId)
    setView('practice')
  }


  async function remove() {
    const label = conversation?.saveChats ? 'Delete this saved chat?' : 'End this temporary chat?'
    if (!window.confirm(`${label} This cannot be undone.`)) return
    setDeleting(true)
    try {
      await api.deleteConversation(id)
      onDeleted()
    } catch (err) {
      setError(err.message)
      setDeleting(false)
    }
  }

  const messages = conversation?.messages ?? []
  const practice = view === 'practice' && Boolean(conversation?.questions?.length)
  const chat = view === 'chat' || (view === 'practice' && !conversation?.questions?.length)
  return (
    <div className="chat-page">
      <header className="chat-header">
        <button className="icon-button back-button" type="button" onClick={() => navigate('/')} aria-label="Back to prompt library"><Icons.ArrowLeft /></button>
        <Brand />
        <div className="chat-title">
          <strong>{conversation?.title ?? 'Practice session'}</strong>
          <span>{sending ? 'Assistant is thinking...' : conversation?.saveChats ? 'Saved session' : 'Practice session'}</span>
        </div>
        <button className="icon-button delete-button" type="button" onClick={remove} disabled={deleting || loading || sending || voiceBusy || !conversation} aria-label="Delete conversation">
          {deleting ? <span className="spinner small dark" /> : <Icons.Trash />}
        </button>
      </header>

      {conversation && <nav className="session-navigation" aria-label="Session views">
        <div role="tablist" aria-label="Session" onKeyDown={navigateTabs}>
          <button id="practice-tab" role="tab" aria-controls="practice-panel" aria-selected={practice} tabIndex={practice ? 0 : -1} className={practice ? 'is-active' : ''} type="button" onClick={() => setView('practice')} disabled={voiceBusy || !conversation.questions?.length}>Practice <span>{conversation.questions?.length ?? 0}</span></button>
          <button id="conversation-tab" role="tab" aria-controls="conversation-panel" aria-selected={chat} tabIndex={chat ? 0 : -1} className={chat ? 'is-active' : ''} type="button" onClick={() => setView('chat')} disabled={voiceBusy}>Conversation</button>
        </div>
      </nav>}
      <main className={`chat-main ${practice ? 'practice-main' : ''}`}>
        {practice && error && <div className="inline-error" role="alert">{error}</div>}
        {loading ? (
          <div className="chat-loading"><span className="spinner dark" /><span>Opening session...</span></div>
        ) : !conversation ? (
          <ErrorPanel message={error || 'This conversation could not be found.'} onRetry={load} />
        ) : (
          <>
          <div id="practice-panel" role="tabpanel" aria-labelledby="practice-tab" hidden={!practice}>{conversation.questions?.length > 0 && <VoiceAnswer conversation={conversation} active={practice} disabled={sending || deleting} onReviewed={setConversation} onBusyChange={setVoiceBusy} questionId={selectedQuestionId} onSelectQuestion={selectQuestion} checkFirst={checkFirst} />}</div>
          <div id="conversation-panel" role="tabpanel" aria-labelledby="conversation-tab" className="messages" hidden={!chat}>
            {messages.map((message, index) => <Message key={message.id || `${message.role}-${index}`} message={message} isStartingPrompt={index === 0} articleRef={index === messages.length - 1 && message.kind === 'answer-review' ? reviewRef : undefined} questions={conversation.questions?.filter((question) => question.messageId === message.id)} onSelectQuestion={selectQuestion} disabled={voiceBusy || sending || deleting} />)}
            {sending && <ThinkingMessage />}
            <div ref={endRef} />
          </div>
          </>
        )}
      </main>

      {conversation && chat && (
        <div className="composer-shell">
          {error && <div className="inline-error" role="alert">{error}</div>}
          <form className="composer" onSubmit={submit}>
            <textarea ref={textareaRef} value={draft} onChange={handleDraft} onKeyDown={handleKeyDown} placeholder="Reply to the assistant..." rows="1" disabled={sending || voiceBusy} aria-label="Message" />
            <button className="send-button" type="submit" disabled={!draft.trim() || sending || voiceBusy} aria-label="Send message"><Icons.Send /></button>
          </form>
          <p className="composer-note">Press Enter to send &middot; Shift + Enter for a new line</p>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [checkFirst, setCheckFirst] = useState(() => {
    try { return localStorage.getItem('threadspace.checkTranscript') === 'true' } catch { return false }
  })
  function changeCheckFirst(value) {
    setCheckFirst(value)
    try { localStorage.setItem('threadspace.checkTranscript', String(value)) } catch { /* The setting still applies to the app until you reload. */ }
  }

  const [activeId, setActiveId] = useState(getIdFromLocation)
  const [configurations, setConfigurations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [startingConfiguration, setStartingConfiguration] = useState(null)
  const [modal, setModal] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const handleRoute = () => setActiveId(getIdFromLocation())
    window.addEventListener('popstate', handleRoute)
    return () => window.removeEventListener('popstate', handleRoute)
  }, [])

  const loadConfigurations = useCallback(async () => {
    setLoading(true)
    setError('')
    try { setConfigurations(await api.listConfigurations()) }
    catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadConfigurations() }, [loadConfigurations])

  async function saveConfiguration(settings) {
    setSaving(true)
    try {
      if (modal.mode === 'create') {
        const created = await api.createConfiguration(settings)
        setConfigurations((items) => [created, ...items])
      } else {
        const updated = await api.updateConfiguration(modal.configuration.id, settings)
        setConfigurations((items) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item))
      }
      setModal(null)
    } finally {
      setSaving(false)
    }
  }

  async function deleteConfiguration() {
    const configuration = modal?.configuration
    if (!configuration) return
    const savedNote = configuration.savedConversationCount
      ? ` Its ${configuration.savedConversationCount} saved chat${configuration.savedConversationCount === 1 ? '' : 's'} will also be deleted.`
      : ''
    if (!window.confirm(`Delete “${configuration.name}”?${savedNote}`)) return

    setSaving(true)
    try {
      await api.deleteConfiguration(configuration.id)
      setConfigurations((items) => items.filter((item) => item.id !== configuration.id))
      setModal(null)
    } catch (err) {
      setError(err.message)
      setModal(null)
    } finally {
      setSaving(false)
    }
  }

  async function startConversation(configuration) {
    if (startingConfiguration) return
    setStartingConfiguration(configuration)
    setError('')
    try {
      const conversation = await api.startConversation(configuration.id)
      navigate(`/conversations/${encodeURIComponent(conversation.id)}`)
      if (configuration.saveChats) loadConfigurations()
    } catch (err) {
      setError(err.message)
    } finally {
      setStartingConfiguration(null)
    }
  }

  function handleChatDeleted() {
    navigate('/')
    loadConfigurations()
  }

  return activeId ? (
    <Chat key={activeId} id={activeId} onDeleted={handleChatDeleted} checkFirst={checkFirst} />
  ) : (
    <>
      <Home
        configurations={configurations}
        loading={loading}
        error={error}
        startingId={startingConfiguration?.id}
        onRetry={loadConfigurations}
        onCreate={() => setModal({ mode: 'create' })}
        onEdit={(configuration) => setModal({ mode: 'edit', configuration })}
        checkFirst={checkFirst}
        onCheckFirst={changeCheckFirst}
        onStart={startConversation}
      />
      {modal && (
        <ConfigurationModal
          key={modal.configuration?.id ?? 'new'}
          mode={modal.mode}
          configuration={modal.configuration}
          categories={[...new Set(configurations.map((item) => item.category?.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))}
          saving={saving}
          onClose={() => setModal(null)}
          onSave={saveConfiguration}
          onDelete={deleteConfiguration}
          onHistoryChanged={loadConfigurations}
        />
      )}
      <LaunchingOverlay configuration={startingConfiguration} />
    </>
  )
}
