import { useEffect, useRef, useState } from 'react'

const API_URL = import.meta.env.VITE_API_URL ?? '/api'

const consonants = { 'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny', 'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n', 'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h', 'ड़': 'r', 'ढ़': 'rh' }
const vowels = { 'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au' }
const vowelMarks = { 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au' }

function romanizeHindi(text) {
  const characters = Array.from(text)
  return characters.map((character, index) => {
    if (consonants[character]) {
      const next = characters[index + 1]
      const endsWord = !next || /[\s.,!?₹]/.test(next)
      return consonants[character] + (endsWord || vowelMarks[next] || next === '्' ? '' : 'a')
    }
    if (vowels[character]) return vowels[character]
    if (vowelMarks[character]) return vowelMarks[character]
    if (character === 'ं' || character === 'ँ') return 'n'
    if (character === 'ः') return 'h'
    if (character === '्') return ''
    return character
  }).join('').replace(/ay\b/g, 'ai')
}

function cleanTranscript(text) {
  return text
    .replace(/([A-Za-z])(?=\d)/g, '$1 ')
    .replace(/(\d)(?=[A-Za-z])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim()
}

function apiErrorMessage(detail, fallback) {
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const messages = detail.map((issue) => issue?.msg).filter(Boolean)
    if (messages.length) return messages.join('. ')
  }
  return fallback
}

export default function App() {
  const [screen, setScreen] = useState('landing')
  const [health, setHealth] = useState('Connecting')
  const [session, setSession] = useState(null)
  const [invoice, setInvoice] = useState(null)
  const [bill, setBill] = useState({ items: [], total: 0 })
  const [editingItemId, setEditingItemId] = useState(null)
  const [itemDraft, setItemDraft] = useState({ name: '', quantity: '', unit_price: '' })
  const [history, setHistory] = useState([])
  const [messages, setMessages] = useState([])
  const [liveTranscript, setLiveTranscript] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [voices, setVoices] = useState([])
  const [voiceName, setVoiceName] = useState('')
  const [isStarting, setIsStarting] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const recorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const autoListenAfterSpeechRef = useRef(false)
  const sessionRef = useRef(null)
  const recordingMonitorRef = useRef({ frameId: null, audioContext: null })

  useEffect(() => {
    fetch(`${API_URL}/health`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then(() => setHealth('Ready'))
      .catch(() => setHealth('Offline'))
    loadHistory()
  }, [])

  useEffect(() => {
    if (!('speechSynthesis' in window)) return undefined
    const loadVoices = () => {
      const available = window.speechSynthesis.getVoices()
      setVoices(available)
      if (!voiceName && available.length) {
        const preferred = available.find((voice) => voice.lang.toLowerCase() === 'en-in')
          || available.find((voice) => /india|google.*english/i.test(voice.name))
          || available.find((voice) => voice.lang.toLowerCase().startsWith('en'))
        setVoiceName(preferred?.name || '')
      }
    }
    loadVoices()
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices)
  }, [voiceName])

  async function loadHistory() {
    try {
      const response = await fetch(`${API_URL}/sessions`)
      if (response.ok) setHistory(await response.json())
    } catch {
      // The first visit can happen before the backend is running.
    }
  }

  async function loadBill(sessionId) {
    if (!sessionId) return
    try {
      const response = await fetch(`${API_URL}/sessions/${sessionId}`)
      if (response.ok) setBill(await response.json())
    } catch {
      // The preview will update on the next successful request.
    }
  }

  async function beginSession() {
    const greeting = 'What would you like to add?'
    setIsStarting(true)
    try {
      const response = await fetch(`${API_URL}/sessions`, { method: 'POST' })
      if (!response.ok) throw new Error()
      const newSession = await response.json()
      setSession(newSession)
      sessionRef.current = newSession
      setBill({ items: [], total: 0 })
      loadBill(newSession.id)
      setMessages([{ role: 'system', text: greeting }])
      setScreen('voice')
      speak(greeting, startRecording)
    } catch {
      setMessages([{ role: 'system', text: greeting }])
      setScreen('voice')
    } finally {
      setIsStarting(false)
    }
  }

  function speak(text, onComplete) {
    if (!('speechSynthesis' in window) || !text) {
      onComplete?.()
      return
    }
    autoListenAfterSpeechRef.current = Boolean(onComplete)
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    const selectedVoice = voices.find((voice) => voice.name === voiceName)
    if (selectedVoice) utterance.voice = selectedVoice
    utterance.lang = selectedVoice?.lang || 'en-IN'
    utterance.rate = 0.9
    utterance.pitch = 1
    utterance.onstart = () => setIsSpeaking(true)
    utterance.onend = () => {
      setIsSpeaking(false)
      if (autoListenAfterSpeechRef.current) {
        autoListenAfterSpeechRef.current = false
        onComplete?.()
      }
    }
    utterance.onerror = () => {
      autoListenAfterSpeechRef.current = false
      setIsSpeaking(false)
    }
    window.speechSynthesis.speak(utterance)
  }

  async function saveSpokenItem(transcript) {
    const activeSession = sessionRef.current || session
    if (!activeSession) return
    try {
      const response = await fetch(`${API_URL}/sessions/${activeSession.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: transcript }),
      })
      const chat = await response.json()
      if (!response.ok) throw new Error(typeof chat.detail === 'string' ? chat.detail : 'Could not add that item.')
      const reply = typeof chat.assistant_message === 'string' ? chat.assistant_message : 'What would you like to add next?'
      setMessages((current) => [...current, { role: 'system', text: reply }])
      loadBill(activeSession.id)
      if (chat.should_finalize) {
        speak(reply, () => finishBill(activeSession))
        return
      }
      speak(reply, startRecording)
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: error.message }])
    }
  }

  async function removeItem(itemId) {
    if (!session) return
    try {
      const response = await fetch(`${API_URL}/sessions/${session.id}/items/${itemId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Could not remove that item.')
      await loadBill(session.id)
      const reply = 'Item removed. What would you like to add next?'
      setMessages((current) => [...current, { role: 'system', text: reply }])
      speak(reply, startRecording)
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: error.message }])
    }
  }

  function beginEditing(item) {
    setEditingItemId(item.id)
    setItemDraft({ name: item.name, quantity: String(item.quantity), unit_price: String(item.unit_price) })
  }

  async function saveItemEdit(itemId) {
    if (!session) return
    try {
      const response = await fetch(`${API_URL}/sessions/${session.id}/items/${itemId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: itemDraft.name, quantity: Number(itemDraft.quantity), unit_price: Number(itemDraft.unit_price) }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not update that item.')
      setEditingItemId(null)
      await loadBill(session.id)
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: error.message }])
    }
  }

  async function transcribeAudio(audio) {
    setIsTranscribing(true)
    try {
      const formData = new FormData()
      formData.append('file', audio, 'voice-note.webm')
      const response = await fetch(`${API_URL}/transcribe`, { method: 'POST', body: formData })
      const result = await response.json()
      if (!response.ok || !result.transcript) throw new Error(typeof result.detail === 'string' ? result.detail : 'I could not understand that recording.')
      setMessages((current) => [...current, { role: 'user', text: result.transcript }])
      saveSpokenItem(result.transcript)
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: error.message }])
    } finally {
      setIsTranscribing(false)
    }
  }

  async function finishBill(sessionToFinish) {
    const activeSession = sessionToFinish?.id ? sessionToFinish : (sessionRef.current || session)
    if (!activeSession) return
    try {
      const response = await fetch(`${API_URL}/sessions/${activeSession.id}/invoice`)
      const nextInvoice = await response.json()
      if (!response.ok) throw new Error(apiErrorMessage(nextInvoice.detail, 'Could not generate the bill.'))
      setInvoice(nextInvoice)
      setScreen('invoice')
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: error.message }])
    }
  }

  async function openInvoice(sessionId) {
    try {
      const response = await fetch(`${API_URL}/sessions/${sessionId}/invoice`)
      const nextInvoice = await response.json()
      if (!response.ok) throw new Error(apiErrorMessage(nextInvoice.detail, 'Could not open that bill.'))
      setInvoice(nextInvoice)
      setScreen('invoice')
    } catch (error) {
      setMessages([{ role: 'system', text: error.message }])
      setScreen('voice')
    }
  }

  function toggleListening() {
    if (isListening) {
      recorderRef.current?.stop()
      return
    }
    if (isSpeaking) {
      autoListenAfterSpeechRef.current = false
      window.speechSynthesis?.cancel()
      setIsSpeaking(false)
    }
    startRecording()
  }

  async function startRecording() {
    if (isListening || isTranscribing) return
    window.speechSynthesis?.cancel()
    setIsSpeaking(false)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const preferredType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType: preferredType })
      audioChunksRef.current = []
      let heardSpeech = false
      let silenceStartedAt = null
      const AudioContext = window.AudioContext || window.webkitAudioContext
      const audioContext = AudioContext ? new AudioContext() : null
      const analyser = audioContext?.createAnalyser()
      if (analyser) {
        analyser.fftSize = 512
        audioContext.createMediaStreamSource(stream).connect(analyser)
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size) audioChunksRef.current.push(event.data)
      }
      recorder.onstart = () => setIsListening(true)
      recorder.onstop = () => {
        if (recordingMonitorRef.current.frameId) cancelAnimationFrame(recordingMonitorRef.current.frameId)
        recordingMonitorRef.current.audioContext?.close()
        recordingMonitorRef.current = { frameId: null, audioContext: null }
        stream.getTracks().forEach((track) => track.stop())
        setIsListening(false)
        const audio = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        if (audio.size) transcribeAudio(audio)
      }
      recorder.onerror = () => {
        if (recordingMonitorRef.current.frameId) cancelAnimationFrame(recordingMonitorRef.current.frameId)
        recordingMonitorRef.current.audioContext?.close()
        recordingMonitorRef.current = { frameId: null, audioContext: null }
        stream.getTracks().forEach((track) => track.stop())
        setIsListening(false)
        setMessages((current) => [...current, { role: 'system', text: 'I could not record that. Please try again.' }])
      }
      recorderRef.current = recorder
      recorder.start()
      if (analyser) {
        const samples = new Uint8Array(analyser.fftSize)
        const monitorSpeech = () => {
          analyser.getByteTimeDomainData(samples)
          const level = Math.sqrt(samples.reduce((sum, sample) => sum + (sample - 128) ** 2, 0) / samples.length) / 128
          if (level > 0.018) {
            heardSpeech = true
            silenceStartedAt = null
          } else if (heardSpeech) {
            silenceStartedAt ??= Date.now()
            if (Date.now() - silenceStartedAt > 1200 && recorder.state === 'recording') {
              recorder.stop()
              return
            }
          }
          recordingMonitorRef.current.frameId = requestAnimationFrame(monitorSpeech)
        }
        recordingMonitorRef.current = { frameId: requestAnimationFrame(monitorSpeech), audioContext }
      }
    } catch {
      setIsListening(false)
      setMessages((current) => [...current, { role: 'system', text: 'Microphone access is needed to record your voice.' }])
    }
  }

  if (screen === 'landing') return (
    <main className="landing">
      <header className="minimal-header"><span className="logo-dot" /> VoiceBill <span className={`api-status ${health === 'Ready' ? 'ready' : ''}`}>{health}</span></header>
      <section className="landing-content">
        <h1>VoiceBill</h1>
        <p className="landing-copy">Create a bill with your voice.</p>
        <button className="enter-button" onClick={beginSession} disabled={isStarting}>{isStarting ? 'Starting…' : 'Start billing'}</button>
        {history.length > 0 && <section className="history"><p>Bill history</p>{history.map((bill) => <button className="history-row" key={bill.id} onClick={() => openInvoice(bill.id)}><span>Bill #{bill.id}<small>{bill.item_count} {bill.item_count === 1 ? 'item' : 'items'}</small></span><strong>₹{bill.total}</strong></button>)}</section>}
      </section>
    </main>
  )

  if (screen === 'invoice' && invoice) return (
    <main className="invoice-screen">
      <header className="voice-header"><button className="back-button" onClick={() => setScreen('voice')}>← <span>Back</span></button><span className="session-label">BILL #{invoice.id}</span></header>
      <section className="invoice-card">
        <p className="invoice-label">INVOICE</p>
        <h1>{invoice.merchant_name}</h1>
        <p className="invoice-date">Bill #{invoice.id}</p>
        <div className="invoice-items">
          {invoice.items.length ? invoice.items.map((item) => <div className="invoice-item" key={item.id}><span>{item.name}<small>{item.quantity} × ₹{item.unit_price}</small></span><strong>₹{item.line_total}</strong></div>) : <p className="empty-invoice">No items were added.</p>}
        </div>
        <div className="invoice-total"><span>Total</span><strong>₹{invoice.total}</strong></div>
        <div className="payment-section">
          <img className="qr-code" src={`${API_URL}/sessions/${invoice.id}/invoice/qr`} alt={`UPI QR code for ₹${invoice.total}`} />
          <p>Scan to pay ₹{invoice.total}</p><small>{invoice.upi_id}</small>
        </div>
      </section>
      <button className="done-button" onClick={() => { setInvoice(null); setSession(null); sessionRef.current = null; setMessages([]); loadHistory(); setScreen('landing') }}>Done</button>
    </main>
  )

  return (
    <main className="voice-screen">
      <header className="voice-header">
        <button className="back-button" onClick={() => setScreen('landing')}>← <span>VoiceBill</span></button>
        <div className="voice-actions"><button className="finish-button" onClick={() => finishBill()} disabled={!session || isListening || isTranscribing}>Finish bill</button></div>
      </header>
      <div className="billing-workspace">
        <div className="talk-column">
          <section className="conversation" aria-live="polite">
            {messages.map((message, index) => <p key={index} className={`message ${message.role}`}>{message.text}</p>)}
            {liveTranscript && <p className="message user live">{liveTranscript}</p>}
          </section>
          <section className="speak-area">
            <p className="listening-label">{isListening ? 'Listening… sends when you pause' : isTranscribing ? 'Understanding…' : isSpeaking ? 'Speaking…' : 'Ready'}</p>
            <button className={`mic-button ${isListening ? 'listening' : ''}`} onClick={toggleListening} disabled={isTranscribing} aria-label={isListening ? 'Stop recording' : 'Start recording'}><span className="mic-icon">●</span>{isListening && <><i className="pulse pulse-one" /><i className="pulse pulse-two" /></>}</button>
            <p className="hint">Hinglish voice input</p>
            {voices.length > 1 && <label className="voice-picker">Voice <select value={voiceName} onChange={(event) => setVoiceName(event.target.value)} disabled={isListening || isSpeaking}>{voices.filter((voice) => voice.lang.toLowerCase().startsWith('en')).map((voice) => <option value={voice.name} key={voice.voiceURI}>{voice.name}</option>)}</select></label>}
          </section>
        </div>
        <aside className="bill-preview" aria-label="Live bill preview">
          <div className="preview-heading"><span>Bill preview</span><small>LIVE</small></div>
          <div className="preview-items">{bill.items.length ? bill.items.map((item) => editingItemId === item.id ? <div className="preview-edit" key={item.id}><input value={itemDraft.name} onChange={(event) => setItemDraft((draft) => ({ ...draft, name: event.target.value }))} aria-label="Item name" /><div><input type="number" min="0.01" step="0.01" value={itemDraft.quantity} onChange={(event) => setItemDraft((draft) => ({ ...draft, quantity: event.target.value }))} aria-label="Quantity" /><input type="number" min="0" step="0.01" value={itemDraft.unit_price} onChange={(event) => setItemDraft((draft) => ({ ...draft, unit_price: event.target.value }))} aria-label="Unit price" /></div><div className="edit-actions"><button onClick={() => saveItemEdit(item.id)}>Save</button><button onClick={() => setEditingItemId(null)}>Cancel</button></div></div> : <div className="preview-item" key={item.id}><span>{item.name}<small>{item.quantity} × ₹{item.unit_price}</small></span><div><strong>₹{item.line_total}</strong><button onClick={() => beginEditing(item)} aria-label={`Edit ${item.name}`}>Edit</button><button onClick={() => removeItem(item.id)} aria-label={`Remove ${item.name}`}>×</button></div></div>) : <p className="preview-empty">Items you add will appear here.</p>}</div>
          <div className="preview-total"><span>Total</span><strong>₹{bill.total}</strong></div>
        </aside>
      </div>
    </main>
  )
}
