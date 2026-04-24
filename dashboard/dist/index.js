/**
 * Hermes Voice dashboard plugin.
 *
 * Plain IIFE bundle that uses the dashboard Plugin SDK globals.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var React = SDK.React;
  var useCallback = SDK.hooks.useCallback;
  var useEffect = SDK.hooks.useEffect;
  var useLayoutEffect = SDK.hooks.useLayoutEffect || SDK.hooks.useEffect;
  var useRef = SDK.hooks.useRef;
  var useState = SDK.hooks.useState;
  var Button = SDK.components.Button;
  var Badge = SDK.components.Badge;
  var Label = SDK.components.Label;
  var Select = SDK.components.Select;
  var SelectOption = SDK.components.SelectOption;
  var cn = SDK.utils.cn;

  var API = "/api/plugins/voice";
  var SILENT_AUDIO_URL = "data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQgAAAAA";
  var DEFAULT_VOICES = [
    "en-US-AriaNeural",
    "en-US-JennyNeural",
    "en-US-AndrewNeural",
    "en-US-BrianNeural",
    "en-GB-SoniaNeural",
  ];
  var STATES = {
    IDLE: "idle",
    REQUESTING_MIC: "requesting_mic",
    RECORDING: "recording",
    UPLOADING: "uploading",
    TRANSCRIBING: "transcribing",
    THINKING: "thinking",
    SPEAKING: "speaking",
    INTERRUPTED: "interrupted",
    BUFFERING: "buffering",
    ERROR: "error",
    MISSING_CONFIG: "missing_configuration",
  };

  function h(type, props) {
    var children = Array.prototype.slice.call(arguments, 2);
    return React.createElement.apply(React, [type, props].concat(children));
  }

  function statusText(state) {
    switch (state) {
      case STATES.REQUESTING_MIC:
        return "Requesting microphone";
      case STATES.RECORDING:
        return "Listening";
      case STATES.UPLOADING:
        return "Uploading audio";
      case STATES.TRANSCRIBING:
        return "Transcribing";
      case STATES.THINKING:
        return "Hermes is thinking";
      case STATES.SPEAKING:
        return "Speaking";
      case STATES.BUFFERING:
        return "Preparing playback";
      case STATES.INTERRUPTED:
        return "Playback stopped";
      case STATES.ERROR:
        return "Needs attention";
      case STATES.MISSING_CONFIG:
        return "Configuration required";
      default:
        return "Ready";
    }
  }

  function parseEventPayload(event) {
    try {
      return JSON.parse(event.data);
    } catch (err) {
      return { event: "error", message: "Bad stream payload" };
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function createSilenceDetector(config) {
    var silenceSeconds = config && typeof config.silenceSeconds === "number" ? config.silenceSeconds : 2;
    var warmupMs = config && typeof config.warmupMs === "number" ? config.warmupMs : 700;
    var detectionStartedAt = null;
    var firstFrameAt = null;
    var silenceStartedAt = 0;
    var baselineLevel = Infinity;
    var baselinePeak = Infinity;
    var speechLevel = 0;
    var speechPeak = 0;
    var smoothedLevel = 0;
    var smoothedPeak = 0;

    function hasUsableSignal(level, peakDeviation) {
      return level > 0.01 || peakDeviation > 0.02;
    }

    function noSpeechTimeoutMs() {
      return warmupMs + silenceSeconds * 1000;
    }

    function smooth(previousValue, nextValue) {
      if (!(previousValue > 0)) return nextValue;
      return previousValue * 0.82 + nextValue * 0.18;
    }

    function rememberQuietFloor(level, peakDeviation) {
      baselineLevel = Math.min(baselineLevel, level);
      baselinePeak = Math.min(baselinePeak, peakDeviation);
    }

    function rememberSpeech(level, peakDeviation) {
      speechLevel = Math.max(speechLevel * 0.94, level);
      speechPeak = Math.max(speechPeak * 0.94, peakDeviation);
    }

    function thresholds() {
      var rememberedLevel = Number.isFinite(baselineLevel) ? baselineLevel : Math.max(smoothedLevel, 0.055);
      var rememberedPeak = Number.isFinite(baselinePeak) ? baselinePeak : Math.max(smoothedPeak, 0.16);
      var observedSpeechLevel = speechLevel > 0 ? speechLevel : rememberedLevel + 0.12;
      var observedSpeechPeak = speechPeak > 0 ? speechPeak : rememberedPeak + 0.24;
      var levelDelta = Math.max(0, observedSpeechLevel - rememberedLevel);
      var peakDelta = Math.max(0, observedSpeechPeak - rememberedPeak);
      return {
        averageThreshold: clamp(Math.max(rememberedLevel + 0.018, rememberedLevel + levelDelta * 0.62), 0.055, 0.24),
        peakThreshold: clamp(Math.max(rememberedPeak + 0.05, rememberedPeak + peakDelta * 0.68), 0.16, 0.72),
      };
    }

    return {
      observe: function (level, peakDeviation, now) {
        var currentTime = typeof now === "number" ? now : Date.now();
        var usableSignal = hasUsableSignal(level, peakDeviation);
        if (!(silenceSeconds > 0)) return false;
        if (firstFrameAt === null) firstFrameAt = currentTime;
        if (detectionStartedAt === null) {
          if (!usableSignal) {
            return currentTime - firstFrameAt >= noSpeechTimeoutMs();
          }
          detectionStartedAt = currentTime;
        }
        smoothedLevel = smooth(smoothedLevel, level);
        smoothedPeak = smooth(smoothedPeak, peakDeviation);
        if (currentTime - detectionStartedAt <= warmupMs) {
          rememberQuietFloor(smoothedLevel, smoothedPeak);
          rememberSpeech(smoothedLevel, smoothedPeak);
          silenceStartedAt = 0;
          return false;
        }
        var currentThresholds = thresholds();
        var speechDetected = smoothedLevel > currentThresholds.averageThreshold * 1.18
          || smoothedPeak > currentThresholds.peakThreshold * 1.12
          || level > currentThresholds.averageThreshold * 1.12
          || peakDeviation > currentThresholds.peakThreshold * 1.08;
        if (speechDetected) {
          rememberSpeech(smoothedLevel, smoothedPeak);
          silenceStartedAt = 0;
          return false;
        }
        var levelSilent = smoothedLevel <= currentThresholds.averageThreshold || level <= currentThresholds.averageThreshold * 0.98;
        var peakSilent = smoothedPeak <= currentThresholds.peakThreshold || peakDeviation <= currentThresholds.peakThreshold * 0.98;
        var clearlySilent = level <= currentThresholds.averageThreshold * 0.9 || smoothedLevel <= currentThresholds.averageThreshold * 0.88;
        var isSilent = levelSilent && (peakSilent || clearlySilent);
        if (isSilent) {
          rememberQuietFloor(smoothedLevel, smoothedPeak);
          if (!silenceStartedAt) silenceStartedAt = currentTime;
          return currentTime - silenceStartedAt >= silenceSeconds * 1000;
        }
        silenceStartedAt = 0;
        return false;
      },
      snapshot: function () {
        var currentThresholds = thresholds();
        return {
          averageThreshold: currentThresholds.averageThreshold,
          peakThreshold: currentThresholds.peakThreshold,
          baselineLevel: Number.isFinite(baselineLevel) ? baselineLevel : null,
          baselinePeak: Number.isFinite(baselinePeak) ? baselinePeak : null,
          speechLevel: speechLevel || null,
          speechPeak: speechPeak || null,
          smoothedLevel: smoothedLevel || null,
          smoothedPeak: smoothedPeak || null,
          silenceStartedAt: silenceStartedAt,
        };
      },
    };
  }

  window.__HERMES_VOICE_TEST__ = window.__HERMES_VOICE_TEST__ || {};
  window.__HERMES_VOICE_TEST__.createSilenceDetector = createSilenceDetector;

  function fetchAudioTranscript(blob) {
    return fetch(API + "/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob,
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (text) {
          throw new Error(text || res.statusText);
        });
      }
      return res.json();
    });
  }

  function VoicePage() {
    var audioRef = useRef(null);
    var chunksRef = useRef([]);
    var mediaRecorderRef = useRef(null);
    var mediaStreamRef = useRef(null);
    var eventSourceRef = useRef(null);
    var transcriptViewportRef = useRef(null);
    var audioContextRef = useRef(null);
    var recordingAudioContextRef = useRef(null);
    var recordingAnalyserRef = useRef(null);
    var recordingSourceRef = useRef(null);
    var silenceAnimationFrameRef = useRef(null);
    var silenceStartedAtRef = useRef(0);

    var statusState = useState(null);
    var status = statusState[0];
    var setStatus = statusState[1];

    var settingsState = useState(null);
    var settings = settingsState[0];
    var setSettings = settingsState[1];

    var stateState = useState(STATES.IDLE);
    var state = stateState[0];
    var setState = stateState[1];
    var stateRef = useRef(state);

    var errorState = useState("");
    var error = errorState[0];
    var setError = errorState[1];

    var transcriptState = useState("");
    var transcript = transcriptState[0];
    var setTranscript = transcriptState[1];

    var assistantState = useState("");
    var assistantText = assistantState[0];
    var setAssistantText = assistantState[1];

    var statusDetailState = useState("");
    var statusDetail = statusDetailState[0];
    var setStatusDetail = statusDetailState[1];

    var audioUrlState = useState("");
    var audioUrl = audioUrlState[0];
    var setAudioUrl = audioUrlState[1];

    var autoplayBlockedState = useState(false);
    var autoplayBlocked = autoplayBlockedState[0];
    var setAutoplayBlocked = autoplayBlockedState[1];

    var settingsOpenState = useState(false);
    var settingsOpen = settingsOpenState[0];
    var setSettingsOpen = settingsOpenState[1];

    var selectedVoiceState = useState("");
    var selectedVoice = selectedVoiceState[0];
    var setSelectedVoice = selectedVoiceState[1];

    var soundsEnabledState = useState(true);
    var soundsEnabled = soundsEnabledState[0];
    var setSoundsEnabled = soundsEnabledState[1];

    var handsFreeState = useState(false);
    var handsFree = handsFreeState[0];
    var setHandsFree = handsFreeState[1];

    var cueVolumeState = useState(1.5);
    var cueVolume = cueVolumeState[0];
    var setCueVolume = cueVolumeState[1];

    var playbackSpeedState = useState(1);
    var playbackSpeed = playbackSpeedState[0];
    var setPlaybackSpeed = playbackSpeedState[1];

    var silenceSecondsState = useState(2);
    var silenceSeconds = silenceSecondsState[0];
    var setSilenceSeconds = silenceSecondsState[1];

    var modelOverrideState = useState("");
    var modelOverride = modelOverrideState[0];
    var setModelOverride = modelOverrideState[1];

    var transferTargetState = useState("");
    var transferTarget = transferTargetState[0];
    var setTransferTarget = transferTargetState[1];

    var transferLabelState = useState("Telegram");
    var transferLabel = transferLabelState[0];
    var setTransferLabel = transferLabelState[1];

    var activeSessionIdState = useState("");
    var activeSessionId = activeSessionIdState[0];
    var setActiveSessionId = activeSessionIdState[1];

    var resetSessionBusyState = useState(false);
    var resetSessionBusy = resetSessionBusyState[0];
    var setResetSessionBusy = resetSessionBusyState[1];

    var transferBusyState = useState(false);
    var transferBusy = transferBusyState[0];
    var setTransferBusy = transferBusyState[1];

    var transferNoticeState = useState("");
    var transferNotice = transferNoticeState[0];
    var setTransferNotice = transferNoticeState[1];

    var audioUnlockedRef = useRef(false);
    var playbackAttemptRef = useRef(0);
    var playbackUrlRef = useRef("");
    var queuedChunkUrlsRef = useRef([]);
    var chunkPlaybackActiveRef = useRef(false);
    var chunkStreamFinishedRef = useRef(false);
    var chunkPlaybackStartedRef = useRef(false);
    var processingCuePlayedRef = useRef(false);
    var playbackCuePlayedRef = useRef(false);
    var autoListenTimerRef = useRef(null);
    var handsFreeTurnArmedRef = useRef(false);
    var recordingStartedAtRef = useRef(0);
    var recordingStopReasonRef = useRef("idle");
    var silenceTelemetryFramesRef = useRef([]);

    var loadStatus = useCallback(function () {
      SDK.fetchJSON(API + "/status")
        .then(function (data) {
          setStatus(data);
          if (!data.stt_ready || !data.chat_ready) {
            setState(STATES.MISSING_CONFIG);
          } else if (state === STATES.MISSING_CONFIG) {
            setState(STATES.IDLE);
          }
        })
        .catch(function (err) {
          setError(err.message || String(err));
          setState(STATES.ERROR);
        });

      SDK.fetchJSON(API + "/settings")
        .then(function (data) {
          setSettings(data);
          setSelectedVoice(data.voice || "");
          setSoundsEnabled(data.sounds_enabled !== false);
          setHandsFree(data.hands_free === true);
          setCueVolume(typeof data.cue_volume === "number" ? data.cue_volume : 1.5);
          setPlaybackSpeed(typeof data.playback_speed === "number" ? data.playback_speed : 1);
          setSilenceSeconds(typeof data.silence_seconds === "number" ? data.silence_seconds : 2);
          setModelOverride(data.model_override || "");
          setTransferTarget(data.transfer_target || "");
          setTransferLabel(data.transfer_label || "Telegram");
          setActiveSessionId(data.active_session_id || "");
        })
        .catch(function () {});
    }, [state]);

    useEffect(function () {
      loadStatus();
      if (!audioRef.current) {
        audioRef.current = new Audio();
        audioRef.current.preload = "auto";
        audioRef.current.playsInline = true;
      }
      return function () {
        clearAutoListenTimer();
        stopSilenceDetection();
        if (eventSourceRef.current) eventSourceRef.current.close();
        stopPlayback();
        stopStream();
      };
    }, []);

    useEffect(function () {
      stateRef.current = state;
    }, [state]);

    useEffect(function () {
      if (audioRef.current) {
        audioRef.current.playbackRate = playbackSpeed;
      }
    }, [playbackSpeed]);

    useLayoutEffect(function () {
      var node = transcriptViewportRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    }, [transcript, assistantText, error, autoplayBlocked]);

    function stopSilenceDetection() {
      if (silenceAnimationFrameRef.current) {
        window.cancelAnimationFrame(silenceAnimationFrameRef.current);
        silenceAnimationFrameRef.current = null;
      }
      silenceStartedAtRef.current = 0;
      if (recordingSourceRef.current) {
        try {
          recordingSourceRef.current.disconnect();
        } catch (err) {}
      }
      if (recordingAnalyserRef.current) {
        try {
          recordingAnalyserRef.current.disconnect();
        } catch (err) {}
      }
      recordingSourceRef.current = null;
      recordingAnalyserRef.current = null;
      if (recordingAudioContextRef.current) {
        try {
          recordingAudioContextRef.current.close();
        } catch (err) {}
      }
      recordingAudioContextRef.current = null;
    }

    function stopStream() {
      stopSilenceDetection();
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(function (track) {
          track.stop();
        });
      }
      mediaStreamRef.current = null;
    }

    function clearAutoListenTimer() {
      if (autoListenTimerRef.current) {
        window.clearTimeout(autoListenTimerRef.current);
        autoListenTimerRef.current = null;
      }
    }

    function resetQueuedChunks() {
      queuedChunkUrlsRef.current = [];
      chunkPlaybackActiveRef.current = false;
      chunkStreamFinishedRef.current = false;
      chunkPlaybackStartedRef.current = false;
    }

    function rememberSilenceFrame(frame) {
      var frames = silenceTelemetryFramesRef.current;
      frames.push(frame);
      if (frames.length > 32) frames.shift();
    }

    function reportVoiceTelemetry(reason, extra) {
      var payload = {
        reason: reason || recordingStopReasonRef.current || "unknown",
        state: stateRef.current,
        hands_free: !!handsFree,
        silence_seconds: silenceSeconds,
        recorded_ms: recordingStartedAtRef.current ? Math.max(0, Date.now() - recordingStartedAtRef.current) : 0,
        last_frame: window.__HERMES_VOICE_TEST__ && window.__HERMES_VOICE_TEST__.lastSilenceFrame
          ? window.__HERMES_VOICE_TEST__.lastSilenceFrame
          : null,
        frames: silenceTelemetryFramesRef.current.slice(),
      };
      if (extra && typeof extra === "object") {
        Object.keys(extra).forEach(function (key) {
          payload[key] = extra[key];
        });
      }
      fetch(API + "/debug/client-telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {});
    }

    function startSilenceDetection(stream) {
      stopSilenceDetection();
      if (!stream || silenceSeconds <= 0) return;
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      try {
        var ctx = new Ctor();
        var source = ctx.createMediaStreamSource(stream);
        var analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.85;
        source.connect(analyser);
        recordingAudioContextRef.current = ctx;
        recordingSourceRef.current = source;
        recordingAnalyserRef.current = analyser;
        var buffer = new Uint8Array(analyser.fftSize);
        var silenceDetector = createSilenceDetector({ silenceSeconds: silenceSeconds, warmupMs: 700 });

        function tick() {
          if (stateRef.current !== STATES.RECORDING || !recordingAnalyserRef.current) {
            silenceAnimationFrameRef.current = null;
            return;
          }
          recordingAnalyserRef.current.getByteTimeDomainData(buffer);
          var totalDeviation = 0;
          var peakDeviation = 0;
          for (var i = 0; i < buffer.length; i += 1) {
            var deviation = Math.abs(buffer[i] - 128) / 128;
            totalDeviation += deviation;
            if (deviation > peakDeviation) peakDeviation = deviation;
          }
          var level = totalDeviation / buffer.length;
          var detectorShouldStop = silenceDetector.observe(level, peakDeviation, Date.now());
          var detectorSnapshot = silenceDetector.snapshot();
          rememberSilenceFrame({
            at: Date.now(),
            level: level,
            peakDeviation: peakDeviation,
            shouldStop: detectorShouldStop,
            averageThreshold: detectorSnapshot.averageThreshold,
            peakThreshold: detectorSnapshot.peakThreshold,
            silenceStartedAt: detectorSnapshot.silenceStartedAt,
          });
          if (window.__HERMES_VOICE_TEST__) {
            window.__HERMES_VOICE_TEST__.lastSilenceFrame = {
              level: level,
              peakDeviation: peakDeviation,
              shouldStop: detectorShouldStop,
              snapshot: detectorSnapshot,
            };
          }
          if (detectorShouldStop) {
            silenceAnimationFrameRef.current = null;
            stopRecording("silence");
            return;
          }
          silenceStartedAtRef.current = detectorSnapshot.silenceStartedAt;
          silenceAnimationFrameRef.current = window.requestAnimationFrame(tick);
        }
        var startLoop = function () {
          silenceAnimationFrameRef.current = window.requestAnimationFrame(tick);
        };
        if (ctx.state === "running") {
          startLoop();
        } else {
          ctx.resume().then(startLoop).catch(startLoop);
        }
      } catch (err) {
        stopSilenceDetection();
      }
    }

    function closeResponseStream() {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    }

    function getAudioContext() {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      if (!audioContextRef.current) {
        audioContextRef.current = new Ctor();
      }
      return audioContextRef.current;
    }

    function unlockAudioContext() {
      var ctx = getAudioContext();
      if (!ctx) return Promise.resolve(false);
      if (ctx.state === "running") return Promise.resolve(true);
      return ctx.resume()
        .then(function () { return ctx.state === "running"; })
        .catch(function () { return false; });
    }

    function playCue(notes) {
      var ctx = getAudioContext();
      if (!soundsEnabled || !ctx || ctx.state !== "running") return;

      var startAt = ctx.currentTime + 0.01;
      notes.forEach(function (note, index) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        var noteStart = startAt + index * (note.gap || 0.11);
        var duration = note.duration || 0.08;
        var peak = (note.gain || 0.045) * cueVolume;

        osc.type = note.type || "sine";
        osc.frequency.setValueAtTime(note.freq, noteStart);
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.linearRampToValueAtTime(peak, noteStart + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(noteStart);
        osc.stop(noteStart + duration + 0.02);
      });
    }

    function playRecordingCue() {
      playCue([
        { freq: 622, duration: 0.06, gain: 0.09, type: "triangle", gap: 0.08 },
        { freq: 784, duration: 0.09, gain: 0.115, type: "sine", gap: 0.08 },
      ]);
    }

    function playProcessingCue() {
      playCue([
        { freq: 392, duration: 0.07, gain: 0.075, type: "sine", gap: 0.09 },
        { freq: 523.25, duration: 0.08, gain: 0.095, type: "triangle", gap: 0.09 },
      ]);
    }

    function playPlaybackReadyCue() {
      playCue([
        { freq: 523.25, duration: 0.05, gain: 0.075, type: "sine", gap: 0.08 },
        { freq: 659.25, duration: 0.08, gain: 0.095, type: "sine", gap: 0.08 },
        { freq: 783.99, duration: 0.1, gain: 0.11, type: "triangle", gap: 0.08 },
      ]);
    }

    function playResponseCompleteCue() {
      playCue([
        { freq: 587.33, duration: 0.06, gain: 0.07, type: "triangle", gap: 0.07 },
        { freq: 440, duration: 0.1, gain: 0.085, type: "sine", gap: 0.07 },
      ]);
    }

    function stopPlayback(options) {
      var preserveHandsFree = Boolean(options && options.preserveHandsFree);
      if (!options || !options.preserveTimer) clearAutoListenTimer();
      playbackAttemptRef.current += 1;
      if (audioRef.current) {
        audioRef.current.onended = null;
        audioRef.current.onerror = null;
        audioRef.current.onplaying = null;
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      playbackUrlRef.current = "";
      chunkPlaybackActiveRef.current = false;
      if (!preserveHandsFree) handsFreeTurnArmedRef.current = false;
    }

    function warmAudioPlayback() {
      if (audioUnlockedRef.current) return Promise.resolve(true);
      if (!audioRef.current) return Promise.resolve(false);

      var audio = audioRef.current;
      audio.src = SILENT_AUDIO_URL;
      audio.muted = true;
      audio.playsInline = true;

      return audio.play()
        .then(function () {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
          audioUnlockedRef.current = true;
          return true;
        })
        .catch(function () {
          audio.muted = false;
          return false;
        });
    }

    function canRecord() {
      return status && status.stt_ready && status.chat_ready;
    }

    function scheduleHandsFreeRestart() {
      clearAutoListenTimer();
      if (!handsFree || !canRecord()) {
        handsFreeTurnArmedRef.current = false;
        return;
      }
      handsFreeTurnArmedRef.current = false;
      autoListenTimerRef.current = window.setTimeout(function () {
        autoListenTimerRef.current = null;
        if (stateRef.current !== STATES.IDLE) return;
        unlockAudioContext();
        warmAudioPlayback();
        beginRecording();
      }, 650);
    }

    function beginRecording() {
      if (!canRecord()) {
        setState(STATES.MISSING_CONFIG);
        return;
      }
      clearAutoListenTimer();
      closeResponseStream();
      resetQueuedChunks();
      stopPlayback();
      processingCuePlayedRef.current = false;
      playbackCuePlayedRef.current = false;
      setStatusDetail("");
      setError("");
      setAudioUrl("");
      setTranscript("");
      setAutoplayBlocked(false);
      setState(STATES.REQUESTING_MIC);

      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function (stream) {
          var mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm";
          var recorder = new MediaRecorder(stream, { mimeType: mime });
          mediaStreamRef.current = stream;
          mediaRecorderRef.current = recorder;
          recordingStartedAtRef.current = Date.now();
          recordingStopReasonRef.current = "pending";
          silenceTelemetryFramesRef.current = [];
          chunksRef.current = [];

          recorder.ondataavailable = function (event) {
            if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
          };
          recorder.onstop = function () {
            var blob = new Blob(chunksRef.current, { type: mime });
            reportVoiceTelemetry(recordingStopReasonRef.current, {
              mime_type: mime,
              blob_size: blob.size,
              silence_started_at: silenceStartedAtRef.current || 0,
            });
            stopStream();
            submitAudio(blob);
          };
          recorder.start();
          stateRef.current = STATES.RECORDING;
          setState(STATES.RECORDING);
          startSilenceDetection(stream);
          playRecordingCue();
        })
        .catch(function (err) {
          setError(err && err.name === "NotAllowedError"
            ? "Microphone permission was denied."
            : (err.message || "Microphone is unavailable."));
          setState(STATES.ERROR);
        });
    }

    function stopRecording(reason) {
      var recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === "recording") {
        recordingStopReasonRef.current = reason || "manual";
        setState(STATES.UPLOADING);
        recorder.stop();
      }
    }

    function submitAudio(blob) {
      if (!blob || blob.size === 0) {
        setError("No audio was captured.");
        setState(STATES.ERROR);
        return;
      }
      if (!processingCuePlayedRef.current) {
        playProcessingCue();
        processingCuePlayedRef.current = true;
      }
      setState(STATES.TRANSCRIBING);
      fetchAudioTranscript(blob)
        .then(function (data) {
          var text = (data.transcript || "").trim();
          if (!text) throw new Error("No speech was detected.");
          setTranscript(text);
          createResponseJob(text);
        })
        .catch(function (err) {
          setError(err.message || String(err));
          setState(STATES.ERROR);
        });
    }

    function createResponseJob(text) {
      setStatusDetail("");
      setAssistantText("");
      setTransferNotice("");
      setState(STATES.THINKING);
      SDK.fetchJSON(API + "/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text }),
      })
        .then(function (data) {
          if (data.session_id) setActiveSessionId(data.session_id);
          openStream(data.job_id);
        })
        .catch(function (err) {
          setError(err.message || String(err));
          setState(STATES.ERROR);
        });
    }

    function openStream(jobId) {
      closeResponseStream();
      resetQueuedChunks();
      var source = new EventSource(API + "/stream/" + encodeURIComponent(jobId));
      eventSourceRef.current = source;

      source.addEventListener("status", function (event) {
        var data = parseEventPayload(event);
        setStatusDetail(data.detail || "");
        if (data.status === "tts") {
          if (!chunkPlaybackActiveRef.current && !chunkPlaybackStartedRef.current) {
            setState(STATES.BUFFERING);
          }
        }
        else if (data.status) setState(STATES.THINKING);
      });
      source.addEventListener("text_delta", function (event) {
        var data = parseEventPayload(event);
        if (data.delta) {
          setAssistantText(function (prev) { return prev + data.delta; });
        }
      });
      source.addEventListener("text_complete", function (event) {
        var data = parseEventPayload(event);
        setAssistantText(data.text || "");
      });
      source.addEventListener("chunk_stream_done", function () {
        chunkStreamFinishedRef.current = true;
        if (
          stateRef.current === STATES.SPEAKING &&
          !chunkPlaybackActiveRef.current &&
          queuedChunkUrlsRef.current.length === 0
        ) {
          setState(STATES.IDLE);
          if (handsFreeTurnArmedRef.current) scheduleHandsFreeRestart();
        }
      });
      source.addEventListener("tts_chunk_ready", function (event) {
        var data = parseEventPayload(event);
        var url = data.audio_url || "";
        if (!url) return;
        if (
          url === playbackUrlRef.current ||
          queuedChunkUrlsRef.current.indexOf(url) >= 0
        ) {
          return;
        }
        queuedChunkUrlsRef.current.push(url);
        if (
          !audioRef.current ||
          audioRef.current.paused ||
          !playbackUrlRef.current
        ) {
          playNextChunk(!chunkPlaybackStartedRef.current);
        }
      });
      source.addEventListener("tts_ready", function (event) {
        var data = parseEventPayload(event);
        if (data.audio_url) {
          setAudioUrl(data.audio_url);
          setAutoplayBlocked(false);
          if (
            !chunkPlaybackStartedRef.current &&
            !chunkPlaybackActiveRef.current &&
            queuedChunkUrlsRef.current.length === 0 &&
            !playbackUrlRef.current
          ) {
            if (!playbackCuePlayedRef.current) {
              playPlaybackReadyCue();
              playbackCuePlayedRef.current = true;
            }
            playUrl(data.audio_url, true, false);
          }
        }
      });
      source.addEventListener("error", function (event) {
        if (event.data) {
          var data = parseEventPayload(event);
          setError(data.message || "Voice request failed.");
          setState(data.stage === "tts" ? STATES.IDLE : STATES.ERROR);
        }
      });
      source.addEventListener("done", function () {
        source.close();
        eventSourceRef.current = null;
        chunkStreamFinishedRef.current = true;
        setStatusDetail("");
        if (
          stateRef.current !== STATES.SPEAKING &&
          stateRef.current !== STATES.BUFFERING &&
          queuedChunkUrlsRef.current.length === 0
        ) setState(STATES.IDLE);
      });
      source.onerror = function () {
        source.close();
        if (eventSourceRef.current === source) eventSourceRef.current = null;
      };
    }

    function playNextChunk(isAutoplay) {
      if (queuedChunkUrlsRef.current.length === 0) return false;
      var nextUrl = queuedChunkUrlsRef.current.shift();
      if (!nextUrl) return false;
      playUrl(nextUrl, isAutoplay, true);
      return true;
    }

    function playUrl(url, isAutoplay, isChunk) {
      if (!url) return;
      if (
        audioRef.current &&
        playbackUrlRef.current === url &&
        !audioRef.current.paused
      ) {
        return;
      }

      clearAutoListenTimer();
      stopPlayback({ preserveHandsFree: isAutoplay || isChunk, preserveTimer: true });
      setError("");
      var playbackAttempt = playbackAttemptRef.current;
      var audio = audioRef.current || new Audio();
      audio.preload = "auto";
      audio.playsInline = true;
      audio.playbackRate = playbackSpeed;
      audioRef.current = audio;
      playbackUrlRef.current = url;
      chunkPlaybackActiveRef.current = Boolean(isChunk);
      if (isChunk) chunkPlaybackStartedRef.current = true;
      if (isAutoplay) handsFreeTurnArmedRef.current = true;
      audio.muted = false;
      audio.src = url;
      if (isAutoplay) setState(STATES.BUFFERING);
      audio.onended = function () {
        if (playbackAttempt !== playbackAttemptRef.current) return;
        var wasChunk = chunkPlaybackActiveRef.current;
        var shouldAutoListen = handsFreeTurnArmedRef.current;
        chunkPlaybackActiveRef.current = false;
        setAutoplayBlocked(false);
        playbackUrlRef.current = "";
        if (wasChunk && playNextChunk(false)) return;
        if (wasChunk) {
          if (!chunkStreamFinishedRef.current) {
            setState(STATES.SPEAKING);
            return;
          }
          setState(STATES.IDLE);
          if (shouldAutoListen) scheduleHandsFreeRestart();
          return;
        }
        if (!wasChunk) playResponseCompleteCue();
        setState(STATES.IDLE);
        if (shouldAutoListen) scheduleHandsFreeRestart();
      };
      audio.onplaying = function () {
        if (playbackAttempt !== playbackAttemptRef.current) return;
        setAutoplayBlocked(false);
        setState(STATES.SPEAKING);
      };
      audio.onerror = function () {
        if (playbackAttempt !== playbackAttemptRef.current) return;
        setError("Audio playback failed.");
        setState(STATES.ERROR);
      };
      audio.play()
        .then(function () {
          if (playbackAttempt !== playbackAttemptRef.current) return;
        })
        .catch(function (err) {
          if (playbackAttempt !== playbackAttemptRef.current) return;
          if (audio.currentTime > 0 || !audio.paused) return;
          if (isAutoplay) {
            setAutoplayBlocked(true);
            setError("");
            chunkPlaybackActiveRef.current = false;
            handsFreeTurnArmedRef.current = false;
            setState(STATES.INTERRUPTED);
            return;
          }
          setError((err && err.message) || "Audio playback failed.");
          setState(STATES.ERROR);
        });
    }

    function handleMainAction() {
      if (state === STATES.RECORDING) stopRecording("manual");
      else if (
        state === STATES.THINKING ||
        state === STATES.BUFFERING ||
        state === STATES.SPEAKING
      ) {
        closeResponseStream();
        resetQueuedChunks();
        stopPlayback();
        setStatusDetail("");
        setAutoplayBlocked(false);
        setError("");
        setState(STATES.INTERRUPTED);
      }
      else {
        unlockAudioContext();
        warmAudioPlayback();
        beginRecording();
      }
    }

    function replay() {
      if (audioUrl) {
        setAutoplayBlocked(false);
        resetQueuedChunks();
        playUrl(audioUrl, false, false);
      }
    }

    function saveSettings() {
      SDK.fetchJSON(API + "/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice: selectedVoice,
          sounds_enabled: soundsEnabled,
          hands_free: handsFree,
          silence_seconds: silenceSeconds,
          cue_volume: cueVolume,
          playback_speed: playbackSpeed,
          model_override: modelOverride,
          transfer_target: transferTarget,
          transfer_label: transferLabel,
        }),
      })
        .then(function (data) {
          setSettings(data);
          setSoundsEnabled(data.sounds_enabled !== false);
          setHandsFree(data.hands_free === true);
          setCueVolume(typeof data.cue_volume === "number" ? data.cue_volume : 1.5);
          setPlaybackSpeed(typeof data.playback_speed === "number" ? data.playback_speed : 1);
          setSilenceSeconds(typeof data.silence_seconds === "number" ? data.silence_seconds : 2);
          setModelOverride(data.model_override || "");
          setTransferTarget(data.transfer_target || "");
          setTransferLabel(data.transfer_label || "Telegram");
          setActiveSessionId(data.active_session_id || activeSessionId);
          setSettingsOpen(false);
          loadStatus();
        })
        .catch(function (err) {
          setError(err.message || String(err));
          setState(STATES.ERROR);
        });
    }

    function transferToTelegram() {
      if (!transferTarget || transferBusy || !(transcript || assistantText)) return;
      setTransferBusy(true);
      setTransferNotice("");
      setError("");
      SDK.fetchJSON(API + "/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: transcript,
          assistant_text: assistantText,
          target: transferTarget,
          label: transferLabel,
        }),
      })
        .then(function (data) {
          setTransferNotice("Moved to " + (data.label || transferLabel || "Telegram"));
        })
        .catch(function (err) {
          setError(err.message || String(err));
        })
        .finally(function () {
          setTransferBusy(false);
        });
    }

    function resetVoiceSession() {
      if (resetSessionBusy) return;
      setResetSessionBusy(true);
      setTransferNotice("");
      setError("");
      SDK.fetchJSON(API + "/session/reset", { method: "POST" })
        .then(function (data) {
          setActiveSessionId(data.session_id || "");
          setTranscript("");
          setAssistantText("");
          setStatusDetail("");
          resetQueuedChunks();
          stopPlayback();
          closeResponseStream();
          setAudioUrl("");
          setState(STATES.IDLE);
          setTransferNotice("Started a new voice session");
        })
        .catch(function (err) {
          setError(err.message || String(err));
        })
        .finally(function () {
          setResetSessionBusy(false);
        });
    }

    var issues = status && status.issues ? status.issues : [];
    var mainDisabled = [
      STATES.REQUESTING_MIC,
      STATES.UPLOADING,
      STATES.TRANSCRIBING,
    ].indexOf(state) >= 0;
    var mainLabel = state === STATES.RECORDING
      ? "Stop"
      : (
        state === STATES.SPEAKING ||
        state === STATES.THINKING ||
        state === STATES.BUFFERING
      )
        ? "Interrupt"
        : "Talk";
    var showThinkingPanel = state === STATES.THINKING
      ? Boolean(statusDetail)
      : state === STATES.BUFFERING
        ? Boolean(statusDetail)
        : false;
    var showTransferButton = Boolean(transferTarget && (transcript || assistantText));
    var sessionBadge = activeSessionId ? ("Session " + activeSessionId.slice(-8)) : "";

    return h("div", { className: "voice-plugin" },
      h("section", { className: "voice-shell" },
        h("section", { className: "voice-transcript-shell" },
          h("header", { className: "voice-header" },
            h("div", { className: "voice-title" },
              h("span", { className: "voice-title-main" }, "Voice"),
              h(Badge, { variant: "outline", className: "voice-chip" },
                status ? (status.ok ? "ready" : "limited") : "checking"
              )
            ),
            h("div", { className: "voice-header-status" }, statusText(state))
          ),
          h("div", { className: "voice-transcript", ref: transcriptViewportRef },
            !(transcript || assistantText) && h("div", { className: "voice-empty" },
              "Tap Talk to start. Your transcript and Hermes response will stay pinned here."
            ),
          transcript && h("div", { className: "voice-turn" },
            h("span", { className: "voice-turn-label" }, "You"),
            h("p", null, transcript)
          ),
          assistantText && h("div", { className: "voice-turn" },
            h("span", { className: "voice-turn-label" }, "Hermes"),
            h("p", null, assistantText)
          )
        ),
        ),

        (issues.length > 0 || error) && h("section", { className: "voice-alerts" },
          error && h("div", { className: "voice-alert" }, error),
          issues.map(function (issue) {
            return h("div", { className: "voice-alert", key: issue.code }, issue.message);
          })
        ),

        h("footer", { className: "voice-controls" },
          showThinkingPanel && h("section", { className: "voice-thinking-panel" },
            h("div", { className: "voice-thinking-label" },
              state === STATES.BUFFERING ? "Preparing reply" : "Hermes is thinking"
            ),
            h("div", { className: "voice-thinking-body" },
              statusDetail
            )
          ),
          h("main", { className: "voice-stage" },
            h("button", {
              type: "button",
              className: cn("voice-orb", "is-" + state),
              disabled: mainDisabled,
              onClick: handleMainAction,
              "aria-label": mainLabel,
            },
              h("span", { className: "voice-orb-mark" }, state === STATES.RECORDING ? "REC" : mainLabel),
              h("span", { className: cn("voice-orb-pulse", "is-" + state) }),
              h("span", { className: cn("voice-orb-meter", "is-" + state), "aria-hidden": "true" },
                h("span", { className: "voice-meter-bar" }),
                h("span", { className: "voice-meter-bar" }),
                h("span", { className: "voice-meter-bar" }),
                h("span", { className: "voice-meter-bar" }),
                h("span", { className: "voice-meter-bar" })
              )
            ),
            h("div", { className: "voice-status" }, statusText(state)),
            h("div", { className: "voice-substatus" },
              state === STATES.RECORDING
                ? "Tap again to send"
                : state === STATES.BUFFERING
                  ? (showThinkingPanel ? "Preparing audio" : (statusDetail || "Preparing audio"))
                  : state === STATES.THINKING && statusDetail
                    ? (showThinkingPanel ? "Reply streaming above" : statusDetail)
                  : autoplayBlocked
                    ? "Autoplay was blocked. Tap replay."
                    : assistantText && state === STATES.THINKING
                      ? "Hermes is thinking while the reply streams in"
                      : transferNotice
                        ? transferNotice
                        : "Tap to start a turn"
            )
          ),

          audioUrl && h("div", { className: "voice-audio-controls" },
            h(Button, { type: "button", variant: "outline", onClick: replay }, "Replay"),
            showTransferButton && h(Button, {
              type: "button",
              variant: "outline",
              onClick: transferToTelegram,
              disabled: transferBusy,
            }, transferBusy ? "Sending..." : ("Transfer to " + (transferLabel || "Telegram"))),
            h(Button, {
              type: "button",
              variant: "outline",
              onClick: function () {
                resetQueuedChunks();
                stopPlayback();
                setState(STATES.INTERRUPTED);
              },
            }, "Stop")
          ),

          settingsOpen && h("div", { className: "voice-settings" },
            h("div", { className: "voice-settings-row" },
              h(Label, { htmlFor: "voice-select" }, "Voice"),
              h(Select, {
                id: "voice-select",
                value: selectedVoice,
                onValueChange: function (value) { setSelectedVoice(value); },
              },
                (settings && settings.available_voices ? settings.available_voices : DEFAULT_VOICES).map(function (voice) {
                  return h(SelectOption, { key: voice, value: voice }, voice);
                })
              )
            ),
            h("div", { className: "voice-settings-row" },
              h(Label, { htmlFor: "voice-model-override" }, "Voice model"),
              h("input", {
                id: "voice-model-override",
                className: "voice-text-input",
                value: modelOverride,
                list: "voice-model-suggestions",
                placeholder: (settings && settings.configured_model) || "Default model",
                onChange: function (event) { setModelOverride(event.target.value); },
              }),
              h("datalist", { id: "voice-model-suggestions" },
                (settings && settings.model_suggestions ? settings.model_suggestions : []).map(function (model) {
                  return h("option", { key: model, value: model });
                })
              )
            ),
            h("div", { className: "voice-settings-row" },
              h(Label, { htmlFor: "voice-transfer-target" }, "Transfer target"),
              h("input", {
                id: "voice-transfer-target",
                className: "voice-text-input",
                value: transferTarget,
                placeholder: "telegram:<chat_id>:<thread_id>",
                onChange: function (event) { setTransferTarget(event.target.value); },
              }),
              h("div", { className: "voice-field-help" }, "Use any Hermes target such as telegram:<chat_id>:<thread_id> or discord:#bot-home.")
            ),
            h("div", { className: "voice-settings-row" },
              h(Label, { htmlFor: "voice-transfer-label" }, "Transfer button label"),
              h("input", {
                id: "voice-transfer-label",
                className: "voice-text-input",
                value: transferLabel,
                placeholder: "Telegram",
                onChange: function (event) { setTransferLabel(event.target.value); },
              })
            ),
            h("div", { className: "voice-settings-row" },
              h("div", { className: "voice-slider-header" },
                h(Label, { htmlFor: "voice-cue-volume" }, "Cue volume"),
                h("span", { className: "voice-slider-value" }, Math.round(cueVolume * 100) + "%")
              ),
              h("input", {
                id: "voice-cue-volume",
                className: "voice-slider",
                type: "range",
                min: "0",
                max: "2",
                step: "0.05",
                value: String(cueVolume),
                onChange: function (event) { setCueVolume(Number(event.target.value || 1)); },
              })
            ),
            h("div", { className: "voice-settings-row" },
              h("div", { className: "voice-slider-header" },
                h(Label, { htmlFor: "voice-playback-speed" }, "Playback speed"),
                h("span", { className: "voice-slider-value" }, playbackSpeed.toFixed(2) + "x")
              ),
              h("input", {
                id: "voice-playback-speed",
                className: "voice-slider",
                type: "range",
                min: "0.75",
                max: "1.5",
                step: "0.05",
                value: String(playbackSpeed),
                onChange: function (event) { setPlaybackSpeed(Number(event.target.value || 1)); },
              })
            ),
            h("div", { className: "voice-settings-row" },
              h("div", { className: "voice-slider-header" },
                h(Label, { htmlFor: "voice-silence-seconds" }, "Silence stop"),
                h("span", { className: "voice-slider-value" }, silenceSeconds <= 0 ? "off" : silenceSeconds.toFixed(1) + "s")
              ),
              h("input", {
                id: "voice-silence-seconds",
                className: "voice-slider",
                type: "range",
                min: "0",
                max: "5",
                step: "0.25",
                value: String(silenceSeconds),
                onChange: function (event) { setSilenceSeconds(Number(event.target.value || 0)); },
              })
            ),
            h("label", { className: "voice-toggle", htmlFor: "voice-sounds-enabled" },
              h("span", { className: "voice-toggle-copy" },
                h("span", { className: "voice-toggle-title" }, "Interface sounds"),
                h("span", { className: "voice-toggle-description" }, "Play short cues for record, processing, and reply readiness")
              ),
              h("input", {
                id: "voice-sounds-enabled",
                type: "checkbox",
                checked: soundsEnabled,
                onChange: function (event) { setSoundsEnabled(Boolean(event.target.checked)); },
              })
            ),
            h("label", { className: "voice-toggle", htmlFor: "voice-hands-free" },
              h("span", { className: "voice-toggle-copy" },
                h("span", { className: "voice-toggle-title" }, "Hands-free mode"),
                h("span", { className: "voice-toggle-description" }, "After Hermes finishes speaking, automatically return to listening")
              ),
              h("input", {
                id: "voice-hands-free",
                type: "checkbox",
                checked: handsFree,
                onChange: function (event) { setHandsFree(Boolean(event.target.checked)); },
              })
            ),
            h("div", { className: "voice-settings-meta" },
              h("span", null, "STT: ", settings ? settings.stt_provider : "checking"),
              h("span", null, "TTS: ", settings ? settings.tts_provider : "checking"),
              sessionBadge && h("span", null, sessionBadge)
            ),
            h("div", { className: "voice-settings-actions" },
              h(Button, { type: "button", variant: "outline", onClick: resetVoiceSession, disabled: resetSessionBusy }, resetSessionBusy ? "Resetting..." : "New session"),
              h(Button, { type: "button", onClick: saveSettings }, "Save"),
              h(Button, { type: "button", variant: "outline", onClick: function () { setSettingsOpen(false); } }, "Close")
            )
          ),

          h("div", { className: "voice-footer-bar" },
            h("div", { className: "voice-footer-meta" },
              h("span", null, "STT: ", settings ? settings.stt_provider : "checking"),
              h("span", null, "TTS: ", settings ? settings.tts_provider : "checking"),
              sessionBadge && h("span", null, sessionBadge)
            ),
            h("div", { className: "voice-footer-actions" },
              h(Button, {
                type: "button",
                variant: "outline",
                onClick: resetVoiceSession,
                disabled: resetSessionBusy,
              }, resetSessionBusy ? "Resetting..." : "New session"),
              h(Button, {
                type: "button",
                variant: "outline",
                className: "voice-icon-button",
                "aria-label": "Voice settings",
                title: "Voice settings",
                onClick: function () { setSettingsOpen(!settingsOpen); },
              }, "⚙")
            )
          )
        )
      )
    );
  }

  window.__HERMES_PLUGINS__.register("voice", VoicePage);
})();
