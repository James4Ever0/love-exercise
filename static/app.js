const STORAGE_KEY = "ai-zuo-cao-state-v2";
const MAX_ROUTINE_ITEMS = 10;
const ROUTINE_TYPES = ["普通体操", "眼保健操"];
const DEFAULT_ROUTINE = { id: "test-routine", name: "测试操", type: "普通体操", items: [{ periodId: "B1-hanging-spine", speed: 1, repeat: 1, eightCounts: 8 }], music: { trackId: "", volume: 0.5, loop: true } };
const STEP_NAMES = ["准备动作", "发力离地", "稳定悬垂", "落地还原"];

const state = {
  periods: [],
  routines: [],
  activeRoutine: null,
  playerReturnView: "home",
  editingRoutineId: null,
  playing: false,
  audioEnabled: true,
  musicEnabled: true,
  musicTracks: [],
  sectionIndex: 0,
  sectionRepeat: 0,
  eightCountIndex: 0,
  beatIndex: 0,
  frameIndex: 0,
  completedRoutineLoops: 0,
  timer: null,
  audioToken: 0,
  audioSequenceResolve: null,
  completionTimer: null,
  ai: { step: 0, scene: "", discomfort: "", duration: "", taskId: null, heartbeat: null, poll: null, controller: null, inputs: null, result: null },
};

const $ = (selector) => document.querySelector(selector);
const els = {
  home: $("#home-view"), editor: $("#editor-view"), player: $("#player-view"),
  grid: $("#routine-grid"), empty: $("#routine-empty"), routineName: $("#routine-name"),
  editorList: $("#editor-list"), editorEmpty: $("#editor-empty"), editorCount: $("#editor-item-count"),
  browserList: $("#browser-list"), periodCount: $("#period-count"),
  editorRoutineType: $("#editor-routine-type"), routineTypeDialog: $("#routine-type-dialog"),
  playerRoutineName: $("#player-routine-name"), playerSectionName: $("#player-section-name"),
  playerSectionLabel: $("#player-section-progress-label"), playerFrameLabel: $("#player-frame-label"),
  playerSectionFill: $("#player-section-progress-fill"), playerFrame: $("#player-frame"),
  playerImageWrap: $("#player-image-wrap"), playerLoading: $("#player-loading"), playerCue: $("#player-cue-badge"),
  playerSectionNumber: $("#player-section-number"), playerOverallNumber: $("#player-overall-number"),
  playerStepName: $("#player-step-name"), playerInstruction: $("#player-instruction"), playerSpeed: $("#player-speed-label"),
  playerToggle: $("#player-toggle"), playerStatus: $("#player-status"), playerOverallLabel: $("#player-overall-label"),
  playerAudio: $("#player-audio"), playerOverallFill: $("#player-overall-fill"), audio: $("#cue-audio"),
  playerMusic: $("#player-music"), music: $("#music-audio"), routineMusic: $("#routine-music"), musicPreview: $("#preview-music"),
  routineMusicVolume: $("#routine-music-volume"), routineMusicVolumeOutput: $("#routine-music-volume-output"),
  musicBpm: $("#music-bpm"), musicAttribution: $("#music-attribution"),
  aiDialog: $("#ai-wizard-dialog"), aiForm: $("#ai-wizard-form"), aiProgress: $("#ai-wizard-progress"), aiResult: $("#ai-wizard-result"), aiError: $("#ai-wizard-error"), aiStepCount: $("#ai-step-count"), aiStepName: $("#ai-step-name"), aiQuestion: $("#ai-question"), aiHint: $("#ai-hint"), aiInput: $("#ai-scene-input"), aiNext: $("#ai-next"), aiSkip: $("#ai-skip"), aiFill: $("#ai-progress-fill"), aiPercent: $("#ai-progress-percent"), aiProgressTitle: $("#ai-progress-title"), aiLog: $("#ai-log"), aiResultName: $("#ai-result-name"), aiResultSummary: $("#ai-result-summary"), aiErrorMessage: $("#ai-error-message"),
};

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function period(id) { return state.periods.find((item) => item.id === id) || null; }
function routine(id = state.editingRoutineId) { return state.routines.find((item) => item.id === id) || null; }
function formatSpeed(speed) { return `${Number(speed).toFixed(2).replace(/0$/, "")}x`; }
function formatDurationMinutes(seconds) { const minutes = seconds / 60; return `${minutes < 1 ? minutes.toFixed(1) : Number(minutes.toFixed(1))} 分钟`; }
function uniqueRoutineName(baseName) {
  const existingNames = new Set(state.routines.map((item) => item.name.trim()));
  if (!existingNames.has(baseName)) return baseName;
  let suffix = 2;
  while (existingNames.has(`${baseName} ${suffix}`)) suffix += 1;
  return `${baseName} ${suffix}`;
}
function routineItems(itemRoutine) { return (itemRoutine?.items || []).map((item) => ({ ...item, period: period(item.periodId) })).filter((item) => item.period); }
function totalSections(itemRoutine) { return routineItems(itemRoutine).reduce((sum, item) => sum + item.repeat, 0); }
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify({ routines: state.routines, audioEnabled: state.audioEnabled, musicEnabled: state.musicEnabled })); }

