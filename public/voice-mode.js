// Orbit Buddy voice conversation mode ("call Orbit").
//
// A real spoken conversation: the user talks, Orbit talks back. The transcript
// is an ordinary chat conversation (every turn goes through the normal chat
// pipeline), so history, search, and memories all work unchanged.
//
// Speech recognition uses consent-gated server transcription via deps.transcribeAudio.
// Speech synthesis: speechSynthesis with a picked natural voice.
// Barge-in: true acoustic barge-in — while Orbit is speaking, a mic analyser
// watches for sustained user speech over the speaker output and cancels the
// utterance so Orbit stops talking when Edward starts. Orb-tap stays as the
// fallback for devices where the analyser can't run.
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
 * Acoustic barge-in detector (pure logic — no DOM or audio, unit-testable).
 *
 * Feed it smoothed mic RMS-energy samples (linear amplitude, 0..1) while Orbit
 * is speaking. sample() returns true only when energy stays above the trigger
 * threshold for `framesRequired` consecutive frames — sustained user speech,
 * not spikes (a door slam never cancels speech).
 *
 * Trigger rule: smoothed RMS must exceed
 *   max(floorRms, relativeFactor × rollingBaseline).
 * The floor is a conservative absolute starting point (~-30 dBFS); the
 * relative rule (2.5× Orbit's own voice level through the speaker, measured
 * over a ~2s rolling baseline) adapts to device volume. Pass the grace-period
 * baseline seed to arm() so the relative rule protects from the first frame —
 * otherwise Orbit's own voice could false-trigger before the baseline adapts.
 *
 * Anti-false-trigger design (the whole point of this function):
 *  - Only armed while Orbit is speaking: arm()/disarm() are called from the
 *    controller's utterance lifecycle. Samples while disarmed are ignored.
 *  - Sustained, not spiky: requires `framesRequired` consecutive above-
 *    threshold frames (~300ms at the default 50ms cadence).
 *  - Cooldown: after a trigger, arming within `cooldownMs` can't re-trigger
 *    (avoids chopping on the tail of the user's own interruption).
 *  - Baseline only adapts from below-threshold samples, so a loud user never
 *    drags the baseline up and masks themselves.
 *
 * Tuning starting points (empirical, per device): floor -30 dBFS,
 * factor 2.5×, 6 frames (~300ms), grace ~800ms before arming,
 * cooldown 1500ms. If false triggers appear on a device, raise the floor or
 * the factor; if it never fires, lower them. Orb-tap interrupt always works.
 */
export function createBargeInDetector(opts = {}) {
  const {
    floorDb = -30,        // absolute energy floor (dBFS) — conservative start
    relativeFactor = 2.5, // must jump this far above the speaking baseline
    framesRequired = 6,   // consecutive frames above threshold (~300ms @ 50ms)
    cooldownMs = 1500,    // after a trigger, don't re-fire this soon
    baselineTauMs = 2000, // rolling baseline time constant during speech
    frameMs = 50,         // expected sampling cadence
  } = opts;
  const floorRms = Math.pow(10, floorDb / 20);
  let armed = false;
  let aboveCount = 0;
  let baseline = 0;
  let lastTriggerAt = -Infinity;

  return {
    /**
     * Arm for a new utterance. baselineSeed is linear-RMS energy measured
     * during the grace period (Orbit's own voice level); defaults to 0.
     */
    arm(nowMs = 0, baselineSeed = 0) {
      armed = true;
      aboveCount = 0;
      baseline = Math.max(0, baselineSeed || 0);
    },
    /** Disarm; cooldown memory survives so a fresh arm can't re-fire instantly. */
    disarm() {
      armed = false;
      aboveCount = 0;
    },
    isArmed() { return armed; },
    /**
     * Feed one smoothed RMS sample (linear amplitude). Returns true exactly
     * once per barge-in (auto-disarms and starts cooldown).
     */
    sample(rms, nowMs = 0) {
      if (!armed) return false;
      if (nowMs - lastTriggerAt < cooldownMs) { aboveCount = 0; return false; }
      const threshold = Math.max(floorRms, baseline * relativeFactor);
      if (rms > threshold) {
        aboveCount += 1;
        if (aboveCount >= framesRequired) {
          armed = false;
          aboveCount = 0;
          lastTriggerAt = nowMs;
          return true;
        }
      } else {
        aboveCount = 0;
        // Adapt to Orbit's voice level, but only from below-threshold samples
        // so the user's own interruption never poisons the baseline.
        baseline += (rms - baseline) * (frameMs / baselineTauMs);
      }
      return false;
    },
  };
}

/**
 * Create the voice-mode controller.
 *
 * deps:
 *   buddyName()            -> display name for the overlay
 *   sendTurn(text)         -> Promise<string>: post a chat turn and resolve
 *                              with the assistant's reply text when done
 *   transcribeAudio(blob)  -> Promise<string>: consent-gated server transcription
 */
export function createVoiceMode(deps) {
  const els = {};
  let state = 'closed'; // closed|opening|idle-tap|thinking|speaking|recording
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
    stopRecording();
    stopSpeaking();
    stopBargeSampling();
  }

  // ---- Acoustic barge-in wiring ----
  // One persistent mic stream per voice session; an AnalyserNode on it feeds
  // smoothed RMS energy to the detector only while Orbit is speaking. No new
  // buttons or settings: it just works, orb-tap remains the fallback.
  let bargeAudio = null;     // { ctx, stream, analyser, data } — one session stream
  let bargeGrace = null;     // grace-period seeding timer (~800ms)
  let bargeTimer = null;      // armed sampling interval (50ms)
  let bargeDetector = null;  // createBargeInDetector instance (keeps cooldown across utterances)
  let bargeSmoothed = 0;     // ~200ms EMA of RMS while armed

  function stopBargeSampling() {
    if (bargeTimer) { clearInterval(bargeTimer); bargeTimer = null; }
    if (bargeGrace) { clearTimeout(bargeGrace); bargeGrace = null; }
    if (bargeDetector) { try { bargeDetector.disarm(); } catch (_) {} }
  }

  function teardownBargeAudio() {
    stopBargeSampling();
    if (bargeAudio) {
      try {
        if (bargeAudio.stream) bargeAudio.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        if (bargeAudio.ctx && typeof bargeAudio.ctx.close === 'function') { try { bargeAudio.ctx.close(); } catch (_) {} }
      } catch (_) {}
      bargeAudio = null;
    }
    bargeDetector = null;
  }

  /** One mic stream for the session; null-safe, never throws. */
  async function ensureBargeAudio() {
    if (bargeAudio && bargeAudio.analyser) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
      if (!bargeAudio) bargeAudio = {};
      if (!bargeAudio.ctx) bargeAudio.ctx = new AC();
      if (bargeAudio.ctx.state === 'suspended') {
        try { await bargeAudio.ctx.resume(); } catch (_) {}
      }
      if (!bargeAudio.stream || bargeAudio.stream.getTracks().every((t) => t.readyState === 'ended')) {
        // One stream per session, opened lazily on the first utterance (mic
        // permission is already granted by then — the user has spoken).
        bargeAudio.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const src = bargeAudio.ctx.createMediaStreamSource(bargeAudio.stream);
      bargeAudio.analyser = bargeAudio.ctx.createAnalyser();
      bargeAudio.analyser.fftSize = 2048;
      src.connect(bargeAudio.analyser);
      bargeAudio.data = new Float32Array(bargeAudio.analyser.fftSize);
      return true;
    } catch (_) {
      return false; // mic unavailable — orb-tap interrupt stays the fallback
    }
  }

  function micRmsNow() {
    try {
      if (!bargeAudio || !bargeAudio.analyser) return null;
      bargeAudio.analyser.getFloatTimeDomainData(bargeAudio.data);
      let sum = 0;
      const d = bargeAudio.data;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      return Math.sqrt(sum / d.length);
    } catch (_) {
      return null;
    }
  }

  function sampleBargeIn() {
    if (state !== 'speaking' || !bargeDetector) { stopBargeSampling(); return; }
    const rms = micRmsNow();
    if (rms == null) return;
    // ~200ms exponential moving average, then the detector's sustained-frame rule.
    bargeSmoothed += (rms - bargeSmoothed) * (50 / 200);
    let trigger = false;
    try { trigger = bargeDetector.sample(bargeSmoothed, performance.now()); } catch (_) {}
    if (trigger) {
      // Acoustic barge-in: Orbit stops mid-sentence, listening resumes.
      // interrupt() calls speechSynthesis.cancel() exactly once via stopAll().
      stopBargeSampling();
      setStatus('Interrupted — listening…');
      interrupt();
    }
  }

  /**
   * Arm the detector for the current utterance: ~800ms grace period (never
   * armed during TTS onset / mic unmute pops), measuring Orbit's own voice
   * level as the baseline seed so the relative trigger is safe immediately.
   */
  function armBargeIn() {
    stopBargeSampling();
    if (!('speechSynthesis' in window)) return;
    if (!bargeDetector) bargeDetector = createBargeInDetector();
    const detector = bargeDetector;
    (async () => {
      const ready = await ensureBargeAudio();
      if (!ready || state !== 'speaking') { stopBargeSampling(); return; }
      let seed = 0;
      let frames = 0;
      const tickSeed = () => {
        bargeGrace = null;
        if (state !== 'speaking') { stopBargeSampling(); return; }
        const rms = micRmsNow();
        // Fast EMA (~250ms tau) — ~96% converged after the grace period.
        if (rms != null) seed += (rms - seed) * 0.2;
        frames += 1;
        if (frames >= 16) { // ~800ms at 50ms/frame: grace over, arm it
          detector.arm(performance.now(), seed);
          bargeSmoothed = 0;
          bargeTimer = setInterval(sampleBargeIn, 50);
        } else {
          bargeGrace = setTimeout(tickSeed, 50);
        }
      };
      bargeGrace = setTimeout(tickSeed, 50);
    })().catch(() => { stopBargeSampling(); });
  }

  function startListen() {
    if (state === 'closed') return;
    stopAll();
    state = 'idle-tap';
    setOrb('idle');
    setStatus('Tap the mic, say your piece, tap again to send.');
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
    setStatus('Speaking… start talking to interrupt.');
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
    // Acoustic barge-in: after an ~800ms grace period the mic analyser arms
    // and Orbit stops mid-sentence when Edward starts talking. Orb-tap stays
    // as the interrupt fallback.
    armBargeIn();
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
        // Warm up speechSynthesis inside the opening user gesture so later
        // speak() calls are allowed on strict platforms (iOS Safari).
        try {
          const warm = new SpeechSynthesisUtterance(' ');
          warm.volume = 0;
          window.speechSynthesis.speak(warm);
        } catch (_) {}
        pickedVoice = pickVoice(window.speechSynthesis.getVoices());
        window.speechSynthesis.onvoiceschanged = () => {
          pickedVoice = pickVoice(window.speechSynthesis.getVoices());
        };
      }
      // Warm up the barge-in AudioContext inside this opening tap gesture so
      // it isn't left suspended on strict platforms (iOS Safari); the mic
      // stream itself is opened lazily on the first utterance.
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          if (!bargeAudio) bargeAudio = {};
          if (!bargeAudio.ctx) {
            bargeAudio.ctx = new AC();
            if (bargeAudio.ctx.state === 'suspended') {
              const p = bargeAudio.ctx.resume();
              if (p && typeof p.catch === 'function') p.catch(() => {});
            }
          }
        }
      } catch (_) {}
    } catch (_) {}
    // Mark the controller open before startListen(). startListen() deliberately
    // ignores calls while closed, so leaving this as "closed" reveals the
    // overlay but strands it on the HTML's default "Listening…" text.
    state = 'opening';
    startListen();
  }

  function close() {
    state = 'closed';
    stopAll();
    teardownBargeAudio();
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
