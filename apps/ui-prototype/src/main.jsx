import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

const screens = [
  ["overview", "总览工作台", "⌘"],
  ["generate", "对话作图", "✦"],
  ["assist", "AI 辅助作图", "◧"],
  ["edit", "智能改图", "▣"],
  ["lora", "LoRA 炼制", "◈"],
  ["models", "模型管家", "▤"],
  ["queue", "任务队列", "≋"],
  ["settings", "Provider 设置", "⚙"],
];

const starterImages = [
  assetUrl("art-01.png"),
  assetUrl("art-02.png"),
  assetUrl("art-03.png"),
  assetUrl("art-04.png"),
];

const defaultPlan = {
  task_type: "txt2img",
  positive_prompt: "",
  negative_prompt: "bad hands, extra fingers, low quality, blurry, watermark, text, logo, deformed face",
  checkpoint: "",
  lora: [],
  controlnet: [],
  width: 512,
  height: 512,
  target_width: null,
  target_height: null,
  sampler: "Euler a",
  steps: 8,
  cfg_scale: 5,
  seed: -1,
  batch_size: 1,
  hires_fix: false,
  adetailer: false,
  rationale: "",
};

const fallbackSamplers = [
  "Euler a",
  "Euler",
  "LMS",
  "Heun",
  "DPM++ 2M Karras",
  "DPM++ SDE Karras",
  "DPM++ 2M SDE Karras",
  "DPM fast",
  "DDIM",
];

