# Log analysis workspace and Codex runner for AI kiosk log analysis (two-trip).
# Uses git worktree when KIOSK_REPO_PATH and LOG_ANALYSIS_WORKSPACE_BASE are set; else temp dir.

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from typing import Any, Dict, List, Optional

import logging

log = logging.getLogger(__name__)

_CODEX_TIMEOUT_DEFAULT = 120
_CODEX_CONTEXT_FILENAME = "codex_log_context.md"
_CODEX_MD_FILENAME = "codex.md"
_RES_OUT = "res.out"

# Paths: set in Docker; optional for local dev (uses temp dir).
KIOSK_REPO_PATH = os.environ.get("KIOSK_REPO_PATH", "")
LOG_ANALYSIS_WORKSPACE_BASE = os.environ.get("LOG_ANALYSIS_WORKSPACE_BASE", "")
LOG_ANALYSIS_CACHE_DIR = os.environ.get("LOG_ANALYSIS_CACHE_DIR", "")
LOG_ANALYSIS_CACHE_TTL_DAYS = int(os.environ.get("LOG_ANALYSIS_CACHE_TTL_DAYS", "2") or "2")

# Max length for sanitized kiosk/identifier in cache filename
_CACHE_KEY_MAX_LEN = 64


def _api_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def get_cache_dir() -> Optional[str]:
    """Return cache directory for log slices, or None if caching is disabled."""
    if LOG_ANALYSIS_CACHE_DIR and LOG_ANALYSIS_CACHE_DIR.strip():
        return LOG_ANALYSIS_CACHE_DIR.strip()
    if LOG_ANALYSIS_WORKSPACE_BASE and os.path.isdir(LOG_ANALYSIS_WORKSPACE_BASE):
        return os.path.join(LOG_ANALYSIS_WORKSPACE_BASE, "log_analysis_cache")
    return None


def _sanitize_cache_key_part(s: str) -> str:
    """Sanitize for use in cache filename: alnum and underscore only, limited length."""
    if not s:
        return "_"
    s = re.sub(r"[^a-zA-Z0-9_-]", "_", str(s))[: _CACHE_KEY_MAX_LEN]
    return s or "_"


def _cache_key_path(
    cache_dir: str, kiosk_name: str, identifier: str, date_str: str
) -> Optional[str]:
    """Return absolute path for the cache file for (kiosk_name, identifier, date_str), or None."""
    if not cache_dir or not date_str:
        return None
    safe_kiosk = _sanitize_cache_key_part(kiosk_name)
    safe_id = _sanitize_cache_key_part(identifier)
    name = f"{safe_kiosk}_{safe_id}_{date_str}.log"
    return os.path.join(cache_dir, name)


def get_cached_log_lines(
    cache_dir: str,
    kiosk_name: str,
    identifier: str,
    date_str: str,
    max_age_seconds: int,
) -> Optional[List[str]]:
    """Return list of log lines if a valid (non-expired) cache file exists; else None. Deletes stale file."""
    path = _cache_key_path(cache_dir, kiosk_name, identifier, date_str)
    if not path or not os.path.isfile(path):
        return None
    try:
        mtime = os.path.getmtime(path)
        if (time.time() - mtime) > max_age_seconds:
            try:
                os.remove(path)
            except OSError:
                pass
            return None
        with open(path, "r", encoding="utf-8") as f:
            return [line.rstrip("\n\r") for line in f]
    except OSError:
        return None


def set_cached_log_lines(
    cache_dir: str,
    kiosk_name: str,
    identifier: str,
    date_str: str,
    lines: List[str],
) -> None:
    """Write log lines to the cache file for that key. Creates parent dir if needed."""
    path = _cache_key_path(cache_dir, kiosk_name, identifier, date_str)
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            for line in lines:
                f.write(line if line.endswith("\n") else line + "\n")
    except OSError as e:
        log.warning("set_cached_log_lines failed path=%s: %s", path, e)


