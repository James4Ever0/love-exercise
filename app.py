from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

import requests
from json_repair import repair_json
from flask import Flask, abort, jsonify, render_template, request, send_file


BASE_DIR = Path(__file__).resolve().parent
MOTION_PERIODS_DIR = BASE_DIR / "motion-periods"
VOCALS_DIR = BASE_DIR / "assets" / "vocals"
MUSIC_DIR = BASE_DIR / "assets" / "music"

app = Flask(__name__)


COMMAND_AUDIO = {
    1: "commands/s-1.mp3",
    2: "commands/s-2.mp3",
    3: "commands/s-3.mp3",
    4: "commands/s-4.mp3",
    5: "commands/s-5.mp3",
    6: "commands/s-6.mp3",
    7: "commands/s-7.mp3",
    8: "commands/s-8.mp3",
}
PERIOD_TYPES = {"普通体操", "眼保健操"}
AI_TASKS: dict[str, dict] = {}
AI_TASKS_LOCK = threading.Lock()
AI_TASK_LEASE_SECONDS = 6
ALLOWED_SPEEDS = {0.5, 0.75, 1, 1.25, 1.5, 2}


def discover_music() -> list[dict]:
    tracks: list[dict] = []
    if not MUSIC_DIR.exists():
        return tracks

    for directory in sorted(MUSIC_DIR.iterdir()):
        metadata_file = directory / "metadata.json"
        if not directory.is_dir() or not metadata_file.is_file():
            continue
        metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
        audio_file = metadata.get("file", "music.mp3")
        if not (directory / audio_file).is_file():
            continue
        tracks.append(
            {
                "id": directory.name,
                "title": metadata.get("title", directory.name),
                "artist": metadata.get("artist", ""),
                "bpm": metadata.get("recommended_bpm", metadata.get("bpm")),
                "duration_seconds": metadata.get("duration_seconds"),
                "license": metadata.get("license", ""),
                "source_url": metadata.get("source_url", ""),
                "license_url": metadata.get("license_url", ""),
                "audio": f"/media/music/{directory.name}/{audio_file}",
            }
        )
    return tracks


def discover_periods() -> list[dict]:
    periods: list[dict] = []
    if not MOTION_PERIODS_DIR.exists():
        return periods

    for directory in sorted(MOTION_PERIODS_DIR.iterdir()):
        period_file = directory / "period.json"
        if not directory.is_dir() or not period_file.exists():
            continue

        metadata = json.loads(period_file.read_text(encoding="utf-8"))
        if metadata.get("schema_version") != 1:
            raise ValueError(f"unsupported period schema: {directory.name}")
        if metadata.get("id") != directory.name:
            raise ValueError(f"period id must match directory name: {directory.name}")
        if metadata.get("type") not in PERIOD_TYPES:
            raise ValueError(f"period type must be 普通体操 or 眼保健操: {directory.name}")
        eight_count = metadata.get("eight_count", {})
        eight_count_seconds = int(eight_count.get("duration_seconds", 10))
        default_eight_counts = int(eight_count.get("default_repetitions", 8))
        allowed_eight_counts = [int(value) for value in eight_count.get("allowed_repetitions", [2, 4, 8])]
        if not allowed_eight_counts or any(value not in {2, 4, 8} for value in allowed_eight_counts):
            raise ValueError(f"allowed eight-count repetitions must use 2, 4, or 8: {directory.name}")
        if default_eight_counts not in allowed_eight_counts:
            raise ValueError(f"default eight-count repetitions must be allowed: {directory.name}")
        steps = [
            step
            for step in metadata.get("steps", [])
            if (directory / step.get("image", "")).is_file()
        ]
        if not steps:
            continue
        audio_name = metadata.get("audio", {}).get("name")
        period = {
            "id": directory.name,
            "title": metadata.get("name", directory.name),
            "type": metadata.get("type", "普通体操"),
            "mirror": bool(metadata.get("mirror", False)),
            "starting_pose": metadata.get("starting_pose", ""),
            "duration": f"{eight_count_seconds * default_eight_counts} 秒（{default_eight_counts} 个八拍）",
            "duration_seconds": eight_count_seconds,
            "default_eight_counts": default_eight_counts,
            "allowed_eight_counts": allowed_eight_counts,
            "scenes": metadata.get("scenes", []),
            "illustration_scene": metadata.get("illustration_scene", ""),
            "view": metadata.get("view", ""),
            "steps": [
                {
                    "number": int(step["frame"]),
                    "cue": int(step.get("cue", step["frame"])),
                    "name": step.get("name", ""),
                    "description": step.get("description", ""),
                }
                for step in steps
            ],
            "frames": [
                {
                    "number": int(step["frame"]),
                    "image": f"/media/motion/{directory.name}/{step['image']}",
                }
                for step in steps
            ],
            "command_audio": {
                str(number): f"/media/vocals/{audio_path}"
                for number, audio_path in COMMAND_AUDIO.items()
                if (VOCALS_DIR / audio_path).is_file()
            },
            "name_audio": (
                f"/media/motion/{directory.name}/{audio_name}"
                if audio_name and (directory / audio_name).is_file()
                else None
            ),
        }
        periods.append(period)

    return periods


