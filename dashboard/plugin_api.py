"""Hermes dashboard Voice plugin API.

Mounted at /api/plugins/voice by the dashboard plugin system.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import mimetypes
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse

from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_AUDIO_BYTES = 25 * 1024 * 1024
JOB_TTL_SECONDS = 15 * 60
EDGE_VOICES = [
    "en-US-AriaNeural",
    "en-US-JennyNeural",
    "en-US-AndrewNeural",
    "en-US-BrianNeural",
    "en-GB-SoniaNeural",
]
OPENAI_VOICES = [
    "alloy",
    "echo",
    "fable",
    "onyx",
    "nova",
    "shimmer",
]
VOICE_SYSTEM_PROMPT = (
    "You are Hermes in a voice conversation. Reply naturally and concisely. "
    "Prefer short spoken answers unless the user asks for detail."
)
SENTENCE_BOUNDARY_RE = re.compile(r'(?<=[.!?])(?:\s|\n)|(?:\n\n)')
MAX_TTS_PENDING_CHARS = 120
FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`([^`]*)`")
IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]+\)")
LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
AUTOLINK_RE = re.compile(r"<(https?://[^>]+)>")
HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE)
BLOCKQUOTE_RE = re.compile(r"^\s{0,3}>\s?", re.MULTILINE)
LIST_MARKER_RE = re.compile(r"^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)", re.MULTILINE)
EMPHASIS_RE = re.compile(r"(\*\*|__|\*|_|~~)")
DEFAULT_TRANSFER_TARGET = ""
DEFAULT_TRANSFER_LABEL = "Telegram"
VOICE_SESSION_PREFIX = "voice-session"


class VoiceJob:
    def __init__(self, *, id: str, transcript: str, created_at: float, session_id: str = ""):
        self.id = id
        self.transcript = transcript
        self.created_at = created_at
        self.session_id = str(session_id or "").strip()
        self.queue: asyncio.Queue[Optional[Dict[str, Any]]] = asyncio.Queue()
        self.status = "queued"
        self.text = ""
        self.speech_text = ""
        self.audio_path: Optional[str] = None
        self.audio_chunk_paths: Dict[int, str] = {}
        self.error: Optional[str] = None


_jobs: Dict[str, VoiceJob] = {}
_last_cleanup = 0.0
_last_client_telemetry: Dict[str, Any] = {}


def _settings_path() -> Path:
    return get_hermes_home() / "voice-plugin" / "settings.json"


def _audio_dir() -> Path:
    return get_hermes_home() / "voice-plugin" / "audio"


def _voice_session_state_path() -> Path:
    return get_hermes_home() / "voice-plugin" / "session.json"


def _read_json_file(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _write_json_file(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _read_voice_session_state() -> Dict[str, Any]:
    return _read_json_file(_voice_session_state_path())


def _write_voice_session_state(payload: Dict[str, Any]) -> None:
    _write_json_file(_voice_session_state_path(), payload)


def _voice_session_title(session_id: str) -> str:
    stamp = time.strftime("%Y-%m-%d %H:%M")
    return f"Voice {stamp}"


def _new_voice_session_id() -> str:
    return f"{VOICE_SESSION_PREFIX}-{uuid.uuid4().hex}"


def _ensure_voice_session_record(session_id: str) -> str:
    from hermes_state import SessionDB

    session_id = str(session_id or "").strip()
    if not session_id:
        session_id = _new_voice_session_id()
    db = SessionDB()
    db.ensure_session(session_id, source="voice_dashboard", model=None)
    try:
        existing = db.get_session(session_id) or {}
        if not str(existing.get("title") or "").strip():
            db.set_session_title(session_id, _voice_session_title(session_id))
    except Exception:
        logger.debug("Voice plugin could not title session %s", session_id, exc_info=True)
    return session_id


def _active_voice_session_id() -> str:
    state = _read_voice_session_state()
    session_id = str(state.get("active_session_id") or "").strip()
    if not session_id:
        session_id = _ensure_voice_session_record("")
        _write_voice_session_state({
            "active_session_id": session_id,
            "updated_at": time.time(),
        })
        return session_id
    return _ensure_voice_session_record(session_id)


def _rotate_voice_session() -> Dict[str, str]:
    previous = str(_read_voice_session_state().get("active_session_id") or "").strip()
    session_id = _ensure_voice_session_record("")
    _write_voice_session_state({
        "active_session_id": session_id,
        "updated_at": time.time(),
        "previous_session_id": previous,
    })
    return {"session_id": session_id, "previous_session_id": previous}


def _load_voice_conversation_history(session_id: str) -> List[Dict[str, Any]]:
    from hermes_state import SessionDB

    session_id = str(session_id or "").strip()
    if not session_id:
        return []
    try:
        return SessionDB().get_messages_as_conversation(session_id)
    except Exception:
        logger.debug("Voice plugin could not load history for %s", session_id, exc_info=True)
        return []


def _safe_audio_path(path_str: Optional[str]) -> Optional[Path]:
    if not path_str:
        return None
    try:
        candidate = Path(path_str).resolve()
        audio_root = _audio_dir().resolve()
        candidate.relative_to(audio_root)
    except Exception:
        return None
    if not candidate.exists() or not candidate.is_file():
        return None
    return candidate


def _delete_audio_artifact(path_str: Optional[str]) -> None:
    path = _safe_audio_path(path_str)
    if not path:
        return
    try:
        path.unlink(missing_ok=True)
    except Exception:
        logger.debug("Voice plugin could not delete audio artifact: %s", path)


def _load_config() -> Dict[str, Any]:
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        return cfg if isinstance(cfg, dict) else {}
    except Exception as exc:
        logger.debug("Voice plugin could not load Hermes config: %s", exc)
        return {}


def _read_settings() -> Dict[str, Any]:
    return _read_json_file(_settings_path())


def _write_settings(settings: Dict[str, Any]) -> None:
    _write_json_file(_settings_path(), settings)


def _transfer_target_label(target: str, label: str = "") -> str:
    custom = str(label or "").strip()
    if custom:
        return custom
    target_text = str(target or "").strip()
    if not target_text:
        return DEFAULT_TRANSFER_LABEL
    platform, _, remainder = target_text.partition(":")
    if not remainder:
        return platform.title() or DEFAULT_TRANSFER_LABEL
    if platform.lower() == "telegram":
        return "Telegram"
    return platform.title() or "Transfer"


def _build_transfer_message(*, transcript: str, assistant_text: str, target_label: str) -> str:
    intro = f"Voice handoff from dashboard → {target_label}"
    lines = [intro]
    user_text = str(transcript or "").strip()
    reply_text = str(assistant_text or "").strip()
    if user_text:
        lines.extend(["", f"You: {user_text}"])
    if reply_text:
        lines.extend(["", f"Hermes: {reply_text}"])
    lines.extend(["", "Continue here when you're ready."])
    return "\n".join(lines).strip()


def _send_transfer_message(*, target: str, message: str) -> Dict[str, Any]:
    from tools.send_message_tool import send_message_tool

    raw = send_message_tool({"action": "send", "target": target, "message": message})
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {"success": False, "error": raw}
    if payload.get("error"):
        raise RuntimeError(str(payload.get("error")))
    if not payload.get("success"):
        raise RuntimeError(str(payload.get("note") or payload.get("error") or "Transfer failed"))
    return payload


def _configured_tts_provider(config: Dict[str, Any]) -> str:
    tts = config.get("tts") if isinstance(config.get("tts"), dict) else {}
    return str(tts.get("provider") or "edge")


def _configured_model(config: Dict[str, Any]) -> str:
    model_cfg = config.get("model", {})
    if isinstance(model_cfg, str):
        return str(model_cfg)
    if isinstance(model_cfg, dict):
        return str(model_cfg.get("default") or model_cfg.get("model") or "")
    return ""


def _effective_model(config: Dict[str, Any], settings: Optional[Dict[str, Any]] = None) -> str:
    settings = settings or _read_settings()
    if settings.get("model_override"):
        return str(settings["model_override"]).strip()
    return _configured_model(config)


def _model_suggestions(config: Dict[str, Any], settings: Optional[Dict[str, Any]] = None) -> List[str]:
    settings = settings or _read_settings()
    current = _effective_model(config, settings)
    configured = _configured_model(config)
    suggestions: List[str] = []
    for candidate in [current, configured, "gpt-5.4-mini", "gpt-5.4", "gpt-5.2"]:
        text = str(candidate or "").strip()
        if text and text not in suggestions:
            suggestions.append(text)
    return suggestions


def _effective_voice(config: Dict[str, Any], settings: Optional[Dict[str, Any]] = None) -> str:
    settings = settings or _read_settings()
    if settings.get("voice"):
        return str(settings["voice"])
    tts = config.get("tts") if isinstance(config.get("tts"), dict) else {}
    provider = _configured_tts_provider(config)
    provider_cfg = tts.get(provider) if isinstance(tts.get(provider), dict) else {}
    return str(
        provider_cfg.get("voice")
        or provider_cfg.get("voice_id")
        or provider_cfg.get("ref_audio")
        or "en-US-AriaNeural"
    )


def _available_voices(config: Dict[str, Any]) -> List[str]:
    provider = _configured_tts_provider(config)
    if provider == "openai":
        voices = list(OPENAI_VOICES)
    elif provider == "edge":
        voices = list(EDGE_VOICES)
    else:
        voices = []
    current = _effective_voice(config)
    if current and current not in voices:
        voices.insert(0, current)
    return voices


def _tts_config_with_voice(config: Dict[str, Any], voice: str) -> Dict[str, Any]:
    tts = config.get("tts") if isinstance(config.get("tts"), dict) else {}
    merged = json.loads(json.dumps(tts))
    provider = str(merged.get("provider") or "edge")
    provider_cfg = merged.setdefault(provider, {})
    if not isinstance(provider_cfg, dict):
        provider_cfg = {}
        merged[provider] = provider_cfg

    if provider in {"edge", "openai", "gemini"}:
        provider_cfg["voice"] = voice
    elif provider in {"elevenlabs", "xai", "mistral"}:
        provider_cfg["voice_id"] = voice
    elif provider == "neutts":
        provider_cfg["ref_audio"] = voice
    return merged


def _stt_status() -> tuple[bool, str, str]:
    try:
        from tools import transcription_tools as stt

        cfg = stt._load_stt_config()
        provider = stt._get_provider(cfg)
        if not stt.is_stt_enabled(cfg):
            return False, provider, "STT is disabled in config.yaml."
        if provider == "none":
            return False, provider, (
                "No speech-to-text provider is available. Install faster-whisper, "
                "configure HERMES_LOCAL_STT_COMMAND, or configure a cloud STT provider."
            )
        return True, provider, ""
    except Exception as exc:
        return False, "unknown", f"STT check failed: {exc}"


def _tts_status() -> tuple[bool, str]:
    try:
        from tools.tts_tool import check_tts_requirements

        if check_tts_requirements():
            return True, ""
        return False, "No text-to-speech provider is available."
    except Exception as exc:
        return False, f"TTS check failed: {exc}"


def _chat_status() -> tuple[bool, str, str]:
    try:
        config = _load_config()
        model = str(_effective_model(config) or "default")
        return True, model, ""
    except Exception as exc:
        return False, "", f"Chat model check failed: {exc}"


def _status_payload() -> Dict[str, Any]:
    config = _load_config()
    settings = _read_settings()
    stt_ready, stt_provider, stt_issue = _stt_status()
    tts_ready, tts_issue = _tts_status()
    chat_ready, model, chat_issue = _chat_status()

    issues = []
    if stt_issue:
        issues.append({"code": "stt_unavailable", "message": stt_issue})
    if tts_issue:
        issues.append({"code": "tts_unavailable", "message": tts_issue})
    if chat_issue:
        issues.append({"code": "chat_unavailable", "message": chat_issue})

    return {
        "ok": stt_ready and tts_ready and chat_ready,
        "stt_ready": stt_ready,
        "tts_ready": tts_ready,
        "chat_ready": chat_ready,
        "stt_provider": stt_provider,
        "tts_provider": _configured_tts_provider(config),
        "configured_model": model,
        "configured_voice": _effective_voice(config, settings),
        "configured_playback_speed": float(settings.get("playback_speed", 1.0) or 1.0),
        "configured_cue_volume": float(settings.get("cue_volume", 1.5) or 1.5),
        "available_voices": _available_voices(config),
        "issues": issues,
    }


async def _emit(job: VoiceJob, event: Dict[str, Any]) -> None:
    await job.queue.put(event)


async def _run_blocking(func: Any, *args: Any) -> Any:
    loop = asyncio.get_running_loop()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return await loop.run_in_executor(pool, func, *args)


def _emit_from_thread(loop: asyncio.AbstractEventLoop, job: VoiceJob, event: Dict[str, Any]) -> None:
    loop.call_soon_threadsafe(job.queue.put_nowait, event)


def _cleanup_jobs() -> None:
    global _last_cleanup
    now = time.time()
    if now - _last_cleanup < 60:
        return
    _last_cleanup = now
    expired = [
        job_id
        for job_id, job in _jobs.items()
        if now - job.created_at > JOB_TTL_SECONDS
    ]
    for job_id in expired:
        job = _jobs.pop(job_id, None)
        if not job:
            continue
        _delete_audio_artifact(job.audio_path)
        for chunk_path in job.audio_chunk_paths.values():
            _delete_audio_artifact(chunk_path)


def _store_client_telemetry(payload: Dict[str, Any]) -> Dict[str, Any]:
    global _last_client_telemetry
    stored = dict(payload)
    frames = stored.get("frames")
    if isinstance(frames, list) and len(frames) > 40:
        stored["frames"] = frames[-40:]
    stored["received_at"] = time.time()
    _last_client_telemetry = stored
    return stored


def _create_voice_agent(
    *,
    session_id: str,
    stream_delta_callback: Any,
    tool_progress_callback: Any,
) -> Any:
    from gateway.run import GatewayRunner, _load_gateway_config, _resolve_gateway_model, _resolve_runtime_agent_kwargs
    from hermes_cli.tools_config import _get_platform_tools
    from hermes_state import SessionDB
    from run_agent import AIAgent

    user_config = _load_gateway_config()
    config = _load_config()
    settings = _read_settings()
    runtime_kwargs = _resolve_runtime_agent_kwargs()
    enabled_toolsets = sorted(_get_platform_tools(user_config, "api_server"))
    return AIAgent(
        model=_effective_model(config, settings),
        **runtime_kwargs,
        max_iterations=int(os.getenv("HERMES_MAX_ITERATIONS", "90")),
        quiet_mode=True,
        verbose_logging=False,
        ephemeral_system_prompt=VOICE_SYSTEM_PROMPT,
        enabled_toolsets=enabled_toolsets,
        session_id=session_id,
        platform="api_server",
        stream_delta_callback=stream_delta_callback,
        tool_progress_callback=tool_progress_callback,
        session_db=SessionDB(),
        fallback_model=GatewayRunner._load_fallback_model(),
    )


def _extract_complete_sentences(buffer: str, *, flush_all: bool = False) -> tuple[List[str], str]:
    if not buffer:
        return [], ""
    parts = SENTENCE_BOUNDARY_RE.split(buffer)
    if len(parts) <= 1:
        if len(buffer) >= MAX_TTS_PENDING_CHARS:
            split_idx = max(
                buffer.rfind(", ", 40, MAX_TTS_PENDING_CHARS + 24),
                buffer.rfind("; ", 40, MAX_TTS_PENDING_CHARS + 24),
                buffer.rfind(": ", 40, MAX_TTS_PENDING_CHARS + 24),
                buffer.rfind(" ", 40, MAX_TTS_PENDING_CHARS + 24),
            )
            if split_idx >= 40:
                head = buffer[: split_idx + 1].strip()
                tail = buffer[split_idx + 1 :].lstrip()
                return ([head] if head else []), tail
        if flush_all and buffer.strip():
            return [buffer.strip()], ""
        return [], buffer

    completed = [part.strip() for part in parts[:-1] if part.strip()]
    remainder = parts[-1]
    if flush_all and remainder.strip():
        completed.append(remainder.strip())
        remainder = ""
    return completed, remainder


def _plain_speech_text(text: str) -> str:
    if not text:
        return ""
    cleaned = FENCED_CODE_RE.sub(" code omitted ", text)
    cleaned = IMAGE_RE.sub(lambda match: match.group(1).strip() or "image", cleaned)
    cleaned = LINK_RE.sub(lambda match: match.group(1).strip(), cleaned)
    cleaned = AUTOLINK_RE.sub("", cleaned)
    cleaned = INLINE_CODE_RE.sub(lambda match: match.group(1).strip(), cleaned)
    cleaned = HEADING_RE.sub("", cleaned)
    cleaned = BLOCKQUOTE_RE.sub("", cleaned)
    cleaned = LIST_MARKER_RE.sub("", cleaned)
    cleaned = cleaned.replace("|", " ")
    cleaned = EMPHASIS_RE.sub("", cleaned)
    cleaned = cleaned.replace("[", "").replace("]", "")
    cleaned = cleaned.replace("(", " ").replace(")", " ")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def _queue_sentence_from_thread(
    loop: asyncio.AbstractEventLoop,
    sentence_queue: asyncio.Queue[Optional[str]],
    sentence: str,
) -> None:
    text = _plain_speech_text(sentence)
    if text:
        loop.call_soon_threadsafe(sentence_queue.put_nowait, text)


def _run_agent_response(
    job: VoiceJob,
    loop: asyncio.AbstractEventLoop,
    sentence_queue: asyncio.Queue[Optional[str]],
) -> str:
    sentence_buffer = ""

    def text_callback(delta: Optional[str]) -> None:
        nonlocal sentence_buffer
        if delta:
            _emit_from_thread(loop, job, {"event": "text_delta", "delta": delta})
            sentence_buffer += delta
            completed, sentence_buffer = _extract_complete_sentences(sentence_buffer)
            for sentence in completed:
                _queue_sentence_from_thread(loop, sentence_queue, sentence)

    def progress_callback(
        event_type: Any,
        tool_name: Any = None,
        preview: Any = None,
        args: Any = None,
        **kwargs: Any,
    ) -> None:
        detail = ""
        event_name = str(event_type or "")
        if event_name == "tool.started":
            tool_label = str(tool_name or "tool").replace("_", " ").strip()
            preview_text = str(preview or "").strip()
            detail = f"Using {tool_label}"
            if preview_text:
                detail = f"{detail}: {preview_text}"
            _emit_from_thread(loop, job, {
                "event": "status",
                "status": "thinking",
                "detail": detail[:180],
            })
            return
        if event_name == "_thinking":
            detail = str(tool_name or "").strip()
        elif event_name == "reasoning.available":
            detail = str(preview or "").strip()
        if detail:
            _emit_from_thread(loop, job, {
                "event": "status",
                "status": "thinking",
                "detail": detail[:180],
            })

    session_id = _ensure_voice_session_record(job.session_id)
    if job.session_id != session_id:
        job.session_id = session_id
    conversation_history = _load_voice_conversation_history(session_id)
    agent = _create_voice_agent(
        session_id=session_id,
        stream_delta_callback=text_callback,
        tool_progress_callback=progress_callback,
    )
    result = agent.run_conversation(
        user_message=job.transcript,
        conversation_history=conversation_history,
        task_id="voice",
    )
    trailing, sentence_buffer = _extract_complete_sentences(sentence_buffer, flush_all=True)
    for sentence in trailing:
        _queue_sentence_from_thread(loop, sentence_queue, sentence)
    if isinstance(result, dict):
        return str(result.get("final_response") or "")
    return ""


def _synthesize_audio_to_path(output_path: Path, text: str) -> Optional[str]:
    if not text.strip():
        return None
    from tools import tts_tool

    settings = _read_settings()
    voice = str(settings.get("voice") or "").strip()
    tts_config = None
    if voice:
        config = _load_config()
        tts_config = _tts_config_with_voice(config, voice)
    raw = tts_tool.text_to_speech_tool(
        text=text,
        output_path=str(output_path),
        tts_config=tts_config,
    )
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {"success": False, "error": raw}
    if not payload.get("success"):
        raise RuntimeError(str(payload.get("error") or "TTS generation failed"))
    path = payload.get("file_path") or str(output_path)
    return str(path)


def _synthesize_audio(job_id: str, text: str) -> Optional[str]:
    out_dir = _audio_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    return _synthesize_audio_to_path(out_dir / f"{job_id}.mp3", text)


def _synthesize_audio_chunk(job_id: str, chunk_index: int, text: str) -> Optional[str]:
    out_dir = _audio_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    return _synthesize_audio_to_path(out_dir / f"{job_id}_chunk_{chunk_index:03d}.mp3", text)


def _transcribe_audio_file(path: str) -> Dict[str, Any]:
    from tools.transcription_tools import transcribe_audio

    return transcribe_audio(path)


async def _run_response_job(job: VoiceJob) -> None:
    loop = asyncio.get_running_loop()
    sentence_queue: asyncio.Queue[Optional[str]] = asyncio.Queue()

    async def stream_tts_chunks() -> None:
        chunk_index = 0
        while True:
            sentence = await sentence_queue.get()
            if sentence is None:
                break
            try:
                chunk_path = await _run_blocking(_synthesize_audio_chunk, job.id, chunk_index, sentence)
                if chunk_path:
                    job.audio_chunk_paths[chunk_index] = chunk_path
                    await _emit(job, {
                        "event": "tts_chunk_ready",
                        "chunk_index": chunk_index,
                        "audio_url": f"/api/plugins/voice/audio/{job.id}/{chunk_index}",
                        "text": sentence,
                    })
                    chunk_index += 1
            except Exception as exc:
                logger.debug("Voice chunk TTS failed: %s", exc)

    chunk_task = asyncio.create_task(stream_tts_chunks())
    try:
        job.status = "thinking"
        await _emit(job, {"event": "status", "status": "thinking"})
        text = await _run_blocking(_run_agent_response, job, loop, sentence_queue)
        job.text = text.strip()
        job.speech_text = _plain_speech_text(job.text)
        job.status = "text_complete"
        await _emit(job, {"event": "text_complete", "text": job.text})
        await sentence_queue.put(None)
        await chunk_task
        await _emit(job, {"event": "chunk_stream_done"})

        try:
            job.status = "tts"
            await _emit(job, {"event": "status", "status": "tts"})
            audio_path = await _run_blocking(_synthesize_audio, job.id, job.speech_text)
            job.audio_path = audio_path
            if audio_path:
                await _emit(job, {"event": "tts_ready", "audio_url": f"/api/plugins/voice/audio/{job.id}"})
        except Exception as exc:
            await _emit(job, {"event": "error", "stage": "tts", "message": str(exc)})

        job.status = "done"
        await _emit(job, {"event": "done"})
    except Exception as exc:
        logger.exception("Voice response job failed")
        job.status = "error"
        job.error = str(exc)
        await sentence_queue.put(None)
        await chunk_task
        await _emit(job, {"event": "error", "stage": "respond", "message": str(exc)})
        await _emit(job, {"event": "done"})
    finally:
        await job.queue.put(None)


@router.get("/status")
async def status() -> Dict[str, Any]:
    return _status_payload()


@router.get("/settings")
async def get_settings() -> Dict[str, Any]:
    config = _load_config()
    settings = _read_settings()
    transfer_target = str(settings.get("transfer_target") or DEFAULT_TRANSFER_TARGET).strip()
    transfer_label = _transfer_target_label(transfer_target, str(settings.get("transfer_label") or DEFAULT_TRANSFER_LABEL))
    active_session_id = _active_voice_session_id()
    return {
        "ok": True,
        "voice": _effective_voice(config, settings),
        "model_override": str(settings.get("model_override") or "").strip(),
        "configured_model": _effective_model(config, settings),
        "model_suggestions": _model_suggestions(config, settings),
        "sounds_enabled": bool(settings.get("sounds_enabled", True)),
        "hands_free": bool(settings.get("hands_free", False)),
        "silence_seconds": float(settings.get("silence_seconds", 2.0) or 2.0),
        "cue_volume": float(settings.get("cue_volume", 1.5) or 1.5),
        "playback_speed": float(settings.get("playback_speed", 1.0) or 1.0),
        "transfer_target": transfer_target,
        "transfer_label": transfer_label,
        "transfer_configured": bool(transfer_target),
        "active_session_id": active_session_id,
        "tts_provider": _configured_tts_provider(config),
        "stt_provider": _stt_status()[1],
        "available_voices": _available_voices(config),
        "settings": settings,
    }


@router.put("/settings")
async def put_settings(request: Request) -> Dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Settings body must be an object")

    def parse_numeric(field: str, minimum: float, maximum: float) -> float:
        try:
            value = float(body[field])
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"{field} must be a number") from exc
        return max(minimum, min(maximum, value))

    current = _read_settings()
    allowed: Dict[str, Any] = {}
    if "voice" in body:
        voice = str(body["voice"]).strip()
        if not voice:
            raise HTTPException(status_code=400, detail="voice must not be empty")
        allowed["voice"] = voice
    if "sounds_enabled" in body:
        allowed["sounds_enabled"] = bool(body["sounds_enabled"])
    if "hands_free" in body:
        allowed["hands_free"] = bool(body["hands_free"])
    if "silence_seconds" in body:
        allowed["silence_seconds"] = parse_numeric("silence_seconds", 0.0, 5.0)
    if "cue_volume" in body:
        allowed["cue_volume"] = parse_numeric("cue_volume", 0.0, 2.0)
    if "playback_speed" in body:
        allowed["playback_speed"] = parse_numeric("playback_speed", 0.75, 1.5)
    if "model_override" in body:
        allowed["model_override"] = str(body["model_override"] or "").strip()
    if "transfer_target" in body:
        allowed["transfer_target"] = str(body["transfer_target"] or "").strip()
    if "transfer_label" in body:
        allowed["transfer_label"] = str(body["transfer_label"] or "").strip()
    current.update(allowed)
    _write_settings(current)
    return await get_settings()


@router.post("/transfer")
async def transfer(request: Request) -> Dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Transfer body must be an object")

    settings = _read_settings()
    target = str(body.get("target") or settings.get("transfer_target") or DEFAULT_TRANSFER_TARGET).strip()
    if not target:
        raise HTTPException(status_code=400, detail="No transfer target is configured")

    transcript = str(body.get("transcript") or "").strip()
    assistant_text = str(body.get("assistant_text") or "").strip()
    if not transcript and not assistant_text:
        raise HTTPException(status_code=400, detail="A transcript or assistant_text is required")

    label = _transfer_target_label(target, str(body.get("label") or settings.get("transfer_label") or ""))
    message = _build_transfer_message(transcript=transcript, assistant_text=assistant_text, target_label=label)
    try:
        result = await _run_blocking(lambda: _send_transfer_message(target=target, message=message))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "ok": True,
        "target": target,
        "label": label,
        "note": str(result.get("note") or "").strip(),
        "mirrored": bool(result.get("mirrored")),
    }


@router.get("/debug/client-telemetry")
async def get_client_telemetry() -> Dict[str, Any]:
    return {"ok": True, "telemetry": _last_client_telemetry or None}


@router.post("/debug/client-telemetry")
async def put_client_telemetry(request: Request) -> Dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Telemetry body must be an object")
    stored = _store_client_telemetry(body)
    return {"ok": True, "received_at": stored["received_at"]}


@router.post("/transcribe")
async def transcribe(request: Request) -> Dict[str, Any]:
    content_type = request.headers.get("content-type", "")
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="Audio body is required")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio body is too large")

    suffix = mimetypes.guess_extension(content_type.split(";", 1)[0].strip()) or ".webm"
    if suffix == ".oga":
        suffix = ".ogg"

    with tempfile.NamedTemporaryFile(prefix="hermes_voice_", suffix=suffix, delete=False) as tmp:
        tmp.write(audio)
        tmp_path = tmp.name
    try:
        result = await _run_blocking(_transcribe_audio_file, tmp_path)
    finally:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except Exception:
            pass

    if not result.get("success"):
        raise HTTPException(status_code=503, detail=str(result.get("error") or "Transcription failed"))
    return {
        "ok": True,
        "transcript": str(result.get("transcript") or "").strip(),
        "provider": result.get("provider"),
    }


@router.post("/respond")
async def respond(request: Request) -> Dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc
    transcript = str((body or {}).get("transcript") or "").strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="transcript is required")

    _cleanup_jobs()
    session_id = _active_voice_session_id()
    job_id = uuid.uuid4().hex
    job = VoiceJob(id=job_id, transcript=transcript, created_at=time.time(), session_id=session_id)
    _jobs[job_id] = job
    asyncio.create_task(_run_response_job(job))
    return {"ok": True, "job_id": job_id, "session_id": session_id}


@router.post("/session/reset")
async def reset_session() -> Dict[str, Any]:
    rotated = _rotate_voice_session()
    return {
        "ok": True,
        "session_id": rotated["session_id"],
        "previous_session_id": rotated["previous_session_id"],
    }


@router.get("/stream/{job_id}")
async def stream(job_id: str) -> StreamingResponse:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    async def events() -> AsyncIterator[str]:
        while True:
            item = await job.queue.get()
            if item is None:
                break
            event_name = str(item.get("event") or "message")
            yield f"event: {event_name}\n"
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/audio/{job_id}")
async def audio(job_id: str) -> FileResponse:
    job = _jobs.get(job_id)
    if not job or not job.audio_path:
        raise HTTPException(status_code=404, detail="Audio not ready")
    path = _safe_audio_path(job.audio_path)
    if not path:
        raise HTTPException(status_code=404, detail="Audio file not found")
    media_type = mimetypes.guess_type(str(path))[0] or "audio/mpeg"
    return FileResponse(path, media_type=media_type, filename=path.name)


@router.get("/audio/{job_id}/{chunk_index}")
async def audio_chunk(job_id: str, chunk_index: int) -> FileResponse:
    job = _jobs.get(job_id)
    path = _safe_audio_path(job.audio_chunk_paths.get(chunk_index) if job else None)
    if not path:
        raise HTTPException(status_code=404, detail="Audio chunk file not found")
    media_type = mimetypes.guess_type(str(path))[0] or "audio/mpeg"
    return FileResponse(path, media_type=media_type, filename=path.name)