def set_cached_log_from_file(
    cache_dir: str,
    kiosk_name: str,
    identifier: str,
    date_str: str,
    source_path: str,
) -> None:
    """Copy source_path to the cache file for that key. Use after streaming to file to avoid loading content into memory."""
    path = _cache_key_path(cache_dir, kiosk_name, identifier, date_str)
    if not path or not os.path.isfile(source_path):
        return
    try:
        size = os.path.getsize(source_path)
        os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
        shutil.copy2(source_path, path)
        log.info("log_analysis set_cached_log_from_file source=%s cache_path=%s bytes=%s", source_path, path, size)
    except OSError as e:
        log.warning("set_cached_log_from_file failed path=%s: %s", path, e)


def cleanup_log_cache(cache_dir: str, max_age_seconds: int) -> None:
    """Remove cache files older than max_age_seconds."""
    if not cache_dir or not os.path.isdir(cache_dir):
        return
    try:
        now = time.time()
        for name in os.listdir(cache_dir):
            if not name.endswith(".log"):
                continue
            path = os.path.join(cache_dir, name)
            if os.path.isfile(path) and (now - os.path.getmtime(path)) > max_age_seconds:
                try:
                    os.remove(path)
                except OSError:
                    pass
    except OSError as e:
        log.warning("cleanup_log_cache failed: %s", e)


def get_empty_workspace() -> str:
    """Return the path of a fixed empty directory for lightweight Codex runs (e.g. identifier extraction). No repo, minimal context. Directory is created once and reused."""
    if LOG_ANALYSIS_WORKSPACE_BASE and os.path.isdir(LOG_ANALYSIS_WORKSPACE_BASE):
        path = os.path.join(LOG_ANALYSIS_WORKSPACE_BASE, "empty")
    else:
        path = os.path.join(tempfile.gettempdir(), "log_analysis_empty")
    os.makedirs(path, mode=0o755, exist_ok=True)
    return path


def create_workspace() -> str:
    """Create a workspace directory (kiosk worktree or temp) for log analysis. Returns absolute path. Caller must call cleanup_workspace."""
    if KIOSK_REPO_PATH and os.path.isdir(KIOSK_REPO_PATH) and LOG_ANALYSIS_WORKSPACE_BASE:
        os.makedirs(LOG_ANALYSIS_WORKSPACE_BASE, mode=0o755, exist_ok=True)
        worktree_id = str(uuid.uuid4())[:8]
        path = os.path.join(LOG_ANALYSIS_WORKSPACE_BASE, worktree_id)
        try:
            cmd = ["git", "-C", KIOSK_REPO_PATH, "worktree", "add", path, "HEAD"]
            log.info("log_analysis create_workspace external_cmd=%s", " ".join(cmd))
            subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                timeout=30,
            )
            log.info("log_analysis worktree created path=%s", path)
            return path
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
            log.warning("git worktree add failed, using temp dir: %s", e)
    td = tempfile.mkdtemp(prefix="log_analysis_")
    log.info("log_analysis using temp workspace path=%s", td)
    return td


def cleanup_workspace(workspace_path: str) -> None:
    """Remove worktree or temp dir."""
    if not workspace_path or not os.path.isdir(workspace_path):
        return
    if KIOSK_REPO_PATH and workspace_path.startswith(LOG_ANALYSIS_WORKSPACE_BASE or "/nonexistent"):
        try:
            cmd_remove = ["git", "-C", KIOSK_REPO_PATH, "worktree", "remove", workspace_path, "--force"]
            cmd_prune = ["git", "-C", KIOSK_REPO_PATH, "worktree", "prune"]
            log.info("log_analysis cleanup_workspace external_cmd_remove=%s external_cmd_prune=%s", " ".join(cmd_remove), " ".join(cmd_prune))
            subprocess.run(cmd_remove, capture_output=True, timeout=10)
            subprocess.run(cmd_prune, capture_output=True, timeout=5)
        except Exception as e:
            log.warning("git worktree remove failed: %s", e)
    else:
        try:
            shutil.rmtree(workspace_path, ignore_errors=True)
        except OSError as e:
            log.warning("rmtree workspace failed: %s", e)


