const titles = {
  overview: "总览工作台",
  generate: "自然语言生图",
  edit: "智能改图",
  lora: "LoRA 炼制",
  models: "模型管家",
  queue: "任务队列",
  settings: "Provider / API 设置",
};

function currentScreen() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("screen") || "overview";
  return titles[requested] ? requested : "overview";
}

function setScreen(name, push = true) {
  const screen = titles[name] ? name : "overview";
  document.querySelectorAll("[data-screen-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.screenPanel === screen);
  });
  document.querySelectorAll("[data-screen]").forEach((button) => {
    button.classList.toggle("active", button.dataset.screen === screen);
  });
  document.getElementById("screen-title").textContent = titles[screen];
  if (push) {
    const url = new URL(window.location.href);
    url.searchParams.set("screen", screen);
    window.history.replaceState({}, "", url);
  }
}

document.querySelectorAll("[data-screen]").forEach((button) => {
  button.addEventListener("click", () => setScreen(button.dataset.screen));
});

setScreen(currentScreen(), false);

