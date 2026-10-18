/**
 * piano-dot.js — 钢琴音频解锁状态点（右下角）
 *
 * 灰 = 钢琴脚本未就绪
 * 橙 = AudioContext 未解锁
 * 绿 = 已解锁（AudioContext running）
 *
 * 点击圆点：真实手势内强制 ensureAudio + resume，不改现有播放逻辑。
 * 仅观察 + 手动兜底。
 */
(function () {
  "use strict";

  var DOT_ID = "piano-audio-dot";
  var POLL_MS = 2000;

  function ready() {
    return typeof window.PianoAudio !== "undefined" && window.PianoAudio;
  }

  function isUnlocked() {
    if (!ready()) return false;
    try { return window.PianoAudio.isUnlocked(); } catch (e) { return false; }
  }

  function ensureDot() {
    var el = document.getElementById(DOT_ID);
    if (el) return el;
    el = document.createElement("button");
    el.id = DOT_ID;
    el.type = "button";
    el.setAttribute("aria-label", "音频解锁状态");
    el.title = "音频解锁";
    el.style.cssText =
      "position:fixed;right:10px;bottom:max(10px,env(safe-area-inset-bottom));" +
      "width:22px;height:22px;border-radius:50%;border:1.5px solid rgba(255,255,255,.25);" +
      "padding:0;margin:0;z-index:9999;cursor:pointer;opacity:.85;" +
      "background:#888;-webkit-tap-highlight-color:transparent;";
    el.addEventListener("click", onDotClick);
    document.body.appendChild(el);
    return el;
  }

  function setColor(el, state) {
    var bg = "#888", border = "rgba(255,255,255,.25)";
    if (state === "orange") { bg = "#e8930c"; border = "rgba(255,255,255,.4)"; }
    else if (state === "green") { bg = "#2ecc71"; border = "rgba(255,255,255,.4)"; }
    el.style.background = bg;
    el.style.borderColor = border;
    el.dataset.state = state;
  }

  function refresh() {
    var el = ensureDot();
    if (!ready()) { setColor(el, "gray"); return; }
    setColor(el, isUnlocked() ? "green" : "orange");
  }

  function onDotClick(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!ready()) return;
    try {
      window.PianoAudio.forceUnlock();
      var n = 0;
      var iv = setInterval(function () {
        if (isUnlocked() || ++n > 10) { clearInterval(iv); refresh(); }
      }, 300);
    } catch (err) {}
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      ensureDot(); refresh();
      setInterval(refresh, POLL_MS);
    });
  } else {
    ensureDot(); refresh();
    setInterval(refresh, POLL_MS);
  }
})();