def write_all_log(workspace_path: str, lines: List[str]) -> None:
    """Write log lines to workspace_path/all.log."""
    path = os.path.join(workspace_path, "all.log")
    with open(path, "w", encoding="utf-8") as f:
        for line in lines:
            f.write(line if line.endswith("\n") else line + "\n")


def ensure_codex_context(workspace_path: str) -> None:
    """Copy codex_log_context.md into workspace as codex.md if not already present."""
    src = os.path.join(_api_dir(), _CODEX_CONTEXT_FILENAME)
    dst = os.path.join(workspace_path, _CODEX_MD_FILENAME)
    if os.path.isfile(src):
        shutil.copy2(src, dst)


def run_codex(
    workspace_path: str,
    prompt: str,
    timeout: int = _CODEX_TIMEOUT_DEFAULT,
    log_file_path: Optional[str] = None,
    use_codex_context: bool = True,
) -> str:
    """Run codex -C workspace_path exec 'prompt' -o res.out; return contents of res.out.
    If log_file_path is set (e.g. './all.log'), prepend an instruction so Codex knows which file to analyze.
    Use use_codex_context=False for minimal-context runs (e.g. identifier extraction in empty workspace)."""
    if use_codex_context:
        ensure_codex_context(workspace_path)
    if log_file_path:
        prompt = f"The log file you must analyze is: {log_file_path} (it is in this workspace).\n\n{prompt}"
    out_path = os.path.join(workspace_path, _RES_OUT)
    cmd = ["codex", "-C", workspace_path, "exec", "--skip-git-repo-check", prompt, "-o", _RES_OUT]
    prompt_preview = (prompt[:80] + "…") if len(prompt) > 80 else prompt
    log.info(
        "log_analysis run_codex external_cmd=codex -C <workspace> exec '<prompt>' -o res.out workspace=%s timeout=%s prompt_len=%s prompt_preview=%s",
        workspace_path,
        timeout,
        len(prompt),
        prompt_preview.replace("%", "%%"),
    )
    try:
        result = subprocess.run(
            cmd,
            cwd=workspace_path,
            timeout=timeout,
            capture_output=True,
            check=False,
        )
        if result.stderr:
            log.debug("codex stderr: %s", result.stderr.decode("utf-8", errors="replace")[:500])
        # Token usage: not exposed by codex CLI; would require parsing API response if using OpenAI directly
        log.info("codex exec completed returncode=%s", result.returncode)
    except subprocess.TimeoutExpired:
        log.warning("codex exec timed out after %ss", timeout)
        return ""
    except FileNotFoundError:
        log.warning("codex CLI not found")
        return ""
    if not os.path.isfile(out_path):
        return ""
    try:
        with open(out_path, "r", encoding="utf-8") as f:
            out = f.read()
        log.info(f"codex exec output:\n{out}")
        return out
    except OSError:
        return ""


# Default response when Codex JSON extraction fails to parse
_EXTRACT_JSON_PARSE_ERROR: Dict[str, Any] = {
    "success": False,
    "error_message": "Could not parse AI response.",
    "identifiers": [],
}