const AI_STEPS = [
  { name: "使用场景", question: "你现在在哪里？", hint: "告诉我你想在什么环境下做操。", placeholder: "例如：办公室久坐，刚开完会", required: true },
  { name: "不舒服的部位", question: "哪里感觉不舒服？", hint: "可以填写肩颈、腰背、眼睛，也可以跳过。", placeholder: "例如：肩颈和腰背", required: false },
  { name: "可用时长", question: "你有多少时间？", hint: "可填写 3 分钟、10 分钟，也可以跳过让 AI 自己安排。", placeholder: "例如：5 分钟", required: false },
];

function renderAiStep() {
  const step = AI_STEPS[state.ai.step];
  els.aiStepCount.textContent = `${state.ai.step + 1} / ${AI_STEPS.length}`;
  els.aiStepName.textContent = step.name;
  els.aiQuestion.textContent = step.question;
  els.aiHint.textContent = step.hint;
  els.aiInput.placeholder = step.placeholder;
  els.aiInput.value = [state.ai.scene, state.ai.discomfort, state.ai.duration][state.ai.step] || "";
  els.aiNext.textContent = state.ai.step === AI_STEPS.length - 1 ? "开始生成" : "下一步";
  els.aiNext.disabled = step.required && !els.aiInput.value.trim();
  els.aiSkip.hidden = step.required;
  els.aiInput.focus();
}

function openAiWizard() {
  state.ai = { ...state.ai, step: 0, scene: "", discomfort: "", duration: "", taskId: null, result: null };
  els.aiForm.hidden = false; els.aiProgress.hidden = true; els.aiResult.hidden = true; els.aiError.hidden = true;
  renderAiStep();
  els.aiDialog.showModal();
}

function closeAiWizard() {
  if (state.ai.taskId) cancelAiGeneration();
  els.aiDialog.close();
}

function readAiStep() {
  const value = els.aiInput.value.trim();
  if (state.ai.step === 0) state.ai.scene = value;
  if (state.ai.step === 1) state.ai.discomfort = value;
  if (state.ai.step === 2) state.ai.duration = value;
  return value;
}

