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

const promptAllInOneGroups = [
  { id: "subject", label: "主体", target: "positive", tags: ["1girl", "solo", "detailed face", "beautiful detailed eyes"] },
  { id: "appearance", label: "外观", target: "positive", tags: ["silver hair", "long hair", "soft expression", "delicate skin"] },
  { id: "outfit", label: "服装", target: "positive", tags: ["black dress", "detailed outfit", "elegant accessories"] },
  { id: "pose", label: "构图", target: "positive", tags: ["upper body", "looking at viewer", "dynamic composition"] },
  { id: "scene", label: "场景", target: "positive", tags: ["rainy night", "cafe window", "cinematic background"] },
  { id: "lighting", label: "光影", target: "positive", tags: ["soft lighting", "rim light", "cinematic lighting"] },
  { id: "quality", label: "质量", target: "positive", tags: ["masterpiece", "best quality", "highly detailed", "sharp focus"] },
  { id: "negative", label: "负面", target: "negative", tags: ["low quality", "blurry", "bad anatomy", "bad hands", "extra fingers", "text", "watermark"] },
];

function App() {
  const [screen, setScreenState] = useState(currentScreen());
  const [health, setHealth] = useState(null);
  const [engineModels, setEngineModels] = useState(null);
  const [resources, setResources] = useState(null);
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
      apiGet("/api/resources").then(setResources).catch(() => {});
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
            resources={resources}
            promptTools={a1111?.promptTools}
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
            resources={resources}
            refreshStatus={refreshStatus}
            topGenerateRequest={topGenerateRequest}
          />
        )}
        {screen === "models" && <ModelsScreen checkpoints={checkpoints} webuiOnline={webuiOnline} resources={resources} setResources={setResources} refreshStatus={refreshStatus} />}
        {screen === "queue" && <QueueScreen />}
        {screen === "settings" && <SettingsScreen providerName={providerName} backendOnline={!connectionError} providerStatus={health?.providerStatus} health={health} engineModels={engineModels} refreshStatus={refreshStatus} />}
        {screen === "edit" && <StaticScreen title="智能改图" text="下一阶段接入 img2img、inpaint 和 ControlNet。当前先聚焦自然语言 txt2img 闭环。" />}
        {screen === "lora" && <StaticScreen title="LoRA 炼制" text="向导式数据导入、质检、标签清洗和训练配置会在生图闭环稳定后继续接入。" />}
      </main>
    </div>
  );
}

function ChatGenerateScreen({ webuiOnline, backendOnline, checkpoints, loras, samplers, resources, refreshStatus, topGenerateRequest }) {
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
  const compatibility = validatePlanForUi(activePlan, resources);
  const compatibilityError = compatibility.ok ? "" : compatibility.issues[0]?.message || "资源不兼容";
  const canSubmit = backendOnline && webuiOnline && Boolean(activePlan.checkpoint) && compatibility.ok && !generating && !planning && Boolean(requestText.trim());
  const canConfirmPlan = backendOnline && webuiOnline && Boolean(pendingPlan?.checkpoint) && Boolean(pendingPlan?.positive_prompt) && compatibility.ok && !generating && !planning;
  const disabledReason = !backendOnline
    ? "后端未连接"
    : !webuiOnline
      ? "A1111 未连接"
      : !activePlan.checkpoint
        ? "没有可用 checkpoint"
        : compatibilityError
          ? compatibilityError
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
                resources={resources}
                compatibility={compatibility}
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

function AssistGenerateScreen({ webuiOnline, backendOnline, checkpoints, loras, samplers, resources, promptTools, refreshStatus, topGenerateRequest }) {
  const [conversation, setConversation] = useState([]);
  const [requestText, setRequestText] = useState("");
  const [plan, setPlan] = useState(() => ({ ...defaultPlan, checkpoint: checkpointTitle(checkpoints[0]) }));
  const [results, setResults] = useState([]);
  const [planning, setPlanning] = useState(false);
  const [activeTask, setActiveTask] = useState(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState("");
  const [tagLibrary, setTagLibrary] = useState(null);
  const [tagQuery, setTagQuery] = useState("");
  const [activeTagGroup, setActiveTagGroup] = useState("");
  const [tagLibraryError, setTagLibraryError] = useState("");

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
    const timer = window.setTimeout(() => {
      void loadPromptTags(tagQuery, activeTagGroup);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [tagQuery, activeTagGroup]);

  useEffect(() => {
    if (!activeTask || !isTaskActive(activeTask)) return undefined;
    const timer = window.setInterval(() => {
      void pollTask(activeTask.id);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeTask?.id, activeTask?.status]);

  const hasPrompt = Boolean(String(plan.positive_prompt || "").trim());
  const generating = Boolean(activeTask && isTaskActive(activeTask));
  const compatibility = validatePlanForUi(plan, resources);
  const compatibilityError = compatibility.ok ? "" : compatibility.issues[0]?.message || "资源不兼容";
  const canGenerate = backendOnline && webuiOnline && Boolean(plan.checkpoint) && hasPrompt && compatibility.ok && !generating && !planning;
  const disabledReason = !backendOnline
    ? "后端未连接"
    : !webuiOnline
      ? "A1111 未连接"
      : !plan.checkpoint
        ? "没有可用 checkpoint"
        : compatibilityError
          ? compatibilityError
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

  async function loadPromptTags(query = "", groupId = "") {
    try {
      const params = new URLSearchParams({
        locale: "zh_CN",
        limit: "180",
        q: query,
        groupId,
      });
      const response = await apiGet(`/api/prompt-tools/tags?${params.toString()}`);
      setTagLibrary(response);
      setTagLibraryError("");
    } catch (error) {
      setTagLibraryError(error.message);
    }
  }

  const promptAllInOne = promptTools?.promptAllInOne || {};
  const promptAllInOneReady = Boolean(promptAllInOne.installed);
  const promptCategories = tagLibrary?.categories || [];
  const promptTags = tagLibrary?.tags || [];
  const activeGroupName = promptCategories
    .flatMap((category) => category.groups || [])
    .find((group) => group.id === activeTagGroup)?.name || "";

  function appendPromptGroup(group) {
    setPlan((current) => ({
      ...current,
      [group.target === "negative" ? "negative_prompt" : "positive_prompt"]: appendPromptTags(
        current[group.target === "negative" ? "negative_prompt" : "positive_prompt"],
        group.tags,
      ),
    }));
  }

  function appendLibraryTag(tag, target = "positive") {
    setPlan((current) => ({
      ...current,
      [target === "negative" ? "negative_prompt" : "positive_prompt"]: appendPromptTags(
        current[target === "negative" ? "negative_prompt" : "positive_prompt"],
        [tag.name || tag],
      ),
    }));
  }

  function formatPromptPair() {
    setPlan((current) => ({
      ...current,
      positive_prompt: formatPromptTags(current.positive_prompt),
      negative_prompt: formatPromptTags(current.negative_prompt),
    }));
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
                <span>{promptAllInOneReady ? "Prompt All in One" : backendOnline ? "Live API" : "Offline"}</span>
              </div>
              <div className="prompt-all-in-one-strip">
                <div>
                  <strong>Tag groups</strong>
                  <span>{promptAllInOneReady ? `${tagLibrary?.totalTags || 0} tags / ${promptAllInOne.groupTagFiles || 0} 个标签库` : "使用兼容标签编辑"}</span>
                </div>
                <button className="small-button" type="button" onClick={formatPromptPair}>格式化</button>
              </div>
              <div className="prompt-tag-toolbar" aria-label="prompt tag groups">
                {promptAllInOneGroups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className={group.target === "negative" ? "negative-tag" : ""}
                    onClick={() => appendPromptGroup(group)}
                    title={group.tags.join(", ")}
                  >
                    {group.label}
                  </button>
                ))}
              </div>
              <div className="prompt-library-panel">
                <div className="prompt-library-controls">
                  <label>
                    <span>搜索插件标签</span>
                    <input value={tagQuery} onChange={(event) => setTagQuery(event.target.value)} placeholder="tag / 中文译名 / 分组" />
                  </label>
                  <button className="small-button" type="button" onClick={() => { setTagQuery(""); setActiveTagGroup(""); }}>重置</button>
                </div>
                {!tagQuery.trim() && (
                  <div className="prompt-category-strip">
                    {promptCategories.slice(0, 10).flatMap((category) => (category.groups || []).slice(0, 4)).slice(0, 18).map((group) => (
                      <button
                        key={group.id}
                        type="button"
                        className={activeTagGroup === group.id ? "active" : ""}
                        onClick={() => setActiveTagGroup(activeTagGroup === group.id ? "" : group.id)}
                        title={`${group.name} (${group.count || 0})`}
                      >
                        {group.name}
                      </button>
                    ))}
                  </div>
                )}
                <div className="prompt-library-tags" aria-label="prompt all in one tag library">
                  {promptTags.slice(0, 72).map((tag) => (
                    <button
                      key={`${tag.groupId}-${tag.name}`}
                      type="button"
                      onClick={() => appendLibraryTag(tag)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        appendLibraryTag(tag, "negative");
                      }}
                      title={`${tag.category} / ${tag.group}${tag.translation ? ` - ${tag.translation}` : ""}`}
                    >
                      <strong>{tag.name}</strong>
                      {tag.translation ? <span>{tag.translation}</span> : null}
                    </button>
                  ))}
                </div>
                <div className="prompt-library-foot">
                  <span>{tagLibraryError || (activeGroupName ? `当前分组：${activeGroupName}` : "左键加入 Positive，右键加入 Negative")}</span>
                  <span>{promptTags.length ? `${Math.min(promptTags.length, 72)} / ${tagLibrary?.totalMatched || promptTags.length}` : "No tags"}</span>
                </div>
              </div>
              <div className="prompt-pair-grid">
                <label className="prompt-field">
                  <span>Positive</span>
                  <textarea className="code-area pro-positive" value={plan.positive_prompt} onChange={(event) => setPlanValue(setPlan, "positive_prompt", event.target.value)} />
                </label>
                <label className="prompt-field">
                  <span>Negative</span>
                  <textarea className="code-area pro-negative" value={plan.negative_prompt} onChange={(event) => setPlanValue(setPlan, "negative_prompt", event.target.value)} />
                </label>
              </div>
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
              <CompatibilitySummary compatibility={compatibility} />
              <LoraEditor plan={plan} setPlan={setPlan} loras={loras} resources={resources} />
              <div className="toggle-row-inline pro-toggles">
                <ToggleRow label="高清修复" checked={isHiresEnabled(plan)} onChange={(checked) => setHiresEnabled(setPlan, checked)} />
                <ToggleRow label="ADetailer" checked={Boolean(plan.adetailer)} onChange={(checked) => setPlanValue(setPlan, "adetailer", checked)} />
              </div>
              {isHiresEnabled(plan) && (
                <div className="hires-settings">
                  <label>Denoise<input type="number" step="0.05" value={plan.hires_fix?.denoising_strength ?? 0.2} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { denoising_strength: Number(event.target.value) }))} /></label>
                  <label>Upscaler<input value={plan.hires_fix?.upscaler || "Lanczos"} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { upscaler: event.target.value }))} /></label>
                  <label>二次步数<input type="number" value={plan.hires_fix?.second_pass_steps ?? Math.max(10, Math.round(plan.steps * 0.6))} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { second_pass_steps: Number(event.target.value) }))} /></label>
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
                <span>{compatibilityLabel(compatibility)}</span>
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