def get_period(period_id: str) -> dict:
    period = next((item for item in discover_periods() if item["id"] == period_id), None)
    if period is None:
        abort(404)
    return period


def _load_env() -> None:
    env_file = BASE_DIR / ".env"
    if not env_file.is_file():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def _task_update(task_id: str, **changes) -> None:
    with AI_TASKS_LOCK:
        task = AI_TASKS.get(task_id)
        if task:
            if "logs" in changes:
                changes["logs"] = task.get("logs", []) + changes["logs"]
            task.update(changes)


def _task_cancelled(task_id: str) -> bool:
    with AI_TASKS_LOCK:
        return not AI_TASKS.get(task_id) or AI_TASKS[task_id]["cancel_event"].is_set()


def _cancel_expired_tasks() -> None:
    now = time.monotonic()
    with AI_TASKS_LOCK:
        for task in AI_TASKS.values():
            if task["status"] == "running" and task["lease_until"] < now:
                task["cancel_event"].set()
                task.update(status="cancelled", step="连接已断开", logs=task.get("logs", []) + ["前端心跳超时，任务已自动取消"])


def _ai_task_watchdog() -> None:
    while True:
        time.sleep(1)
        _cancel_expired_tasks()


threading.Thread(target=_ai_task_watchdog, daemon=True, name="ai-task-watchdog").start()


def _unique_name(name: str, existing_names: list[str]) -> str:
    normalized = {" ".join(item.strip().split()).casefold() for item in existing_names}
    base = " ".join(name.strip().split()) or "我的新操"
    if base.casefold() not in normalized:
        return base
    suffix = 2
    while f"{base} {suffix}".casefold() in normalized:
        suffix += 1
    return f"{base} {suffix}"


def _extract_json(text: str) -> dict:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("模型没有返回 JSON 对象")
    repaired = repair_json(cleaned[start : end + 1])
    parsed = json.loads(repaired)
    if not isinstance(parsed, dict):
        raise ValueError("生成结果必须是 JSON 对象")
    return parsed


def _validate_generated(data: dict, periods: list[dict], tracks: list[dict], existing_names: list[str], duration_minutes: float | None) -> dict:
    if not isinstance(data.get("name"), str) or not data["name"].strip():
        raise ValueError("缺少有效的操名称")
    if data.get("type") not in PERIOD_TYPES:
        raise ValueError("操类型必须是普通体操或眼保健操")
    period_by_id = {item["id"]: item for item in periods}
    track_ids = {item["id"] for item in tracks}
    items = data.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 10:
        raise ValueError("动作小节数量必须在 1 到 10 个之间")
    seen = set()
    validated_items = []
    total_seconds = 0
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"第 {index + 1} 个动作小节格式无效")
        period_id = item.get("periodId")
        selected = period_by_id.get(period_id)
        if not selected or selected["type"] != data["type"]:
            raise ValueError(f"第 {index + 1} 个动作类型不匹配或不存在")
        if period_id in seen:
            raise ValueError("同一个动作小节不能重复添加")
        seen.add(period_id)
        eight_counts = item.get("eightCounts")
        speed = item.get("speed")
        repeat = item.get("repeat")
        if eight_counts not in selected["allowed_eight_counts"]:
            raise ValueError(f"{selected['title']} 的八拍数量不被支持")
        if speed not in ALLOWED_SPEEDS:
            raise ValueError("动作速度不被支持")
        if not isinstance(repeat, int) or not 1 <= repeat <= 5:
            raise ValueError("动作重复次数必须是 1 到 5")
        total_seconds += selected["duration_seconds"] * eight_counts * repeat / speed
        validated_items.append({"periodId": period_id, "eightCounts": eight_counts, "speed": speed, "repeat": repeat})
    music = data.get("music") or {}
    track_id = music.get("trackId", "")
    if track_id and track_id not in track_ids:
        raise ValueError("背景音乐不存在")
    volume = music.get("volume", 0.5)
    if not isinstance(volume, (int, float)) or not 0 <= volume <= 1:
        raise ValueError("背景音乐音量无效")
    if duration_minutes and not duration_minutes * 60 * 0.35 <= total_seconds <= duration_minutes * 60 * 2.5:
        raise ValueError("生成的总时长与目标时长差距过大")
    return {"name": _unique_name(data["name"], existing_names), "type": data["type"], "items": validated_items, "music": {"trackId": track_id, "volume": float(volume), "loop": True}}


