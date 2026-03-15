// Mock phone UI — browser app

const messagesEl = document.getElementById('messages');
const waitingEl = document.getElementById('waiting');
const inputEl = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const hangupBtn = document.getElementById('hangup-btn');
const statusEl = document.getElementById('call-status');
const micBtn = document.getElementById('mic-btn');
const voiceToggle = document.getElementById('voice-toggle');
const voiceStatusEl = document.getElementById('voice-status');

let ws = null;
let inCall = false;

// --------------- Voice Mode ---------------

let voiceMode = false;
let recognition = null;
let recognizing = false;
let audioCtx = null;

// Toggle voice mode on/off
voiceToggle.addEventListener('click', () => {
  voiceMode = !voiceMode;
  if (voiceMode) {
    voiceToggle.classList.add('active');
    voiceToggle.textContent = '🔊 Voice On';
    micBtn.style.display = 'block';
  } else {
    voiceToggle.classList.remove('active');
    voiceToggle.textContent = '🔇 Voice Off';
    micBtn.style.display = 'none';
    stopRecognition();
    speechSynthesis.cancel();
    setVoiceStatus('');
  }
});

// --------------- Speech Synthesis (TTS) ---------------

function speakText(text) {
  if (!voiceMode) return;
  // Cancel any in-progress speech
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  utterance.onstart = () => setVoiceStatus('speaking', 'Speaking...');
  utterance.onend = () => setVoiceStatus('');
  utterance.onerror = () => setVoiceStatus('');

  speechSynthesis.speak(utterance);
}

// --------------- Speech Recognition (STT) ---------------

function createRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('SpeechRecognition not supported in this browser');
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onresult = (event) => {
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        const transcript = result[0].transcript.trim();
        if (transcript && inCall) {
          inputEl.value = '';
          addMessage('user', transcript);
          ws.send(JSON.stringify({ type: 'user-input', text: transcript }));
        }
      } else {
        interimTranscript += result[0].transcript;
      }
    }
    // Show interim results in the input field
    if (interimTranscript) {
      inputEl.value = interimTranscript;
    }
  };

  rec.onstart = () => {
    recognizing = true;
    micBtn.classList.add('active');
    setVoiceStatus('listening', 'Listening...');
  };

  rec.onend = () => {
    recognizing = false;
    micBtn.classList.remove('active');
    // Only clear status if we're not speaking
    if (!speechSynthesis.speaking) {
      setVoiceStatus('');
    }
    // Restart if voice mode is still on and in call (continuous listening)
    if (voiceMode && inCall) {
      try {
        rec.start();
      } catch (e) {
        // Ignore — already started
      }
    }
  };

  rec.onerror = (event) => {
    // 'no-speech' and 'aborted' are normal operational errors, not failures
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.error('SpeechRecognition error:', event.error);
      setVoiceStatus('', 'Mic error: ' + event.error);
    }
  };

  return rec;
}

function startRecognition() {
  if (recognizing) return;
  // Cancel TTS so the mic doesn't pick up the speaker
  speechSynthesis.cancel();
  if (!recognition) {
    recognition = createRecognition();
  }
  if (recognition) {
    try {
      recognition.start();
    } catch (e) {
      // Ignore if already started
    }
  }
}

function stopRecognition() {
  if (recognition && recognizing) {
    // Temporarily disable voiceMode so onend handler won't restart
    const wasVoice = voiceMode;
    voiceMode = false;
    recognition.stop();
    voiceMode = wasVoice;
  }
  recognizing = false;
  micBtn.classList.remove('active');
}

// Mic button toggles recognition
micBtn.addEventListener('click', () => {
  if (!voiceMode) return;
  if (recognizing) {
    stopRecognition();
    setVoiceStatus('');
  } else {
    startRecognition();
  }
});

// --------------- Voice Status Indicator ---------------

function setVoiceStatus(mode, text) {
  if (!mode && !text) {
    voiceStatusEl.textContent = '';
    voiceStatusEl.className = '';
    return;
  }
  voiceStatusEl.className = mode || '';
  voiceStatusEl.textContent = text || '';
}

// --------------- Ring Sound Effect ---------------

function playRingSound() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Play three short beeps
    const beepTimes = [0, 0.25, 0.5];
    beepTimes.forEach((startTime) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime + startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + startTime + 0.15);
      osc.start(audioCtx.currentTime + startTime);
      osc.stop(audioCtx.currentTime + startTime + 0.15);
    });
  } catch (e) {
    console.warn('Could not play ring sound:', e);
  }
}

// --------------- WebSocket & Core Logic ---------------

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    statusEl.textContent = 'Connected — waiting for call...';
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'incoming-call') {
      inCall = true;
      waitingEl.style.display = 'none';
      statusEl.textContent = 'In call with Claude';
      inputEl.disabled = false;
      sendBtn.disabled = false;
      hangupBtn.style.display = 'block';
      addMessage('system', 'Call connected');
      playRingSound();

      // Auto-start listening if voice mode is on
      if (voiceMode) {
        startRecognition();
      }
    }

    if (msg.type === 'assistant-message') {
      addMessage('assistant', msg.text);
      // Speak assistant message if voice mode is on
      if (voiceMode) {
        speakText(msg.text);
      }
    }

    if (msg.type === 'call-ended') {
      inCall = false;
      statusEl.textContent = 'Call ended';
      inputEl.disabled = true;
      sendBtn.disabled = true;
      hangupBtn.style.display = 'none';
      addMessage('system', 'Call ended');
      stopRecognition();
      speechSynthesis.cancel();
      setVoiceStatus('');
    }

    if (msg.type === 'call-error') {
      addMessage('system', `Error: ${msg.error}`);
    }
  };

  ws.onclose = () => {
    statusEl.textContent = 'Disconnected — reconnecting...';
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    statusEl.textContent = 'Connection error';
  };
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = role === 'assistant' ? 'Claude' : role === 'user' ? 'You' : 'System';

  const content = document.createElement('div');
  content.textContent = text;

  div.appendChild(label);
  div.appendChild(content);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || !ws || !inCall) return;

  // Cancel TTS when user sends a message
  if (voiceMode) {
    speechSynthesis.cancel();
  }

  addMessage('user', text);
  ws.send(JSON.stringify({ type: 'user-input', text }));
  inputEl.value = '';
  inputEl.focus();
}

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

hangupBtn.addEventListener('click', () => {
  if (ws) {
    ws.send(JSON.stringify({ type: 'hang-up' }));
  }
});

// Start connection
connect();