function ChatPlanConfirm({ plan, setPlan, checkpoints, loras, samplers, resources, compatibility, disabledReason, canConfirm, onConfirm, onDiscard }) {
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

          <CompatibilitySummary compatibility={compatibility} />

          <div className="chat-plan-subsection">
            <div className="chat-section-title compact">
              <strong>LoRA</strong>
              <span>{plan.lora?.length ? `${plan.lora.length} 个` : "未使用"}</span>
            </div>
              <LoraEditor plan={plan} setPlan={setPlan} loras={loras} resources={resources} compact />
          </div>

          <div className="chat-plan-subsection">
            <div className="chat-section-title compact">
              <strong>高清修复</strong>
              <span>{isHiresEnabled(plan) ? "开启" : "关闭"}</span>
            </div>
            <ToggleRow label="二次重绘" checked={isHiresEnabled(plan)} onChange={(checked) => setHiresEnabled(setPlan, checked)} />
            {isHiresEnabled(plan) && (
              <div className="hires-settings compact-hires">
                <label>Denoise<input type="number" step="0.05" value={plan.hires_fix?.denoising_strength ?? 0.2} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { denoising_strength: Number(event.target.value) }))} /></label>
                <label>Upscaler<input value={plan.hires_fix?.upscaler || "Lanczos"} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { upscaler: event.target.value }))} /></label>
                <label>二次步数<input type="number" value={plan.hires_fix?.second_pass_steps ?? Math.max(10, Math.round(plan.steps * 0.6))} onChange={(event) => setPlanValue(setPlan, "hires_fix", nextHiresFix(plan, { second_pass_steps: Number(event.target.value) }))} /></label>
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