def _generate_ai_task(task_id: str, inputs: dict) -> None:
    try:
        _load_env()
        api_key = os.getenv("OPENAI_API_KEY")
        base_url = os.getenv("OPENAI_BASEURL", "https://api.deepseek.com").rstrip("/")
        model = os.getenv("OPENAI_MODEL_NAME", "deepseek-chat")
        if not api_key:
            raise ValueError("服务器缺少 OPENAI_API_KEY")
        periods = discover_periods()
        tracks = discover_music()
        context = [{"id": p["id"], "name": p["title"], "type": p["type"], "scenes": p["scenes"], "eight_count": {"duration_seconds": p["duration_seconds"], "allowed": p["allowed_eight_counts"]}} for p in periods]
        prompt = f"""根据用户需求生成一套操，只返回 JSON，不要 Markdown。\n场景：{inputs['scene']}\n不适部位：{inputs.get('discomfort') or '未填写'}\n目标时长（分钟）：{inputs.get('duration_minutes') or '未填写'}\n只能从动作目录选择，操类型只能是普通体操或眼保健操，动作类型必须匹配，最多 10 个动作。\n动作目录：{json.dumps(context, ensure_ascii=False)}\n音乐目录：{json.dumps([{k: t[k] for k in ('id', 'title', 'bpm')} for t in tracks], ensure_ascii=False)}\n输出格式：{{\"name\":\"...\",\"type\":\"普通体操\",\"items\":[{{\"periodId\":\"...\",\"eightCounts\":2,\"speed\":1,\"repeat\":1}}],\"music\":{{\"trackId\":\"或空字符串\",\"volume\":0.5}}}}"""
        feedback = ""
        for attempt in range(1, 5):
            if _task_cancelled(task_id):
                return
            _task_update(task_id, attempt=attempt, progress=min(85, attempt * 20), step="生成新操方案", logs=[f"第 {attempt} 次请求模型…"])
            messages = [{"role": "system", "content": "你是爱做操的动作编排助手，只输出符合要求的 JSON。"}, {"role": "user", "content": prompt + feedback}]
            response = requests.post(f"{base_url}/v1/chat/completions", headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, json={"model": model, "messages": messages, "temperature": 0.2, "max_tokens": 1200}, timeout=(5, 20))
            response.raise_for_status()
            if _task_cancelled(task_id):
                return
            content = response.json()["choices"][0]["message"]["content"]
            _task_update(task_id, step="校验生成结果", logs=["已收到模型结果，正在校验动作、类型、时长和音乐…"])
            try:
                result = _validate_generated(_extract_json(content), periods, tracks, inputs.get("existing_names", []), inputs.get("duration_minutes"))
                _task_update(task_id, status="completed", progress=100, step="生成完成", logs=["名称已生成", "动作小节已匹配", "速度、八拍和重复次数已设置", "背景音乐已匹配"], result=result)
                return
            except Exception as exc:
                feedback = f"\n上一次结果校验失败：{exc}\n请只返回修正后的 JSON。"
                _task_update(task_id, logs=[f"校验失败：{exc}"])
        raise ValueError("超过 3 次重试，生成结果仍未通过校验")
    except Exception as exc:
        if not _task_cancelled(task_id):
            _task_update(task_id, status="failed", step="生成失败", error=str(exc), logs=[str(exc)])