function parseDuration(value) {
  const match = String(value || "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function showAiProgress() {
  els.aiForm.hidden = true; els.aiProgress.hidden = false; els.aiResult.hidden = true; els.aiError.hidden = true;
  els.aiLog.innerHTML = ""; els.aiFill.style.width = "5%"; els.aiPercent.textContent = "准备中 5%";
}

function showAiError(message) {
  stopAiPolling();
  els.aiForm.hidden = true; els.aiProgress.hidden = true; els.aiResult.hidden = true; els.aiError.hidden = false;
  els.aiErrorMessage.textContent = message || "生成失败，请重试。";
}

function stopAiPolling() {
  clearInterval(state.ai.heartbeat); clearTimeout(state.ai.poll); state.ai.heartbeat = null; state.ai.poll = null;
}

async function cancelAiGeneration() {
  const taskId = state.ai.taskId;
  stopAiPolling();
  state.ai.controller?.abort();
  state.ai.controller = null; state.ai.taskId = null;
  if (taskId) fetch(`/api/ai/routines/generate/${taskId}`, { method: "DELETE", keepalive: true }).catch(() => {});
}

function addGeneratedRoutine(result) {
  const generated = { id: `routine-ai-${Date.now()}`, name: uniqueRoutineName(result.name), type: result.type, items: result.items, music: result.music || { trackId: "", volume: 0.5, loop: true } };
  state.routines.push(generated); saveState(); return generated;
}

function finishAiSuccess(result) {
  stopAiPolling(); state.ai.taskId = null; state.ai.result = result;
  els.aiForm.hidden = true; els.aiProgress.hidden = true; els.aiError.hidden = true; els.aiResult.hidden = false;
  els.aiResultName.textContent = result.name;
  els.aiResultSummary.textContent = `${result.type} · ${result.items.length} 个动作小节${result.music?.trackId ? " · 已匹配背景音乐" : " · 未使用背景音乐"}`;
}

async function pollAiTask() {
  if (!state.ai.taskId) return;
  try {
    const response = await fetch(`/api/ai/routines/generate/${state.ai.taskId}`);
    const data = await response.json();
    els.aiProgressTitle.textContent = data.step || "正在生成";
    const progress = Math.max(5, Math.min(100, data.progress || (data.attempt ? data.attempt * 20 : 10)));
    els.aiFill.style.width = `${progress}%`; els.aiPercent.textContent = `${data.step || "处理中"} ${progress}%`;
    els.aiLog.innerHTML = (data.logs || []).map((log) => `<div>${escapeHtml(log)}</div>`).join("");
    els.aiLog.scrollTop = els.aiLog.scrollHeight;
    if (data.status === "completed") { finishAiSuccess(data.result); return; }
    if (data.status === "failed" || data.status === "cancelled") { showAiError(data.status === "cancelled" ? "生成已取消。" : data.error); return; }
    state.ai.poll = setTimeout(pollAiTask, 700);
  } catch (error) { showAiError("无法读取生成进度，请检查服务器连接。"); }
}

async function startAiGeneration() {
  readAiStep();
  const taskId = crypto.randomUUID ? crypto.randomUUID() : `ai-${Date.now()}`;
  state.ai.taskId = taskId;
  state.ai.inputs = { scene: state.ai.scene, discomfort: state.ai.discomfort, duration_minutes: parseDuration(state.ai.duration), existing_names: state.routines.map((item) => item.name) };
  showAiProgress();
  state.ai.heartbeat = setInterval(() => fetch(`/api/ai/routines/generate/${taskId}/heartbeat`, { method: "POST" }).catch(() => cancelAiGeneration()), 2000);
  try {
    const response = await fetch("/api/ai/routines/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task_id: taskId, ...state.ai.inputs }) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "生成请求失败"); }
    pollAiTask();
  } catch (error) { showAiError(error.message); }
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.routines = Array.isArray(saved.routines) ? saved.routines : [structuredClone(DEFAULT_ROUTINE)];
    if (typeof saved.audioEnabled === "boolean") state.audioEnabled = saved.audioEnabled;
    if (typeof saved.musicEnabled === "boolean") state.musicEnabled = saved.musicEnabled;
  } catch { state.routines = [structuredClone(DEFAULT_ROUTINE)]; }
}

function showView(view) {
  els.home.hidden = view !== "home";
  els.editor.hidden = view !== "editor";
  els.player.hidden = view !== "player";
  document.body.classList.toggle("player-open", view === "player");
}

function renderHome() {
  els.grid.innerHTML = state.routines.map((itemRoutine) => {
    const items = routineItems(itemRoutine);
    const first = items[0]?.period;
    const duration = items.reduce((sum, item) => sum + (item.period.duration_seconds * item.eightCounts * item.repeat) / item.speed, 0);
    return `<article class="routine-card">
      <div class="routine-card-art ${first ? "has-art" : ""}">${first ? `<img src="${first.frames[0]?.image || ""}" alt="">` : "<span>＋</span>"}<div class="routine-card-art-fade"></div><span class="routine-card-count">${items.length} 个小节</span></div>
      <div class="routine-card-body"><div class="routine-card-title-row"><div><span class="routine-type-badge ${itemRoutine.type === "眼保健操" ? "eyes" : "normal"}">${escapeHtml(itemRoutine.type)}</span><h2>${escapeHtml(itemRoutine.name)}</h2></div><span class="routine-duration">${formatDurationMinutes(duration)}</span></div>
      <div class="routine-card-actions"><button class="primary-button small" data-play-routine="${itemRoutine.id}" type="button">▶ 开始做操</button><button class="outline-button small" data-edit-routine="${itemRoutine.id}" type="button">编辑</button><button class="delete-routine-button" data-delete-routine="${itemRoutine.id}" type="button" aria-label="删除${escapeHtml(itemRoutine.name)}">删除</button></div></div>
    </article>`;
  }).join("");
  els.empty.hidden = state.routines.length > 0;
  els.grid.querySelectorAll("[data-play-routine]").forEach((button) => button.addEventListener("click", () => startPlayer(button.dataset.playRoutine)));
  els.grid.querySelectorAll("[data-edit-routine]").forEach((button) => button.addEventListener("click", () => openEditor(button.dataset.editRoutine)));
  els.grid.querySelectorAll("[data-delete-routine]").forEach((button) => button.addEventListener("click", () => deleteRoutine(button.dataset.deleteRoutine)));
}

function renderBrowser() {
  const current = routine(state.editingRoutineId);
  const matchingPeriods = state.periods.filter((item) => item.type === current?.type);
  els.periodCount.textContent = String(matchingPeriods.length);
  const atLimit = (current?.items.length || 0) >= MAX_ROUTINE_ITEMS;
  els.browserList.innerHTML = matchingPeriods.map((item) => {
    const existing = current?.items.some((entry) => entry.periodId === item.id);
    const disabled = existing || atLimit;
    return `<article class="browser-card"><img src="${item.frames[0]?.image || ""}" alt=""><div class="browser-card-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.section_label || "动作小节")} · ${item.frames.length} 帧</span></div><button class="add-button ${disabled ? "added" : ""}" data-add-period="${item.id}" type="button" ${disabled ? "disabled" : ""}>${existing ? "已加入" : atLimit ? "已满 10 节" : "＋ 添加"}</button></article>`;
  }).join("");
  els.browserList.querySelectorAll("[data-add-period]").forEach((button) => button.addEventListener("click", () => addPeriod(button.dataset.addPeriod)));
}

function renderEditor() {
  const current = routine();
  if (!current) return;
  const items = routineItems(current);
  els.routineName.value = current.name;
  els.editorRoutineType.textContent = current.type;
  els.editorRoutineType.className = `routine-type-label ${current.type === "眼保健操" ? "eyes" : "normal"}`;
  els.editorCount.textContent = `${items.length} / ${MAX_ROUTINE_ITEMS} 个小节`;
  els.editorEmpty.hidden = items.length > 0;
  renderMusicSettings(current);
  els.editorList.innerHTML = items.map((entry, index) => `<article class="editor-item" draggable="true" data-item-index="${index}">
    <div class="drag-handle" title="拖动排序">⠿</div><div class="editor-item-number">${String(index + 1).padStart(2, "0")}</div>
    <div class="editor-item-image"><img src="${entry.period.frames[0]?.image || ""}" alt=""></div><div class="editor-item-copy"><strong>${escapeHtml(entry.period.title)}</strong><span>${entry.period.frames.length} 帧 · 约 ${Math.round((entry.period.duration_seconds * entry.eightCounts) / entry.speed)} 秒</span></div>
    <label class="inline-setting">八拍 <select data-setting="eightCounts" data-index="${index}">${entry.period.allowed_eight_counts.map((value) => `<option value="${value}" ${entry.eightCounts === value ? "selected" : ""}>${value} 个</option>`).join("")}</select></label>
    <label class="inline-setting">速度 <select data-setting="speed" data-index="${index}">${[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => `<option value="${value}" ${entry.speed === value ? "selected" : ""}>${formatSpeed(value)}</option>`).join("")}</select></label>
    <label class="inline-setting">重复 <select data-setting="repeat" data-index="${index}">${[1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${entry.repeat === value ? "selected" : ""}>${value} 次</option>`).join("")}</select></label>
    <div class="editor-item-tools"><button class="preview-button" data-preview-index="${index}" type="button" title="预览动作小节" aria-label="预览动作小节">▶</button><button class="delete-button" data-delete-index="${index}" type="button" title="删除动作小节" aria-label="删除动作小节">×</button></div>
  </article>`).join("");
  els.editorList.querySelectorAll("[data-setting]").forEach((control) => control.addEventListener("change", () => {
    const entry = current.items[Number(control.dataset.index)];
    entry[control.dataset.setting] = Number(control.value); saveState(); renderEditor();
  }));
  els.editorList.querySelectorAll("[data-delete-index]").forEach((button) => button.addEventListener("click", () => { current.items.splice(Number(button.dataset.deleteIndex), 1); saveState(); renderEditor(); renderBrowser(); }));
  els.editorList.querySelectorAll("[data-preview-index]").forEach((button) => button.addEventListener("click", () => previewPeriod(Number(button.dataset.previewIndex))));
  setupDragSort();
}

function renderMusicSettings(current) {
  const selected = state.musicTracks.find((track) => track.id === current.music?.trackId);
  els.routineMusic.innerHTML = `<option value="">无背景音乐</option>${state.musicTracks.map((track) => `<option value="${escapeHtml(track.id)}" ${track.id === current.music?.trackId ? "selected" : ""}>${escapeHtml(track.title)} · ${track.bpm || "-"} BPM</option>`).join("")}`;
  els.routineMusicVolume.value = String(current.music?.volume ?? 0.5);
  els.routineMusicVolumeOutput.textContent = `${Math.round((current.music?.volume ?? 0.5) * 100)}%`;
  els.musicBpm.textContent = selected ? `${selected.bpm || "-"} BPM` : "可选";
  els.musicAttribution.textContent = selected ? `${selected.title} · ${selected.artist}` : "未选择背景音乐";
  els.musicPreview.disabled = !selected;
  if (!els.musicPreview.classList.contains("holding")) {
    els.musicPreview.textContent = selected ? "按住试听" : "无音乐可试听";
  }
}

function setupDragSort() {
  let dragged = null;
  els.editorList.querySelectorAll(".editor-item").forEach((item) => {
    item.addEventListener("dragstart", () => { dragged = Number(item.dataset.itemIndex); item.classList.add("dragging"); });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    item.addEventListener("dragover", (event) => event.preventDefault());
    item.addEventListener("drop", (event) => { event.preventDefault(); const target = Number(item.dataset.itemIndex); const current = routine(); const moved = current.items.splice(dragged, 1)[0]; current.items.splice(target, 0, moved); saveState(); renderEditor(); });
  });
}

function addPeriod(periodId) {
  const current = routine();
  if (!current || current.items.some((item) => item.periodId === periodId)) return;
  if (current.items.length >= MAX_ROUTINE_ITEMS) {
    window.alert("每套操最多可以包含 10 个动作小节。");
    return;
  }
  const selectedPeriod = period(periodId);
  if (!selectedPeriod || selectedPeriod.type !== current.type) {
    window.alert("只能添加与当前操类型一致的动作小节。");
    return;
  }
  current.items.push({ periodId, speed: 1, repeat: 1, eightCounts: selectedPeriod?.default_eight_counts || 8 }); saveState(); renderEditor(); renderBrowser();
}

function newRoutine() {
  if (typeof els.routineTypeDialog.showModal === "function") els.routineTypeDialog.showModal();
  else els.routineTypeDialog.setAttribute("open", "");
}

function createRoutine(type) {
  if (!ROUTINE_TYPES.includes(type)) return;
  const baseName = type === "普通体操" ? "我的普通体操" : "我的眼保健操";
  const created = { id: `routine-${Date.now()}`, name: uniqueRoutineName(baseName), type, items: [], music: { trackId: "", volume: 0.5, loop: true } };
  els.routineTypeDialog.close();
  state.routines.push(created); saveState(); renderHome(); openEditor(created.id);
}

function deleteRoutine(id) {
  const target = routine(id);
  if (!target) return;
  if (!window.confirm(`确定删除“${target.name}”吗？这套操中的动作设置也会被删除。`)) return;
  stopPlayback();
  state.routines = state.routines.filter((item) => item.id !== id);
  if (state.editingRoutineId === id) state.editingRoutineId = null;
  saveState();
  renderHome();
  showView("home");
}

function openEditor(id) { stopPlayback(); state.editingRoutineId = id; showView("editor"); renderEditor(); renderBrowser(); }
function saveEditor() { const current = routine(); if (!current) return; current.name = els.routineName.value.trim() || "未命名的操"; saveState(); renderHome(); showView("home"); }
function previewPeriod(index) { const current = routine(); const item = current?.items[index]; if (!item) return; startPlayer({ id: `preview-${Date.now()}`, name: `${current.name} · 小节预览`, type: current.type, items: [structuredClone(item)], music: { trackId: "", volume: 0, loop: false } }, "editor"); }

function currentRoutineItem() { return state.activeRoutine?.items[state.sectionIndex] || null; }
function currentPeriod() { return period(currentRoutineItem()?.periodId); }
function totalPlaybackSections() { return totalSections(state.activeRoutine); }
function currentPlaybackUnitNumber() { const items = routineItems(state.activeRoutine); return items.slice(0, state.sectionIndex).reduce((sum, item) => sum + item.repeat, 0) + state.sectionRepeat + 1; }
function totalPlaybackEightCounts() { return routineItems(state.activeRoutine).reduce((sum, item) => sum + item.eightCounts * item.repeat, 0); }
function completedPlaybackEightCounts() { const items = routineItems(state.activeRoutine); const before = items.slice(0, state.sectionIndex).reduce((sum, item) => sum + item.eightCounts * item.repeat, 0); return before + state.sectionRepeat * currentRoutineItem().eightCounts; }

function renderPlayer() {
  const current = currentRoutineItem(); const activePeriod = currentPeriod();
  if (!current || !activePeriod) return;
  const frame = activePeriod.frames[state.frameIndex] || activePeriod.frames[0];
  const sectionNumber = state.sectionIndex + 1;
  const overallTotal = totalPlaybackSections();
  const overallDone = currentPlaybackUnitNumber() - 1;
  const cueNumber = state.beatIndex === 0 ? state.eightCountIndex + 1 : state.beatIndex + 1;
  const sectionProgress = ((state.eightCountIndex * 8 + state.beatIndex + 1) / (current.eightCounts * 8)) * 100;
  const overallProgress = ((completedPlaybackEightCounts() + (sectionProgress / 100) * current.eightCounts) / Math.max(totalPlaybackEightCounts(), 1)) * 100;
  const isPreview = state.playerReturnView === "editor";
  const mirrorFrame = activePeriod.mirror === true && (state.eightCountIndex + 1) % 2 === 0;
  els.playerRoutineName.textContent = state.activeRoutine.name;
  els.playerSectionName.textContent = isPreview ? activePeriod.title : `第 ${sectionNumber} 节操 · ${activePeriod.title}`;
  els.playerSectionLabel.textContent = isPreview ? `八拍 ${state.eightCountIndex + 1} / ${current.eightCounts}` : `第 ${sectionNumber} 节操 · 八拍 ${state.eightCountIndex + 1} / ${current.eightCounts}`;
  els.playerFrameLabel.textContent = `${String(frame.number).padStart(2, "0")} / ${String(activePeriod.frames.length).padStart(2, "0")}`;
  els.playerSectionFill.style.width = `${sectionProgress}%`; els.playerOverallFill.style.width = `${overallProgress}%`;
  els.playerFrame.src = frame.image; els.playerFrame.alt = `${activePeriod.title}关键帧`; els.playerFrame.style.transform = mirrorFrame ? "scaleX(-1)" : ""; els.playerImageWrap.classList.remove("loaded"); els.playerFrame.onload = () => els.playerImageWrap.classList.add("loaded");
  els.playerCue.textContent = cueNumber; els.playerSectionNumber.textContent = isPreview ? "" : String(sectionNumber).padStart(2, "0"); els.playerOverallNumber.textContent = `${Math.round(overallProgress)}%`;
  els.playerStepName.textContent = `第 ${state.eightCountIndex + 1} 个八拍 · 第 ${state.beatIndex + 1} 拍`; els.playerInstruction.textContent = activePeriod.steps?.[state.frameIndex]?.description || "跟随画面完成动作";
  els.playerSpeed.textContent = formatSpeed(current.speed); els.playerToggle.textContent = state.playing ? "Ⅱ" : "▶"; els.playerStatus.textContent = state.playing ? "动作进行中" : state.completedRoutineLoops ? "整套操已完成" : "准备播放";
  els.playerOverallLabel.textContent = `整套操 ${overallDone} / ${overallTotal}`;
  els.playerAudio.textContent = state.audioEnabled ? "语音开" : "语音关";
  els.playerMusic.textContent = !currentMusicTrack() ? "无音乐" : state.musicEnabled ? "音乐开" : "音乐关";
  els.playerMusic.disabled = !currentMusicTrack();
}

function stopAudio() { state.audioToken += 1; els.audio.pause(); els.audio.onended = null; els.audio.onerror = null; els.audio.removeAttribute("src"); if (state.audioSequenceResolve) { state.audioSequenceResolve(false); state.audioSequenceResolve = null; } }
function currentMusicTrack() { return state.musicTracks.find((track) => track.id === state.activeRoutine?.music?.trackId) || null; }
function effectiveMusicVolume() { return state.activeRoutine?.music?.volume ?? 0.5; }
function stopMusic() { els.music.pause(); els.music.removeAttribute("src"); delete els.music.dataset.trackId; }
function startMusic() {
  const track = currentMusicTrack();
  if (!state.musicEnabled || !track) return;
  if (els.music.dataset.trackId !== track.id) {
    els.music.src = track.audio;
    els.music.dataset.trackId = track.id;
  }
  els.music.loop = true;
  els.music.volume = effectiveMusicVolume();
  els.music.play().catch(() => {});
}
function startMusicPreview() {
  const current = routine();
  const track = state.musicTracks.find((item) => item.id === current?.music?.trackId);
  if (!track) return;
  els.music.src = track.audio;
  els.music.dataset.trackId = track.id;
  els.music.loop = true;
  els.music.volume = current.music.volume ?? 0.5;
  els.music.play().catch(() => {});
}
function playAudioSequence(urls) {
  if (!state.audioEnabled || !urls.length) return Promise.resolve(true);
  const token = ++state.audioToken;
  return new Promise((resolve) => { let done = false; const finish = (result) => { if (done) return; done = true; state.audioSequenceResolve = null; els.audio.onended = null; els.audio.onerror = null; resolve(result); }; state.audioSequenceResolve = finish; const next = (index) => { if (token !== state.audioToken || index >= urls.length) return finish(token === state.audioToken); els.audio.src = urls[index]; els.audio.volume = 1; els.audio.currentTime = 0; els.audio.onended = () => next(index + 1); els.audio.onerror = () => next(index + 1); els.audio.play().catch(() => finish(false)); }; next(0); });
}
function playCue() { const activePeriod = currentPeriod(); const cue = activePeriod?.command_audio?.[String(state.beatIndex === 0 ? state.eightCountIndex + 1 : state.beatIndex + 1)]; if (!state.audioEnabled || !cue) return; state.audioToken += 1; els.audio.pause(); els.audio.src = cue; els.audio.volume = 1; els.audio.currentTime = 0; els.audio.play().catch(() => {}); }
function beatDuration() { const item = currentRoutineItem(); return ((currentPeriod()?.duration_seconds || 10) * 1000 / 8) / (item?.speed || 1); }
function scheduleBeat() { clearTimeout(state.timer); if (state.playing) state.timer = setTimeout(advancePlayback, beatDuration()); }

async function announceSection() {
  const activePeriod = currentPeriod(); if (!state.playing || !activePeriod) return;
  const sectionAudio = `/media/vocals/segments/${state.sectionIndex + 1}.mp3`;
  const includeSectionNumber = state.playerReturnView !== "editor";
  const urls = [includeSectionNumber ? sectionAudio : null, activePeriod.name_audio].filter(Boolean); await playAudioSequence(urls);
  if (!state.playing) return; playCue(); renderPlayer(); scheduleBeat();
}

function advancePlayback() {
  if (state.beatIndex < 7) { state.beatIndex += 1; state.frameIndex = Math.min(Math.floor(state.beatIndex / 2), currentPeriod().frames.length - 1); playCue(); renderPlayer(); scheduleBeat(); return; }
  if (state.eightCountIndex < currentRoutineItem().eightCounts - 1) { state.eightCountIndex += 1; state.beatIndex = 0; state.frameIndex = 0; playCue(); renderPlayer(); scheduleBeat(); return; }
  const current = currentRoutineItem();
  if (state.sectionRepeat < current.repeat - 1) { state.sectionRepeat += 1; state.eightCountIndex = 0; state.beatIndex = 0; state.frameIndex = 0; playCue(); renderPlayer(); scheduleBeat(); return; }
  if (state.sectionIndex < routineItems(state.activeRoutine).length - 1) { state.sectionIndex += 1; state.sectionRepeat = 0; state.eightCountIndex = 0; state.beatIndex = 0; state.frameIndex = 0; renderPlayer(); void announceSection(); return; }
  state.completedRoutineLoops += 1; state.playing = false; clearTimeout(state.timer); stopAudio(); stopMusic(); renderPlayer(); state.completionTimer = setTimeout(exitPlayer, 450);
}

function startPlayer(idOrRoutine, returnView = "home") { const selected = typeof idOrRoutine === "string" ? routine(idOrRoutine) : idOrRoutine; if (!selected || !selected.items.length) return; stopPlayback(); state.activeRoutine = selected; state.playerReturnView = returnView; state.sectionIndex = 0; state.sectionRepeat = 0; state.eightCountIndex = 0; state.beatIndex = 0; state.frameIndex = 0; state.completedRoutineLoops = 0; state.playing = true; showView("player"); renderPlayer(); startMusic(); const fullscreen = els.player.requestFullscreen?.(); if (fullscreen) fullscreen.catch(() => {}); void announceSection(); }
function togglePlayer() {
  if (state.playing) {
    state.playing = false;
    clearTimeout(state.timer);
    stopAudio();
    els.music.pause();
    renderPlayer();
    return;
  }
  state.playing = true;
  if (state.musicEnabled && currentMusicTrack()) els.music.play().catch(() => {});
  renderPlayer();
  playCue();
  scheduleBeat();
}
function stopPlayback() { state.playing = false; clearTimeout(state.timer); clearTimeout(state.completionTimer); state.timer = null; state.completionTimer = null; stopAudio(); stopMusic(); }
function exitPlayer() { stopPlayback(); const destination = state.playerReturnView; showView(destination); if (destination === "editor") { renderEditor(); renderBrowser(); } else { renderHome(); } if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }

async function init() {
  loadState();
  try {
    const [periodResponse, musicResponse] = await Promise.all([fetch("/api/periods"), fetch("/api/music")]);
    state.periods = (await periodResponse.json()).periods || [];
    state.musicTracks = (await musicResponse.json()).tracks || [];
  } catch { state.periods = []; state.musicTracks = []; }
  const valid = new Set(state.periods.map((item) => item.id));
  const validTracks = new Set(state.musicTracks.map((track) => track.id));
  state.routines.forEach((itemRoutine) => {
    if (!ROUTINE_TYPES.includes(itemRoutine.type)) itemRoutine.type = "普通体操";
    if (!itemRoutine.music || typeof itemRoutine.music !== "object") itemRoutine.music = { trackId: "", volume: 0.5, loop: true };
    if (!validTracks.has(itemRoutine.music.trackId)) itemRoutine.music.trackId = "";
    if (typeof itemRoutine.music.volume !== "number") itemRoutine.music.volume = 0.5;
    itemRoutine.items = itemRoutine.items.filter((item) => valid.has(item.periodId)).slice(0, MAX_ROUTINE_ITEMS);
    itemRoutine.items = itemRoutine.items.filter((item) => period(item.periodId)?.type === itemRoutine.type);
    itemRoutine.items.forEach((item) => {
      const itemPeriod = period(item.periodId);
      const allowed = itemPeriod?.allowed_eight_counts || [2, 4, 8];
      if (!allowed.includes(item.eightCounts)) item.eightCounts = itemPeriod?.default_eight_counts || 8;
    });
  });
  saveState();
  renderHome(); showView("home");
}

$("#brand-home").addEventListener("click", (event) => { event.preventDefault(); stopPlayback(); showView("home"); renderHome(); });
["#ai-routine-main"].forEach((selector) => $(selector).addEventListener("click", openAiWizard));
["#ai-wizard-close"].forEach((selector) => $(selector).addEventListener("click", closeAiWizard));
els.aiInput.addEventListener("input", () => { const step = AI_STEPS[state.ai.step]; els.aiNext.disabled = step.required && !els.aiInput.value.trim(); });
els.aiInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); if (!els.aiNext.disabled) els.aiNext.click(); } });
els.aiNext.addEventListener("click", () => { readAiStep(); if (state.ai.step === AI_STEPS.length - 1) startAiGeneration(); else { state.ai.step += 1; renderAiStep(); } });
els.aiSkip.addEventListener("click", () => { readAiStep(); state.ai.step += 1; renderAiStep(); });
$("#ai-cancel").addEventListener("click", () => { cancelAiGeneration(); els.aiDialog.close(); });
$("#ai-result-edit").addEventListener("click", () => { const created = addGeneratedRoutine(state.ai.result); els.aiDialog.close(); openEditor(created.id); });
$("#ai-result-play").addEventListener("click", () => { const created = addGeneratedRoutine(state.ai.result); els.aiDialog.close(); renderHome(); startPlayer(created.id); });
$("#ai-result-retry").addEventListener("click", openAiWizard); $("#ai-error-retry").addEventListener("click", openAiWizard); $("#ai-error-close").addEventListener("click", () => els.aiDialog.close());
["#new-routine-main", "#new-routine-empty"].forEach((selector) => $(selector).addEventListener("click", newRoutine));
document.querySelectorAll("[data-new-routine-type]").forEach((button) => button.addEventListener("click", () => createRoutine(button.dataset.newRoutineType)));
$("#cancel-new-routine").addEventListener("click", () => els.routineTypeDialog.close());
$("#back-home").addEventListener("click", () => { showView("home"); renderHome(); }); $("#cancel-edit").addEventListener("click", () => { showView("home"); renderHome(); }); $("#save-routine").addEventListener("click", saveEditor);
els.routineMusic.addEventListener("change", () => { stopMusic(); const current = routine(); current.music.trackId = els.routineMusic.value; saveState(); renderMusicSettings(current); });
els.routineMusicVolume.addEventListener("input", () => { const current = routine(); current.music.volume = Number(els.routineMusicVolume.value); els.routineMusicVolumeOutput.textContent = `${Math.round(current.music.volume * 100)}%`; if (state.activeRoutine?.id === current.id) els.music.volume = effectiveMusicVolume(); saveState(); });
els.musicPreview.addEventListener("pointerdown", (event) => { if (els.musicPreview.disabled) return; event.preventDefault(); els.musicPreview.setPointerCapture?.(event.pointerId); els.musicPreview.classList.add("holding"); els.musicPreview.textContent = "试听中"; startMusicPreview(); });
els.musicPreview.addEventListener("pointerup", () => { els.musicPreview.classList.remove("holding"); els.musicPreview.textContent = "按住试听"; stopMusic(); });
els.musicPreview.addEventListener("pointercancel", () => { els.musicPreview.classList.remove("holding"); els.musicPreview.textContent = "按住试听"; stopMusic(); });
els.musicPreview.addEventListener("pointerleave", () => { if (els.musicPreview.classList.contains("holding")) { els.musicPreview.classList.remove("holding"); els.musicPreview.textContent = "按住试听"; stopMusic(); } });
$("#exit-player").addEventListener("click", exitPlayer); $("#player-toggle").addEventListener("click", togglePlayer);
$("#player-audio").addEventListener("click", () => { state.audioEnabled = !state.audioEnabled; if (!state.audioEnabled) stopAudio(); saveState(); renderPlayer(); });
$("#player-music").addEventListener("click", () => { if (!currentMusicTrack()) return; state.musicEnabled = !state.musicEnabled; if (state.musicEnabled && state.playing) startMusic(); else els.music.pause(); saveState(); renderPlayer(); });
$("#player-prev").addEventListener("click", () => { stopPlayback(); state.frameIndex = (state.frameIndex + currentPeriod().frames.length - 1) % currentPeriod().frames.length; state.beatIndex = state.frameIndex * 2; renderPlayer(); }); $("#player-next").addEventListener("click", () => { stopPlayback(); state.frameIndex = (state.frameIndex + 1) % currentPeriod().frames.length; state.beatIndex = state.frameIndex * 2; renderPlayer(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !els.player.hidden) exitPlayer(); if (event.code === "Space" && !els.player.hidden && event.target.tagName !== "INPUT") { event.preventDefault(); togglePlayer(); } });
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && !els.player.hidden) exitPlayer(); });
window.addEventListener("beforeunload", () => { if (state.ai.taskId) navigator.sendBeacon(`/api/ai/routines/generate/${state.ai.taskId}`, new Blob([], { type: "application/json" })); });
init();
