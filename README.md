# 爱做操 - 护腰小卫士

爱做操是一个本地运行的 Flask Web App，用于创建、编辑和播放普通体操或眼保健操。系统包含动作关键帧、八拍节奏、语音口令、可选背景音乐，以及基于 OpenAI 兼容 API 的 AI 自动编排功能。

<img width="2560" height="1322" alt="image" src="https://github.com/user-attachments/assets/1b814f2e-d138-4ea0-a711-9c9081c831b0" />

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python app.py
```

打开 <http://127.0.0.1:5000>。

AI 自动编排需要在 `.env` 中填写真实的 `OPENAI_API_KEY`。

## Included Assets

- `motion-periods/`：动作小节 JSON、关键帧和动作名称语音。
- `assets/music/`：背景音乐及其元数据。
- `assets/vocals/`：节拍、节次和动作语音。