function LoraEditor({ plan, setPlan, loras, resources, compact = false }) {
  const selected = normalizeLorasForUi(plan.lora);
  const activeNames = new Set(selected.map((item) => item.name));
  const loraChoices = compatibleLoraOptions(plan.checkpoint, resources, loras);
  const options = loraChoices.filter((lora) => !activeNames.has(loraTitle(lora)));

  function addLora(name) {
    if (!name) return;
    const resource = loraChoices.find((item) => loraTitle(item) === name);
    const next = {
      name,
      alias: resource?.alias,
      weight: Number(resource?.defaultWeight || 0.75),
      trigger_words: Array.isArray(resource?.triggerWords) ? resource.triggerWords : [],
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

function CompatibilitySummary({ compatibility }) {
  if (!compatibility) return null;
  const ok = compatibility.ok;
  const messages = ok ? compatibility.warnings || [] : compatibility.issues || [];
  return (
    <div className={`compatibility-summary ${ok ? "ok" : "bad"}`}>
      <strong>{ok ? "资源校验通过" : "资源不兼容"}</strong>
      <span>{compatibilityLabel(compatibility)}</span>
      {messages.slice(0, 2).map((item) => <p key={`${item.code}-${item.resourceName}`}>{item.message}</p>)}
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

function ModelsScreen({ checkpoints, webuiOnline, resources: initialResources, setResources: setAppResources, refreshStatus }) {
  const [resources, setResources] = useState(initialResources);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("checkpoint");

  useEffect(() => {
    if (initialResources) {
      setResources(initialResources);
    } else {
      loadResources();
    }
  }, [initialResources]);

  async function loadResources({ scan = false } = {}) {
    try {
      setError("");
      const response = scan ? await apiPost("/api/resources/scan", {}) : await apiGet("/api/resources");
      setResources(response);
      setAppResources?.(response);
      if (scan) await refreshStatus();
    } catch (error) {
      setError(error.message);
    }
  }

  async function updateProfile(profile, patch) {
    try {
      setError("");
      const response = await apiPut("/api/resources/profile", { type: profile.type, name: profile.name, ...patch });
      setResources(response.resources);
      setAppResources?.(response.resources);
    } catch (error) {
      setError(error.message);
    }
  }

  const profiles = resources?.profiles || [];
  const tabs = [
    ["checkpoint", "Checkpoint"],
    ["lora", "LoRA"],
    ["vae", "VAE"],
    ["controlnet", "ControlNet"],
    ["pending", "待标注"],
  ];
  const rows = activeTab === "pending"
    ? profiles.filter((profile) => profile.baseType === "unknown" && ["lora", "controlnet"].includes(profile.type))
    : profiles.filter((profile) => profile.type === activeTab);

  return (
    <section className="screen active">
      <div className="panel full-panel">
        <PanelHeader
          title="模型资源兼容性"
          text="管理 Checkpoint、LoRA、VAE、ControlNet 的架构类型和兼容规则。"
          button={<button className="primary-action" onClick={() => loadResources({ scan: true })}>刷新索引</button>}
        />
        {error && <div className="inline-error">{error}</div>}
        <div className="resource-tabs">
          {tabs.map(([key, label]) => (
            <button key={key} className={activeTab === key ? "active" : ""} onClick={() => setActiveTab(key)}>
              {label}
            </button>
          ))}
        </div>
        <div className="resource-profile-list">
          {rows.length ? rows.map((profile) => (
            <ResourceProfileRow
              key={`${profile.type}-${profile.name}`}
              profile={profile}
              checkpoints={profiles.filter((item) => item.type === "checkpoint")}
              vaes={profiles.filter((item) => item.type === "vae")}
              onChange={(patch) => updateProfile(profile, patch)}
            />
          )) : (
            <div className="empty-gallery compact-empty">
              <strong>{webuiOnline ? "没有资源" : "A1111 离线"}</strong>
              <span>{webuiOnline ? "点击刷新索引，或把模型文件放入 A1111 对应目录。" : "启动 A1111 后再扫描资源。"}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ResourceProfileRow({ profile, checkpoints, vaes, onChange }) {
  const [draft, setDraft] = useState(profile);
  const checkpointListId = `checkpoint-options-${profile.type}-${normalizeResourceKey(profile.name) || "resource"}`;

  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  function setDraftValue(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function save() {
    onChange({
      ...draft,
      recommendedSize: sizeFromText(draft.recommendedSize),
      triggerWords: listFromText(draft.triggerWords),
      compatibleCheckpoints: listFromText(draft.compatibleCheckpoints),
      blockedCheckpoints: listFromText(draft.blockedCheckpoints),
    });
  }

  return (
    <div className={`resource-profile-row ${profile.baseType === "unknown" ? "needs-review" : ""}`}>
      <div className="resource-profile-main">
        <strong>{profile.name}</strong>
        <span>{profile.type} · {profile.path || profile.source || "local"}</span>
      </div>
      <div className="resource-profile-fields">
        <label>Base
          <select value={draft.baseType || "unknown"} onChange={(event) => setDraftValue("baseType", event.target.value)}>
            {["sd15", "sdxl", "pony", "flux", "universal", "unknown"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        {profile.type === "checkpoint" && (
          <>
            <label>VAE
              <select value={draft.preferredVae || "Automatic"} onChange={(event) => setDraftValue("preferredVae", event.target.value)}>
                <option value="Automatic">Automatic</option>
                {vaes.map((vae) => <option key={vae.name} value={vae.name}>{vae.name}</option>)}
              </select>
            </label>
            <label className="resource-profile-wide">Recommended
              <input value={sizeText(draft.recommendedSize)} onChange={(event) => setDraftValue("recommendedSize", event.target.value)} />
            </label>
          </>
        )}
        {profile.type === "lora" && (
          <>
            <label>Weight<input type="number" step="0.05" value={draft.defaultWeight || 0.75} onChange={(event) => setDraftValue("defaultWeight", Number(event.target.value))} /></label>
            <label>Trigger<input value={textFromList(draft.triggerWords)} onChange={(event) => setDraftValue("triggerWords", event.target.value)} /></label>
          </>
        )}
        {profile.type === "controlnet" && (
          <>
            <label>Control<input value={draft.controlType || ""} onChange={(event) => setDraftValue("controlType", event.target.value)} /></label>
            <label>Preprocessor<input value={draft.defaultPreprocessor || ""} onChange={(event) => setDraftValue("defaultPreprocessor", event.target.value)} /></label>
            <label>Module<input value={draft.defaultModule || ""} onChange={(event) => setDraftValue("defaultModule", event.target.value)} /></label>
            <label>Weight<input type="number" step="0.05" value={draft.defaultControlWeight || 1} onChange={(event) => setDraftValue("defaultControlWeight", Number(event.target.value))} /></label>
          </>
        )}
        {profile.type !== "checkpoint" && (
          <>
            <label className="resource-profile-wide">Compatible
              <input
                list={checkpointListId}
                value={textFromList(draft.compatibleCheckpoints)}
                onChange={(event) => setDraftValue("compatibleCheckpoints", event.target.value)}
                placeholder={checkpoints[0]?.name || "按 baseType 自动匹配"}
              />
            </label>
            <label className="resource-profile-wide">Blocked
              <input
                list={checkpointListId}
                value={textFromList(draft.blockedCheckpoints)}
                onChange={(event) => setDraftValue("blockedCheckpoints", event.target.value)}
                placeholder="逗号分隔"
              />
            </label>
          </>
        )}
        <label>Notes<input value={draft.notes || ""} onChange={(event) => setDraftValue("notes", event.target.value)} /></label>
        <datalist id={checkpointListId}>
          {checkpoints.map((checkpoint) => (
            <option key={checkpoint.name} value={checkpoint.name}>{checkpoint.title || checkpoint.name}</option>
          ))}
        </datalist>
      </div>
      <button className="small-button" onClick={save}>保存</button>
    </div>
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


function SettingsScreen({ providerName, backendOnline, providerStatus, health, engineModels, refreshStatus }) {
  const [status, setStatus] = useState(providerStatus || null);
  const [providers, setProviders] = useState([]);
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState(defaultProviderForm());
  const [localLlm, setLocalLlm] = useState(null);
  const [selectedLocalModel, setSelectedLocalModel] = useState("gemma4:e4b");
  const [libraryQuery, setLibraryQuery] = useState("qwen");
  const [libraryModels, setLibraryModels] = useState([]);
  const [librarySource, setLibrarySource] = useState("");
  const [modelInfo, setModelInfo] = useState(null);
  const [pullConfirmModel, setPullConfirmModel] = useState("");
  const [pullTask, setPullTask] = useState(null);
  const [runtimeSettings, setRuntimeSettings] = useState({ lowPerformanceMode: false });
  const [testResult, setTestResult] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [activeSection, setActiveSection] = useState("providers");
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [providerModalMode, setProviderModalMode] = useState("create");

  useEffect(() => {
    void loadProviderData();
  }, [providerName]);

  useEffect(() => {
    void loadPullTasks();
  }, []);

  useEffect(() => {
    if (!pullTask || !["queued", "running"].includes(pullTask.status)) return undefined;
    const timer = window.setInterval(() => {
      void refreshPullTask(pullTask.id);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pullTask?.id, pullTask?.status]);

  useEffect(() => {
    if (!providerModalOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape" && busy !== "save") closeProviderModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [providerModalOpen, busy]);

  async function loadProviderData() {
    try {
      const [providerResponse, localResponse, settingsResponse] = await Promise.all([
        apiGet("/api/providers"),
        apiGet("/api/local-llm/status").catch(() => null),
        apiGet("/api/settings/runtime").catch(() => null),
      ]);
      setProviders(providerResponse.providers || []);
      setStatus(providerResponse.active || providerStatus || null);
      setLocalLlm(localResponse);
      setSelectedLocalModel((current) => resolveSelectedLocalModel(current, providerResponse.active || providerStatus, localResponse));
      if (settingsResponse?.settings) setRuntimeSettings(settingsResponse.settings);
      setError("");
    } catch (error) {
      setError(error.message);
    }
  }

  function openCreateProvider(preset = {}) {
    setEditingId("");
    setProviderModalMode("create");
    setForm(defaultProviderForm(preset));
    setTestResult(null);
    setProviderModalOpen(true);
    setActiveSection("providers");
  }

  function openEditProvider(provider) {
    setEditingId(provider.id);
    setProviderModalMode("edit");
    setForm({
      name: provider.name || "",
      type: provider.type || "openai-compatible",
      baseUrl: provider.baseUrl || "",
      model: provider.model || "",
      apiKey: "",
      keepApiKey: provider.hasApiKey,
      isActive: provider.isActive,
    });
    setTestResult(null);
    setProviderModalOpen(true);
    setActiveSection("providers");
  }

  function closeProviderModal() {
    setProviderModalOpen(false);
    setEditingId("");
    setForm(defaultProviderForm());
  }

  async function saveProvider() {
    try {
      setBusy("save");
      setError("");
      const payload = providerPayload(form);
      const response = editingId
        ? await apiPut("/api/providers/" + editingId, payload)
        : await apiPost("/api/providers", payload);
      setStatus(response.active);
      const providerResponse = await apiGet("/api/providers");
      setProviders(providerResponse.providers || []);
      setEditingId(response.provider?.id || "");
      setForm((current) => ({ ...current, apiKey: "", keepApiKey: response.provider?.hasApiKey || false }));
      closeProviderModal();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy("");
    }
  }

  async function activateProvider(id) {
    try {
      setBusy("activate:" + id);
      setError("");
      const response = await apiPost("/api/providers/" + id + "/activate", {});
      setStatus(response.active);
      await loadProviderData();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy("");
    }
  }

  async function deleteProvider(id) {
    try {
      setBusy("delete:" + id);
      setError("");
      const response = await apiDelete("/api/providers/" + id);
      setStatus(response.active);
      if (editingId === id) closeProviderModal();
      await loadProviderData();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy("");
    }
  }

  async function testProvider(id = "") {
    try {
      setBusy(id ? "test:" + id : "test");
      setError("");
      const response = id
        ? await apiPost("/api/providers/" + id + "/test", {})
        : await apiPost("/api/providers/test", {});
      setTestResult(response.samplePlan ? response : { provider: response.provider });
      setStatus(response.active || response.provider || status);
      await loadProviderData();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy("");
    }
  }

  async function searchLibrary(query = libraryQuery) {
    try {
      setBusy("library-search");
      setError("");
      const response = await apiGet(`/api/local-llm/library?q=${encodeURIComponent(query || "")}`);
      setLibraryModels(response.models || []);
      setLibrarySource(response.source || "");
      setPullConfirmModel("");
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy("");
    }
  }

  async function loadPullTasks() {
    try {
      const response = await apiGet("/api/local-llm/pulls?limit=5");
      const latest = (response.tasks || []).find((task) => ["queued", "running"].includes(task.status)) || (response.tasks || [])[0] || null;
      setPullTask(latest);
    } catch {
      setPullTask(null);
    }
  }

  async function refreshPullTask(id) {
    if (!id) return;
    try {
      const response = await apiGet(`/api/local-llm/pulls/${id}`);
      setPullTask(response.task);
      if (["succeeded", "failed"].includes(response.task?.status)) {
        await loadProviderData();
      }
    } catch (error) {
      setError(error.message);
    }
  }

  async function pullSelectedModel(model = selectedLocalModel, options = {}) {
    const modelName = String(model || "").trim();
    if (!modelName) return;
    try {
      const knownInfo = modelInfo?.selectedTag?.name === modelName || modelInfo?.model === modelName ? modelInfo : null;
      let preflight = knownInfo;
      if (!preflight) {
        setBusy("model-info");
        preflight = await apiGet(`/api/local-llm/model-info?model=${encodeURIComponent(modelName)}`);
        setModelInfo(preflight);
      }
      const riskLevel = preflight?.fit?.level;
      if (["warning", "danger", "unknown"].includes(riskLevel) && !options.force && pullConfirmModel !== modelName) {
        setPullConfirmModel(modelName);
        setError(riskLevel === "danger" ? "该模型预检结果不建议运行。确认仍要拉取时，请再次点击拉取按钮。" : "该模型可能占用较高资源。确认仍要拉取时，请再次点击拉取按钮。");
        return;
      }
      setBusy("pull-model");
      setError("");
      const response = await apiPost("/api/local-llm/pull", { model: modelName, force: options.force || pullConfirmModel === modelName });
      if (!response.ok) throw new Error(response.error || response.stderr || "Model pull failed");
      if (response.task) setPullTask(response.task);
      setSelectedLocalModel(modelName);
      setPullConfirmModel("");
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy("");
    }
  }

  async function inspectLocalModel(model = selectedLocalModel) {
    const modelName = String(model || "").trim();
    if (!modelName) return;
    try {
      setBusy("model-info");
      setError("");
      setSelectedLocalModel(modelName);
      const response = await apiGet(`/api/local-llm/model-info?model=${encodeURIComponent(modelName)}`);
      setModelInfo(response);
      setPullConfirmModel("");
      const recommended = response.selectedTag?.name;
      if (recommended && !modelName.includes(":") && recommended !== modelName) setSelectedLocalModel(recommended);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy("");
    }
  }

  async function createLocalProvider(model = selectedLocalModel) {
    const resolvedModel = model || selectedLocalModel || localLlm?.model || "gemma4:e4b";
    try {
      setBusy("local-provider");
      setError("");
      const response = await apiPost("/api/providers", {
        name: `Local ${resolvedModel}`,
        type: "local",
        baseUrl: localLlm?.baseUrl || "http://127.0.0.1:11434/v1",
        model: resolvedModel,
        apiKey: "",
        isActive: true,
      });
      setStatus(response.active);
      await loadProviderData();
      setActiveSection("providers");
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy("");
    }
  }

  async function deleteLocalModel(model) {
    const modelName = String(model || "").trim();
    if (!modelName) return;
    if (status?.type === "local" && status?.model === modelName) {
      setError("该模型正在被当前 Provider 使用，请先切换 Provider 后再删除。");
      return;
    }
    if (!window.confirm(`确认删除本地模型 ${modelName}？删除后如需使用需要重新拉取。`)) return;
    try {
      setBusy("delete-model:" + modelName);
      setError("");
      const response = await apiDelete(`/api/local-llm/models/${encodeURIComponent(modelName)}`);
      if (!response.ok) throw new Error(response.error || response.stderr || "Model delete failed");
      if (selectedLocalModel === modelName) setSelectedLocalModel("");
      setPullConfirmModel("");
      await loadProviderData();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy("");
    }
  }

  async function saveRuntimeSettings(nextSettings) {
    try {
      setBusy("runtime-settings");
      setError("");
      const response = await apiPut("/api/settings/runtime", nextSettings);
      setRuntimeSettings(response.settings || nextSettings);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy("");
    }
  }

  async function refreshAllSettings() {
    await Promise.all([
      loadProviderData(),
      refreshStatus ? refreshStatus() : Promise.resolve(),
    ]);
  }

  const a1111 = engineModels?.engines?.a1111 || health?.engines?.a1111 || null;
  const sections = [
    { id: "providers", title: "大模型 Provider", desc: "提示词规划与任务解析" },
    { id: "local", title: "本地大模型", desc: "Ollama 与 Gemma 状态" },
    { id: "runtime", title: "性能与显存", desc: "省显存运行策略" },
    { id: "image", title: "生图后端", desc: "A1111 连接与模型目录" },
    { id: "diagnostics", title: "系统诊断", desc: "服务状态与刷新" },
  ];

  return (
    <section className="screen active settings-page">
      <div className="settings-shell">
        <aside className="settings-nav panel">
          <div className="settings-nav-title">
            <strong>系统设置</strong>
            <span>管理大模型 Provider、本地模型、性能策略和运行诊断。</span>
          </div>
          <div className="settings-nav-list">
            {sections.map((item) => (
              <button key={item.id} className={activeSection === item.id ? "active" : ""} onClick={() => setActiveSection(item.id)}>
                <strong>{item.title}</strong>
                <span>{item.desc}</span>
              </button>
            ))}
          </div>
          <div className="settings-nav-footer">
            <StatusRow label="后端" value={backendOnline ? "在线" : "离线"} tone={backendOnline ? "ok" : "bad"} />
            <StatusRow label="Provider" value={status?.type || "env"} tone={status?.type ? "ok" : ""} />
          </div>
        </aside>

        <div className="settings-content">
          {error && <div className="inline-error">{error}</div>}
          {activeSection === "providers" && (
            <ProviderSettingsPanel
              providers={providers}
              status={status}
              busy={busy}
              testResult={testResult}
              onCreate={() => openCreateProvider()}
              onEdit={openEditProvider}
              onActivate={activateProvider}
              onDelete={deleteProvider}
              onTest={testProvider}
            />
          )}
          {activeSection === "local" && (
            <LocalLlmSettingsPanel
              localLlm={localLlm}
              selectedModel={selectedLocalModel}
              libraryQuery={libraryQuery}
              libraryModels={libraryModels}
              librarySource={librarySource}
              modelInfo={modelInfo}
              pullConfirmModel={pullConfirmModel}
              pullTask={pullTask}
              status={status}
              busy={busy}
              onRefresh={loadProviderData}
              onModelChange={(model) => {
                setSelectedLocalModel(model);
                setPullConfirmModel("");
              }}
              onLibraryQueryChange={setLibraryQuery}
              onSearchLibrary={searchLibrary}
              onInspectModel={inspectLocalModel}
              onPullModel={pullSelectedModel}
              onDeleteModel={deleteLocalModel}
              onCreateLocalProvider={createLocalProvider}
              onTest={() => testProvider()}
            />
          )}
          {activeSection === "runtime" && (
            <RuntimeSettingsPanel
              settings={runtimeSettings}
              busy={busy === "runtime-settings"}
              localLlm={localLlm}
              a1111={a1111}
              onChange={(nextSettings) => {
                setRuntimeSettings(nextSettings);
                void saveRuntimeSettings(nextSettings);
              }}
            />
          )}
          {activeSection === "image" && <ImageBackendSettingsPanel a1111={a1111} />}
          {activeSection === "diagnostics" && (
            <DiagnosticsSettingsPanel
              health={health}
              a1111={a1111}
              localLlm={localLlm}
              status={status}
              busy={busy}
              onRefresh={refreshAllSettings}
            />
          )}
        </div>
      </div>
      {providerModalOpen && (
        <ProviderModal
          mode={providerModalMode}
          form={form}
          busy={busy === "save"}
          onClose={closeProviderModal}
          onSave={saveProvider}
          onFormChange={(key, value) => setFormValue(setForm, key, value)}
        />
      )}
    </section>
  );
}

function ProviderSettingsPanel({ providers, status, busy, testResult, onCreate, onEdit, onActivate, onDelete, onTest }) {
  return (
    <div className="panel provider-manager settings-section-card settings-wide">
      <PanelHeader title="大模型 Provider" text="配置用于提示词规划、任务解析和内容理解的大语言模型服务。" button={<button className="primary-action" onClick={onCreate}>新增 Provider</button>} />
      <div className="provider-table" role="table">
        <div className="provider-table-row head" role="row">
          <span>名称</span>
          <span>协议</span>
          <span>模型</span>
          <span>Base URL</span>
          <span>状态</span>
          <span>操作</span>
        </div>
        {providers.length ? providers.map((provider) => (
          <div key={provider.id} className={"provider-table-row " + (provider.isActive ? "active" : "")} role="row">
            <span>
              <strong>{provider.name || provider.type}</strong>
              <small>{provider.hasApiKey ? "已保存 API Key" : "无 API Key"}</small>
            </span>
            <span>{provider.type}</span>
            <span>{provider.model || "-"}</span>
            <span><small>{provider.baseUrl || "默认端点"}</small></span>
            <span>
              <strong className={provider.isActive ? "ok" : ""}>{provider.isActive ? "当前使用" : "已保存"}</strong>
              <small className={provider.testStatus === "ok" ? "ok model-ready" : ""}>{provider.testStatus === "ok" ? "✓ 模型可用" : "未验证"}</small>
            </span>
            <span className="provider-actions">
              {!provider.isActive && <button className="small-button" onClick={() => onActivate(provider.id)} disabled={Boolean(busy)}>启用</button>}
              <button className="small-button" onClick={() => onTest(provider.id)} disabled={Boolean(busy)}>{busy === "test:" + provider.id ? "测试中" : "测试"}</button>
              <button className="small-button" onClick={() => onEdit(provider)}>编辑</button>
              <button className="small-button danger-button" onClick={() => onDelete(provider.id)} disabled={Boolean(busy)}>删除</button>
            </span>
          </div>
        )) : (
          <div className="empty-state">暂无已保存 Provider。当前使用环境变量回退：{status?.type || "env"}。</div>
        )}
      </div>
    </div>
  );
}

function ProviderModal({ mode, form, busy, onClose, onSave, onFormChange }) {
  const isEdit = mode === "edit";
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div className="modal-panel provider-modal" role="dialog" aria-modal="true" aria-label={isEdit ? "编辑 Provider" : "新增 Provider"}>
        <div className="modal-header">
          <div>
            <h2>{isEdit ? "编辑 Provider" : "新增 Provider"}</h2>
            <p>API Key 会加密保存在本机，页面不会回显明文。</p>
          </div>
          <button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭">×</button>
        </div>
        <div className="settings-form single-column provider-modal-form">
          <label>名称<input value={form.name} onChange={(event) => onFormChange("name", event.target.value)} /></label>
          <label>协议类型
            <select value={form.type} onChange={(event) => onFormChange("type", event.target.value)}>
              <option value="local">local</option>
              <option value="openai-compatible">openai-compatible</option>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
              <option value="mock">mock</option>
            </select>
          </label>
          <label>Base URL<input value={form.baseUrl} onChange={(event) => onFormChange("baseUrl", event.target.value)} placeholder="http://127.0.0.1:11434/v1" /></label>
          <label>模型<input value={form.model} onChange={(event) => onFormChange("model", event.target.value)} placeholder="gemma4:e4b" /></label>
          <label>API Key<input type="password" value={form.apiKey} onChange={(event) => onFormChange("apiKey", event.target.value)} placeholder={form.keepApiKey ? "已保存密钥，留空表示保持不变" : "可留空"} /></label>
          <label className="check-row"><input type="checkbox" checked={form.isActive} onChange={(event) => onFormChange("isActive", event.target.checked)} />保存后立即启用</label>
        </div>
        <div className="modal-actions">
          <button className="small-button" onClick={onClose} disabled={busy}>取消</button>
          <button className="primary-action" onClick={onSave} disabled={busy}>{busy ? <BusyLabel text="保存中" /> : "保存"}</button>
        </div>
      </div>
    </div>
  );
}

function LocalLlmSettingsPanel({ localLlm, selectedModel, libraryQuery, libraryModels, librarySource, modelInfo, pullConfirmModel, pullTask, status, busy, onRefresh, onModelChange, onLibraryQueryChange, onSearchLibrary, onInspectModel, onPullModel, onDeleteModel, onCreateLocalProvider, onTest }) {
  const models = Array.isArray(localLlm?.models) ? localLlm.models : [];
  const installedModels = Array.isArray(localLlm?.installedModels) && localLlm.installedModels.length
    ? localLlm.installedModels
    : models.map((name) => ({ name, sizeLabel: "", modifiedAt: "", details: {} }));
  const selectValue = selectedModel || localLlm?.model || models[0] || "gemma4:e4b";
  const selectedInstalled = models.includes(selectValue);
  const needsPullConfirm = pullConfirmModel === selectValue;
  const activeLocalModel = status?.type === "local" ? status?.model : "";
  const selectedTag = modelInfo?.tags?.find((tag) => tag.name === selectValue) || modelInfo?.selectedTag;
  const pulling = pullTask && ["queued", "running"].includes(pullTask.status);
  return (
    <div className="panel settings-section-card">
      <PanelHeader title="本地大模型" text={localLlm?.serviceOnline ? "Ollama 服务在线，可管理已安装模型并创建本地 Provider。" : "使用 Ollama 提供本地 OpenAI-compatible 接口。"} button={<button className="small-button" onClick={onRefresh}>刷新</button>} />
      <div className="provider-matrix roomy">
        <div><strong>Ollama</strong><span>{localLlm?.installed ? localLlm.version || "已安装" : "未安装"}</span></div>
        <div><strong>服务</strong><span>{localLlm?.serviceOnline ? "http://127.0.0.1:11434" : "未连接"}</span></div>
        <div><strong>已安装模型</strong><span>{models.length ? `${models.length} 个模型` : "未检测到模型"}</span></div>
        <div><strong>当前 Provider</strong><span>{status?.name || status?.type || "环境变量"}</span></div>
      </div>
      <div className="local-model-table" role="table">
        <div className="local-model-row head" role="row">
          <span>模型</span>
          <span>大小</span>
          <span>状态</span>
          <span>操作</span>
        </div>
        {installedModels.length ? installedModels.map((model) => {
          const modelName = model.name || model.model;
          const isSelected = modelName === selectValue;
          const isActive = modelName === activeLocalModel;
          return (
            <div key={modelName} className={`local-model-row ${isSelected ? "selected" : ""} ${isActive ? "active" : ""}`} role="row">
              <span>
                <strong>{modelName}</strong>
                <small>{model.details?.parameter_size || model.details?.family || "Ollama 模型"}</small>
              </span>
              <span>{model.sizeLabel || "-"}</span>
              <span>
                <strong className={isActive ? "ok" : ""}>{isActive ? "当前 Provider" : "已安装"}</strong>
                {isSelected && !isActive ? <small className="ok">已选中</small> : null}
              </span>
              <span className="provider-actions">
                <button className="small-button" onClick={() => onModelChange(modelName)} disabled={Boolean(busy) || isSelected}>选择</button>
                <button className="small-button" onClick={() => onCreateLocalProvider(modelName)} disabled={Boolean(busy)}>设为 Provider</button>
                <button className="small-button danger-button" onClick={() => onDeleteModel(modelName)} disabled={Boolean(busy) || isActive}>{busy === "delete-model:" + modelName ? "删除中" : "删除"}</button>
              </span>
            </div>
          );
        }) : (
          <div className="empty-state">暂无本地模型。可以在下方搜索 Ollama 云端模型库并拉取。</div>
        )}
      </div>
      <div className="local-library-search">
        <div className="local-library-controls">
          <label>搜索 Ollama 云端模型库
            <input value={libraryQuery} onChange={(event) => onLibraryQueryChange(event.target.value)} placeholder="qwen / llama / mistral" />
          </label>
          <button className="small-button" onClick={() => onSearchLibrary(libraryQuery)} disabled={Boolean(busy)}>{busy === "library-search" ? "搜索中" : "搜索"}</button>
        </div>
        <div className="library-source">{librarySource ? `来源：${librarySource}` : "搜索结果会从 Ollama 官方模型库读取，失败时使用推荐列表兜底。"}</div>
        {libraryModels?.length ? (
          <div className="library-model-list">
            {libraryModels.map((model) => (
              <button key={model.pullName || model.name} type="button" onClick={() => onInspectModel(model.pullName || model.name)}>
                <strong>{model.name}</strong>
                <span>{models.includes(model.pullName || model.name) ? "已安装" : "未安装 · 可拉取"}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {modelInfo && (
        <div className={`model-fit-card ${modelInfo.fit?.level || "unknown"}`}>
          <div>
            <strong>{modelInfo.fit?.label || "模型预检"}</strong>
            <span>{modelInfo.fit?.reason || "无法静态判断模型运行情况。"}</span>
          </div>
          <div>
            <strong>已选择尺寸</strong>
            <span>{selectedTag?.name || selectValue}{selectedTag?.sizeLabel ? ` · ${selectedTag.sizeLabel}` : ""}{selectedTag?.context ? ` · ${selectedTag.context} context` : ""}</span>
          </div>
          <div>
            <strong>硬件</strong>
            <span>{modelInfo.hardware?.gpuName || "GPU 未检测"} · 显存 {modelInfo.hardware?.gpuFreeGb || modelInfo.hardware?.gpuMemoryGb || "-"}GB / 内存 {modelInfo.hardware?.systemMemoryGb || "-"}GB</span>
          </div>
          {modelInfo.tags?.length ? (
            <div className="model-size-picker">
              <label>选择模型尺寸 / Tag
                <select value={selectedTag?.name || selectValue} onChange={(event) => onInspectModel(event.target.value)}>
                  {modelInfo.tags.slice(0, 24).map((tag) => (
                    <option key={tag.name} value={tag.name}>
                      {(tag.name.split(":")[1] || tag.name) + (tag.sizeLabel ? ` · ${tag.sizeLabel}` : "") + (tag.context ? ` · ${tag.context} context` : "")}
                    </option>
                  ))}
                </select>
              </label>
              <span>选择后会重新预检，拉取按钮会下载当前选中的具体 tag。</span>
            </div>
          ) : null}
          {needsPullConfirm && (
            <div className="model-pull-confirm">
              预检提示该模型可能带来较高显存/内存压力。再次点击“确认拉取”才会开始下载。
            </div>
          )}
        </div>
      )}
      {pullTask && (
        <div className={`model-pull-task ${pullTask.status}`}>
          <div className="model-pull-task-head">
            <div>
              <strong>{pullTask.model}</strong>
              <span>{pullStatusLabel(pullTask)}</span>
            </div>
            <strong>{Math.round(pullTask.progress || 0)}%</strong>
          </div>
          <div className="model-pull-progress"><span style={{ width: `${Math.max(0, Math.min(100, pullTask.progress || 0))}%` }} /></div>
          {pullTask.error ? <div className="model-pull-error">{pullTask.error}</div> : null}
          {pullTask.logs?.length ? <small>{pullTask.logs.slice(-1)[0]}</small> : null}
        </div>
      )}
      <div className="button-row">
        <button className={needsPullConfirm ? "small-button danger-button" : "small-button"} onClick={() => onPullModel(selectValue)} disabled={Boolean(busy) || pulling || !localLlm?.installed || !selectValue}>{busy === "pull-model" ? "创建任务中" : pulling ? "下载中" : needsPullConfirm ? "确认拉取" : "拉取选中模型"}</button>
        <button className="small-button" onClick={onTest} disabled={Boolean(busy)}>{busy === "test" ? "测试中" : "测试当前 Provider"}</button>
      </div>
    </div>
  );
}

function pullStatusLabel(task = {}) {
  if (task.status === "succeeded") return "下载完成";
  if (task.status === "failed") return task.progressLabel || "下载失败";
  return task.progressLabel || task.statusText || "下载中";
}

function RuntimeSettingsPanel({ settings, busy, localLlm, a1111, onChange }) {
  const lowPerformanceMode = Boolean(settings?.lowPerformanceMode);
  const setMode = (enabled) => {
    if (busy || enabled === lowPerformanceMode) return;
    onChange({ ...settings, lowPerformanceMode: enabled });
  };
  return (
    <div className="panel settings-section-card runtime-settings-panel settings-wide">
      <PanelHeader title="性能与显存" text="选择本地大模型与 A1111 同机运行时的显存策略。" />
      <div className="runtime-mode-banner">
        <div>
          <span>当前模式</span>
          <strong>{lowPerformanceMode ? "省显存模式" : "标准模式"}</strong>
        </div>
        <span className={lowPerformanceMode ? "runtime-mode-pill danger" : "runtime-mode-pill"}>
          {busy ? "保存中" : lowPerformanceMode ? "低峰值 / 慢启动" : "快速响应"}
        </span>
      </div>

      <div className="runtime-mode-grid">
        <button type="button" className={!lowPerformanceMode ? "selected" : ""} onClick={() => setMode(false)} disabled={busy}>
          <strong>标准模式</strong>
          <span>优先响应速度，Ollama 与 A1111 按各自运行状态保留模型。</span>
          <small>适合显存充足或只运行单侧任务。</small>
        </button>
        <button type="button" className={lowPerformanceMode ? "selected danger" : ""} onClick={() => setMode(true)} disabled={busy}>
          <strong>省显存模式</strong>
          <span>生图前释放 Ollama 模型，生图完成后卸载 A1111 checkpoint。</span>
          <small>适合同机运行 LLM + WebUI，但速度会明显变慢。</small>
        </button>
      </div>

      <div className="runtime-warning">
        <strong>速度影响提示</strong>
        <span>开启省显存模式后，每次规划/生图可能触发模型重新加载，等待时间会明显增加。</span>
      </div>

      <div className="runtime-flow-list">
        <div>
          <strong>1. 生成规划</strong>
          <span>{lowPerformanceMode ? "按需调用当前 Provider；完成后保留最少运行状态。" : "保持常规 Provider 调用流程。"}</span>
        </div>
        <div>
          <strong>2. 提交 A1111 生图</strong>
          <span>{lowPerformanceMode ? "提交前执行 Ollama stop，尽量释放 LLM 占用显存。" : "不主动干预 Ollama 模型。"}</span>
        </div>
        <div>
          <strong>3. 生图完成</strong>
          <span>{lowPerformanceMode ? "任务结束后卸载 A1111 checkpoint，降低闲置显存占用。" : "保留 A1111 当前 checkpoint，后续生图更快。"}</span>
        </div>
      </div>

      <div className="runtime-status-grid">
        <DiagnosticCard title="Ollama" value={localLlm?.serviceOnline ? "在线" : "离线"} detail={localLlm?.models?.length ? `${localLlm.models.length} 个模型` : "未检测到模型"} ok={Boolean(localLlm?.serviceOnline)} />
        <DiagnosticCard title="A1111" value={a1111?.running ? "在线" : "离线"} detail={a1111?.baseUrl || "http://127.0.0.1:7860"} ok={Boolean(a1111?.running)} />
        <DiagnosticCard title="策略" value={lowPerformanceMode ? "省显存" : "标准"} detail={lowPerformanceMode ? "低峰值，慢启动" : "高响应，占用更高"} ok />
      </div>
    </div>
  );
}

function ImageBackendSettingsPanel({ a1111 }) {
  const modelDirs = a1111?.modelDirs || {};
  return (
    <div className="panel settings-section-card settings-wide">
      <PanelHeader title="生图后端" text="当前只接入 A1111，ComfyUI 暂不显示。" />
      <div className="provider-matrix roomy">
        <div><strong>当前后端</strong><span>A1111</span></div>
        <div><strong>地址</strong><span>{a1111?.baseUrl || "http://127.0.0.1:7860"}</span></div>
        <div><strong>状态</strong><span>{a1111?.running ? "在线" : "离线"}</span></div>
        <div><strong>健康检查</strong><span>{a1111?.health?.ok ? "通过" : "未通过"}</span></div>
      </div>
      <div className="settings-path-list">
        <div><strong>Checkpoint</strong><span>{modelDirs.checkpoints || "-"}</span></div>
        <div><strong>LoRA</strong><span>{modelDirs.loras || "-"}</span></div>
        <div><strong>VAE</strong><span>{modelDirs.vae || "-"}</span></div>
        <div><strong>ControlNet</strong><span>{modelDirs.controlnet || "-"}</span></div>
      </div>
    </div>
  );
}

function DiagnosticsSettingsPanel({ health, a1111, localLlm, status, busy, onRefresh }) {
  return (
    <div className="panel settings-section-card">
      <PanelHeader title="系统诊断" text="查看关键服务状态，必要时手动刷新。" button={<button className="small-button" onClick={onRefresh} disabled={Boolean(busy)}>刷新</button>} />
      <div className="diagnostics-grid">
        <DiagnosticCard title="Backend" value={health?.ok ? "在线" : "未知"} detail={health?.inferenceBackend || "a1111"} ok={Boolean(health?.ok)} />
        <DiagnosticCard title="A1111" value={a1111?.running ? "在线" : "离线"} detail={a1111?.baseUrl || "http://127.0.0.1:7860"} ok={Boolean(a1111?.running)} />
        <DiagnosticCard title="Ollama" value={localLlm?.serviceOnline ? "在线" : "离线"} detail={localLlm?.modelInstalled ? "gemma4:e4b 已安装" : "Gemma 未就绪"} ok={Boolean(localLlm?.serviceOnline)} />
        <DiagnosticCard title="Provider" value={status?.name || status?.type || "环境变量"} detail={status?.model || status?.baseUrl || "-"} ok={Boolean(status)} />
      </div>
    </div>
  );
}

function DiagnosticCard({ title, value, detail, ok }) {
  return (
    <div className="diagnostic-card">
      <span>{title}</span>
      <strong className={ok ? "ok" : "bad"}>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ProtocolSettingsPanel({ testResult }) {
  return (
    <div className="panel settings-section-card">
      <PanelHeader title="协议说明" text={testResult ? "最近 Provider 测试完成：" + (testResult.latencyMs || "-") + "ms" : "当前支持的大语言模型 Provider 类型。"} />
      <div className="provider-matrix roomy">
        <div><strong>OpenAI</strong><span>官方 OpenAI API 配置</span></div>
        <div><strong>OpenAI-compatible</strong><span>通过 Base URL + Model 适配本地服务和第三方网关</span></div>
        <div><strong>Anthropic</strong><span>Anthropic-compatible 消息生成</span></div>
        <div><strong>Local</strong><span>Ollama、LM Studio、llama.cpp 等本地运行时</span></div>
        <div><strong>Mock</strong><span>用于离线 UI 和工作流测试</span></div>
      </div>
    </div>
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

async function apiPut(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
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

function defaultProviderForm(overrides = {}) {
  return {
    name: overrides.name || "Local Gemma 4 E4B",
    type: overrides.type || "local",
    baseUrl: overrides.baseUrl || "http://127.0.0.1:11434/v1",
    model: overrides.model || "gemma4:e4b",
    apiKey: "",
    keepApiKey: Boolean(overrides.hasApiKey),
    isActive: Boolean(overrides.isActive),
  };
}

function resolveSelectedLocalModel(current, activeProvider, localLlm) {
  const models = Array.isArray(localLlm?.models) ? localLlm.models : [];
  if (current && models.includes(current)) return current;
  if (activeProvider?.type === "local" && activeProvider.model && models.includes(activeProvider.model)) return activeProvider.model;
  if (localLlm?.model && models.includes(localLlm.model)) return localLlm.model;
  return models[0] || activeProvider?.model || localLlm?.model || current || "gemma4:e4b";
}

function providerPayload(form = {}) {
  const payload = {
    name: form.name,
    type: form.type,
    baseUrl: form.baseUrl,
    model: form.model,
    isActive: form.isActive,
  };
  if (form.apiKey || !form.keepApiKey) payload.apiKey = form.apiKey || "";
  return payload;
}

function setFormValue(setForm, key, value) {
  setForm((current) => ({ ...current, [key]: value }));
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
  const enabled = targetDiffers && (plan.hires_fix === true || (source.enabled === true && source.mode !== "resize"));
  if (!enabled) return false;
  return {
    enabled: true,
    mode: source.mode || "hires",
    target_width: targetWidth,
    target_height: targetHeight,
    denoising_strength: clampNumber(source.denoising_strength, 0, 1, 0.2),
    upscaler: source.upscaler || "Lanczos",
    second_pass_steps: clampNumber(source.second_pass_steps, 1, 80, Math.max(10, Math.round(Number(plan.steps || 8) * 0.6))),
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
    mode: "hires",
    target_width: targetWidth,
    target_height: targetHeight,
    denoising_strength: 0.2,
    upscaler: "Lanczos",
    second_pass_steps: Math.max(10, Math.round(Number(plan.steps || 8) * 0.6)),
  };
  return { ...current, enabled: true, target_width: targetWidth, target_height: targetHeight, ...patch };
}

function setHiresEnabled(setPlan, enabled) {
  setPlan((plan) => {
    if (!enabled) {
      return { ...plan, hires_fix: false };
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
    next.hires_fix = shouldEnable && isHiresEnabled(next)
      ? nextHiresFix({ ...next, target_width: targetWidth, target_height: targetHeight }, { enabled: true, target_width: targetWidth, target_height: targetHeight })
      : false;
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
    return `生成 ${base} · 原尺寸输出`;
  }
  return isHiresEnabled(plan)
    ? `生成 ${base} → 高清修复 ${targetWidth}x${targetHeight}`
    : `生成 ${base} → 普通放大 ${targetWidth}x${targetHeight}`;
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

function appendPromptTags(value, tags = []) {
  const currentTags = splitPromptTags(value);
  const seen = new Set(currentTags.map((tag) => tag.toLowerCase()));
  const nextTags = [...currentTags];
  for (const tag of tags) {
    const normalized = String(tag || "").trim();
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    nextTags.push(normalized);
  }
  return nextTags.join(", ");
}

function formatPromptTags(value) {
  return splitPromptTags(value).join(", ");
}

function splitPromptTags(value) {
  return String(value || "")
    .replace(/\r?\n/g, ",")
    .replace(/[;；，、]+/g, ",")
    .split(",")
    .map((tag) => tag.trim().replace(/\s+/g, " "))
    .filter(Boolean);
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
      hires_fix: shouldTarget && isHiresEnabled(plan) ? nextHiresFix(next, { target_width: next.target_width, target_height: next.target_height }) : false,
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

function validatePlanForUi(plan = {}, resources = {}) {
  const profiles = resources?.profiles || [];
  if (!profiles.length || !plan.checkpoint) return { ok: true, issues: [], warnings: [], resolvedVae: "Automatic" };
  const checkpoint = findResourceProfile(profiles, "checkpoint", plan.checkpoint);
  const issues = [];
  const warnings = [];
  if (!checkpoint) {
    issues.push({ code: "CHECKPOINT_NOT_FOUND", message: `Checkpoint not indexed: ${plan.checkpoint}`, resourceName: plan.checkpoint });
    return { ok: false, issues, warnings, resolvedVae: "Automatic" };
  }
  if (checkpoint.baseType === "flux") issues.push({ code: "FLUX_UNSUPPORTED", message: `Flux checkpoint is not supported by A1111: ${checkpoint.name}`, resourceName: checkpoint.name });
  if (checkpoint.baseType === "unknown") warnings.push({ code: "CHECKPOINT_UNKNOWN", message: `Checkpoint needs annotation: ${checkpoint.name}`, resourceName: checkpoint.name });
  for (const lora of normalizeLorasForUi(plan.lora)) {
    const profile = findResourceProfile(profiles, "lora", lora.name);
    if (!profile) issues.push({ code: "LORA_NOT_FOUND", message: `LoRA not indexed: ${lora.name}`, resourceName: lora.name });
    else if (!resourceCompatible(profile, checkpoint)) issues.push({ code: "LORA_INCOMPATIBLE", message: `LoRA ${profile.name} (${profile.baseType}) 不兼容 ${checkpoint.name} (${checkpoint.baseType})`, resourceName: profile.name });
  }
  for (const control of Array.isArray(plan.controlnet) ? plan.controlnet : []) {
    const name = typeof control === "string" ? control : control?.name || control?.model || "";
    if (!name) continue;
    const profile = findResourceProfile(profiles, "controlnet", name);
    if (!profile) issues.push({ code: "CONTROLNET_NOT_FOUND", message: `ControlNet not indexed: ${name}`, resourceName: name });
    else if (!resourceCompatible(profile, checkpoint)) issues.push({ code: "CONTROLNET_INCOMPATIBLE", message: `ControlNet ${profile.name} (${profile.baseType}) 不兼容 ${checkpoint.name} (${checkpoint.baseType})`, resourceName: profile.name });
  }
  const resolvedVae = checkpoint.preferredVae || "Automatic";
  if (resolvedVae && resolvedVae !== "Automatic") {
    const vae = findResourceProfile(profiles, "vae", resolvedVae);
    if (!vae || !resourceCompatible(vae, checkpoint)) issues.push({ code: "VAE_INCOMPATIBLE", message: `VAE ${resolvedVae} 不兼容 ${checkpoint.name}`, resourceName: resolvedVae });
  }
  return { ok: !issues.length, issues, warnings, checkpoint, resolvedVae };
}

function compatibilityLabel(compatibility = {}) {
  if (!compatibility.checkpoint) return "资源校验待扫描";
  const base = compatibility.checkpoint.baseType || "unknown";
  const vae = compatibility.resolvedVae || "Automatic";
  return compatibility.ok ? `${base} · VAE ${vae}` : compatibility.issues?.[0]?.message || "资源不兼容";
}

function compatibleLoraOptions(checkpointName, resources = {}, fallback = []) {
  const profiles = resources?.profiles || [];
  const checkpoint = findResourceProfile(profiles, "checkpoint", checkpointName);
  const compatible = checkpoint
    ? profiles.filter((profile) => profile.type === "lora" && resourceCompatible(profile, checkpoint))
    : [];
  if (compatible.length) return compatible.map((profile) => ({
    name: profile.name,
    alias: profile.title || profile.name,
    defaultWeight: profile.defaultWeight,
    triggerWords: profile.triggerWords,
  }));
  return fallback;
}

function resourceCompatible(profile, checkpoint) {
  if (!profile || !checkpoint) return false;
  if (checkpointListIncludes(profile.blockedCheckpoints, checkpoint)) return false;
  if (checkpointListIncludes(profile.compatibleCheckpoints, checkpoint)) return true;
  if (profile.baseType === "universal") return true;
  if (profile.baseType === "unknown" || checkpoint.baseType === "unknown") return false;
  return profile.baseType === checkpoint.baseType;
}

function checkpointListIncludes(values = [], checkpoint = {}) {
  const checkpointKeys = [checkpoint.name, checkpoint.title, checkpoint.path].map(normalizeResourceKey).filter(Boolean);
  return (Array.isArray(values) ? values : []).some((value) => {
    const key = normalizeResourceKey(value);
    return key && checkpointKeys.some((checkpointKey) => checkpointKey === key || checkpointKey.includes(key) || key.includes(checkpointKey));
  });
}

function findResourceProfile(profiles = [], type, name) {
  const needle = normalizeResourceKey(name);
  return profiles.find((profile) => profile.type === type && [profile.name, profile.title, profile.path].some((value) => normalizeResourceKey(value) === needle))
    || profiles.find((profile) => profile.type === type && [profile.name, profile.title, profile.path].some((value) => {
      const key = normalizeResourceKey(value);
      return key && needle && (key.includes(needle) || needle.includes(key));
    }));
}

function normalizeResourceKey(value) {
  return String(value || "").toLowerCase().replace(/\.(safetensors|ckpt|pt|pth)$/g, "").replace(/\[[a-f0-9]{8,}\]/g, "").replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function textFromList(value) {
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function listFromText(value) {
  if (Array.isArray(value)) return value;
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function sizeText(value = {}) {
  if (typeof value === "string") return value;
  const square = value.square || {};
  const portrait = value.portrait || {};
  const landscape = value.landscape || {};
  return [
    `square=${square.width || 512}x${square.height || 512}`,
    `portrait=${portrait.width || 512}x${portrait.height || 768}`,
    `landscape=${landscape.width || 768}x${landscape.height || 512}`,
  ].join(", ");
}

function sizeFromText(value = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const output = {};
  for (const part of String(value || "").split(",")) {
    const match = part.trim().match(/^(square|portrait|landscape)\s*=\s*(\d{3,4})\s*x\s*(\d{3,4})$/i);
    if (!match) continue;
    output[match[1].toLowerCase()] = {
      width: Number(match[2]),
      height: Number(match[3]),
    };
  }
  return output;
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
