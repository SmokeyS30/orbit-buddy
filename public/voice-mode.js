// Orbit Buddy voice conversation mode ("call Orbit").
//
// A real spoken conversation: the user talks, Orbit talks back. The transcript
// is an ordinary chat conversation (every turn goes through the normal chat
// pipeline), so history, search, and memories all work unchanged.
//
// Speech recognition: Web Speech API when available (free, on-device, low
// latency); otherwise the server-side Whisper fallback via deps.transcribeAudio.
// Speech synthesis: speechSynthesis with a picked natural voice.
// Barge-in: pressing the orb while Orbit is speaking cancels the speech and
// starts listening immediately. True acoustic barge-in (detecting the user's
// voice over the speaker output) is deferred — the orb is the interrupt.
//
// Pure helpers (isVoiceModeCommand, speechText, pickVoice) are exported for
// unit tests. The VoiceMode controller is DOM-dependent and wired from app.js.

/** Typed chat commands that open voice mode instead of sending a message. */
export function isVoiceModeCommand(text) {
  const t = String(text || '').trim();
  return (
    /^(call|phone|ring)\s+(orbit|you)\b[\s.!?]*$/i.test(t) ||
    /^voice\s+(mode|chat|call)\b[\s.!?]*$/i.test(t) ||
    /^let'?s\s+talk\b[\s.!?]*$/i.test(t) ||
    /^talk\s+to\s+me\b[\s.!?]*$/i.test(t)
  );
}

/**
 * Convert a markdown chat reply into speakable plain text for TTS.
 * Code and tables are summarized rather than read aloud; links keep
 * their text; everything is collapsed to flowing sentences.
 */