def extract_identifiers_json(
    workspace_path: str,
    question: str,
    timeout: int = 60,
) -> Dict[str, Any]:
    """Run Codex to extract identifiers from the user's text only. Returns { success, error_message, identifiers }.
    No date context is passed in; approximate_date is used only when pulling from the device.
    """
    prompt = (
        "You must output only valid JSON, no other text. USE THIS EXACT STRUCTURE:\n"
        '{"success": true or false, "error_message": null or "user-facing string", "identifiers": ["string", ...]}\n\n'
        "From the user message below, extract identifiers. An identifier is exactly one of these five types (user may say e.g. \"session id\", \"session_id\", \"scan id\", \"transaction id\", \"testcut id\", or mention a date/time):\n"
        "- session_id: UUID (e.g. 8a6a49b0-e430-11f0-b7d2-7bf5f7dc4479). Match any phrasing like \"session id\", \"session_id\", \"session\", etc.\n"
        "- scan_id: numeric id only, no prefix (e.g. 123123123). Match \"scan id\", \"scan_id\", \"scan\", etc. Output as plain digits only.\n"
        "- transaction_id: numeric id only, no prefix. Match \"transaction id\", \"transaction_id\", etc. Output as plain digits only.\n"
        "- testcut_id: for testcuts only. You MUST output it with lowercase \"t\" plus exactly 9 zero-padded digits (e.g. 15428 -> t000015428). Only use this format when the user clearly means a testcut (\"testcut\", \"testcut id\", etc.). Never add \"t\" to scan_id or transaction_id.\n"
        "- datetime: when the user mentions both a date and at least an hour, normalize to YYYY-MM-DDTHH or YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS (e.g. 2025-12-28T17). Accept 2 PM, 14:00, Dec 28 afternoon, etc. If the user gives only a date with no hour, do not add datetime to identifiers; instead set success to false and error_message to a short sentence asking for at least an approximate hour (e.g. \"Please provide at least an approximate hour (e.g. 2 PM or 14:00)).\").\n\n"
        "Use only the user message; no other context. Include in identifiers only what appears in the message (at least one required). "
        "Set success to false and error_message only when you cannot interpret the message or find no identifier of any of the five types. "
        "When no identifier is found, use this exact error_message: \"Your question must include at least one of the following so the correct logs can be identified: a session ID (UUID), scan ID, transaction ID, testcut ID, or a date and time (with at least an approximate hour).\" "
        "Otherwise success true, error_message null, identifiers = list of extracted values.\n\n"
        f"Example: {{\"success\": true, \"error_message\": null, \"identifiers\": [\"8a6a49b0-e430-11f0-b7d2-7bf5f7dc4479\"]}} or for testcut 15428 use [\"t000015428\"]\n\n"
        f"User message:\n{(_truncate_question(question))}"
    )
    out = run_codex(workspace_path, prompt, timeout=timeout, use_codex_context=False)
    if not out:
        return {**_EXTRACT_JSON_PARSE_ERROR, "error_message": "AI extraction produced no output."}
    raw = out.strip()
    # Strip optional markdown code fence
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3].strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("extract_identifiers_json parse failed: %s", raw[:200])
        return _EXTRACT_JSON_PARSE_ERROR
    if not isinstance(parsed, dict):
        return _EXTRACT_JSON_PARSE_ERROR
    success = parsed.get("success")
    error_message = parsed.get("error_message")
    identifiers = parsed.get("identifiers")
    if not isinstance(identifiers, list):
        identifiers = []
    else:
        identifiers = [str(x).strip() for x in identifiers if x is not None and str(x).strip()]
    return {
        "success": bool(success),
        "error_message": str(error_message).strip() if error_message else None,
        "identifiers": identifiers,
    }


def _truncate_question(question: str, max_len: int = 2000) -> str:
    if not question:
        return ""
    s = (question or "").strip()
    return s[:max_len] if len(s) > max_len else s


# UUID-like pattern to extract from Codex output (session IDs, etc.)
_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


def extract_identifiers_with_codex(
    workspace_path: str,
    question: str,
    timeout: int = 60,
) -> List[str]:
    """Run Codex to extract identifiers (e.g. session IDs) from the question. Returns list of strings."""
    prompt = (
        "From the following question, list any identifiers that should be searched in logs "
        "(e.g. session IDs, UUIDs). Output only the raw identifiers, one per line. "
        "If there are none, output nothing.\n\nQuestion: " + (question or "")[:2000]
    )
    out = run_codex(workspace_path, prompt, timeout=timeout)
    if not out:
        return []
    ids = []
    seen = set()
    for line in out.strip().splitlines():
        line = line.strip()
        for match in _UUID_RE.finditer(line):
            s = match.group(0)
            if s not in seen:
                seen.add(s)
                ids.append(s)
        if line and not line.startswith("#") and len(line) in (36, 32) and line.replace("-", "").isalnum():
            if line not in seen:
                seen.add(line)
                ids.append(line)
    return ids[:10]