function App() {
  const [screen, setScreenState] = useState(currentScreen());
  const [health, setHealth] = useState(null);
  const [engineModels, setEngineModels] = useState(null);
  const [connectionError, setConnectionError] = useState("");
  const [topGenerateRequest, setTopGenerateRequest] = useState(0);

  useEffect(() => {
    refreshStatus();
    const timer = window.setInterval(refreshStatus, 10000);
    return () => window.clearInterval(timer);
  }, []);

  function setScreen(nextScreen) {
    const valid = screens.some(([key]) => key === nextScreen) ? nextScreen : "overview";
    setScreenState(valid);
    const url = new URL(window.location.href);
    url.searchParams.set("screen", valid);
    window.history.replaceState({}, "", url);
  }

  async function refreshStatus() {
    try {
      const [nextHealth, nextModels] = await Promise.all([
        apiGet("/health"),
        apiGet("/api/engines/models"),
      ]);
      setHealth(nextHealth);
      setEngineModels(nextModels);
      setConnectionError("");
    } catch (error) {
      setConnectionError(error.message);
      setHealth(null);
      setEngineModels(null);
    }
  }

  const a1111 = engineModels?.engines?.a1111;
  const checkpoints = a1111?.models?.checkpoints || [];
  const loras = a1111?.models?.loras || [];
  const samplers = a1111?.models?.samplers || [];
  const webuiOnline = Boolean(a1111?.running || health?.engines?.a1111?.running);
  const providerName = health?.provider || "unknown";
  const title = screens.find(([key]) => key === screen)?.[1] || "总览工作台";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">SA</div>
          <div>
            <div className="brand-name">SD Agent Studio</div>
            <div className="brand-subtitle">Local creative agent</div>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary">
          {screens.map(([key, label, icon]) => (
            <button key={key} className={`nav-item ${screen === key ? "active" : ""}`} onClick={() => setScreen(key)}>
              <span className="nav-icon">{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="side-status">
          <div className="status-card">
            <StatusRow label="WebUI" value={webuiOnline ? "Connected" : "Offline"} tone={webuiOnline ? "ok" : "bad"} />
            <StatusRow label="Provider" value={providerName} tone={providerName === "unknown" ? "" : "ok"} />
            <StatusRow label="Checkpoint" value={checkpoints[0]?.name || checkpoints[0]?.title || "none"} />
            <div className="meter"><span style={{ width: webuiOnline ? "72%" : "8%" }} /></div>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="screen-kicker">Project / Akiba Character Pack</div>
            <h1>{title}</h1>
          </div>
          <div className="top-actions">
            <span className={`connection-pill ${webuiOnline ? "" : "warn"}`}>
              Local SD: {health?.webuiBaseUrl || "127.0.0.1:7860"}
            </span>
            <span className={`connection-pill ${connectionError ? "warn" : ""}`}>
              {connectionError ? "backend offline" : `${checkpoints.length} checkpoint`}
            </span>
            <button
              className="primary-action"
              onClick={() => {
                if (screen === "generate" || screen === "assist") {
                  setTopGenerateRequest((count) => count + 1);
                } else {
                  setScreen("generate");
                }
              }}
            >
              {screen === "generate" ? "解析/生成" : screen === "assist" ? "解析/生成" : "对话作图"}
            </button>
          </div>
        </header>

        {screen === "overview" && <Overview setScreen={setScreen} webuiOnline={webuiOnline} checkpoints={checkpoints} />}
        {screen === "generate" && (
          <ChatGenerateScreen
            webuiOnline={webuiOnline}
            backendOnline={!connectionError}
            checkpoints={checkpoints}
            loras={loras}
            samplers={samplers}
            refreshStatus={refreshStatus}
            topGenerateRequest={topGenerateRequest}
          />
        )}
        {screen === "assist" && (
          <AssistGenerateScreen
            webuiOnline={webuiOnline}
            backendOnline={!connectionError}
            checkpoints={checkpoints}
            loras={loras}
            samplers={samplers}
            refreshStatus={refreshStatus}
            topGenerateRequest={topGenerateRequest}
          />
        )}
        {screen === "models" && <ModelsScreen checkpoints={checkpoints} webuiOnline={webuiOnline} refreshStatus={refreshStatus} />}
        {screen === "queue" && <QueueScreen />}
        {screen === "settings" && <SettingsScreen providerName={providerName} backendOnline={!connectionError} providerStatus={health?.providerStatus} />}
        {screen === "edit" && <StaticScreen title="智能改图" text="下一阶段接入 img2img、inpaint 和 ControlNet。当前先聚焦自然语言 txt2img 闭环。" />}
        {screen === "lora" && <StaticScreen title="LoRA 炼制" text="向导式数据导入、质检、标签清洗和训练配置会在生图闭环稳定后继续接入。" />}
      </main>
    </div>
  );
}

function ChatGenerateScreen({ webuiOnline, backendOnline, checkpoints, loras, samplers, refreshStatus, topGenerateRequest }) {
  const [conversation, setConversation] = useState([
    { role: "agent", text: "告诉我你想要的画面、用途和风格，我会先解析出可编辑参数；确认后再提交到 A1111。" },
  ]);
  const [requestText, setRequestText] = useState("画一个银发少女，穿黑色礼服，坐在雨夜咖啡馆窗边，精致插画，适合手机壁纸。");
  const [plan, setPlan] = useState(() => ({ ...defaultPlan, checkpoint: checkpointTitle(checkpoints[0]) }));
  const [pendingPlan, setPendingPlan] = useState(null);
  const [results, setResults] = useState([]);
  const [planning, setPlanning] = useState(false);
  const [activeTask, setActiveTask] = useState(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [selectedReference, setSelectedReference] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!plan.checkpoint && checkpoints[0]) {
      setPlan((current) => ({ ...current, checkpoint: checkpointTitle(checkpoints[0]) }));
    }
  }, [checkpoints, plan.checkpoint]);

  useEffect(() => {
    loadGenerations();
    restoreActiveTask();
  }, []);

  useEffect(() => {
    if (!activeTask || !isTaskActive(activeTask)) return undefined;
    const timer = window.setInterval(() => {
      void pollTask(activeTask.id);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeTask?.id, activeTask?.status]);

  useEffect(() => {
    if (topGenerateRequest > 0) {
      void submitConversation();
    }
  }, [topGenerateRequest]);

  const generating = Boolean(activeTask && isTaskActive(activeTask));
  const activePlan = pendingPlan || plan;
  const canSubmit = backendOnline && webuiOnline && Boolean(activePlan.checkpoint) && !generating && !planning && Boolean(requestText.trim());
  const canConfirmPlan = backendOnline && webuiOnline && Boolean(pendingPlan?.checkpoint) && Boolean(pendingPlan?.positive_prompt) && !generating && !planning;
  const disabledReason = !backendOnline
    ? "后端未连接"
    : !webuiOnline
      ? "A1111 未连接"
      : !activePlan.checkpoint
        ? "没有可用 checkpoint"
        : "";

  async function loadGenerations() {
    try {
      setLoadingHistory(true);
      const response = await apiGet("/api/generations?limit=24");
      setResults((response.generations || []).flatMap(generationToGalleryItems));
    } catch (error) {
      setError(error.message);
    } finally {
      setLoadingHistory(false);
    }
  }

  async function restoreActiveTask() {
    try {
      const task = await loadCurrentGenerationTask();
      if (!task) return;
      setActiveTask(task);
      setPendingPlan(null);
      setPlan(normalizePlanForUi(task.plan || {}, checkpoints));
      setConversation((items) => [...items, { role: "agent", text: `已接回正在处理的任务：${task.id.slice(0, 8)}。` }]);
    } catch (error) {
      setError(error.message);
    }
  }

  async function submitConversation() {
    if (!requestText.trim() || planning || generating) return;
    if (disabledReason) {
      setError(disabledReason);
      return;
    }

    const userMessage = requestText.trim();
    const recentContext = conversation.slice(-6).map((item) => `${item.role}: ${item.text}`).join("\n");
    setPlanning(true);
    setError("");
    setConversation((items) => [...items, { role: "user", text: userMessage }]);

    try {
      const sourcePlan = pendingPlan || plan;
      const endpoint = sourcePlan.positive_prompt ? "/api/generate/revise" : "/api/generate/plan";
      const response = await apiPost(endpoint, endpoint.endsWith("revise")
        ? { userRequest: withReferenceContext(userMessage, selectedReference), conversation: conversation.slice(-6), plan: sourcePlan }
        : { userRequest: `${recentContext}\nuser: ${userMessage}` });
      const nextPlan = normalizePlanForUi(response.plan, checkpoints);
      setPlan(nextPlan);
      setPendingPlan(nextPlan);
      setConversation((items) => [...items, { role: "agent", text: "已解析方案，请确认参数后再生成；也可以继续描述修改。" }]);
      setRequestText("");
      await refreshStatus();
    } catch (error) {
      setError(error.message);
      setConversation((items) => [...items, { role: "agent", text: `处理失败：${error.message}` }]);
    } finally {
      setPlanning(false);
    }
  }

  async function pollTask(taskId) {
    try {
      const response = await apiGet(`/api/tasks/${taskId}`);
      const task = response.task;
      setActiveTask(task);
      if (task.status === "succeeded") {
        const images = extractImages(task.result || {}, task.plan || plan);
        setActiveTask(null);
        setConversation((items) => [...items, { role: "agent", text: `完成，已生成 ${images.length || 0} 张图片。你可以继续描述修改。` }]);
        await loadGenerations();
        await refreshStatus();
      }
      if (task.status === "failed") {
        setActiveTask(null);
        setError(task.error || "生成失败");
        setConversation((items) => [...items, { role: "agent", text: `生成失败：${task.error || "未知错误"}` }]);
      }
      if (task.status === "cancelled") {
        setActiveTask(null);
        setConversation((items) => [...items, { role: "agent", text: "任务已取消。" }]);
      }
    } catch (error) {
      setError(error.message);
    }
  }

  async function cancelActiveTask() {
    if (!activeTask) return;
    try {
      const response = await apiPost(`/api/tasks/${activeTask.id}/cancel`, {});
      setActiveTask(response.task);
    } catch (error) {
      setError(error.message);
    }
  }

  async function confirmPendingPlan() {
    if (!pendingPlan || !canConfirmPlan) {
      setError(disabledReason || "当前方案还不能生成，请确认 prompt、模型和参数。");
      return;
    }

    setError("");
    try {
      const taskResponse = await apiPost("/api/tasks/generate", {
        backend: "a1111",
        plan: normalizePlanForRun(pendingPlan),
      });
      setPlan(pendingPlan);
      setPendingPlan(null);
      setActiveTask(taskResponse.task);
      setConversation((items) => [...items, { role: "agent", text: `已提交生成任务：${taskResponse.taskId}` }]);
      await refreshStatus();
    } catch (error) {
      setError(error.message);
      setConversation((items) => [...items, { role: "agent", text: `提交失败：${error.message}` }]);
    }
  }

  async function reuseGeneration(item) {
    const nextPlan = normalizePlanForUi({ ...(item.plan || {}), seed: -1 }, checkpoints);
    const reference = generationReference(item, nextPlan);
    setPlan(nextPlan);
    setPendingPlan(nextPlan);
    setSelectedReference(reference);
    setConversation((items) => [...items, {
      role: "agent",
      text: reference.generationId
        ? `已引用历史图 ${reference.generationId.slice(0, 8)}，并复用它的生成参数；你可以描述下一轮想调整的方向。`
        : "已复用这张图的生成参数；图片还在写入历史库，下一轮会基于这些参数继续调整。",
    }]);
  }

  return (
    <section className="screen active chat-create-screen">
      <div className="chat-create-layout">
        <section className={`panel chat-create-main ${pendingPlan ? "confirming" : ""}`}>
          <div className="chat-hero">
            <div>
              <div className="section-label">Conversation</div>
              <h2>直接说你要的图</h2>
              <p>我会先给出可编辑方案，确认后再提交到 A1111。</p>
            </div>
            <span className={disabledReason ? "connection-pill warn" : "connection-pill ok-pill"}>{disabledReason || "Ready"}</span>
          </div>

          <div className="chat-result-stage">
            {pendingPlan && !generating ? (
              <ChatPlanConfirm
                plan={pendingPlan}
                setPlan={setPendingPlan}
                checkpoints={checkpoints}
                loras={loras}
                samplers={samplers}
                disabledReason={disabledReason}
                canConfirm={canConfirmPlan}
                onConfirm={confirmPendingPlan}
                onDiscard={() => setPendingPlan(null)}
              />
            ) : generating ? (
              <GenerationLoading task={activeTask} plan={plan} />
            ) : results[0] ? (
              <div className="featured-result">
                <img src={results[0].url} alt={results[0].filename || "latest generated result"} />
                <div className="featured-actions">
                  <a href={results[0].url} target="_blank" rel="noreferrer">打开大图</a>
                  <button onClick={() => reuseGeneration(results[0])}>基于这张继续</button>
                </div>
              </div>
            ) : (
              <div className="conversation-empty">
                <strong>还没有生成结果</strong>
                <span>输入一句中文需求后，我会先给出可确认参数。</span>
              </div>
            )}
          </div>

          <div className="conversation chat-only-log">
            {conversation.slice(-8).map((item, index) => (
              <div key={`${item.role}-${index}`} className={`bubble ${item.role === "agent" ? "agent" : "user"} ${index > 1 ? "subtle" : ""}`}>
                {item.text}
              </div>
            ))}
          </div>

          <div className="chat-composer">
            <textarea
              value={requestText}
              onChange={(event) => setRequestText(event.target.value)}
              placeholder="描述你想生成的图片，比如角色、场景、用途、风格。"
            />
            <button className="primary-action" onClick={submitConversation} disabled={!canSubmit}>
              {planning ? <BusyLabel text="理解中" /> : generating ? <BusyLabel text="生成中" /> : pendingPlan ? "修改方案" : "解析方案"}
            </button>
            {generating && <button className="secondary-action" onClick={cancelActiveTask}>取消</button>}
          </div>
          {error && <div className="inline-error">{error}</div>}
        </section>

        <aside className="panel chat-history-rail">
          <PanelHeader
            title="结果"
            text="只展示图片，不暴露参数。"
            button={<button className="small-button" onClick={loadGenerations}>{loadingHistory ? "加载中" : "刷新"}</button>}
          />
          {results.length ? (
            <div className="chat-result-grid">
              {results.slice(0, 12).map((image) => (
                <button key={`${image.generationId || "image"}-${image.url}`} className="chat-thumb" onClick={() => reuseGeneration(image)}>
                  <img src={image.url} alt={image.filename || "generated result"} />
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-gallery compact-empty">
              <strong>暂无图片</strong>
              <span>生成后会自动保存到历史。</span>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function AssistGenerateScreen({ webuiOnline, backendOnline, checkpoints, loras, samplers, refreshStatus, topGenerateRequest }) {
  const [conversation, setConversation] = useState([]);
  const [requestText, setRequestText] = useState("");
  const [plan, setPlan] = useState(() => ({ ...defaultPlan, checkpoint: checkpointTitle(checkpoints[0]) }));
  const [results, setResults] = useState([]);
  const [planning, setPlanning] = useState(false);
  const [activeTask, setActiveTask] = useState(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!plan.checkpoint && checkpoints[0]) {
      setPlan((current) => ({ ...current, checkpoint: checkpointTitle(checkpoints[0]) }));
    }
  }, [checkpoints, plan.checkpoint]);

  useEffect(() => {
    loadGenerations();
    restoreActiveTask();
  }, []);

  useEffect(() => {
    if (!activeTask || !isTaskActive(activeTask)) return undefined;
    const timer = window.setInterval(() => {
      void pollTask(activeTask.id);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeTask?.id, activeTask?.status]);

  const hasPrompt = Boolean(String(plan.positive_prompt || "").trim());
  const generating = Boolean(activeTask && isTaskActive(activeTask));
  const canGenerate = backendOnline && webuiOnline && Boolean(plan.checkpoint) && hasPrompt && !generating && !planning;
  const disabledReason = !backendOnline
    ? "后端未连接"
    : !webuiOnline
      ? "A1111 未连接"
      : !plan.checkpoint
        ? "没有可用 checkpoint"
        : !hasPrompt
          ? "先解析方案"
          : "";

  useEffect(() => {
    if (topGenerateRequest > 0) {
      void handleTopGenerateRequest();
    }
  }, [topGenerateRequest]);

  async function loadGenerations() {
    try {
      setLoadingHistory(true);
      const response = await apiGet("/api/generations?limit=40");
      setResults((response.generations || []).flatMap(generationToGalleryItems));
    } catch (error) {
      setError(error.message);
    } finally {
      setLoadingHistory(false);
    }
  }

  async function restoreActiveTask() {
    try {
      const task = await loadCurrentGenerationTask();
      if (!task) return;
      setActiveTask(task);
      setPlan(normalizePlanForUi(task.plan || {}, checkpoints));
      setConversation((items) => [...items, { role: "agent", text: `已接回正在处理的任务：${task.id.slice(0, 8)}。` }]);
    } catch (error) {
      setError(error.message);
    }
  }

  async function createPlan() {
    if (!requestText.trim() || planning) return;
    setPlanning(true);
    setError("");
    const userMessage = requestText.trim();
    const recentContext = conversation.slice(-4).map((item) => `${item.role}: ${item.text}`).join("\n");
    setConversation((items) => [...items, { role: "user", text: userMessage }]);

    try {
      const endpoint = plan.positive_prompt ? "/api/generate/revise" : "/api/generate/plan";
      const response = await apiPost(endpoint, endpoint.endsWith("revise")
        ? { userRequest: userMessage, conversation: conversation.slice(-6), plan }
        : { userRequest: `${recentContext}\nuser: ${userMessage}` });
      const nextPlan = normalizePlanForUi(response.plan, checkpoints);
      setPlan(nextPlan);
      setConversation((items) => [
        ...items,
        { role: "agent", text: nextPlan.rationale || "方案已生成，你可以继续编辑 prompt 和参数后执行生成。" },
      ]);
      setRequestText("");
      await refreshStatus();
    } catch (error) {
      setError(error.message);
      setConversation((items) => [...items, { role: "agent", text: `解析失败：${error.message}` }]);
    } finally {
      setPlanning(false);
    }
  }

  async function handleTopGenerateRequest() {
    if (requestText.trim()) {
      await createPlan();
      return;
    }
    await runGeneration();
  }

  async function runGeneration() {
    if (!String(plan.positive_prompt || "").trim()) {
      setError("请先点击“解析方案”，生成可编辑 prompt 后再执行生图。");
      return;
    }
    if (!canGenerate) {
      setError(disabledReason || "当前方案还不能生成，请确认模型和参数。");
      return;
    }
    setError("");

    try {
      const response = await apiPost("/api/tasks/generate", {
        backend: "a1111",
        plan: normalizePlanForRun(plan),
      });
      setActiveTask(response.task);
      setConversation((items) => [...items, { role: "agent", text: `任务已创建：${response.taskId}，正在等待 A1111 返回进度。` }]);
      await refreshStatus();
    } catch (error) {
      setError(error.message);
      setConversation((items) => [...items, { role: "agent", text: `生成失败：${error.message}` }]);
    }
  }

  async function pollTask(taskId) {
    try {
      const response = await apiGet(`/api/tasks/${taskId}`);
      const task = response.task;
      setActiveTask(task);
      if (task.status === "succeeded") {
        const images = extractImages(task.result || {}, task.plan || plan);
        setActiveTask(null);
        setConversation((items) => [...items, { role: "agent", text: `生成完成：返回 ${images.length || 0} 张图片，已写入历史库。` }]);
        await loadGenerations();
        await refreshStatus();
      }
      if (task.status === "failed") {
        setActiveTask(null);
        setError(task.error || "生成失败");
        setConversation((items) => [...items, { role: "agent", text: `生成失败：${task.error || "未知错误"}` }]);
      }
      if (task.status === "cancelled") {
        setActiveTask(null);
        setConversation((items) => [...items, { role: "agent", text: "任务已取消。" }]);
      }
    } catch (error) {
      setError(error.message);
    }
  }

  async function cancelActiveTask() {
    if (!activeTask) return;
    try {
      const response = await apiPost(`/api/tasks/${activeTask.id}/cancel`, {});
      setActiveTask(response.task);
    } catch (error) {
      setError(error.message);
    }
  }

  async function reuseGeneration(item, { fixedSeed = false } = {}) {
    const nextPlan = normalizePlanForUi({
      ...(item.plan || {}),
      seed: fixedSeed ? item.plan?.seed ?? -1 : -1,
    }, checkpoints);
    setPlan(nextPlan);
    setConversation((items) => [...items, { role: "agent", text: fixedSeed ? "已复用历史参数并固定 seed。" : "已复用历史参数，seed 已重置为随机。" }]);
  }

  async function deleteGenerationItem(item) {
    if (!item.generationId) return;
    try {
      await apiDelete(`/api/generations/${item.generationId}`);
      await loadGenerations();
    } catch (error) {
      setError(error.message);
    }
  }

  return (
    <section className="screen active generate-screen assist-pro-screen">
      <div className="assist-pro-workbench">
        <section className="assist-command-surface">
          <div className="assist-command-bar">
            <div className="assist-brief">
              <div className="section-label">AI Assist</div>
              <textarea
                value={requestText}
                onChange={(event) => setRequestText(event.target.value)}
                placeholder="例如：银发少女，黑色礼服，坐在雨夜咖啡馆窗边，精致插画，手机壁纸。"
              />
            </div>
            <div className="assist-command-actions">
              <button className="primary-action" onClick={createPlan} disabled={planning || !requestText.trim()}>
                {planning ? <BusyLabel text="解析中" /> : "解析到方案"}
              </button>
              <button className="small-button" onClick={() => setRequestText("")} disabled={!requestText.trim() || planning}>清空</button>
              <span className={disabledReason ? "warn-text" : "ok"}>{disabledReason || "Ready"}</span>
            </div>
          </div>

          <div className="assist-preset-row" aria-label="quick prompts">
            <button onClick={() => setRequestText("保持主体，改成手机壁纸竖屏构图，氛围更强。")}>竖屏壁纸</button>
            <button onClick={() => setRequestText("改成头像近景，脸部清晰，背景简洁。")}>头像近景</button>
            <button onClick={() => setRequestText("保留设定，出 4 张不同构图方案。")}>4 张变体</button>
          </div>

          <div className="assist-editor-grid">
            <div className="assist-prompt-editor">
              <div className="assist-section-head">
                <h2>Prompt</h2>
                <span>{backendOnline ? "Live API" : "Offline"}</span>
              </div>
              <label>Positive</label>
              <textarea className="code-area pro-positive" value={plan.positive_prompt} onChange={(event) => setPlanValue(setPlan, "positive_prompt", event.target.value)} />
              <label>Negative</label>
              <textarea className="code-area pro-negative" value={plan.negative_prompt} onChange={(event) => setPlanValue(setPlan, "negative_prompt", event.target.value)} />
            </div>

            <div className="assist-param-editor">
              <div className="assist-section-head">
                <h2>Controls</h2>
                <span>{sizeSummary(plan)}</span>
              </div>
              <label className="span-field">Checkpoint<select value={plan.checkpoint} onChange={(event) => setPlanValue(setPlan, "checkpoint", event.target.value)}>
                <option value="">选择 checkpoint</option>
                {checkpoints.map((checkpoint) => (
                  <option key={checkpointTitle(checkpoint)} value={checkpointTitle(checkpoint)}>{checkpointTitle(checkpoint)}</option>
                ))}
              </select></label>
              <div className="assist-param-grid">
                <label>W<input type="number" value={plan.width} onChange={(event) => setNumberPlanValue(setPlan, "width", event.target.value)} /></label>
                <label>H<input type="number" value={plan.height} onChange={(event) => setNumberPlanValue(setPlan, "height", event.target.value)} /></label>
                <label>目标W<input type="number" value={plan.target_width || ""} onChange={(event) => setTargetPlanValue(setPlan, "target_width", event.target.value)} placeholder="同生成" /></label>
                <label>目标H<input type="number" value={plan.target_height || ""} onChange={(event) => setTargetPlanValue(setPlan, "target_height", event.target.value)} placeholder="同生成" /></label>
                <label>Steps<input type="number" value={plan.steps} onChange={(event) => setNumberPlanValue(setPlan, "steps", event.target.value)} /></label>
                <label>CFG<input type="number" step="0.5" value={plan.cfg_scale} onChange={(event) => setNumberPlanValue(setPlan, "cfg_scale", event.target.value)} /></label>
                <label>Batch<input type="number" value={plan.batch_size} onChange={(event) => setNumberPlanValue(setPlan, "batch_size", event.target.value)} /></label>
                <label>Seed<input type="number" value={plan.seed} onChange={(event) => setNumberPlanValue(setPlan, "seed", event.target.value)} /></label>
                <SamplerSelect value={plan.sampler} samplers={samplers} onChange={(value) => setPlanValue(setPlan, "sampler", value)} />
              </div>
              <LoraEditor plan={plan} setPlan={setPlan} loras={loras} />
              <div className="toggle-row-inline pro-toggles">
                <ToggleRow label="高清修复" checked={isHiresEnabled(plan)} onChange={(checked) => setHiresEnabled(setPlan, checked)} />
                <ToggleRow label="ADetailer" checked={Boolean(plan.adetailer)} onChange={(checked) => setPlanValue(setPlan, "adetailer", checked)} />
              </div>
              {isHiresEnabled(plan) && (
                <div className="hires-settings">
                  <label>Denoise<input type="number" step="0.05" value={plan.hires_fix?.denoising_strength ?? 0.35} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { denoising_strength: Number(event.target.value) }))} /></label>
                  <label>Upscaler<input value={plan.hires_fix?.upscaler || "Latent"} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { upscaler: event.target.value }))} /></label>
                  <label>二次步数<input type="number" value={plan.hires_fix?.second_pass_steps ?? Math.max(8, Math.round(plan.steps * 0.5))} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { second_pass_steps: Number(event.target.value) }))} /></label>
                </div>
              )}
              <div className="rationale-box pro-rationale">
                <span>AI 解析</span>
                <strong>{plan.rationale || "等待解析方案"}</strong>
              </div>
            </div>
          </div>

          {conversation.length > 0 && (
            <div className="assist-console-log">
              {conversation.slice(-4).map((item, index) => (
                <div key={`${item.role}-${index}`} className={`assist-log-entry ${item.role === "agent" ? "agent" : "user"} ${index > 0 ? "subtle" : ""}`}>
                  <span>{item.role === "agent" ? "AI" : "用户"}</span>
                  <p>{item.text}</p>
                </div>
              ))}
            </div>
          )}
          {error && <div className="inline-error">{error}</div>}
        </section>

        <aside className="assist-render-rail">
          <div className="panel render-action-panel assist-render-panel">
            <div className="assist-render-head">
              <div>
                <div className="section-label">Render</div>
                <strong>{plan.checkpoint || "未选择模型"}</strong>
                <span>{sizeSummary(plan)} · {plan.steps} steps · CFG {plan.cfg_scale} · batch {plan.batch_size}</span>
              </div>
              <button className="primary-action render-button" onClick={runGeneration} disabled={!canGenerate}>
                {generating ? <BusyLabel text="生成中" /> : "生成"}
              </button>
            </div>
            {generating && <button className="wide secondary-action" onClick={cancelActiveTask}>取消任务</button>}
            {generating ? (
              <GenerationLoading task={activeTask} plan={plan} />
            ) : results[0] ? (
              <div className="assist-latest-preview">
                <img src={results[0].url} alt={results[0].filename || "latest generated result"} />
                <div>
                  <a href={results[0].url} target="_blank" rel="noreferrer">打开</a>
                  <button onClick={() => reuseGeneration(results[0])}>复用</button>
                  <button onClick={() => reuseGeneration(results[0], { fixedSeed: true })}>固定 Seed</button>
                </div>
              </div>
            ) : (
              <div className="render-empty-state">
                <span>{disabledReason || "方案确认后即可提交到 A1111。"}</span>
              </div>
            )}
          </div>

          <div className="panel history-panel assist-history-panel">
            <PanelHeader
              title="历史"
              button={<button className="small-button" onClick={loadGenerations}>{loadingHistory ? "加载中" : "刷新"}</button>}
            />
            {results.length ? (
              <div className="gallery-grid history-grid assist-history-grid">
                {results.slice(0, 12).map((image) => (
                  <div key={`${image.generationId || "image"}-${image.url}`} className="gallery-link">
                    <img src={image.url} alt={image.filename || "generated result"} />
                    <span>{image.filename || "base64 result"}</span>
                    <div className="gallery-actions">
                      <a href={image.url} target="_blank" rel="noreferrer">开</a>
                      <button onClick={() => reuseGeneration(image)}>复</button>
                      <button onClick={() => reuseGeneration(image, { fixedSeed: true })}>Seed</button>
                      <button onClick={() => deleteGenerationItem(image)}>删</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-gallery compact-empty">
                <strong>暂无历史</strong>
                <span>生成完成后会自动保存。</span>
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function ChatPlanConfirm({ plan, setPlan, checkpoints, loras, samplers, disabledReason, canConfirm, onConfirm, onDiscard }) {
  return (
    <div className="chat-plan-confirm">
      <div className="chat-plan-head">
        <div>
          <div className="section-label">Confirm</div>
          <h2>确认生成方案</h2>
        </div>
        <span className={disabledReason ? "warn-text" : "ok"}>{disabledReason || "Ready"}</span>
      </div>

      <div className="chat-plan-body">
        <section className="chat-plan-section chat-plan-prompts">
          <div className="chat-section-title">
            <strong>Prompt</strong>
            <span>{sizeSummary(plan)}</span>
          </div>
          <label>Positive<textarea className="code-area chat-positive" value={plan.positive_prompt} onChange={(event) => setPlanValue(setPlan, "positive_prompt", event.target.value)} /></label>
          <label>Negative<textarea className="code-area chat-negative" value={plan.negative_prompt} onChange={(event) => setPlanValue(setPlan, "negative_prompt", event.target.value)} /></label>
          <div className="chat-plan-rationale">
            <span>AI 解析</span>
            <p>{plan.rationale || "等待解析方案"}</p>
          </div>
        </section>

        <section className="chat-plan-section chat-plan-controls">
          <div className="chat-section-title">
            <strong>参数</strong>
            <span>{plan.steps} steps · CFG {plan.cfg_scale}</span>
          </div>

          <label className="span-field">Checkpoint<select value={plan.checkpoint} onChange={(event) => setPlanValue(setPlan, "checkpoint", event.target.value)}>
            <option value="">选择 checkpoint</option>
            {checkpoints.map((checkpoint) => (
              <option key={checkpointTitle(checkpoint)} value={checkpointTitle(checkpoint)}>{checkpointTitle(checkpoint)}</option>
            ))}
          </select></label>

          <div className="chat-param-grid">
            <label>W<input type="number" value={plan.width} onChange={(event) => setNumberPlanValue(setPlan, "width", event.target.value)} /></label>
            <label>H<input type="number" value={plan.height} onChange={(event) => setNumberPlanValue(setPlan, "height", event.target.value)} /></label>
            <label>目标W<input type="number" value={plan.target_width || ""} onChange={(event) => setTargetPlanValue(setPlan, "target_width", event.target.value)} placeholder="同生成" /></label>
            <label>目标H<input type="number" value={plan.target_height || ""} onChange={(event) => setTargetPlanValue(setPlan, "target_height", event.target.value)} placeholder="同生成" /></label>
            <label>Steps<input type="number" value={plan.steps} onChange={(event) => setNumberPlanValue(setPlan, "steps", event.target.value)} /></label>
            <label>CFG<input type="number" step="0.5" value={plan.cfg_scale} onChange={(event) => setNumberPlanValue(setPlan, "cfg_scale", event.target.value)} /></label>
            <label>Batch<input type="number" value={plan.batch_size} onChange={(event) => setNumberPlanValue(setPlan, "batch_size", event.target.value)} /></label>
            <label>Seed<input type="number" value={plan.seed} onChange={(event) => setNumberPlanValue(setPlan, "seed", event.target.value)} /></label>
            <SamplerSelect value={plan.sampler} samplers={samplers} onChange={(value) => setPlanValue(setPlan, "sampler", value)} />
          </div>

          <div className="chat-plan-subsection">
            <div className="chat-section-title compact">
              <strong>LoRA</strong>
              <span>{plan.lora?.length ? `${plan.lora.length} 个` : "未使用"}</span>
            </div>
            <LoraEditor plan={plan} setPlan={setPlan} loras={loras} compact />
          </div>

          <div className="chat-plan-subsection">
            <div className="chat-section-title compact">
              <strong>高清修复</strong>
              <span>{isHiresEnabled(plan) ? "开启" : "关闭"}</span>
            </div>
            <ToggleRow label="启用 resize" checked={isHiresEnabled(plan)} onChange={(checked) => setHiresEnabled(setPlan, checked)} />
            {isHiresEnabled(plan) && (
              <div className="hires-settings compact-hires">
                <label>Denoise<input type="number" step="0.05" value={plan.hires_fix?.denoising_strength ?? 0.35} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { denoising_strength: Number(event.target.value) }))} /></label>
                <label>Upscaler<input value={plan.hires_fix?.upscaler || "Latent"} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { upscaler: event.target.value }))} /></label>
                <label>二次步数<input type="number" value={plan.hires_fix?.second_pass_steps ?? Math.max(8, Math.round(plan.steps * 0.5))} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { second_pass_steps: Number(event.target.value) }))} /></label>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="chat-plan-actions">
        <div>
          <strong>{sizeSummary(plan)}</strong>
          <span>{plan.checkpoint || "未选择模型"}</span>
        </div>
        <button className="small-button" onClick={onDiscard}>丢弃</button>
        <button className="primary-action" onClick={onConfirm} disabled={!canConfirm}>确认生成</button>
      </div>
    </div>
  );
}

function LoraEditor({ plan, setPlan, loras, compact = false }) {
  const selected = normalizeLorasForUi(plan.lora);
  const activeNames = new Set(selected.map((item) => item.name));
  const options = loras.filter((lora) => !activeNames.has(loraTitle(lora)));

  function addLora(name) {
    if (!name) return;
    const resource = loras.find((item) => loraTitle(item) === name);
    const next = {
      name,
      alias: resource?.alias,
      weight: 0.75,
      trigger_words: [],
    };
    setPlan((current) => ({ ...current, lora: [...normalizeLorasForUi(current.lora), next] }));
  }

  function updateLora(index, patch) {
    setPlan((current) => {
      const next = normalizeLorasForUi(current.lora);
      next[index] = { ...next[index], ...patch };
      return { ...current, lora: next.filter((item) => item.name) };
    });
  }

  function removeLora(index) {
    setPlan((current) => {
      const next = normalizeLorasForUi(current.lora);
      next.splice(index, 1);
      return { ...current, lora: next };
    });
  }

  return (
    <div className={`lora-editor ${compact ? "compact-lora-editor" : ""}`}>
      <div className="lora-editor-head">
        <span>LoRA</span>
        <select value="" onChange={(event) => addLora(event.target.value)} disabled={!options.length}>
          <option value="">{options.length ? "添加 LoRA" : "没有可添加 LoRA"}</option>
          {options.map((lora) => (
            <option key={loraTitle(lora)} value={loraTitle(lora)}>{loraTitle(lora)}</option>
          ))}
        </select>
      </div>
      {selected.length ? (
        <div className="lora-chip-list">
          {selected.map((lora, index) => (
            <div key={`${lora.name}-${index}`} className="lora-chip">
              <strong title={lora.name}>{lora.name}</strong>
              <input
                type="number"
                step="0.05"
                min="-2"
                max="2"
                value={lora.weight}
                onChange={(event) => updateLora(index, { weight: Number(event.target.value) })}
                aria-label={`${lora.name} weight`}
              />
              <input
                value={lora.trigger_words.join(", ")}
                onChange={(event) => updateLora(index, { trigger_words: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })}
                placeholder="触发词"
                aria-label={`${lora.name} trigger words`}
              />
              <button type="button" onClick={() => removeLora(index)} aria-label={`remove ${lora.name}`}>删</button>
            </div>
          ))}
        </div>
      ) : (
        <p className="lora-empty">未使用 LoRA</p>
      )}
    </div>
  );
}

function SamplerSelect({ value, samplers, onChange }) {
  const options = samplerOptions(samplers, value);

  return (
    <label className="span-field">Sampler<select value={value || ""} onChange={(event) => onChange(event.target.value)}>
      {options.map((sampler) => (
        <option key={sampler} value={sampler}>{sampler}</option>
      ))}
    </select></label>
  );
}

function BusyLabel({ text }) {
  return (
    <span className="busy-label">
      <span className="mini-spinner" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

function PlanStat({ label, value }) {
  return (
    <div className="plan-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function GenerationLoading({ task, plan }) {
  const progress = Math.round((task?.progress || 0) * 100);
  const preview = task?.result?.progressPreview || "";
  return (
    <div className="generation-loading" role="status" aria-live="polite">
      {preview ? <img className="progress-preview" src={preview} alt="A1111 progress preview" /> : (
        <div className="loading-orbit" aria-hidden="true">
          <span />
        </div>
      )}
      <div className="loading-copy">
        <strong>{task?.progressLabel || "A1111 正在生成"}</strong>
        <span>{sizeSummary(plan)} · {plan.steps} steps · {plan.sampler} · {progress}%</span>
      </div>
      <div className="loading-bar determinate" aria-hidden="true"><span style={{ width: `${Math.max(4, progress)}%` }} /></div>
      <div className="loading-steps">
        <span>{task?.id ? `任务 ${task.id.slice(0, 8)}` : "提交 txt2img"}</span>
        <span>{task?.status || "running"}</span>
        <span>保存到 outputs</span>
      </div>
    </div>
  );
}

function Overview({ setScreen, webuiOnline, checkpoints }) {
  return (
    <section className="screen active">
      <div className="overview-grid">
        <div className="panel span-2">
          <PanelHeader title="当前任务" text="A1111 生图链路已经接入，可选择对话作图或 AI 辅助参数作图。" button={<button className="small-button" onClick={() => setScreen("queue")}>查看队列</button>} />
          <div className="task-timeline">
            <TaskRow active title="自然语言生图链路" text={webuiOnline ? "A1111 connected · ready" : "等待 A1111 启动"} progress={webuiOnline ? 100 : 20} />
            <TaskRow title="模型索引刷新" text={`checkpoint ${checkpoints.length}`} progress={checkpoints.length ? 100 : 15} green={checkpoints.length > 0} />
            <TaskRow title="结果保存" text="outputs/generations · runtime ignored" progress={100} green />
          </div>
        </div>
        <div className="panel">
          <PanelHeader title="系统状态" />
          <div className="metrics">
            <Metric label="WebUI" value={webuiOnline ? "在线" : "离线"} />
            <Metric label="Checkpoint" value={String(checkpoints.length)} />
            <Metric label="Backend" value="8787" />
            <Metric label="UI" value="5177" />
          </div>
        </div>
        <div className="panel span-2">
          <PanelHeader title="最近生成" text="当前页面会展示真实输出；这里保留设计稿样张用于占位。" />
          <div className="image-strip">
            {starterImages.map((image) => <img key={image} src={image} alt="recent generation" />)}
          </div>
        </div>
        <div className="panel">
          <PanelHeader title="快捷入口" />
          <div className="quick-actions">
            <button onClick={() => setScreen("generate")}>对话作图</button>
            <button onClick={() => setScreen("assist")}>AI 辅助作图</button>
            <button onClick={() => setScreen("models")}>查看模型</button>
            <button onClick={() => setScreen("settings")}>Provider 设置</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ModelsScreen({ checkpoints, webuiOnline, refreshStatus }) {
  const [resources, setResources] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    loadResources();
  }, []);

  async function loadResources({ scan = false } = {}) {
    try {
      setError("");
      const response = scan ? await apiPost("/api/resources/scan", {}) : await apiGet("/api/resources");
      setResources(response);
      if (scan) await refreshStatus();
    } catch (error) {
      setError(error.message);
    }
  }

  const rows = [
    ...((resources?.a1111?.checkpoints || checkpoints).map((item) => ({ type: "Checkpoint", arch: "SD", purpose: indexedPurpose(resources, "checkpoint", item) || "自然语言生图 / 基础 txt2img", item }))),
    ...((resources?.a1111?.loras || []).map((item) => ({ type: "LoRA", arch: "SD", purpose: indexedPurpose(resources, "lora", item) || "待标注", item }))),
    ...((resources?.a1111?.vaes || []).map((item) => ({ type: "VAE", arch: "SD", purpose: indexedPurpose(resources, "vae", item) || "色彩/解码", item }))),
    ...((resources?.a1111?.samplers || []).map((item) => ({ type: "Sampler", arch: "A1111", purpose: "采样策略", item }))),
  ];

  return (
    <section className="screen active">
      <div className="panel full-panel">
        <PanelHeader
          title="模型管家"
          text="统一扫描 checkpoint、LoRA、VAE 和 sampler，并建立 Agent 可用资源索引。"
          button={<button className="primary-action" onClick={() => loadResources({ scan: true })}>刷新索引</button>}
        />
        {error && <div className="inline-error">{error}</div>}
        <div className="table model-table">
          <div className="table-head"><span>名称</span><span>类型</span><span>架构</span><span>推荐用途</span><span>来源</span><span>状态</span></div>
          {rows.length ? rows.map((row) => (
            <div key={`${row.type}-${resourceName(row.item)}`}>
              <span>{resourceName(row.item)}</span>
              <span>{row.type}</span>
              <span>{row.arch}</span>
              <span>{row.purpose}</span>
              <span>{row.item.source || "api"}</span>
              <span className="ok">可用</span>
            </div>
          )) : (
            <div><span>未检测到 checkpoint</span><span>-</span><span>-</span><span>启动 A1111 并放入模型</span><span>-</span><span className={webuiOnline ? "warn-text" : ""}>{webuiOnline ? "空" : "离线"}</span></div>
          )}
        </div>
      </div>
    </section>
  );
}

function QueueScreen() {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    loadTasks();
    const timer = window.setInterval(loadTasks, 1500);
    return () => window.clearInterval(timer);
  }, []);

  async function loadTasks() {
    try {
      const response = await apiGet("/api/tasks?limit=20");
      setTasks(response.tasks || []);
      setError("");
    } catch (error) {
      setError(error.message);
    }
  }

  async function retryTask(taskId) {
    try {
      await apiPost(`/api/tasks/${taskId}/retry`, {});
      await loadTasks();
    } catch (error) {
      setError(error.message);
    }
  }

  async function cancelTask(taskId) {
    try {
      await apiPost(`/api/tasks/${taskId}/cancel`, {});
      await loadTasks();
    } catch (error) {
      setError(error.message);
    }
  }

  const running = tasks.filter(isTaskActive).length;
  const succeeded = tasks.filter((task) => task.status === "succeeded").length;

  return (
    <section className="screen active">
      <div className="workspace-grid queue-grid">
        <div className="panel span-2">
          <PanelHeader title="任务队列" text="生成任务已持久化到本地，可取消、失败重试、查看进度。" button={<button className="small-button" onClick={loadTasks}>刷新</button>} />
          {error && <div className="inline-error">{error}</div>}
          <div className="queue-list">
            {tasks.length ? tasks.map((task) => (
              <div key={task.id} className={`queue-item ${isTaskActive(task) ? "running" : ""}`}>
                <strong>{task.plan?.task_type || "txt2img"} · {task.plan?.checkpoint || "未选择模型"}</strong>
                <span>{task.progressLabel || task.error || formatDateTime(task.createdAt)}</span>
                <em>{task.status} · {Math.round((task.progress || 0) * 100)}%</em>
                <div className="queue-actions">
                  {isTaskActive(task) && <button onClick={() => cancelTask(task.id)}>取消</button>}
                  {["failed", "cancelled", "succeeded"].includes(task.status) && <button onClick={() => retryTask(task.id)}>重试</button>}
                </div>
              </div>
            )) : (
              <div className="queue-item"><strong>暂无任务</strong><span>在自然语言生图页点击生成后会出现在这里</span><em>idle</em></div>
            )}
          </div>
        </div>
        <div className="panel">
          <PanelHeader title="资源占用" />
          <div className="resource-bars">
            <Resource label="运行" value={String(running)} progress={running ? 65 : 6} />
            <Resource label="成功" value={String(succeeded)} progress={Math.min(100, succeeded * 12)} />
            <Resource label="任务" value={String(tasks.length)} progress={Math.min(100, tasks.length * 8)} />
            <Resource label="存储" value="SQLite" progress={38} />
          </div>
        </div>
        <div className="panel span-3">
          <PanelHeader title="任务日志" />
          <pre className="log-box">{tasks.slice(0, 8).map((task) => `[${task.status}] ${formatDateTime(task.updatedAt)} · ${task.progressLabel || task.error || task.id}`).join("\n") || "[idle] 等待生成任务"}</pre>
        </div>
      </div>
    </section>
  );
}

function SettingsScreen({ providerName, backendOnline, providerStatus }) {
  const [status, setStatus] = useState(providerStatus || null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadProviderStatus();
  }, [providerName]);

  async function loadProviderStatus() {
    try {
      const response = await apiGet("/api/providers/status");
      setStatus(response);
      setError("");
    } catch (error) {
      setError(error.message);
    }
  }

  async function testProvider() {
    try {
      setTesting(true);
      setError("");
      const response = await apiPost("/api/providers/test", {});
      setTestResult(response);
      setStatus(response.provider);
    } catch (error) {
      setError(error.message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="screen active">
      <div className="workspace-grid settings-grid">
        <div className="panel">
          <PanelHeader title="Provider 列表" text="用于 prompt、标签、评估和任务规划。" />
          <div className="provider-list">
            <button className="selected">{status?.type || providerName || "mock"} · 当前</button>
            <button>OpenAI-compatible · 本地网关</button>
            <button>Local · LM Studio</button>
            <button>Claude 类接口</button>
          </div>
        </div>
        <div className="panel span-2">
          <div className="panel-header">
            <div>
              <h2>连接状态</h2>
              <p>连接测试不会影响本地 WebUI 生图能力。</p>
            </div>
            <span className={`connection-pill ${backendOnline ? "ok-pill" : "warn"}`}>{backendOnline ? "Connected" : "Offline"}</span>
          </div>
          {error && <div className="inline-error">{error}</div>}
          <div className="settings-form">
            <label>Backend API<input readOnly value={API_BASE} /></label>
            <label>Provider<input readOnly value={status?.type || providerName || "unknown"} /></label>
            <label>Provider Base<input readOnly value={status?.baseUrl || "local/mock"} /></label>
            <label>Model<input readOnly value={status?.model || "not configured"} /></label>
            <label>API Key<input readOnly value={status?.hasApiKey ? status.keyPreview || "***" : "未配置"} /></label>
            <label>生成后端<input readOnly value="A1111 / txt2img" /></label>
          </div>
          <button className="primary-action wide" onClick={testProvider} disabled={testing}>
            {testing ? <BusyLabel text="测试中" /> : "测试 Provider"}
          </button>
        </div>
        <div className="panel span-3">
          <PanelHeader title="协议适配策略" text={testResult ? `最近测试成功：${testResult.latencyMs}ms · ${testResult.samplePlan?.checkpoint || "无模型"}` : "API key 只在本地环境中读取，页面不会回显明文。"} />
          <div className="provider-matrix">
            <div><strong>OpenAI</strong><span>Responses / Chat Completions · 用于高质量规划和 prompt</span></div>
            <div><strong>OpenAI-compatible</strong><span>统一 base_url + model · 适配本地或第三方网关</span></div>
            <div><strong>Local</strong><span>Ollama / LM Studio / llama.cpp · 离线低成本解析</span></div>
            <div><strong>Mock</strong><span>无 Provider 时仍可用真实 checkpoint 生成方案</span></div>
          </div>
        </div>
      </div>
    </section>
  );
}

function StaticScreen({ title, text }) {
  return (
    <section className="screen active">
      <div className="panel full-panel">
        <PanelHeader title={title} text={text} />
        <div className="static-placeholder">
          <img src={assetUrl("art-02.png")} alt="" />
          <div>
            <strong>当前开发焦点：自然语言生图</strong>
            <span>这个页面的视觉结构已保留，真实接口会在后续阶段接入。</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function PanelHeader({ title, text, button }) {
  return (
    <div className="panel-header">
      <div>
        <h2>{title}</h2>
        {text ? <p>{text}</p> : null}
      </div>
      {button}
    </div>
  );
}

function StatusRow({ label, value, tone = "" }) {
  return (
    <div className="status-row">
      <span>{label}</span>
      <strong className={tone === "ok" ? "ok" : tone === "bad" ? "bad" : ""}>{value}</strong>
    </div>
  );
}

function TaskRow({ title, text, progress, active, green }) {
  return (
    <div className={`task-row ${active ? "active" : ""}`}>
      <div className={`task-dot ${green ? "green" : ""}`} />
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
      <div className={`task-progress ${green ? "complete" : ""}`}><span style={{ width: `${progress}%` }} /></div>
    </div>
  );
}

function Metric({ label, value }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Resource({ label, value, progress }) {
  return (
    <div>
      <span>{label}</span>
      <div className="meter"><span style={{ width: `${progress}%` }} /></div>
      <strong>{value}</strong>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }) {
  return (
    <div>
      <span>{label}</span>
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <strong>{checked ? "开启" : "关闭"}</strong>
      </label>
    </div>
  );
}

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${path} failed: ${response.status}`);
  }
  return response.json();
}

async function apiDelete(path) {
  const response = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${path} failed: ${response.status}`);
  }
  return response.json();
}

async function loadCurrentGenerationTask() {
  const response = await apiGet("/api/tasks?limit=20");
  return (response.tasks || []).find(isTaskActive) || null;
}

function normalizePlanForUi(plan = {}, checkpoints = []) {
  const checkpoint = plan.checkpoint || checkpointTitle(checkpoints[0]);
  const requestedWidth = clampNumber(plan.width, 256, 2048, defaultPlan.width);
  const requestedHeight = clampNumber(plan.height, 256, 2048, defaultPlan.height);
  const baseSize = recommendedBaseSizeForUi(requestedWidth, requestedHeight);
  const width = baseSize.width;
  const height = baseSize.height;
  let targetWidth = nullableNumber(plan.target_width);
  let targetHeight = nullableNumber(plan.target_height);
  if ((!targetWidth || !targetHeight) && (requestedWidth !== width || requestedHeight !== height)) {
    targetWidth = requestedWidth;
    targetHeight = requestedHeight;
  }
  if (targetWidth === width && targetHeight === height) {
    targetWidth = null;
    targetHeight = null;
  }
  const hiresFix = normalizeHiresFixForUi({
    ...plan,
    width,
    height,
    target_width: targetWidth,
    target_height: targetHeight,
  });
  return {
    ...defaultPlan,
    ...plan,
    checkpoint,
    width,
    height,
    target_width: targetWidth,
    target_height: targetHeight,
    steps: Number(plan.steps || defaultPlan.steps),
    cfg_scale: Number(plan.cfg_scale || defaultPlan.cfg_scale),
    batch_size: Number(plan.batch_size || defaultPlan.batch_size),
    seed: Number.isFinite(Number(plan.seed)) ? Number(plan.seed) : -1,
    lora: normalizeLorasForUi(plan.lora),
    hires_fix: hiresFix,
    adetailer: Boolean(plan.adetailer),
  };
}

function normalizePlanForRun(plan) {
  const requestedWidth = clampNumber(plan.width, 256, 2048, 512);
  const requestedHeight = clampNumber(plan.height, 256, 2048, 512);
  const baseSize = recommendedBaseSizeForUi(requestedWidth, requestedHeight);
  const width = baseSize.width;
  const height = baseSize.height;
  let targetWidth = nullableNumber(plan.target_width);
  let targetHeight = nullableNumber(plan.target_height);
  if ((!targetWidth || !targetHeight) && (requestedWidth !== width || requestedHeight !== height)) {
    targetWidth = requestedWidth;
    targetHeight = requestedHeight;
  }
  if (targetWidth === width && targetHeight === height) {
    targetWidth = null;
    targetHeight = null;
  }
  return {
    ...plan,
    width,
    height,
    target_width: targetWidth,
    target_height: targetHeight,
    steps: clampNumber(plan.steps, 1, 80, 8),
    cfg_scale: clampNumber(plan.cfg_scale, 1, 20, 5),
    batch_size: clampNumber(plan.batch_size, 1, 4, 1),
    seed: Number.isFinite(Number(plan.seed)) ? Number(plan.seed) : -1,
    lora: normalizeLorasForUi(plan.lora),
    hires_fix: normalizeHiresFixForUi({ ...plan, width, height, target_width: targetWidth, target_height: targetHeight }),
    adetailer: Boolean(plan.adetailer),
  };
}

function normalizeHiresFixForUi(plan = {}) {
  const source = typeof plan.hires_fix === "object" && plan.hires_fix ? plan.hires_fix : {};
  const targetWidth = nullableNumber(plan.target_width ?? source.target_width);
  const targetHeight = nullableNumber(plan.target_height ?? source.target_height);
  const targetDiffers = Boolean(targetWidth && targetHeight && (targetWidth !== Number(plan.width) || targetHeight !== Number(plan.height)));
  if (!targetDiffers) return false;
  return {
    enabled: true,
    mode: source.mode || "resize",
    target_width: targetWidth,
    target_height: targetHeight,
    denoising_strength: clampNumber(source.denoising_strength, 0, 1, 0.35),
    upscaler: source.upscaler || "Latent",
    second_pass_steps: clampNumber(source.second_pass_steps, 1, 80, Math.max(8, Math.round(Number(plan.steps || 8) * 0.5))),
  };
}

function isHiresEnabled(plan = {}) {
  return plan.hires_fix === true || plan.hires_fix?.enabled === true;
}

function nextHiresFix(plan = {}, patch = {}) {
  if (patch.enabled === false) return false;
  const targetSize = defaultTargetSizeForUi(plan);
  const targetWidth = nullableNumber(plan.target_width) || targetSize.width;
  const targetHeight = nullableNumber(plan.target_height) || targetSize.height;
  const current = normalizeHiresFixForUi(plan) || {
    enabled: false,
    mode: "resize",
    target_width: targetWidth,
    target_height: targetHeight,
    denoising_strength: 0.35,
    upscaler: "Latent",
    second_pass_steps: Math.max(8, Math.round(Number(plan.steps || 8) * 0.5)),
  };
  return { ...current, enabled: true, target_width: targetWidth, target_height: targetHeight, ...patch };
}

function setHiresEnabled(setPlan, enabled) {
  setPlan((plan) => {
    if (!enabled) {
      return { ...plan, target_width: null, target_height: null, hires_fix: false };
    }
    const targetSize = defaultTargetSizeForUi(plan);
    const next = {
      ...plan,
      target_width: nullableNumber(plan.target_width) || targetSize.width,
      target_height: nullableNumber(plan.target_height) || targetSize.height,
    };
    return {
      ...next,
      hires_fix: nextHiresFix(next, { enabled: true, target_width: next.target_width, target_height: next.target_height }),
    };
  });
}

function setTargetPlanValue(setPlan, key, value) {
  setPlan((plan) => {
    const nextValue = value === "" ? null : Number(value);
    const next = { ...plan, [key]: Number.isFinite(nextValue) ? nextValue : null };
    const targetWidth = key === "target_width" ? next.target_width : nullableNumber(next.target_width);
    const targetHeight = key === "target_height" ? next.target_height : nullableNumber(next.target_height);
    const shouldEnable = Boolean(targetWidth && targetHeight && (targetWidth !== Number(next.width) || targetHeight !== Number(next.height)));
    next.hires_fix = shouldEnable ? nextHiresFix({ ...next, target_width: targetWidth, target_height: targetHeight }, { enabled: true, target_width: targetWidth, target_height: targetHeight }) : normalizeHiresFixForUi(next);
    return next;
  });
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function recommendedBaseSizeForUi(width = 512, height = 512) {
  const safeWidth = clampNumber(width, 256, 2048, 512);
  const safeHeight = clampNumber(height, 256, 2048, 512);
  const ratio = safeWidth / safeHeight;
  if (ratio < 0.9) return { width: 512, height: 768 };
  if (ratio > 1.1) return { width: 768, height: 512 };
  return { width: 512, height: 512 };
}

function defaultTargetSizeForUi(plan = {}) {
  const base = recommendedBaseSizeForUi(plan.width, plan.height);
  if (base.width === 512 && base.height === 512) return { width: 768, height: 768 };
  if (base.width < base.height) return { width: 768, height: 1152 };
  return { width: 1152, height: 768 };
}

function sizeSummary(plan = {}) {
  const base = `${plan.width || 512}x${plan.height || 512}`;
  const targetWidth = plan.target_width || plan.hires_fix?.target_width;
  const targetHeight = plan.target_height || plan.hires_fix?.target_height;
  if (!targetWidth || !targetHeight || Number(targetWidth) === Number(plan.width) && Number(targetHeight) === Number(plan.height)) {
    return `生成 ${base} · 无高清 resize`;
  }
  return `生成 ${base} → 输出 ${targetWidth}x${targetHeight}`;
}

function extractImages(response, plan = null) {
  const outputImages = Array.isArray(response.outputImages) ? response.outputImages : [];
  if (outputImages.length) {
    return outputImages.map((image) => ({ ...image, url: absoluteUrl(image.url), plan }));
  }

  return (response.images || []).map((image, index) => ({
    ...(typeof image === "object" ? image : {}),
    url: imageUrl(image),
    filename: typeof image === "object" ? image.filename || `result-${index + 1}.png` : `base64-result-${index + 1}.png`,
    plan,
  }));
}

function generationToGalleryItems(generation) {
  return (generation.images || []).map((image, index) => ({
    ...image,
    generationId: generation.id,
    url: absoluteUrl(image.url),
    filename: image.filename || `generation-${index + 1}.png`,
    plan: generation.plan,
    createdAt: generation.createdAt,
  }));
}

function absoluteUrl(url) {
  if (!url) return "";
  if (/^https?:\/\//.test(url) || url.startsWith("data:")) return url;
  return `${API_BASE}${url.startsWith("/") ? url : `/${url}`}`;
}

function imageUrl(image) {
  if (typeof image === "string") {
    return image.startsWith("data:") ? image : `data:image/png;base64,${image}`;
  }
  return absoluteUrl(image?.url || "");
}

function generationReference(item, plan) {
  return {
    generationId: item.generationId || "",
    filename: item.filename || "",
    url: item.url || "",
    plan,
  };
}

function withReferenceContext(userMessage, reference) {
  if (!reference) return userMessage;
  const context = {
    generationId: reference.generationId || "",
    filename: reference.filename || "",
    imageUrl: reference.url || "",
    sourcePlan: reference.plan || {},
  };
  return [
    userMessage,
    "参考图上下文：请基于下面这张历史图的生成参数继续修订方案；当前系统不会视觉分析图片本身，图片 URL 仅用于追踪用户选择的参考结果。",
    JSON.stringify(context),
  ].join("\n");
}

function setPlanValue(setPlan, key, value) {
  setPlan((plan) => ({ ...plan, [key]: value }));
}

function setNumberPlanValue(setPlan, key, value) {
  const nextValue = value === "" ? "" : Number(value);
  if (key !== "width" && key !== "height") {
    setPlanValue(setPlan, key, nextValue);
    return;
  }
  setPlan((plan) => {
    const requestedWidth = key === "width" ? clampNumber(nextValue, 256, 2048, plan.width || 512) : clampNumber(plan.width, 256, 2048, 512);
    const requestedHeight = key === "height" ? clampNumber(nextValue, 256, 2048, plan.height || 512) : clampNumber(plan.height, 256, 2048, 512);
    const baseSize = recommendedBaseSizeForUi(requestedWidth, requestedHeight);
    const shouldTarget = requestedWidth !== baseSize.width || requestedHeight !== baseSize.height;
    const next = {
      ...plan,
      width: baseSize.width,
      height: baseSize.height,
      target_width: shouldTarget ? requestedWidth : null,
      target_height: shouldTarget ? requestedHeight : null,
    };
    return {
      ...next,
      hires_fix: shouldTarget ? nextHiresFix(next, { target_width: next.target_width, target_height: next.target_height }) : false,
    };
  });
}

function checkpointTitle(checkpoint) {
  return checkpoint?.title || checkpoint?.name || "";
}

function loraTitle(lora) {
  return lora?.name || lora?.alias || lora?.filename || "";
}

function normalizeLorasForUi(loras = []) {
  if (!Array.isArray(loras)) return [];
  return loras.map((lora) => {
    if (typeof lora === "string") {
      return { name: lora, weight: 1, trigger_words: [] };
    }
    const triggerWords = Array.isArray(lora?.trigger_words)
      ? lora.trigger_words
      : String(lora?.trigger_words || lora?.trigger || "").split(",").map((item) => item.trim()).filter(Boolean);
    return {
      ...lora,
      name: lora?.name || lora?.alias || lora?.filename || "",
      weight: Number.isFinite(Number(lora?.weight)) ? Number(lora.weight) : 1,
      trigger_words: triggerWords,
    };
  }).filter((lora) => lora.name);
}

function resourceName(resource) {
  return resource?.title || resource?.name || resource?.alias || resource?.filename || "";
}

function samplerOptions(samplers, currentValue) {
  const names = (Array.isArray(samplers) && samplers.length ? samplers : fallbackSamplers)
    .map((sampler) => typeof sampler === "string" ? sampler : sampler?.name)
    .filter(Boolean);
  return [...new Set([currentValue, ...names].filter(Boolean))];
}

function indexedPurpose(resources, type, item) {
  const name = resourceName(item);
  const match = (resources?.index || []).find((resource) => resource.type === type && (resource.name === name || resource.title === name));
  return match?.purpose || "";
}

function isTaskActive(task) {
  return ["queued", "running", "cancelling"].includes(task?.status);
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatLoras(loras) {
  if (!Array.isArray(loras) || !loras.length) return "无";
  return loras.map((lora) => typeof lora === "string" ? lora : `${lora.name || "LoRA"} · ${lora.weight ?? 1}`).join(" / ");
}

function formatList(items) {
  if (!Array.isArray(items)) return "";
  return items.map((item) => typeof item === "string" ? item : item.name || item.title || "").filter(Boolean).join(" / ");
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function currentScreen() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("screen") || "overview";
  return screens.some(([key]) => key === requested) ? requested : "overview";
}

function assetUrl(name) {
  return new URL(`../prototype/assets/${name}`, import.meta.url).href;
}

createRoot(document.getElementById("root")).render(<App />);