export function speechText(markdown) {
  let s = String(markdown || '');
  // Code fences: don't read code aloud — note that it's in the transcript.
  s = s.replace(/```[\s\S]*?```/g, ' … ');
  // Inline code: keep the words, drop the backticks.
  s = s.replace(/`([^`]+)`/g, '$1');
  // Images: keep alt text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links: keep the link text.
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Headings: keep the text, add a pause.
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '$1. ');
  // Blockquotes: keep the text.
  s = s.replace(/^>\s?(.+)$/gm, '$1');
  // List markers: turn into sentence breaks.
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '');
  // Table rows: cells become comma-separated phrases.
  s = s.replace(/^\s*\|(.+)\|\s*$/gm, (_, row) => {
    if (/^[\s|:.-]+$/.test(row)) return '';
    return row.split('|').map((c) => c.trim()).filter(Boolean).join(', ') + '. ';
  });
  // Bold/italic/strikethrough markers.
  s = s.replace(/(\*\*|__)([^*_]+)\1/g, '$2');
  s = s.replace(/(\*|_)([^*_]+)\1/g, '$2');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  // Horizontal rules and leftover HTML.
  s = s.replace(/^\s*(?:---|\*\*\*|___)\s*$/gm, '');
  s = s.replace(/<[^>]+>/g, ' ');
  // Collapse whitespace.
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').replace(/\n/g, ' ').trim();
  s = s.replace(/\s+([.,!?;:])/g, '$1');
  // TTS sanity cap: very long replies get summarized by truncation.
  const MAX = 1500;
  if (s.length > MAX) s = s.slice(0, MAX).replace(/\s+\S*$/, '') + '…';
  return s;
}

/**
 * Pick the most natural-sounding English voice from speechSynthesis voices.
 * Pure function over voice descriptors so it can be unit tested.
 */
export function pickVoice(voices) {
  const list = Array.isArray(voices) ? voices : [];
  if (!list.length) return null;
  const novelty = /(novelty|whisper|cellos|zarvox|boing|bubbles|bad news|good news|trinoids|deranged)/i;
  let best = null;
  let bestScore = -Infinity;
  for (const v of list) {
    const name = String(v.name || '');
    const lang = String(v.lang || '');
    if (novelty.test(name)) continue;
    let score = 0;
    if (/^en/i.test(lang)) score += 10;
    if (/^en[-_]US/i.test(lang)) score += 5;
    if (/samantha|google us english|zira|david|natural|neural|aria|guy|jenny|aria/i.test(name)) score += 8;
    if (v.localService) score += 2;
    if (v.default) score += 1;
    if (score > bestScore) { bestScore = score; best = v; }
  }
  return best;
}

/**
 * Create the voice-mode controller.
 *
 * deps:
 *   buddyName()            -> display name for the overlay
 *   sendTurn(text)         -> Promise<string>: post a chat turn and resolve
 *                              with the assistant's reply text when done
 *   transcribeAudio(blob)  -> Promise<string>: Whisper fallback for browsers
 *                              without Web Speech API
 */
export function createVoiceMode(deps) {
  const els = {};
  let state = 'closed'; // closed|listening|thinking|speaking|recording
  let recognition = null;
  let recorder = null;
  let recordChunks = [];
  let synth = null;
  let pickedVoice = null;

  function $(id) { return document.getElementById(id); }

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
  }

  function setOrb(mode) {
    if (!els.orb) return;
    els.orb.classList.toggle('listening', mode === 'listening' || mode === 'recording');
    els.orb.classList.toggle('speaking', mode === 'speaking' || mode === 'thinking');
  }

  function addLine(role, text, live) {
    if (!els.transcript) return null;
    let line = live ? els.transcript.querySelector('.voice-line.live') : null;
    if (!line) {
      line = document.createElement('div');
      line.className = 'voice-line ' + role + (live ? ' live' : '');
      els.transcript.appendChild(line);
    }
    line.textContent = text;
    els.transcript.scrollTop = els.transcript.scrollHeight;
    return line;
  }

  function clearLiveLine() {
    const live = els.transcript && els.transcript.querySelector('.voice-line.live');
    if (live) live.remove();
  }

  function stopRecognition() {
    if (recognition) {
      try { recognition.onresult = null; recognition.onend = null; recognition.onerror = null; recognition.abort(); } catch (_) {}
      recognition = null;
    }
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (_) {}
    }
    recorder = null;
    recordChunks = [];
  }

  function stopSpeaking() {
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (_) {}
  }

  function stopAll() {
    stopRecognition();
    stopRecording();
    stopSpeaking();
  }

  const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;

  function startListen() {
    if (state === 'closed') return;
    stopAll();
    if (SR()) {
      state = 'listening';
      setOrb('listening');
      setStatus('Listening…');
      const Rec = SR();
      recognition = new Rec();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      let finalTranscript = '';
      recognition.onresult = (event) => {
        if (state !== 'listening') return;
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const tr = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalTranscript += tr + ' ';
          else interim += tr;
        }
        const show = (finalTranscript + interim).trim();
        if (show) addLine('user', show, true);
      };
      recognition.onend = () => {
        recognition = null;
        if (state !== 'listening') return;
        const text = finalTranscript.trim();
        clearLiveLine();
        if (text) submitTurn(text);
        else startListen(); // hands-free: keep the conversation going
      };
      recognition.onerror = (event) => {
        recognition = null;
        if (state !== 'listening') return;
        const err = event && event.error;
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          setStatus('Microphone is blocked — allow it to keep talking.');
          state = 'idle-blocked';
          setOrb('idle');
          return;
        }
        // 'no-speech', 'aborted', 'network': just listen again
        if (err !== 'aborted') startListen();
      };
      try {
        recognition.start();
      } catch (_) {
        state = 'idle-blocked';
        setStatus('Could not start listening.');
      }
    } else {
      // No Web Speech API (e.g. Firefox): tap-to-record via Whisper fallback.
      state = 'idle-tap';
      setOrb('idle');
      setStatus('Tap the mic, say your piece, tap again to send.');
    }
  }

  async function startRecording() {
    stopAll();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      setStatus('Microphone is blocked — allow it to keep talking.');
      return;
    }
    recordChunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recordChunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordChunks, { type: recorder.mimeType || 'audio/webm' });
      recordChunks = [];
      recorder = null;
      if (state === 'closed') return;
      if (!blob.size) { startListen(); return; }
      state = 'thinking';
      setOrb('thinking');
      setStatus('Transcribing…');
      try {
        const text = (await deps.transcribeAudio(blob)).trim();
        if (text) submitTurn(text);
        else { setStatus('Didn’t catch that — try again.'); startListen(); }
      } catch (e) {
        setStatus('Transcription failed — try again.');
        startListen();
      }
    };
    recorder.start();
    state = 'recording';
    setOrb('recording');
    setStatus('Recording… tap the mic to send.');
  }

  async function submitTurn(text) {
    if (state === 'closed') return;
    stopAll();
    state = 'thinking';
    setOrb('thinking');
    setStatus('Thinking…');
    clearLiveLine();
    addLine('user', text);
    let reply = '';
    try {
      reply = await deps.sendTurn(text);
    } catch (e) {
      if (state === 'closed') return;
      addLine('assistant', 'Hmm — that didn’t go through. ' + (e && e.message ? e.message : 'Try again.'));
      startListen();
      return;
    }
    if (state === 'closed') return;
    if (reply) addLine('assistant', reply.length > 400 ? reply.slice(0, 400) + '…' : reply);
    speak(reply);
  }

  function speak(text) {
    if (state === 'closed') return;
    const clean = speechText(text);
    if (!clean || !('speechSynthesis' in window)) { startListen(); return; }
    stopSpeaking();
    state = 'speaking';
    setOrb('speaking');
    setStatus('Speaking… tap the mic to interrupt.');
    synth = window.speechSynthesis;
    if (!pickedVoice) {
      try { pickedVoice = pickVoice(synth.getVoices()); } catch (_) { pickedVoice = null; }
    }
    const utter = new SpeechSynthesisUtterance(clean);
    if (pickedVoice) utter.voice = pickedVoice;
    utter.rate = 1;
    utter.pitch = 1;
    const done = () => { if (state === 'speaking') startListen(); };
    utter.onend = done;
    utter.onerror = done;
    synth.speak(utter);
  }

  /** Barge-in: interrupt Orbit and take the floor. */
  function interrupt() {
    if (state === 'closed') return;
    if (state === 'speaking' || state === 'thinking') {
      stopAll();
      startListen();
      return;
    }
    if (state === 'recording') {
      // Stop and send what was recorded so far.
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
      return;
    }
    if (state === 'idle-tap' || state === 'idle-blocked') {
      startRecording();
      return;
    }
    if (state === 'listening') {
      // Already listening with Web Speech — nothing to do.
      return;
    }
  }

  function open() {
    els.overlay = $('voice-overlay');
    els.orb = $('voice-orb');
    els.status = $('voice-status');
    els.transcript = $('voice-transcript');
    els.name = $('voice-name');
    if (!els.overlay) return;
    if (state !== 'closed') return;
    try {
      const name = deps.buddyName ? deps.buddyName() : 'Orbit';
      if (els.name) els.name.textContent = name || 'Orbit';
    } catch (_) {}
    els.transcript.replaceChildren();
    els.overlay.classList.remove('hidden');
    document.body.classList.add('voice-open');
    try {
      if (window.speechSynthesis) {
        pickedVoice = pickVoice(window.speechSynthesis.getVoices());
        window.speechSynthesis.onvoiceschanged = () => {
          pickedVoice = pickVoice(window.speechSynthesis.getVoices());
        };
      }
    } catch (_) {}
    startListen();
  }

  function close() {
    state = 'closed';
    stopAll();
    if (els.overlay) els.overlay.classList.add('hidden');
    document.body.classList.remove('voice-open');
  }

  function isOpen() { return state !== 'closed'; }

  function wire() {
    const done = $('voice-done');
    if (done && !done.dataset.wired) {
      done.dataset.wired = '1';
      done.addEventListener('click', () => close());
    }
    const orb = $('voice-orb');
    if (orb && !orb.dataset.wired) {
      orb.dataset.wired = '1';
      orb.addEventListener('pointerdown', (e) => { e.preventDefault(); interrupt(); });
      orb.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); interrupt(); }
      });
    }
  }

  return { open, close, isOpen, wire, interrupt };
}