@app.post("/api/ai/routines/generate")
def ai_generate():
    payload = request.get_json(silent=True) or {}
    scene = str(payload.get("scene", "")).strip()
    if not scene:
        return jsonify({"error": "场景不能为空"}), 400
    if len(scene) > 120 or len(str(payload.get("discomfort", ""))) > 120:
        return jsonify({"error": "输入内容不能超过 120 个字符"}), 400
    duration_minutes = payload.get("duration_minutes")
    if duration_minutes is not None:
        try:
            duration_minutes = float(duration_minutes)
        except (TypeError, ValueError):
            return jsonify({"error": "可用时长格式无效"}), 400
        if not 0.5 <= duration_minutes <= 120:
            return jsonify({"error": "可用时长需要在 0.5 到 120 分钟之间"}), 400
    task_id = str(payload.get("task_id") or uuid.uuid4())
    task = {"id": task_id, "status": "running", "progress": 5, "step": "准备生成", "attempt": 0, "logs": ["已收到生成请求"], "cancel_event": threading.Event(), "lease_until": time.monotonic() + AI_TASK_LEASE_SECONDS}
    with AI_TASKS_LOCK:
        AI_TASKS[task_id] = task
    threading.Thread(target=_generate_ai_task, args=(task_id, {"scene": scene, "discomfort": str(payload.get("discomfort", ""))[:120], "duration_minutes": duration_minutes, "existing_names": payload.get("existing_names", [])}), daemon=True).start()
    return jsonify({"task_id": task_id, "status": "running"}), 202


@app.post("/api/ai/routines/generate/<task_id>/heartbeat")
def ai_generate_heartbeat(task_id: str):
    with AI_TASKS_LOCK:
        task = AI_TASKS.get(task_id)
        if not task:
            abort(404)
        if task["status"] == "cancelled":
            return jsonify({"task_id": task_id, "status": "cancelled"}), 410
        if task["status"] == "running":
            task["lease_until"] = time.monotonic() + AI_TASK_LEASE_SECONDS
        return jsonify({"task_id": task_id, "status": task["status"]})


@app.get("/api/ai/routines/generate/<task_id>")
def ai_generate_status(task_id: str):
    with AI_TASKS_LOCK:
        task = AI_TASKS.get(task_id)
        if not task:
            abort(404)
        return jsonify({k: v for k, v in task.items() if k != "cancel_event"})


@app.route("/api/ai/routines/generate/<task_id>", methods=["DELETE", "POST"])
def ai_generate_cancel(task_id: str):
    with AI_TASKS_LOCK:
        task = AI_TASKS.get(task_id)
        if not task:
            abort(404)
        task["cancel_event"].set()
        task.update(status="cancelled", step="已取消", logs=task.get("logs", []) + ["用户取消了生成"])
    return jsonify({"task_id": task_id, "status": "cancelled"})


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/periods")
def periods_api():
    return jsonify({"periods": discover_periods()})


@app.get("/api/music")
def music_api():
    return jsonify({"tracks": discover_music()})


@app.get("/media/motion/<period_id>/<path:asset_path>")
def motion_asset(period_id: str, asset_path: str):
    get_period(period_id)
    period_root = (MOTION_PERIODS_DIR / period_id).resolve()
    requested_path = (period_root / asset_path).resolve()
    if period_root not in requested_path.parents or not requested_path.is_file():
        abort(404)
    if requested_path.suffix.lower() == ".mp3":
        mimetype = "audio/mpeg"
    elif requested_path.suffix.lower() in {".jpeg", ".jpg", ".png"}:
        with requested_path.open("rb") as image_file:
            mimetype = "image/png" if image_file.read(8) == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
    else:
        abort(404)
    return send_file(requested_path, mimetype=mimetype, max_age=3600)


@app.get("/media/vocals/<path:audio_path>")
def vocal_audio(audio_path: str):
    requested_path = (VOCALS_DIR / audio_path).resolve()
    vocals_root = VOCALS_DIR.resolve()
    if vocals_root not in requested_path.parents or not requested_path.is_file():
        abort(404)
    with requested_path.open("rb") as audio_file:
        mimetype = "audio/wav" if audio_file.read(4) == b"RIFF" else "audio/mpeg"
    return send_file(requested_path, mimetype=mimetype, max_age=3600)


@app.get("/media/music/<track_id>/<path:audio_path>")
def music_audio(track_id: str, audio_path: str):
    track_root = (MUSIC_DIR / track_id).resolve()
    requested_path = (track_root / audio_path).resolve()
    if MUSIC_DIR.resolve() not in track_root.parents or track_root not in requested_path.parents or not requested_path.is_file():
        abort(404)
    return send_file(requested_path, mimetype="audio/mpeg", max_age=3600)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
