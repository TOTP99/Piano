(() => {
  "use strict";
  /* 结构：配置/曲库 → 键盘 → 音频引擎 → MIDI → 调度 → 选曲/存储 → 哼唱 → 事件绑定 */

  /* ========================================================================
   * 自动弹奏钢琴
   * 模块：曲库 → 键盘 → 滚动 → 音频引擎 → 调度演奏 → 选曲 UI → 控制事件
   * ======================================================================== */

  // ========== 1. 曲库 ==========
  const SONG_LIBRARY = [];

  const LIB_STORAGE_KEY = "autoPiano.songLibrary.v2";

  function serializeLibrary(lib) {
    return lib.map(function (s) {
      const en = s.nameEn || s.name;
      return {
        id: s.id,
        name: en,
        nameEn: en,
        nameZh: s.nameZh || null,
        showZh: !!s.showZh,
        desc: s.desc || "",
        tempo: s.tempo || 92,
        melody: s.melody || [],
        chords: s.chords || {},
        chordOrder: s.chordOrder || [],
        midiEvents: s.midiEvents || null
      };
    });
  }

  function saveLibraryToStorage() {
    try {
      localStorage.setItem(LIB_STORAGE_KEY, JSON.stringify(serializeLibrary(SONG_LIBRARY)));
    } catch (e) {
      console.warn("曲库保存失败", e);
    }
  }

  /** 将原始 JSON 曲目规范为库内结构（兼容 name / nameEn / nameZh） */
  function songEntryFromRaw(s) {
    if (!s || !(s.name || s.nameEn)) return null;
    const en = s.nameEn || s.name;
    const zh = s.nameZh || null;
    const showZh = !!s.showZh && !!zh;
    return {
      id: s.id || ("import_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7)),
      name: showZh ? zh : en,
      nameEn: en,
      nameZh: zh,
      showZh: showZh,
      desc: s.desc || "",
      tempo: s.tempo || 92,
      melody: Array.isArray(s.melody) ? s.melody : [],
      chords: s.chords || {},
      chordOrder: Array.isArray(s.chordOrder) ? s.chordOrder : [],
      midiEvents: Array.isArray(s.midiEvents) ? s.midiEvents : null
    };
  }

  function loadLibraryFromStorage() {
    try {
      const raw = localStorage.getItem(LIB_STORAGE_KEY);
      if (!raw) return false;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return false;
      SONG_LIBRARY.length = 0;
      arr.forEach(function (s) {
        const entry = songEntryFromRaw(s);
        if (entry) SONG_LIBRARY.push(entry);
      });
      return SONG_LIBRARY.length > 0;
    } catch (e) {
      console.warn("曲库读取失败", e);
      return false;
    }
  }

  /**
   * 自动读取与页面同目录的 auto-piano-library.json 并合并进曲库。
   * - 已有相同 id：用文件中的曲目覆盖本地
   * - 新 id：追加
   * - file:// 或文件不存在时静默失败
   */
  const SIDE_CAR_LIBRARY_FILE = "auto-piano-library.json";

  function extractSongsFromLibraryJson(obj) {
    if (obj && obj.format === "autoPiano.library.v1" && Array.isArray(obj.songs)) return obj.songs;
    if (obj && obj.format === "autoPiano.song.v1" && obj.song) return [obj.song];
    if (Array.isArray(obj)) return obj;
    if (obj && (obj.id || obj.name || obj.nameEn)) return [obj];
    return [];
  }

  /** @returns {Promise<{added:number, updated:number}>} */
  async function loadLibraryFromSidecar() {
    let url;
    try {
      url = new URL(SIDE_CAR_LIBRARY_FILE, window.location.href).href;
    } catch (e) {
      return { added: 0, updated: 0 };
    }
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) return { added: 0, updated: 0 };
      const obj = await res.json();
      const songs = extractSongsFromLibraryJson(obj);
      if (!songs.length) return { added: 0, updated: 0 };
      let added = 0, updated = 0;
      songs.forEach(function (s) {
        const entry = songEntryFromRaw(s);
        if (!entry) return;
        const exist = SONG_LIBRARY.findIndex(function (x) { return x.id === entry.id; });
        if (exist >= 0) {
          SONG_LIBRARY[exist] = entry; // 同 id 覆盖
          updated++;
        } else {
          SONG_LIBRARY.push(entry);
          added++;
        }
      });
      return { added: added, updated: updated };
    } catch (e) {
      console.info("[曲库] 未自动加载 " + SIDE_CAR_LIBRARY_FILE + "（可忽略）", e && e.message ? e.message : e);
      return { added: 0, updated: 0 };
    }
  }

  loadLibraryFromStorage();

  let currentSong = SONG_LIBRARY[0] || {
    id: "empty", name: "（空）", desc: "", tempo: 92, melody: [], chords: {}, chordOrder: []
  };
  let songListExpanded = false; // 默认只显示当前曲目，点击可展开/收起全部曲库
  let melody = (currentSong.melody || []).slice();
  let chords = Object.assign({}, currentSong.chords || {});
  let chordOrder = (currentSong.chordOrder || []).slice();
  if (currentSong.midiEvents && currentSong.midiEvents.length) {
    // 延后到 midiEvents 变量声明后由首屏状态处理；此处仅 melody 初始化
  }

  // ========== 2. 88 键键盘 ==========
  const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const WHITE_NOTES = new Set(["C","D","E","F","G","A","B"]);
  function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
  function midiToName(midi) {
    return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
  }
  function isWhite(midi) { return WHITE_NOTES.has(NOTE_NAMES[midi % 12]); }

  const ALL_KEYS = [];
  for (let m = 21; m <= 108; m++) {
    ALL_KEYS.push({ midi: m, name: midiToName(m), freq: midiToFreq(m), white: isWhite(m) });
  }
  const freqMap = {};
  ALL_KEYS.forEach(k => { freqMap[k.name] = k.freq; });

  /** 移调：按半音升降，超出 88 键范围则夹紧到边界 */
  function transposeNote(note) {
    if (!note || note === "-" || note === "rest" || !transposeSemis) return note;
    let midi = null;
    for (let i = 0; i < ALL_KEYS.length; i++) {
      if (ALL_KEYS[i].name === note) { midi = ALL_KEYS[i].midi; break; }
    }
    if (midi == null) return note;
    const m = Math.max(21, Math.min(108, midi + transposeSemis));
    return midiToName(m);
  }


  const DEFAULT_WHITE_W = 18, DEFAULT_BLACK_W = 11;
  let WHITE_W = DEFAULT_WHITE_W, BLACK_W = DEFAULT_BLACK_W;
  let compactKeyHeight = null; // 横屏紧凑模式下的键高 {white, black}；null = 使用 CSS 默认高度

  /** 根据 A0–C8 生成白键/黑键 DOM */
  function buildKeyboard() {
    const kb = document.getElementById("keyboard");
    kb.innerHTML = "";
    const whites = ALL_KEYS.filter(k => k.white);
    kb.style.width = (whites.length * WHITE_W) + "px";
    whites.forEach(k => {
      const el = document.createElement("div");
      el.className = "key white";
      el.style.width = WHITE_W + "px";
      el.style.height = compactKeyHeight ? (compactKeyHeight.white + "px") : "";
      el.dataset.note = k.name;
      el.dataset.midi = k.midi;
      const lab = document.createElement("span");
      lab.className = "note-label";
      lab.textContent = k.name;
      if (NOTE_NAMES[k.midi % 12] === "C") {
        lab.classList.add("c-mark");
        lab.textContent = "C" + (Math.floor(k.midi / 12) - 1);
      }
      el.appendChild(lab);
      kb.appendChild(el);
    });
    let wi = 0;
    ALL_KEYS.forEach(k => {
      if (k.white) { wi++; return; }
      const el = document.createElement("div");
      el.className = "key black";
      el.style.width = BLACK_W + "px";
      el.style.height = compactKeyHeight ? (compactKeyHeight.black + "px") : "";
      el.dataset.note = k.name;
      el.dataset.midi = k.midi;
      el.style.left = (wi * WHITE_W - BLACK_W / 2) + "px";
      const lab = document.createElement("span");
      lab.className = "note-label";
      lab.textContent = k.name;
      el.appendChild(lab);
      kb.appendChild(el);
    });
  }
  buildKeyboard();

  /** 横屏紧凑模式：按可用宽度重新计算键宽，让 52 个白键全部可见，无需横向滚动 */
  function fitKeyboardToViewport() {
    const wrap = document.getElementById("keyboardWrap");
    if (!wrap) return;
    const whiteCount = ALL_KEYS.filter(k => k.white).length;
    const cs = getComputedStyle(wrap);
    const hPad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const vPad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const availW = Math.max(200, wrap.clientWidth - hPad - 4); // 留 4px 安全余量
    let w = (availW / whiteCount);
    w = Math.max(7, Math.min(DEFAULT_WHITE_W, w));
    const b = Math.max(4, Math.round(w * 0.6));
    WHITE_W = w; BLACK_W = b;
    const availH = Math.max(60, wrap.clientHeight - vPad);
    const whiteH = Math.max(64, Math.min(140, availH));
    compactKeyHeight = { white: whiteH, black: Math.round(whiteH * 0.64) };
    buildKeyboard();
  }
  /** 退出横屏紧凑模式：恢复默认键宽/键高 */
  function resetKeyboardFit() {
    WHITE_W = DEFAULT_WHITE_W; BLACK_W = DEFAULT_BLACK_W;
    compactKeyHeight = null;
    buildKeyboard();
  }

  // ========== 3. 平滑滚动 ==========
  let scrollRaf = null, scrollTarget = null, userScrolling = false, userScrollTimer = null;
  function getWrap() { return document.getElementById("keyboardWrap"); }
  function maxScroll() {
    const w = getWrap();
    return w ? Math.max(0, w.scrollWidth - w.clientWidth) : 0;
  }
  /** 将视口平滑滚动到给定音名集合的中心 */
  function centerOnNotes(notes) {
    const wrap = getWrap();
    if (!wrap || !notes || !notes.length) return;
    let minL = Infinity, maxR = -Infinity, found = false;
    notes.forEach(n => {
      if (!n || n === "-" || n === "rest") return;
      const el = document.querySelector('.key[data-note="' + n + '"]');
      if (!el) return;
      found = true;
      minL = Math.min(minL, el.offsetLeft);
      maxR = Math.max(maxR, el.offsetLeft + el.offsetWidth);
    });
    if (!found) return;
    scrollTarget = Math.max(0, Math.min(maxScroll(), (minL + maxR) / 2 - wrap.clientWidth / 2));
    startSmoothScroll();
  }
  function startSmoothScroll() {
    if (scrollRaf || userScrolling) return;
    function step() {
      const wrap = getWrap();
      if (!wrap || scrollTarget === null || userScrolling) { scrollRaf = null; return; }
      const cur = wrap.scrollLeft;
      const diff = scrollTarget - cur;
      if (Math.abs(diff) < 0.35) {
        wrap.scrollLeft = scrollTarget;
        scrollRaf = null;
        return;
      }
      const speed = Math.min(0.22, Math.max(0.06, Math.abs(diff) / 400));
      wrap.scrollLeft = cur + diff * speed;
      scrollRaf = requestAnimationFrame(step);
    }
    scrollRaf = requestAnimationFrame(step);
  }
  function scrollToCenter() { centerOnNotes(["C4"]); }
  (function setupUserScroll() {
    const wrap = getWrap();
    if (!wrap) return;
    function lock() { userScrolling = true; if (userScrollTimer) clearTimeout(userScrollTimer); }
    function unlock() {
      if (userScrollTimer) clearTimeout(userScrollTimer);
      userScrollTimer = setTimeout(() => {
        userScrolling = false;
        if (isPlaying) {
          const notes = [];
          if (previewNote) notes.push(previewNote);
          document.querySelectorAll(".key.active").forEach(el => notes.push(el.dataset.note));
          if (notes.length) centerOnNotes(notes);
        }
      }, 800);
    }
    wrap.addEventListener("touchstart", lock, { passive: true });
    wrap.addEventListener("mousedown", lock);
    wrap.addEventListener("touchend", unlock, { passive: true });
    wrap.addEventListener("mouseup", unlock);
    wrap.addEventListener("mouseleave", unlock);
  })();
  setTimeout(scrollToCenter, 50);

  // ========== 4. 音频引擎（合成钢琴 · 踏板 · 混响）==========
  let audioCtx = null;
  let masterGain = null;
  let compNode = null;
  let dryGain = null;
  let wetGain = null;
  let reverbNode = null;
  let bodyBus = null;
  let bodyResonators = [];
  let pedalDown = false;
  let sustainedGains = [];
  let resonanceGains = [];
  let activeVoiceLoad = 0;
  const MAX_RESONANCE_VOICES = 24;
  let audioSessionNoteCount = 0;
  const AUDIO_REBUILD_THRESHOLD = 400; // 单个音频上下文累计发声次数超过此值后，停止时重建，规避 Safari 长时间高负载后音频线程劣化
  let pedalEnabled = true;
  let showNoteNames = true;
  let expressionEnabled = true;
  let expressionCurve = [];
  let midiEvents = null;
  let midiTimerIds = [];
  let midiEndTimer = null;
  let midiPlaying = false;
  let midiAbsStart = 0;
  let midiBeatOffset = 0;
  let midiNextIndex = 0;
  let midiRaf = null;
  let mainVol = 0.58, chordVol = 0.32;
  let transposeSemis = 0;
  let loopEnabled = false;
  let reverbAmount = 0.32;

  // 若启动时当前曲是 MIDI，恢复事件表
  if (currentSong.midiEvents && currentSong.midiEvents.length) {
    midiEvents = currentSong.midiEvents.slice();
    melody = [];
    chords = {};
    chordOrder = [];
  }

  (function syncInitialStatus() {
    const statusEl = document.getElementById("status");
    if (statusEl) statusEl.textContent = SONG_LIBRARY.length ? ("准备就绪 — 当前：《" + currentSong.name + "》") : "准备就绪 — 曲库为空，请添加曲目";
  })();

  // 启动时自动合并同目录 auto-piano-library.json（同 id 覆盖本地曲目）
  loadLibraryFromSidecar().then(function (result) {
    const added = result && result.added ? result.added : 0;
    const updated = result && result.updated ? result.updated : 0;
    if (!added && !updated) {
      if (!SONG_LIBRARY.length) {
        const statusEl = document.getElementById("status");
        if (statusEl) {
          statusEl.textContent = "曲库为空 — 可将 auto-piano-library.json 放在本页同目录，或点「曲目」导入";
        }
      }
      return;
    }
    saveLibraryToStorage();
    // 当前曲若被覆盖，重新 loadSong 以刷新旋律/MIDI
    const still = currentSong && SONG_LIBRARY.find(function (s) { return s.id === currentSong.id; });
    if (still) {
      try { loadSong(still); } catch (e) { currentSong = still; }
    } else if (!currentSong || currentSong.id === "empty" || !still) {
      try { loadSong(SONG_LIBRARY[0]); } catch (e) {
        currentSong = SONG_LIBRARY[0];
      }
    }
    try { renderSongList(); renderMiniSongList(); updateNowPlaying(); } catch (e) {}
    const statusEl = document.getElementById("status");
    if (statusEl) {
      var parts = [];
      if (added) parts.push("新加 " + added + " 首");
      if (updated) parts.push("覆盖 " + updated + " 首");
      statusEl.textContent = "已从 auto-piano-library.json " + parts.join("、") + " · 当前：《" + currentSong.name + "》";
    }
  });

  /** 更自然的厅堂脉冲：立体声扩散 + 早期反射 + 短 pre-delay */
  function makeImpulseResponse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    const preDelay = Math.floor(rate * 0.012);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      const side = c === 0 ? 1 : -1;
      for (let i = 0; i < len; i++) {
        if (i < preDelay) { data[i] = 0; continue; }
        const j = i - preDelay;
        const env = Math.pow(1 - j / (len - preDelay), decay);
        let s = (Math.random() * 2 - 1) * env;
        const taps = [0.011, 0.019, 0.028, 0.041, 0.057, 0.073];
        for (let k = 0; k < taps.length; k++) {
          const di = Math.floor(taps[k] * rate);
          if (j === di) s += (0.32 - k * 0.04) * side * (Math.random() > 0.5 ? 1 : -1);
        }
        const comb = Math.floor(rate * (0.015 + c * 0.003));
        if (j > comb) s += data[i - comb] * 0.11 * env;
        data[i] = s * 0.78;
      }
    }
    return buf;
  }

  function ensureAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    compNode = audioCtx.createDynamicsCompressor();
    compNode.threshold.value = -22;
    compNode.knee.value = 18;
    compNode.ratio.value = 2.4;
    compNode.attack.value = 0.004;
    compNode.release.value = 0.28;
    compNode.connect(audioCtx.destination);

    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.8;
    masterGain.connect(compNode);

    dryGain = audioCtx.createGain();
    dryGain.gain.value = 0.74;
    dryGain.connect(masterGain);

    wetGain = audioCtx.createGain();
    wetGain.gain.value = reverbAmount;
    wetGain.connect(masterGain);

    reverbNode = audioCtx.createConvolver();
    reverbNode.buffer = makeImpulseResponse(audioCtx, 2.4, 2.8);
    reverbNode.connect(wetGain);

    bodyBus = audioCtx.createGain();
    bodyBus.gain.value = 0.11;
    bodyBus.connect(dryGain);
    bodyBus.connect(reverbNode);

    bodyResonators = [];
    [92, 148, 220, 310].forEach(function (fq) {
      const bp = audioCtx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = fq;
      bp.Q.value = 8.5;
      const g = audioCtx.createGain();
      g.gain.value = 0.55;
      bp.connect(g);
      g.connect(bodyBus);
      bodyResonators.push(bp);
    });
    audioSessionNoteCount = 0;
  }

  // Safari 等浏览器在长时间、高密度音符（尤其踏板延音叠加）播放后，
  // 音频渲染线程可能劣化（卡顿/变速），且不一定能靠 resume() 自愈。
  // 停止播放时若判断本次会话负载过高或上下文状态异常，直接整体重建，
  // 保证下一首曲子有一个干净的音频图。
  function rebuildAudioGraph() {
    if (!audioCtx) return;
    const old = audioCtx;
    try { old.close(); } catch (e) {}
    audioCtx = null;
    masterGain = null; dryGain = null; wetGain = null;
    reverbNode = null; bodyBus = null; compNode = null;
    bodyResonators = [];
    sustainedGains = [];
    resonanceGains = [];
    activeVoiceLoad = 0;
    ensureAudio();
  }

  async function resumeAudio() {
    ensureAudio();
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch (e) {}
    }
    if (audioCtx.state !== "running") {
      // resume 也救不回来，直接重建
      rebuildAudioGraph();
      try { await audioCtx.resume(); } catch (e) {}
    }
  }

  const activeTimeouts = new Map();

  function setKeyState(note, state) {
    const el = document.querySelector('.key[data-note="' + note + '"]');
    if (!el) return;
    el.classList.remove("active", "next");
    if (state) el.classList.add(state);
  }
  function clearAllHighlights() {
    document.querySelectorAll(".key.active, .key.next").forEach(function (el) {
      el.classList.remove("active", "next");
    });
    activeTimeouts.forEach(function (id) { clearTimeout(id); });
    activeTimeouts.clear();
  }

  /** 延音踏板：受 pedalEnabled 控制；抬起时同时收掉弦间共鸣 */
  function setPedal(on) {
    if (on && !pedalEnabled) on = false;
    if (on === pedalDown) return;
    pedalDown = on;
    if (!on && audioCtx) {
      const now = audioCtx.currentTime;
      function fadeList(list, sec) {
        list.forEach(function (g) {
          try {
            g.gain.cancelScheduledValues(now);
            g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
            g.gain.exponentialRampToValueAtTime(0.0001, now + sec);
          } catch (e) {}
        });
      }
      fadeList(sustainedGains, 0.38);
      fadeList(resonanceGains, 0.55);
      sustainedGains = [];
      resonanceGains = [];
    }
  }

  /**
   * 合成钢琴 v2：
   * - 更锐利的琴锤瞬态（噪声 + 短促敲击正弦）
   * - 9 层谐波 + 非谐 + 力度相关衰减
   * - 力度相关低通（轻触暗、重触亮）
   * - 踏板弦间共鸣（八度/五度/同音级极轻长尾）
   * - 声板 resonator 总线
   * - 立体声按弦位平移
   */
  function playNote(note, duration, volume, when, opts) {
    duration = duration == null ? 0.4 : duration;
    volume = volume == null ? 0.4 : volume;
    when = when || 0;
    opts = opts || {};
    if (!note || note === "-" || note === "rest") return;
    if (!Number.isFinite(duration) || !Number.isFinite(volume) || !Number.isFinite(when)) return;
    if (!audioCtx) ensureAudio();
    const f = freqMap[note];
    if (!f || volume < 0.001) return;
    audioSessionNoteCount++;

    const t0 = when > 0 ? when : audioCtx.currentTime;
    const midiApprox = 69 + 12 * Math.log2(f / 440);
    const heightAtten = 1 - Math.max(0, (midiApprox - 58) * 0.0065) + Math.max(0, (50 - midiApprox) * 0.004);
    const human = 0.92 + Math.random() * 0.12;
    const vel = Math.max(0.0001, Math.min(1, volume * heightAtten * human));
    const sustainExtra = pedalDown ? 1.55 : 0;
    const bodyDur = duration + sustainExtra;

    // 并发音符负载计数：避免长曲目在踏板延音堆叠时产生过多音频节点，
    // 在低性能设备上导致卡顿/失声
    activeVoiceLoad++;
    const voiceLifetimeMs = Math.max(0, (t0 - audioCtx.currentTime) + bodyDur + 3.5) * 1000;
    setTimeout(function () { activeVoiceLoad = Math.max(0, activeVoiceLoad - 1); }, voiceLifetimeMs);
    const isOverloaded = activeVoiceLoad > MAX_RESONANCE_VOICES;

    const pan = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
    if (pan) {
      const p = Math.max(-0.58, Math.min(0.58, (midiApprox - 60) / 42));
      pan.pan.setValueAtTime(p, t0);
    }

    const noteGain = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();
    filter.type = "lowpass";
    const bright = 2800 + f * 0.55 + vel * 3200;
    const dark = 420 + f * 0.12 + vel * 180;
    filter.frequency.setValueAtTime(bright, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(dark, 160), t0 + Math.min(0.55, bodyDur * 0.55));
    filter.Q.value = 0.55 + (1 - vel) * 0.35;

    // 琴锤瞬态：更短更亮噪声 + 短促敲击正弦
    try {
      const nLen = Math.floor(audioCtx.sampleRate * 0.016);
      const nBuf = audioCtx.createBuffer(1, nLen, audioCtx.sampleRate);
      const nd = nBuf.getChannelData(0);
      for (let i = 0; i < nLen; i++) {
        nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (nLen * 0.11));
      }
      const nSrc = audioCtx.createBufferSource();
      nSrc.buffer = nBuf;
      const nBp = audioCtx.createBiquadFilter();
      nBp.type = "bandpass";
      nBp.frequency.value = Math.min(7800, 1600 + f * 4.2 + vel * 1200);
      nBp.Q.value = 0.75;
      const nG = audioCtx.createGain();
      nG.gain.setValueAtTime(vel * (0.18 + vel * 0.08), t0);
      nG.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.022);
      nSrc.connect(nBp);
      nBp.connect(nG);
      nG.connect(noteGain);
      nSrc.start(t0);
      nSrc.stop(t0 + 0.03);

      const click = audioCtx.createOscillator();
      const cg = audioCtx.createGain();
      click.type = "sine";
      click.frequency.setValueAtTime(Math.min(2400, 700 + f * 1.8), t0);
      click.frequency.exponentialRampToValueAtTime(Math.max(180, f * 0.6), t0 + 0.012);
      cg.gain.setValueAtTime(vel * 0.12, t0);
      cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.014);
      click.connect(cg);
      cg.connect(noteGain);
      click.start(t0);
      click.stop(t0 + 0.02);
    } catch (e) {}

    // 谐波：非谐 + 力度相关衰减
    const B = 0.00014;
    const partials = [
      { n: 1, amp: 0.50, decay: 1.05, type: "triangle" },
      { n: 2, amp: 0.30, decay: 1.35, type: "sine" },
      { n: 3, amp: 0.16, decay: 1.75, type: "sine" },
      { n: 4, amp: 0.10, decay: 2.15, type: "sine" },
      { n: 5, amp: 0.055, decay: 2.55, type: "sine" },
      { n: 6, amp: 0.032, decay: 2.95, type: "sine" },
      { n: 7, amp: 0.018, decay: 3.35, type: "sine" },
      { n: 8, amp: 0.011, decay: 3.75, type: "sine" },
      { n: 9, amp: 0.006, decay: 4.10, type: "sine" }
    ];

    partials.forEach(function (p) {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = p.type;
      const fn = p.n * f * Math.sqrt(1 + B * p.n * p.n);
      osc.frequency.setValueAtTime(fn, t0);
      osc.detune.setValueAtTime((Math.random() - 0.5) * 2.2, t0);
      const ampScale = p.n <= 2 ? 1 : (0.55 + vel * 0.55);
      const peak = vel * p.amp * ampScale;
      const decayMul = 1 + (1 - vel) * 0.45 * Math.max(0, p.n - 2);
      const pEnd = t0 + Math.min(bodyDur * p.decay / decayMul, bodyDur + 0.7);
      const atk = 0.003 + (1 - vel) * 0.01 + (p.n > 4 ? 0.004 : 0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
      g.gain.exponentialRampToValueAtTime(peak * (0.55 + vel * 0.15), t0 + 0.055 + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, pEnd);
      osc.connect(g);
      g.connect(filter);
      osc.start(t0);
      osc.stop(pEnd + 0.05);
    });

    // 基音下八度轻共鸣
    if (midiApprox > 36) {
      const sub = audioCtx.createOscillator();
      const sg = audioCtx.createGain();
      sub.type = "sine";
      sub.frequency.setValueAtTime(f * 0.5, t0);
      const subPeak = vel * (pedalDown ? 0.055 : 0.028);
      sg.gain.setValueAtTime(0.0001, t0);
      sg.gain.exponentialRampToValueAtTime(subPeak, t0 + 0.06);
      sg.gain.exponentialRampToValueAtTime(0.0001, t0 + bodyDur * 1.05);
      sub.connect(sg);
      sg.connect(filter);
      sub.start(t0);
      sub.stop(t0 + bodyDur + 0.25);
    }

    // 踏板弦间共鸣（负载过高时跳过，优先保证主音符正常发声）
    if (pedalDown && vel > 0.08 && !isOverloaded) {
      const ratios = [0.5, 2, 1.5, 3];
      const levels = [0.04, 0.035, 0.022, 0.015];
      ratios.forEach(function (r, i) {
        const rf = f * r;
        if (rf < 28 || rf > 4200) return;
        const ro = audioCtx.createOscillator();
        const rg = audioCtx.createGain();
        ro.type = "sine";
        ro.frequency.setValueAtTime(rf * (1 + (Math.random() - 0.5) * 0.0015), t0);
        const peak = vel * levels[i];
        rg.gain.setValueAtTime(0.0001, t0);
        rg.gain.exponentialRampToValueAtTime(peak, t0 + 0.12 + i * 0.03);
        rg.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.8 + duration);
        ro.connect(rg);
        rg.connect(dryGain);
        ro.start(t0);
        ro.stop(t0 + 3.2 + duration);
        resonanceGains.push(rg);
      });
    }

    const attack = 0.004 + (1 - vel) * 0.012;
    noteGain.gain.setValueAtTime(0.0001, t0);
    noteGain.gain.exponentialRampToValueAtTime(1, t0 + attack);
    noteGain.gain.setValueAtTime(1, t0 + Math.min(0.12, duration * 0.35));
    if (pedalDown) {
      noteGain.gain.setValueAtTime(0.7, t0 + duration);
      sustainedGains.push(noteGain);
      const safeEnd = t0 + bodyDur + 1.1;
      noteGain.gain.setValueAtTime(0.55, safeEnd - 0.55);
      noteGain.gain.exponentialRampToValueAtTime(0.0001, safeEnd);
    } else {
      const release = Math.max(0.16, duration * 0.5);
      noteGain.gain.setValueAtTime(0.58, t0 + Math.max(attack + 0.04, duration - release));
      noteGain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration + 0.04);
    }

    filter.connect(noteGain);
    if (pan) {
      noteGain.connect(pan);
      pan.connect(dryGain);
      pan.connect(reverbNode);
      bodyResonators.forEach(function (bp) { pan.connect(bp); });
    } else {
      noteGain.connect(dryGain);
      noteGain.connect(reverbNode);
      bodyResonators.forEach(function (bp) { noteGain.connect(bp); });
    }

    if (!opts.noHighlight) {
      const delayMs = Math.max(0, (t0 - audioCtx.currentTime) * 1000);
      if (activeTimeouts.get(note)) clearTimeout(activeTimeouts.get(note));
      const tid = setTimeout(function () {
        setKeyState(note, "active");
        if (opts.scroll) scrollKeyIntoView(note);
        const visDur = Math.min(duration, 0.55) * 1000;
        const tid2 = setTimeout(function () {
          const el = document.querySelector('.key[data-note="' + note + '"]');
          if (el && el.classList.contains("active")) el.classList.remove("active");
          activeTimeouts.delete(note);
        }, visDur);
        activeTimeouts.set(note, tid2);
      }, delayMs);
      activeTimeouts.set(note + "_start", tid);
    }
  }

  function scrollKeyIntoView(note) {
    const notes = [note];
    if (typeof previewNote !== "undefined" && previewNote) notes.push(previewNote);
    centerOnNotes(notes);
  }


  // —— 5. 表情曲线与 MIDI ——

  /** 为旋律生成拱形/乐句渐强渐弱曲线（0.55–1.0） */
  function buildExpressionCurve(mel) {
    const n = mel.length;
    const curve = new Array(n);
    if (n === 0) return curve;
    // 以 8 音为一句，句内正弦拱形；整首再叠一层大拱
    for (let i = 0; i < n; i++) {
      const phrase = 8;
      const local = (i % phrase) / Math.max(1, phrase - 1);
      const phraseArch = 0.62 + 0.38 * Math.sin(Math.PI * local);
      const global = 0.85 + 0.15 * Math.sin(Math.PI * (i / Math.max(1, n - 1)));
      // 休止保持，不参与
      if (mel[i] === "-" || mel[i] === "rest") curve[i] = 0.7;
      else curve[i] = Math.min(1, phraseArch * global);
    }
    return curve;
  }

  function expressionAt(index) {
    if (!expressionEnabled || !expressionCurve.length) return 1;
    return expressionCurve[index % expressionCurve.length] || 1;
  }

  function updateExprBar(v) {
    const fill = document.getElementById("exprBarFill");
    if (fill) fill.style.width = Math.round(Math.max(0.15, Math.min(1, v)) * 100) + "%";
  }

  // --- 简易 MIDI 解析（Format 0/1，提取 note on/off）---
  function readVarLen(view, offset) {
    let value = 0, b;
    do {
      b = view.getUint8(offset.value++);
      value = (value << 7) | (b & 0x7f);
    } while (b & 0x80);
    return value;
  }

  function midiToNoteName(midi) {
    if (midi < 21 || midi > 108) return null;
    return midiToName(midi);
  }

  function parseMidiFile(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    let o = 0;
    const id = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (id !== "MThd") throw new Error("不是有效的 MIDI 文件");
    o = 8;
    const format = view.getUint16(o); o += 2;
    const nTracks = view.getUint16(o); o += 2;
    const division = view.getUint16(o); o += 2;
    if (division & 0x8000) throw new Error("暂不支持 SMPTE 时基");
    const tpq = division; // ticks per quarter note
    if (!tpq || tpq <= 0) throw new Error("MIDI 时间刻度（division）无效");

    const rawNotes = []; // {tick, midi, durTicks, vel, channel}

    for (let tr = 0; tr < nTracks; tr++) {
      if (o + 8 > view.byteLength) break;
      const chunkId = String.fromCharCode(view.getUint8(o), view.getUint8(o+1), view.getUint8(o+2), view.getUint8(o+3));
      const chunkLen = view.getUint32(o + 4);
      o += 8;
      if (chunkId !== "MTrk") { o += chunkLen; continue; }
      const end = o + chunkLen;
      let tick = 0;
      let running = null;
      const active = new Map(); // key: channel*128+note -> {tick, vel}

      while (o < end) {
        const off = { value: o };
        const delta = readVarLen(view, off);
        o = off.value;
        tick += delta;
        if (o >= end) break;
        let status = view.getUint8(o);
        if (status < 0x80) {
          if (running === null) throw new Error("MIDI running status 错误");
          status = running;
        } else {
          o++;
          running = status;
        }
        const type = status & 0xf0;
        const ch = status & 0x0f;

        if (type === 0x90 || type === 0x80) {
          const note = view.getUint8(o++);
          const vel = view.getUint8(o++);
          const key = ch * 128 + note;
          if (type === 0x90 && vel > 0) {
            active.set(key, { tick: tick, vel: vel });
          } else {
            const on = active.get(key);
            if (on) {
              rawNotes.push({
                tick: on.tick,
                midi: note,
                durTicks: Math.max(1, tick - on.tick),
                vel: on.vel,
                channel: ch
              });
              active.delete(key);
            }
          }
        } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
          o += 2;
        } else if (type === 0xc0 || type === 0xd0) {
          o += 1;
        } else if (status === 0xff) {
          const meta = view.getUint8(o++);
          const off2 = { value: o };
          const len = readVarLen(view, off2);
          o = off2.value + len;
        } else if (status === 0xf0 || status === 0xf7) {
          const off2 = { value: o };
          const len = readVarLen(view, off2);
          o = off2.value + len;
        } else {
          break;
        }
      }
      // 未关闭的 note：给默认长度
      active.forEach(function (on, key) {
        rawNotes.push({
          tick: on.tick,
          midi: key % 128,
          durTicks: tpq,
          vel: on.vel,
          channel: (key / 128) | 0
        });
      });
      o = end;
    }

    if (!rawNotes.length) throw new Error("MIDI 中没有音符");

    // 转为以四分音符为 1 拍的秒级事件（默认 120 BPM，可被速度滑条缩放）
    rawNotes.sort(function (a, b) { return a.tick - b.tick || a.midi - b.midi; });
    const events = [];
    rawNotes.forEach(function (n) {
      const name = midiToNoteName(n.midi);
      if (!name) return;
      const beat = n.tick / tpq;
      const durBeats = Math.max(0.15, n.durTicks / tpq);
      if (!Number.isFinite(beat) || !Number.isFinite(durBeats)) return;
      events.push({
        beat: beat,
        durBeats: durBeats,
        note: name,
        vel: Math.min(1, 0.35 + (n.vel / 127) * 0.65)
      });
    });
    if (!events.length) throw new Error("MIDI 中没有可播放的有效音符（可能超出音域或时间数据损坏）");
    return events;
  }

  function clearMidiTimers() {
    midiTimerIds.forEach(function (id) { clearTimeout(id); });
    midiTimerIds = [];
    if (midiEndTimer) { clearTimeout(midiEndTimer); midiEndTimer = null; }
    if (midiRaf) { clearTimeout(midiRaf); midiRaf = null; }
    midiPlaying = false;
  }

  function midiBeatSec() {
    return 60 / Math.max(30, Math.min(240, tempo));
  }

  /** 当前乐曲时间线位置（拍） */
  function midiNowBeat() {
    if (!audioCtx || !midiPlaying) return midiBeatOffset;
    return midiBeatOffset + (audioCtx.currentTime - midiAbsStart) / midiBeatSec();
  }

  /**
   * 窗口调度：只提前安排 LOOKAHEAD_BEATS 内的音符，避免数千 setTimeout。
   * 改速时调用 midiRescheduleFromNow() 即可从当前位置重排。
   */
  const MIDI_LOOKAHEAD_BEATS = 2.5;
  const MIDI_POLL_MS = 40;

  function midiScheduleWindow() {
    if (!midiPlaying || !isPlaying || !midiEvents || !audioCtx) return;
    const beatSec = midiBeatSec();
    const nowBeat = midiNowBeat();
    if (!Number.isFinite(nowBeat) || !Number.isFinite(beatSec)) {
      // 时间基准异常，无法继续调度，安全停止而不是卡死/静音
      stopAuto();
      document.getElementById("status").textContent = "曲目数据异常，已停止播放";
      return;
    }
    const horizon = nowBeat + MIDI_LOOKAHEAD_BEATS;
    const nowAudio = audioCtx.currentTime;

    while (midiNextIndex < midiEvents.length) {
      const ev = midiEvents[midiNextIndex];
      if (!ev || !Number.isFinite(ev.beat) || !Number.isFinite(ev.durBeats)) {
        // 单条事件数据损坏：跳过，不影响其余音符
        midiNextIndex++;
        continue;
      }
      if (ev.beat > horizon) break;
      // 已过去的音：略过或极短补发
      const when = midiAbsStart + (ev.beat - midiBeatOffset) * beatSec;
      const dur = Math.min(ev.durBeats * beatSec, 2.5);
      const idx = midiNextIndex;
      midiNextIndex++;
      if (!Number.isFinite(when) || !Number.isFinite(dur)) continue;

      if (when + dur < nowAudio - 0.05) continue; // 彻底过期

      const phrase = 12;
      const local = (idx % phrase) / Math.max(1, phrase - 1);
      const expr = expressionEnabled ? (0.62 + 0.38 * Math.sin(Math.PI * local)) : 1;
      const vel = mainVol * ev.vel * expr;
      const startWhen = Math.max(when, nowAudio);

      // 预备高亮下一音
      const previewDelay = Math.max(0, (startWhen - nowAudio) * 1000);
      const tidPrev = setTimeout(function () {
        if (!isPlaying || !midiPlaying) return;
        try {
          updateExprBar(expr);
          const next = midiEvents[idx + 1];
          if (next) showPreview(transposeNote(next.note));
          else clearPreview();
          playNote(transposeNote(ev.note), Math.max(0.08, when + dur - startWhen), vel, startWhen, { scroll: true });
        } catch (e) {
          // 单个音符调度失败不应影响后续音符播放
        }
      }, previewDelay);
      midiTimerIds.push(tidPrev);
    }

    // 全部结束
    if (midiNextIndex >= midiEvents.length) {
      const last = midiEvents[midiEvents.length - 1];
      const endBeat = last ? (last.beat + last.durBeats) : nowBeat;
      const endIn = Math.max(0.2, (endBeat - nowBeat) * beatSec + 0.4);
      midiEndTimer = setTimeout(function () {
        if (!isPlaying) return;
        if (loopEnabled) {
          clearMidiTimers();
          midiPlaying = true;
          midiBeatOffset = 0;
          midiNextIndex = 0;
          midiAbsStart = audioCtx.currentTime + 0.08;
          document.getElementById("status").textContent =
            "循环中 — 《" + currentSong.name + "》";
          if (midiEvents[0]) showPreview(transposeNote(midiEvents[0].note));
          midiScheduleWindow();
          return;
        }
        stopAuto();
        document.getElementById("status").textContent =
          "MIDI 演奏结束 — 《" + currentSong.name + "》";
      }, endIn * 1000);
      return;
    }

    midiRaf = setTimeout(midiScheduleWindow, MIDI_POLL_MS);
  }

  /** 从当前播放位置按新速度重排（未播事件） */
  function midiRescheduleFromNow() {
    if (!midiPlaying || !midiEvents || !audioCtx) return;
    // 冻结当前拍位置
    const nowBeat = midiNowBeat();
    midiBeatOffset = nowBeat;
    midiAbsStart = audioCtx.currentTime;
    // 清掉尚未触发的窗口定时器，保留索引（跳过已调度下标之前的）
    midiTimerIds.forEach(function (id) { clearTimeout(id); });
    midiTimerIds = [];
    if (midiEndTimer) { clearTimeout(midiEndTimer); midiEndTimer = null; }
    if (midiRaf) { clearTimeout(midiRaf); midiRaf = null; }
    // 若 nextIndex 超前过多，回退到第一个 beat >= nowBeat - 小容差 的事件
    let i = 0;
    while (i < midiEvents.length && midiEvents[i].beat < nowBeat - 0.01) i++;
    midiNextIndex = i;
    midiScheduleWindow();
  }

  function startMidiPlayback() {
    if (!midiEvents || !midiEvents.length || !audioCtx) return;
    clearMidiTimers();
    midiPlaying = true;
    midiBeatOffset = 0;
    midiNextIndex = 0;
    midiAbsStart = audioCtx.currentTime + 0.12;
    if (midiEvents[0]) showPreview(transposeNote(midiEvents[0].note));
    midiScheduleWindow();
  }

  // —— 6. 自动演奏调度 ——
  let isPlaying = false, nextBeatTime = 0, beatCount = 0;
  let melodyIndex = 0, chordIndex = 0, tempo = 92, timerId = null, previewNote = null;
  const LOOKAHEAD = 0.15, SCHEDULE_MS = 20;
  function beatDuration() { return 60 / tempo; }

  (function syncInitialTempo() {
    tempo = currentSong.tempo || 92;
    const tempoEl = document.getElementById("tempo");
    const tempoValEl = document.getElementById("tempoVal");
    if (tempoEl) tempoEl.value = tempo;
    if (tempoValEl) tempoValEl.textContent = tempo;
  })();

  function showPreview(note) {
    if (previewNote && previewNote !== note) {
      const old = document.querySelector('.key[data-note="' + previewNote + '"]');
      if (old) old.classList.remove("next");
    }
    previewNote = (note && note !== "-" && note !== "rest") ? note : null;
    if (previewNote) {
      const el = document.querySelector('.key[data-note="' + previewNote + '"]');
      if (el && !el.classList.contains("active")) el.classList.add("next");
      if (isPlaying) {
        const notes = [previewNote];
        document.querySelectorAll(".key.active").forEach(el => notes.push(el.dataset.note));
        centerOnNotes(notes);
      }
    }
  }
  function clearPreview() {
    if (previewNote) {
      const el = document.querySelector('.key[data-note="' + previewNote + '"]');
      if (el) el.classList.remove("next");
      previewNote = null;
    }
  }

  /** 调度一拍：旋律、预备高亮、小节与踏板 */
  function scheduleBeat(beatTime, beatInBar) {
    const note = loopEnabled ? melody[melodyIndex % melody.length] : melody[melodyIndex];
    const nextNote = loopEnabled
      ? melody[(melodyIndex + 1) % melody.length]
      : (melodyIndex + 1 < melody.length ? melody[melodyIndex + 1] : null);
    if (note) {
      const phraseEnd = (melodyIndex % 8 === 7);
      const dur = (note === "-" || note === "rest") ? 0.2 : (phraseEnd ? 0.5 : 0.28);
      const delayToNow = Math.max(0, (beatTime - audioCtx.currentTime) * 1000);
      setTimeout(() => { clearPreview(); showPreview(transposeNote(nextNote)); }, delayToNow);
      if (note !== "-" && note !== "rest") {
        const humanT = (Math.random() - 0.5) * 0.012;
        const expr = expressionAt(melodyIndex);
        updateExprBar(expr);
        const humanV = mainVol * (0.82 + Math.random() * 0.14) * expr;
        playNote(transposeNote(note), dur, humanV, beatTime + humanT, { scroll: true });
      }
    }
    melodyIndex++;

    if (beatInBar === 0 && chordOrder.length) {
      const name = chordOrder[chordIndex % chordOrder.length];
      const notes = chords[name] || [];
      const statusEl = document.getElementById("status");
      if (statusEl) {
        statusEl.textContent = "《" + currentSong.name + "》· " + name + " · 第 " + (Math.floor(beatCount / 4) + 1) + " 小节";
      }
      setPedal(false);
      const pedalOnAt = beatTime + 0.04;
      const delayPedal = Math.max(0, (pedalOnAt - audioCtx.currentTime) * 1000);
      setTimeout(function () { if (isPlaying) setPedal(true); }, delayPedal);
      notes.forEach(function (n, i) {
        const humanDelay = i * 0.055 + Math.random() * 0.012;
        playNote(transposeNote(n), 1.05, chordVol * 0.48, beatTime + humanDelay, { scroll: false });
      });
      chordIndex++;
    }
  }

  function scheduler() {
    if (!isPlaying || !audioCtx) return;
    const now = audioCtx.currentTime;
    while (nextBeatTime < now + LOOKAHEAD) {
      // 非循环：旋律播完一轮后停止
      if (!loopEnabled && melody.length && melodyIndex >= melody.length) {
        const endIn = Math.max(0.15, (nextBeatTime - now) * 1000 + 400);
        setTimeout(function () {
          if (!isPlaying) return;
          stopAuto();
          document.getElementById("status").textContent =
            "演奏结束 — 《" + currentSong.name + "》";
        }, endIn);
        return;
      }
      scheduleBeat(nextBeatTime, beatCount % 4);
      nextBeatTime += beatDuration();
      beatCount++;
    }
    timerId = setTimeout(scheduler, SCHEDULE_MS);
  }


  async function startAuto() {
    if (isPlaying) return;
    if (midiEvents && midiEvents.length) {
      await resumeAudio();
      isPlaying = true;
      SeasonParticles.notifyPlayStart();
      const btn = document.getElementById("playBtn");
      btn.classList.add("active");
      btn.textContent = "♪ 演奏中";
      clearAllHighlights();
      clearPreview();
      setPedal(pedalEnabled);
      document.getElementById("status").textContent = "MIDI 演奏中 — 《" + currentSong.name + "》";
      startMidiPlayback();
      return;
    }
    if (!melody.length) {
      document.getElementById("status").textContent = "请先选曲或输入自定义谱";
      return;
    }
    await resumeAudio();
    isPlaying = true;
    SeasonParticles.notifyPlayStart();
    const btn = document.getElementById("playBtn");
    btn.classList.add("active");
    btn.textContent = "♪ 演奏中";
    clearAllHighlights();
    clearPreview();
    nextBeatTime = audioCtx.currentTime + 0.12;
    beatCount = 0; melodyIndex = 0; chordIndex = 0;
    if (!expressionCurve.length) expressionCurve = buildExpressionCurve(melody);
    showPreview(transposeNote(melody.find(n => n !== "-" && n !== "rest") || null));
    setPedal(false);
    scheduler();
  }

  function stopAuto() {
    isPlaying = false;
    SeasonParticles.notifyPlayStop();
    if (timerId) { clearTimeout(timerId); timerId = null; }
    clearMidiTimers();
    clearAllHighlights();
    clearPreview();
    setPedal(false);
    // 保险丝：无论之前是否发生异常，强制把踏板/共鸣/总线状态复位，
    // 避免损坏的曲目数据导致后续曲目播放"没有声音"
    pedalDown = false;
    sustainedGains = [];
    resonanceGains = [];
    activeVoiceLoad = 0;
    if (audioCtx && masterGain && dryGain && wetGain) {
      const now = audioCtx.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(0.8, now);
      dryGain.gain.cancelScheduledValues(now);
      dryGain.gain.setValueAtTime(0.88 - reverbAmount * 0.35, now);
      wetGain.gain.cancelScheduledValues(now);
      wetGain.gain.setValueAtTime(0.05 + reverbAmount * 0.7, now);
    }
    // 本次会话音符数过多，或音频上下文状态异常（如 Safari 长时间高负载后
    // 音频线程劣化）：直接重建整个音频图，保证下一首曲子有干净的引擎
    if (audioCtx && (audioSessionNoteCount > AUDIO_REBUILD_THRESHOLD || audioCtx.state !== "running")) {
      rebuildAudioGraph();
    }
    updateExprBar(0.4);
    document.getElementById("playBtn").classList.remove("active");
    document.getElementById("playBtn").textContent = "▶ 开始";
    document.getElementById("status").textContent = "已停止 — 当前：《" + currentSong.name + "》";
  }

  // —— 7. 选曲与自定义谱 ——
  /** 切换当前曲目并重置演奏状态 */
  function loadSong(song) {
    stopAuto();
    currentSong = song;
    tempo = song.tempo || 92;
    if (song.midiEvents && song.midiEvents.length) {
      midiEvents = song.midiEvents.slice();
      melody = [];
      chords = {};
      chordOrder = [];
      expressionCurve = [];
    } else {
      midiEvents = null;
      melody = (song.melody || []).slice();
      chords = Object.assign({}, song.chords || {});
      chordOrder = (song.chordOrder || []).slice();
      expressionCurve = buildExpressionCurve(melody);
    }
    document.getElementById("tempo").value = tempo;
    document.getElementById("tempoVal").textContent = tempo;
    document.getElementById("status").textContent = "已选择：《" + song.name + "》— 点击开始";
    document.querySelectorAll(".song-item").forEach(el => {
      el.classList.toggle("selected", el.dataset.id === song.id);
    });
    updateNowPlaying();
    renderMiniSongList();
    // 滚到第一个有效音
    let first = null;
    if (midiEvents && midiEvents[0]) first = midiEvents[0].note;
    else first = melody.find(function (n) { return n !== "-" && n !== "rest"; });
    if (first) setTimeout(function () { centerOnNotes([transposeNote(first)]); }, 30);
    const addBtn = document.getElementById("addMidiToLibBtn");
    if (addBtn) addBtn.disabled = true; // 已在库中的曲不显示「待加入」
  }

  /** 解析自定义音名序列（支持休止 - / rest） */

  /** 根据旋律推断大调主音 */
  function guessMajorRoot(notes) {
    const pcCount = new Array(12).fill(0);
    notes.forEach(function (n) {
      if (!n || n === "-" || n === "rest") return;
      for (let i = 0; i < ALL_KEYS.length; i++) {
        if (ALL_KEYS[i].name === n) { pcCount[ALL_KEYS[i].midi % 12]++; break; }
      }
    });
    const major = [1, 0, 0.6, 0, 0.8, 0.7, 0, 0.9, 0, 0.5, 0, 0.4];
    let best = 0, bestScore = -1;
    for (let root = 0; root < 12; root++) {
      let s = 0;
      for (let i = 0; i < 12; i++) s += pcCount[i] * major[(i - root + 12) % 12];
      if (s > bestScore) { bestScore = s; best = root; }
    }
    return best;
  }

  function buildDiatonicChords(rootPc) {
    function pcName(pc) { return NOTE_NAMES[((pc % 12) + 12) % 12]; }
    function chord(root, third, fifth, bassOct, midOct) {
      const arr = [
        pcName(root) + bassOct,
        pcName(third) + midOct,
        pcName(fifth) + midOct
      ];
      return arr.filter(function (nm) { return !!freqMap[nm]; });
    }
    const I = rootPc, IV = rootPc + 5, V = rootPc + 7, vi = rootPc + 9;
    return {
      chords: {
        "I": chord(I, I + 4, I + 7, "2", "3"),
        "IV": chord(IV, IV + 4, IV + 7, "2", "3"),
        "V": chord(V, V + 4, V + 7, "2", "3"),
        "vi": chord(vi, vi + 3, vi + 7, "2", "3")
      },
      chordOrder: ["I", "I", "IV", "I", "IV", "I", "V", "I"]
    };
  }

  function parseCustomNotes(text) {
    return text
      .replace(/,/g, " ")
      .split(/\s+/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        if (s === "-" || s.toLowerCase() === "rest" || s === "0") return "-";
        // 允许 c4 / C4
        const m = s.match(/^([A-Ga-g])([#b]?)(\d)$/);
        if (!m) return null;
        let name = m[1].toUpperCase() + (m[2] === "b" ? "b" : m[2]) + m[3];
        // 简单降号转升号：Db->C#, Eb->D#, Gb->F#, Ab->G#, Bb->A#
        const flats = { "Db":"C#","Eb":"D#","Gb":"F#","Ab":"G#","Bb":"A#" };
        const base = name.slice(0, -1);
        if (flats[base]) name = flats[base] + name.slice(-1);
        return freqMap[name] ? name : null;
      })
      .filter(n => n !== null);
  }

  function songNoteCount(song) {
    if (song.midiEvents && song.midiEvents.length) return song.midiEvents.length;
    if (song.melody && song.melody.length) return song.melody.filter(function (n) { return n !== "-" && n !== "rest"; }).length;
    return 0;
  }


  function downloadJson(filename, dataObj) {
    try {
      const json = JSON.stringify(dataObj, null, 2);
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(url);
        a.remove();
      }, 200);
    } catch (e) {
      alert("导出失败：" + (e && e.message ? e.message : e));
    }
  }

  function songToExport(song) {
    return {
      id: song.id,
      name: song.name,
      desc: song.desc || "",
      tempo: song.tempo || 92,
      melody: song.melody || [],
      chords: song.chords || {},
      chordOrder: song.chordOrder || [],
      midiEvents: song.midiEvents || null
    };
  }

  function exportOneSong(song) {
    const safe = (song.name || "song").replace(/[\\\\/:*?"<>|]/g, "_").slice(0, 40);
    downloadJson("piano-" + safe + ".json", {
      format: "autoPiano.song.v1",
      exportedAt: new Date().toISOString(),
      song: songToExport(song)
    });
  }

  function exportAllLibrary() {
    if (!SONG_LIBRARY.length) {
      alert("曲库为空，无可导出内容");
      return;
    }
    downloadJson("auto-piano-library.json", {
      format: "autoPiano.library.v1",
      exportedAt: new Date().toISOString(),
      songs: serializeLibrary(SONG_LIBRARY)
    });
  }

  function importLibraryFromJson(obj) {
    const songs = extractSongsFromLibraryJson(obj);
    if (!songs.length) throw new Error("无法识别的 JSON 格式");
    let added = 0;
    songs.forEach(function (s) {
      const entry = songEntryFromRaw(s);
      if (!entry) return;
      const exist = SONG_LIBRARY.findIndex(function (x) { return x.id === entry.id; });
      if (exist >= 0) SONG_LIBRARY[exist] = entry;
      else SONG_LIBRARY.push(entry);
      added++;
    });
    if (!added) throw new Error("文件中没有有效曲目");
    saveLibraryToStorage();
    renderSongList();
    renderMiniSongList();
    updateNowPlaying();
    return added;
  }


  // 右侧「当前曲目」栏已删除，以下两个函数保留为空操作以兼容其余调用点
  function updateNowPlaying() {}

  function renderMiniSongList() {}

  function renderSongListToggle() {
    const toggle = document.getElementById("songListToggle");
    if (!toggle) return;
    if (!SONG_LIBRARY.length) { toggle.innerHTML = ""; return; }
    toggle.classList.toggle("expanded", songListExpanded);
    toggle.innerHTML = (songListExpanded
      ? "收起曲库"
      : "当前：《" + currentSong.name + "》 · 共 " + SONG_LIBRARY.length + " 首，点击展开") +
      ' <span class="chevron">▾</span>';
    toggle.onclick = function () {
      songListExpanded = !songListExpanded;
      renderSongList();
    };
  }

  function renderSongList() {
    renderSongListToggle();
    const list = document.getElementById("songList");
    list.innerHTML = "";
    if (!SONG_LIBRARY.length) {
      list.innerHTML = "<p style=\"font-size:0.82rem;color:var(--muted);padding:8px 0\">曲库为空，请导入 MIDI 或输入自定义谱。</p>";
      return;
    }
    const sorted = SONG_LIBRARY.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    const visible = songListExpanded
      ? sorted
      : sorted.filter(function (s) { return s.id === currentSong.id; }).slice(0, 1).length
        ? sorted.filter(function (s) { return s.id === currentSong.id; })
        : sorted.slice(0, 1);
    visible.forEach(function (song) {
      const idx = sorted.indexOf(song);
      const row = document.createElement("div");
      row.className = "song-item" + (song.id === currentSong.id ? " selected" : "");
      row.dataset.id = song.id;

      const meta = document.createElement("div");
      meta.className = "song-meta";
      const count = songNoteCount(song);
      const kind = song.midiEvents ? "MIDI" : "曲谱";
      if (!song.nameEn) song.nameEn = song.name;
      const displayName = song.showZh && song.nameZh ? song.nameZh : (song.nameEn || song.name);
      meta.innerHTML = (idx + 1) + ". " + escapeHtml(displayName) + "<small>" + escapeHtml(song.desc || kind) + " · " + (song.tempo || 92) + " BPM · " + count + " 音</small>";
      meta.addEventListener("click", function () {
        loadSong(song);
        closeSongModal();
      });

      const actions = document.createElement("div");
      actions.className = "song-actions";

      // 中英文切换按钮（displayName 已在上方计算）
      const zhBtn = document.createElement("button");
      zhBtn.type = "button";
      zhBtn.className = "zh-song" + (song.showZh ? " active" : "");
      zhBtn.textContent = song.showZh ? "英" : "中";
      zhBtn.title = song.showZh ? "显示英文名" : "显示中文名";
      zhBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (song.showZh) {
          song.showZh = false;
          song.name = song.nameEn || song.name;
        } else {
          if (!song.nameZh) {
            const hit = lookupSongZh(song.nameEn || song.name);
            if (!hit) {
              alert("无常用中文译名，可手动改名");
              return;
            }
            song.nameZh = hit;
          }
          if (!song.nameEn) song.nameEn = song.name;
          song.showZh = true;
          song.name = song.nameZh;
        }
        if (currentSong && currentSong.id === song.id) {
          currentSong.name = song.name;
          currentSong.showZh = song.showZh;
          currentSong.nameZh = song.nameZh;
          currentSong.nameEn = song.nameEn;
          const st = document.getElementById("status");
          if (st && st.textContent && st.textContent.indexOf("《") >= 0) {
            st.textContent = st.textContent.replace(/《[^》]*》/, "《" + song.name + "》");
          }
        }
        try { saveLibraryToStorage(); } catch (err) {}
        renderSongList();
      });

      const exp = document.createElement("button");
      exp.type = "button";
      exp.className = "exp-song";
      exp.textContent = "导出";
      exp.title = "导出为 JSON 文件";
      exp.addEventListener("click", function (e) {
        e.stopPropagation();
        exportOneSong(song);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "del-song";
      del.textContent = "删除";
      del.title = "从曲库删除";
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!confirm("确定从曲库删除《" + (song.nameEn || song.name) + "》？")) return;
        const idx = SONG_LIBRARY.findIndex(function (s) { return s.id === song.id; });
        if (idx < 0) return;
        SONG_LIBRARY.splice(idx, 1);
        saveLibraryToStorage();
        if (currentSong.id === song.id) {
          if (SONG_LIBRARY.length) loadSong(SONG_LIBRARY[0]);
          else {
            currentSong = { id: "empty", name: "（空）", desc: "", tempo: 92, melody: [], chords: {}, chordOrder: [] };
            melody = []; chords = {}; chordOrder = []; midiEvents = null;
            document.getElementById("status").textContent = "曲库已空 — 请导入或自定义";
          }
        }
        renderSongList();
        renderMiniSongList();
        updateNowPlaying();
      });

      actions.appendChild(zhBtn);
      actions.appendChild(exp);
      actions.appendChild(del);
      row.appendChild(meta);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function openSongModal() {
    songListExpanded = false;
    try { setModalMainTab("library"); } catch (e) { /* tabs may init later */ }
    renderSongList();
    renderMiniSongList();
    document.getElementById("songModal").classList.add("show");
  }
  function closeSongModal() {
    document.getElementById("songModal").classList.remove("show");
  }

  // ========== 7. 停止 / 退出 ==========
  /** 停止演奏 */
  function onStopBtn() {
    if (isPlaying) stopAuto();
  }
  function resetStopBtn() {
    const btn = document.getElementById("stopBtn");
    if (btn) btn.textContent = "■ 结束";
  }


  // ========== 8. 事件绑定 ==========
  document.getElementById("keyboard").addEventListener("pointerdown", e => {
    const key = e.target.closest(".key");
    if (!key) return;
    resumeAudio().then(() => playNote(key.dataset.note, 0.45, mainVol * 0.9));
  });

  document.getElementById("playBtn").addEventListener("click", () => {
    resetStopBtn();
    startAuto();
  });
  document.getElementById("stopBtn").addEventListener("click", onStopBtn);
  document.getElementById("songBtn").addEventListener("click", function () { openSongModal(); });
  document.getElementById("closeSongBtn").addEventListener("click", closeSongModal);

  document.getElementById("exportAllBtn").addEventListener("click", exportAllLibrary);
  document.getElementById("importLibBtn").addEventListener("click", function () {
    document.getElementById("importLibFile").click();
  });
  document.getElementById("importLibFile").addEventListener("change", function (e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const obj = JSON.parse(reader.result);
        const n = importLibraryFromJson(obj);
        setModalMainTab("library");
        document.getElementById("status").textContent = "已导入 " + n + " 首曲目到曲库";
        alert("成功导入 " + n + " 首曲目");
      } catch (err) {
        alert("导入失败：" + (err && err.message ? err.message : err));
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  });

  document.getElementById("songModal").addEventListener("click", e => {
    if (e.target.id === "songModal") closeSongModal();
  });

  document.getElementById("applyCustomBtn").addEventListener("click", () => {
    const name = (document.getElementById("customName").value || "自定义").trim();
    const notes = parseCustomNotes(document.getElementById("customNotes").value);
    if (notes.length < 2) {
      alert("请至少输入 2 个有效音符，例如：C4 D4 E4 F4 G4");
      return;
    }
    const root = guessMajorRoot(notes);
    const harm = buildDiatonicChords(root);
    const custom = {
      id: "custom_" + Date.now(),
      name: name,
      desc: "自定义简谱 · " + notes.length + " 音 · " + NOTE_NAMES[root] + " 大调",
      tempo: tempo,
      melody: notes,
      chords: harm.chords,
      chordOrder: harm.chordOrder
    };
    // 若不在库中则插入列表顶部（仅本次会话）
    const exists = SONG_LIBRARY.findIndex(s => s.id === custom.id);
    if (exists < 0) {
      SONG_LIBRARY.unshift(custom);
      saveLibraryToStorage();
    }
    loadSong(custom);
    closeSongModal();
  });

  // ========== 9. 听歌辨谱（本地麦克风 + 自相关基频检测 + 调号识别，全程离线不联网）==========
  let listenCtx = null, listenStream = null, listenProcessor = null, listenSourceNode = null, listenMuteGain = null;
  let listening = false;
  let pitchFrames = []; // {t, freq, rms}
  let listenStartTime = 0;

  function setListenStatus(text, cls) {
    const el = document.getElementById("listenStatus");
    if (!el) return;
    el.textContent = text || "";
    el.className = "sheet-status" + (cls ? " " + cls : "");
  }

  // 灵敏度 1–10 → 软件增益与静音门限
  function getListenGain() {
    const el = document.getElementById("listenSens");
    const v = el ? +el.value : 6;
    // 1→约 1.2x，6→约 4x，10→约 9x
    return 0.6 + v * 0.85;
  }
  function getListenSilenceRms() {
    const el = document.getElementById("listenSens");
    const v = el ? +el.value : 6;
    // 灵敏度越高，门限越低（更易捕捉远距/小声）
    return Math.max(0.0012, 0.014 - v * 0.0012);
  }

  // 经典自相关基频检测：软件增益 + 归一化后算自相关，远距也能识别
  function autoCorrelate(buf, sampleRate, sensGain) {
    const SIZE = buf.length;
    sensGain = sensGain || 1;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    const silenceGate = getListenSilenceRms() * 0.7;
    if (rms < silenceGate) return { freq: -1, rms: rms };

    // 软件放大 + 防止削波
    const boosted = new Float32Array(SIZE);
    let peak = 0.0001;
    for (let i = 0; i < SIZE; i++) {
      const s = buf[i] * sensGain;
      boosted[i] = s;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    const norm = peak > 1 ? 1 / peak : 1;
    for (let i = 0; i < SIZE; i++) boosted[i] *= norm;

    let r1 = 0, r2 = SIZE - 1;
    const thres = 0.15;
    for (let i = 0; i < SIZE / 2; i++) { if (Math.abs(boosted[i]) < thres) { r1 = i; break; } }
    for (let i = 1; i < SIZE / 2; i++) { if (Math.abs(boosted[SIZE - i]) < thres) { r2 = SIZE - i; break; } }
    const trimmed = boosted.slice(r1, r2);
    const newSize = trimmed.length;
    if (newSize < 8) return { freq: -1, rms: rms };

    const c = new Array(newSize).fill(0);
    for (let lag = 0; lag < newSize; lag++) {
      for (let i = 0; i < newSize - lag; i++) c[lag] += trimmed[i] * trimmed[i + lag];
    }

    let d = 0;
    while (d < newSize - 1 && c[d] > c[d + 1]) d++;
    let maxVal = -1, maxPos = -1;
    for (let i = d; i < newSize; i++) {
      if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
    }
    if (maxPos <= 0) return { freq: -1, rms: rms };

    let T0 = maxPos;
    const x1 = c[T0 - 1] !== undefined ? c[T0 - 1] : c[T0];
    const x2 = c[T0];
    const x3 = c[T0 + 1] !== undefined ? c[T0 + 1] : c[T0];
    const a = (x1 + x3 - 2 * x2) / 2, b = (x3 - x1) / 2;
    if (a) T0 = T0 - b / (2 * a);
    if (T0 <= 0) return { freq: -1, rms: rms };

    const freq = sampleRate / T0;
    if (freq < 70 || freq > 1200) return { freq: -1, rms: rms };
    return { freq: freq, rms: rms };
  }

  function freqToMidiFloat(freq) { return 69 + 12 * Math.log2(freq / 440); }

  // Krumhansl-Schmuckler 调号识别：把识别出的音高做音级直方图，和大/小调音级权重模板做相关，取相关性最高的调
  const KS_MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  const KS_MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
  const KEY_PC_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

  function detectKey(midiArr) {
    if (!midiArr.length) return "未知";
    const hist = new Array(12).fill(0);
    midiArr.forEach(function (m) { hist[((m % 12) + 12) % 12]++; });

    function correlate(profile, rotation) {
      let sumH = 0, sumP = 0, sumHH = 0, sumPP = 0, sumHP = 0;
      for (let i = 0; i < 12; i++) {
        const h = hist[i], p = profile[(i - rotation + 12) % 12];
        sumH += h; sumP += p; sumHH += h * h; sumPP += p * p; sumHP += h * p;
      }
      const num = 12 * sumHP - sumH * sumP;
      const den = Math.sqrt((12 * sumHH - sumH * sumH) * (12 * sumPP - sumP * sumP));
      return den ? num / den : 0;
    }

    let best = { score: -Infinity, name: "C 大调" };
    for (let root = 0; root < 12; root++) {
      const sMaj = correlate(KS_MAJOR, root);
      const sMin = correlate(KS_MINOR, root);
      if (sMaj > best.score) best = { score: sMaj, name: KEY_PC_NAMES[root] + " 大调" };
      if (sMin > best.score) best = { score: sMin, name: KEY_PC_NAMES[root] + " 小调" };
    }
    return best.name;
  }

  async function startListening() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setListenStatus("当前浏览器不支持麦克风（请用 Chrome/Safari，并在 HTTPS 或 localhost 打开）", "err");
      resetListenButton();
      return;
    }
    // 非安全上下文（file:// 等）多数浏览器会拒绝 getUserMedia
    if (typeof window.isSecureContext === "boolean" && !window.isSecureContext) {
      setListenStatus("需要 HTTPS 或 localhost 才能使用麦克风（请勿用 file:// 直接打开）", "err");
      resetListenButton();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1
        }
      });
    } catch (err) {
      var msg = "无法访问麦克风";
      if (err && err.name === "NotAllowedError") msg = "麦克风权限被拒绝，请在浏览器设置中允许";
      else if (err && err.name === "NotFoundError") msg = "未检测到麦克风设备";
      else msg = "无法访问麦克风（权限或环境限制）";
      setListenStatus(msg, "err");
      resetListenButton();
      return;
    }
    listenStream = stream;
    try {
      listenCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (eCtx) {
      setListenStatus("无法创建音频上下文", "err");
      resetListenButton();
      try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      return;
    }
    if (listenCtx.state === "suspended") {
      try { await listenCtx.resume(); } catch (e) {}
    }
    listenSourceNode = listenCtx.createMediaStreamSource(listenStream);
    // ScriptProcessor 虽已废弃，但兼容性最好；保持与 v2 内核一致
    listenProcessor = listenCtx.createScriptProcessor(2048, 1, 1);
    listenMuteGain = listenCtx.createGain();
    listenMuteGain.gain.value = 0;

    pitchFrames = [];
    listenStartTime = listenCtx.currentTime;
    listening = true;

    const buf = new Float32Array(2048);
    listenProcessor.onaudioprocess = function (e) {
      if (!listening) return;
      try {
        e.inputBuffer.copyFromChannel(buf, 0);
      } catch (eCopy) {
        // 部分旧环境无 copyFromChannel
        var ch = e.inputBuffer.getChannelData(0);
        for (var i = 0; i < buf.length && i < ch.length; i++) buf[i] = ch[i];
      }
      const result = autoCorrelate(buf, listenCtx.sampleRate, getListenGain());
      const t = listenCtx.currentTime - listenStartTime;
      pitchFrames.push({ t: t, freq: result.freq, rms: result.rms });

      const pitchEl = document.getElementById("listenPitch");
      const gate = getListenSilenceRms();
      if (result.freq > 0 && result.rms >= gate) {
        const midiRound = Math.round(freqToMidiFloat(result.freq));
        const name = midiToNoteName(midiRound) || "?";
        if (pitchEl) pitchEl.textContent = name + "　" + result.freq.toFixed(0) + " Hz";
      } else {
        if (pitchEl) pitchEl.textContent = "—";
      }
    };

    listenSourceNode.connect(listenProcessor);
    listenProcessor.connect(listenMuteGain);
    listenMuteGain.connect(listenCtx.destination);
  }

  function stopListening() {
    listening = false;
    if (listenProcessor) {
      try { listenProcessor.disconnect(); } catch (e) {}
      listenProcessor.onaudioprocess = null;
      listenProcessor = null;
    }
    if (listenSourceNode) {
      try { listenSourceNode.disconnect(); } catch (e) {}
      listenSourceNode = null;
    }
    if (listenMuteGain) {
      try { listenMuteGain.disconnect(); } catch (e) {}
      listenMuteGain = null;
    }
    if (listenStream) {
      try { listenStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      listenStream = null;
    }
    if (listenCtx) {
      try { listenCtx.close(); } catch (e) {}
      listenCtx = null;
    }
    var pitchEl = document.getElementById("listenPitch");
    if (pitchEl) pitchEl.textContent = "—";
    processRecordedPitches();
  }

  function processRecordedPitches() {
    if (!pitchFrames.length) { setListenStatus("没有录到声音，请重试", "err"); return; }

    const SILENCE_RMS = getListenSilenceRms();
    const MIN_NOTE_SEC = 0.08;
    const MERGE_GAP_SEC = 0.14;
    const REST_GAP_SEC = 0.2;

    const midiFrames = pitchFrames.map(function (f) {
      if (f.freq <= 0 || f.rms < SILENCE_RMS) return null;
      return Math.round(freqToMidiFloat(f.freq));
    });

    // 合并连续同音帧为音符段
    const segments = [];
    let cur = null;
    for (let i = 0; i < midiFrames.length; i++) {
      const m = midiFrames[i], t = pitchFrames[i].t;
      if (m === null) {
        if (cur) { segments.push(cur); cur = null; }
        continue;
      }
      if (cur && cur.midi === m) {
        cur.endT = t;
      } else {
        if (cur) segments.push(cur);
        cur = { midi: m, startT: t, endT: t };
      }
    }
    if (cur) segments.push(cur);

    // 丢弃过短抖动段，合并被极短间隙打断的同音段
    const merged = [];
    segments.forEach(function (s) {
      if (s.endT - s.startT < MIN_NOTE_SEC) return;
      const last = merged[merged.length - 1];
      if (last && last.midi === s.midi && (s.startT - last.endT) < MERGE_GAP_SEC) {
        last.endT = s.endT;
      } else {
        merged.push(s);
      }
    });

    if (!merged.length) {
      setListenStatus("没有识别出稳定的音高，请靠近麦克风、放慢速度再试一次", "err");
      return;
    }

    const tokens = [];
    for (let i = 0; i < merged.length; i++) {
      if (i > 0 && (merged[i].startT - merged[i - 1].endT) > REST_GAP_SEC) tokens.push("-");
      tokens.push(midiToNoteName(merged[i].midi) || "C4");
    }

    document.getElementById("customNotes").value = tokens.join(" ");
    if (!document.getElementById("customName").value.trim()) {
      document.getElementById("customName").value =
        "哼唱识别 " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }

    const key = detectKey(merged.map(function (s) { return s.midi; }));
    const noteCount = tokens.filter(function (t) { return t !== "-"; }).length;
    setListenStatus("识别完成，共 " + noteCount + " 个音，推测调号：" + key + "（已写入简谱）", "ok");
    try { setModalAddTab("score"); } catch (e) {}
  }

  function resetListenButton() {
    const btn = document.getElementById("listenToggleBtn");
    btn.textContent = "🎙️ 开始聆听";
    btn.classList.remove("recording");
  }

  // listenBtn 已并入「添加曲目 → 哼唱」子页

  (function setupListenSens() {
    const sens = document.getElementById("listenSens");
    const val = document.getElementById("listenSensVal");
    if (!sens) return;
    sens.addEventListener("input", function () {
      if (val) val.textContent = this.value;
    });
  })();

  document.getElementById("listenToggleBtn").addEventListener("click", function () {
    const btn = this;
    if (!listening) {
      btn.textContent = "⏹ 停止并识别";
      btn.classList.add("recording");
      setListenStatus("聆听中，请哼唱或播放歌曲…", "busy");
      startListening();
    } else {
      resetListenButton();
      setListenStatus("处理中…", "busy");
      stopListening();
    }
  });


  document.getElementById("tempo").addEventListener("input", function () {
    tempo = +this.value;
    document.getElementById("tempoVal").textContent = tempo;
    // MIDI 播放中改速：从当前进度按新 BPM 重排未播音符
    if (midiPlaying && midiEvents) midiRescheduleFromNow();
  });
  document.getElementById("volMain").addEventListener("input", function () {
    mainVol = +this.value / 100;
    document.getElementById("volMainVal").textContent = this.value;
  });
  document.getElementById("volChord").addEventListener("input", function () {
    chordVol = +this.value / 100;
    document.getElementById("volChordVal").textContent = this.value;
  });
  document.getElementById("transpose").addEventListener("input", function () {
    transposeSemis = +this.value;
    const v = transposeSemis;
    document.getElementById("transposeVal").textContent = (v > 0 ? "+" : "") + v;
    if (midiPlaying && midiEvents) midiRescheduleFromNow();
    updateNowPlaying();
  });
  document.getElementById("reverb").addEventListener("input", function () {
    reverbAmount = +this.value / 100;
    document.getElementById("reverbVal").textContent = this.value;
    if (wetGain) wetGain.gain.value = 0.05 + reverbAmount * 0.7;
    if (dryGain) dryGain.gain.value = 0.88 - reverbAmount * 0.35;
  });
  const loopEl = document.getElementById("loopToggle");
  if (loopEl) {
    loopEl.addEventListener("change", function () {
      loopEnabled = this.checked;
    });
  }

  document.addEventListener("keydown", e => {
    if (e.code === "Space" && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      if (isPlaying) stopAuto();
      else startAuto();
    }
    if (e.code === "Escape") {
      if (document.getElementById("songModal").classList.contains("show")) closeSongModal();
      else {
        var panel = document.getElementById("ctrlPanel");
        if (panel && panel.classList.contains("show")) {
          panel.classList.remove("show");
          var t = document.getElementById("ctrlToggleBtn");
          if (t) { t.classList.remove("active"); t.setAttribute("aria-expanded", "false"); }
        }
      }
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isPlaying) stopAuto();
  });

  const pedalEl = document.getElementById("pedalToggle");
  const nameEl = document.getElementById("nameToggle");
  if (pedalEl) {
    pedalEl.addEventListener("change", function () {
      pedalEnabled = this.checked;
      if (!pedalEnabled) setPedal(false);
    });
  }
  if (nameEl) {
    nameEl.addEventListener("change", function () {
      showNoteNames = this.checked;
      document.body.classList.toggle("hide-note-names", !showNoteNames);
    });
  }
  const exprEl = document.getElementById("exprToggle");
  if (exprEl) {
    exprEl.addEventListener("change", function () {
      expressionEnabled = this.checked;
      if (!expressionEnabled) updateExprBar(0.4);
    });
  }

  // MIDI 导入
  const midiInput = document.getElementById("midiFile");
  if (midiInput) {
    // 读取单个 MIDI 文件，返回 Promise<{file, events}>
    function readMidiFileAsync(file) {
      return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () {
          try {
            const events = parseMidiFile(reader.result);
            resolve({ file: file, events: events });
          } catch (err) {
            reject({ file: file, error: err });
          }
        };
        reader.onerror = function () { reject({ file: file, error: reader.error }); };
        reader.readAsArrayBuffer(file);
      });
    }

    midiInput.addEventListener("change", function (e) {
      const files = e.target.files ? Array.prototype.slice.call(e.target.files) : [];
      if (!files.length) return;

      Promise.allSettled(files.map(readMidiFileAsync)).then(function (results) {
        const ok = [];
        const failed = [];
        results.forEach(function (r) {
          if (r.status === "fulfilled") ok.push(r.value);
          else failed.push(r.reason);
        });

        if (!ok.length) {
          alert("MIDI 解析失败：" + failed.map(function (f) {
            return f.file.name + "（" + (f.error && f.error.message ? f.error.message : f.error) + "）";
          }).join("；"));
          e.target.value = "";
          return;
        }

        // 单文件：沿用原有「导入待确认 + 加入曲库」流程
        if (ok.length === 1 && !failed.length) {
          const first = ok[0];
          const events = first.events;
          const baseName = first.file.name.replace(/\.(mid|midi)$/i, "");
          midiEvents = events;
          currentSong = {
            id: "midi_" + Date.now(),
            name: baseName || "MIDI 乐曲",
            desc: "MIDI 导入 · " + events.length + " 个音",
            tempo: tempo,
            melody: [],
            chords: {},
            chordOrder: [],
            midiEvents: events
          };
          melody = [];
          chords = {};
          chordOrder = [];
          expressionCurve = [];
          document.getElementById("status").textContent =
            "已导入 MIDI：《" + currentSong.name + "》· " + events.length + " 音 — 可点「加入曲库」或直接开始";
          const addBtn = document.getElementById("addMidiToLibBtn");
          if (addBtn) addBtn.disabled = false;
          if (events[0]) setTimeout(function () { centerOnNotes([transposeNote(events[0].note)]); }, 40);
          // 不自动关闭弹窗，方便点「加入曲库」
        } else {
          // 多文件：逐个直接加入曲库，最后一首设为当前曲目
          ok.forEach(function (item, idx) {
            const events = item.events;
            const baseName = item.file.name.replace(/\.(mid|midi)$/i, "");
            const entry = {
              id: "midi_" + Date.now() + "_" + idx,
              name: baseName || "MIDI 乐曲",
              desc: "MIDI 导入 · " + events.length + " 个音",
              tempo: tempo,
              melody: [],
              chords: {},
              chordOrder: [],
              midiEvents: events
            };
            SONG_LIBRARY.push(entry);
            if (idx === ok.length - 1) {
              currentSong = entry;
              midiEvents = entry.midiEvents;
              melody = [];
              chords = {};
              chordOrder = [];
              expressionCurve = [];
              if (events[0]) setTimeout(function () { centerOnNotes([transposeNote(events[0].note)]); }, 40);
            }
          });
          saveLibraryToStorage();
          setModalMainTab("library");
          renderSongList();
          renderMiniSongList();
          updateNowPlaying();
          const addBtn = document.getElementById("addMidiToLibBtn");
          if (addBtn) addBtn.disabled = true;

          let msg = "已导入并加入曲库 " + ok.length + " 首 MIDI";
          if (failed.length) {
            msg += "，" + failed.length + " 首解析失败：" + failed.map(function (f) { return f.file.name; }).join("、");
          }
          document.getElementById("status").textContent = msg;
        }

        e.target.value = "";
      });
    });
  }

  const addMidiBtn = document.getElementById("addMidiToLibBtn");
  if (addMidiBtn) {
    addMidiBtn.addEventListener("click", function () {
      if (!currentSong || !currentSong.midiEvents || !currentSong.midiEvents.length) {
        alert("请先导入 MIDI 文件");
        return;
      }
      // 避免重复 id
      if (SONG_LIBRARY.some(function (s) { return s.id === currentSong.id; })) {
        alert("该曲已在曲库中");
        addMidiBtn.disabled = true;
        return;
      }
      const entry = {
        id: currentSong.id,
        name: currentSong.name,
        desc: currentSong.desc || ("MIDI · " + currentSong.midiEvents.length + " 音"),
        tempo: tempo,
        melody: [],
        chords: {},
        chordOrder: [],
        midiEvents: currentSong.midiEvents.slice()
      };
      SONG_LIBRARY.push(entry);
      currentSong = entry;
      saveLibraryToStorage();
      addMidiBtn.disabled = true;
      setModalMainTab("library");
      renderSongList();
      renderMiniSongList();
      updateNowPlaying();
      document.getElementById("status").textContent =
        "已加入曲库并保存：《" + entry.name + "》· " + entry.midiEvents.length + " 音";
    });
  }

  // 首屏曲目侧栏
  try { updateNowPlaying(); renderMiniSongList(); } catch (e) {}


  // —— 8. 浮层控制面板 ——
  (function setupCtrlPanelToggle() {
    const toggleBtn = document.getElementById("ctrlToggleBtn");
    const panel = document.getElementById("ctrlPanel");
    const card = document.getElementById("ctrlCard");
    if (!toggleBtn || !panel) return;
    function openCtrl() {
      panel.classList.add("show");
      toggleBtn.classList.add("active");
      toggleBtn.setAttribute("aria-expanded", "true");
    }
    function closeCtrl() {
      panel.classList.remove("show");
      toggleBtn.classList.remove("active");
      toggleBtn.setAttribute("aria-expanded", "false");
    }
    toggleBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (panel.classList.contains("show")) closeCtrl();
      else openCtrl();
    });
    panel.addEventListener("click", function (e) {
      if (e.target === panel) closeCtrl();
    });
    if (card) card.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("keydown", function (e) {
      if (e.code === "Escape" && panel.classList.contains("show")) {
        const songModal = document.getElementById("songModal");
        if (songModal && songModal.classList.contains("show")) return;
        closeCtrl();
      }
    });
  })();

  // 恢复默认
  (function setupDefaultBtn() {
    const btn = document.getElementById("defaultBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      tempo = 92; mainVol = 0.58; chordVol = 0.32; reverbAmount = 0.32;
      transposeSemis = 0;
      pedalEnabled = true; showNoteNames = true; expressionEnabled = true;
      loopEnabled = false;
      function setR(id, vid, v) {
        var el = document.getElementById(id), vl = document.getElementById(vid);
        if (el) el.value = v; if (vl) vl.textContent = v;
      }
      setR("tempo", "tempoVal", 92);
      setR("volMain", "volMainVal", 58);
      setR("volChord", "volChordVal", 32);
      setR("reverb", "reverbVal", 32);
      setR("transpose", "transposeVal", 0);
      var map = {
        pedalToggle: true, nameToggle: true, exprToggle: true,
        loopToggle: false
      };
      Object.keys(map).forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.checked = map[id];
      });
      document.body.classList.toggle("hide-note-names", !showNoteNames);
      if (!pedalEnabled) setPedal(false);
      if (wetGain) wetGain.gain.value = 0.05 + reverbAmount * 0.7;
      if (dryGain) dryGain.gain.value = 0.88 - reverbAmount * 0.35;
      if (midiPlaying && midiEvents) midiRescheduleFromNow();
    });
  })();

  // ========== 选曲弹窗 Tab ==========
  let modalMainTab = "library";
  let modalAddTab = "score";

  function setModalMainTab(tab) {
    modalMainTab = tab === "add" ? "add" : "library";
    document.querySelectorAll("#modalMainTabs .tab").forEach(function (btn) {
      var on = btn.getAttribute("data-main-tab") === modalMainTab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".modal-pane").forEach(function (pane) {
      pane.classList.toggle("active", pane.getAttribute("data-main-pane") === modalMainTab);
    });
    if (modalMainTab === "library") renderSongList();
  }
  function setModalAddTab(tab) {
    if (tab !== "score" && tab !== "midi" && tab !== "listen") tab = "score";
    if (modalAddTab === "listen" && tab !== "listen" && listening) {
      try { stopListening(); } catch (e) {}
      try { resetListenButton(); } catch (e) {}
    }
    modalAddTab = tab;
    document.querySelectorAll("#modalAddTabs .subtab").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-add-tab") === tab);
    });
    document.querySelectorAll(".add-pane").forEach(function (pane) {
      pane.classList.toggle("active", pane.getAttribute("data-add-pane") === tab);
    });
  }
  (function setupModalTabs() {
    var mainTabs = document.getElementById("modalMainTabs");
    if (mainTabs) {
      mainTabs.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-main-tab]");
        if (!btn) return;
        setModalMainTab(btn.getAttribute("data-main-tab"));
      });
    }
    var addTabs = document.getElementById("modalAddTabs");
    if (addTabs) {
      addTabs.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-add-tab]");
        if (!btn) return;
        setModalAddTab(btn.getAttribute("data-add-tab"));
      });
    }
    var toScore = document.getElementById("listenToScoreBtn");
    if (toScore) {
      toScore.addEventListener("click", function () { setModalAddTab("score"); });
    }
    var close2 = document.getElementById("closeSongBtn2");
    if (close2) close2.addEventListener("click", closeSongModal);
  })();

  // openSongModal 已在定义处支持 Tab 重置

  // ========== 中英文曲名 ==========
const SONG_NAME_ZH_MAP = {
    "twinkle twinkle little star": "小星星 · 传统儿歌",
    "twinkle twinkle": "小星星 · 传统儿歌",
    "little star": "小星星 · 传统儿歌",
    "fur elise": "致爱丽丝 · 贝多芬",
    "fuer elise": "致爱丽丝 · 贝多芬",
    "for elise": "致爱丽丝 · 贝多芬",
    "elise": "致爱丽丝 · 贝多芬",
    "moonlight sonata": "月光奏鸣曲 · 贝多芬",
    "moonlight": "月光奏鸣曲 · 贝多芬",
    "sonata quasi una fantasia": "月光奏鸣曲 · 贝多芬",
    "canon in d": "D大调卡农 · 帕赫贝尔",
    "pachelbel canon": "D大调卡农 · 帕赫贝尔",
    "canon": "D大调卡农 · 帕赫贝尔",
    "ode to joy": "欢乐颂 · 贝多芬",
    "joy of man": "欢乐颂 · 贝多芬",
    "jingle bells": "铃儿响叮当 · 传统圣诞歌",
    "happy birthday": "祝你生日快乐 · 传统",
    "silent night": "平安夜 · 传统圣诞歌",
    "ave maria": "圣母颂 · 舒伯特",
    "clair de lune": "月光 · 德彪西",
    "gymnopedie": "裸足舞曲 · 萨蒂",
    "gymnopedie no 1": "裸足舞曲第一号 · 萨蒂",
    "gymnopedie 1": "裸足舞曲第一号 · 萨蒂",
    "river flows in you": "River Flows in You · 李闰珉",
    "kiss the rain": "吻别雨丝 · 李闰珉",
    "wedding march": "婚礼进行曲 · 门德尔松",
    "bridal chorus": "婚礼合唱 · 瓦格纳",
    "minuet in g": "G大调小步舞曲 · 巴赫/佩佐尔德",
    "minuet": "小步舞曲 · 巴赫",
    "prelude in c": "C大调前奏曲 · 巴赫",
    "toccata and fugue": "托卡塔与赋格 · 巴赫",
    "air on the g string": "G弦上的咏叹调 · 巴赫",
    "jesu joy of man's desiring": "耶稣，人类渴望的喜悦 · 巴赫",
    "swan lake": "天鹅湖 · 柴可夫斯基",
    "nutcracker": "胡桃夹子 · 柴可夫斯基",
    "sugar plum fairy": "糖梅仙子 · 柴可夫斯基",
    "turkish march": "土耳其进行曲 · 莫扎特",
    "rondo alla turca": "土耳其进行曲 · 莫扎特",
    "eine kleine nachtmusik": "小夜曲 · 莫扎特",
    "spring": "春 · 维瓦尔第",
    "four seasons": "四季 · 维瓦尔第",
    "nocturne": "夜曲 · 肖邦",
    "nocturne op 9 no 2": "夜曲 Op.9 No.2 · 肖邦",
    "fantaisie impromptu": "幻想即兴曲 · 肖邦",
    "revolutionary etude": "革命练习曲 · 肖邦",
    "etude op 10 no 12": "革命练习曲 · 肖邦",
    "ballade": "叙事曲 · 肖邦",
    "polonaise": "波兰舞曲 · 肖邦",
    "heroic polonaise": "英雄波兰舞曲 · 肖邦",
    "liebestraum": "梦中的爱 · 李斯特",
    "la campanella": "钟 · 李斯特",
    "hungarian rhapsody": "匈牙利狂想曲 · 李斯特",
    "waltz of the flowers": "花之圆舞曲 · 柴可夫斯基",
    "blue danube": "蓝色多瑙河 · 约翰·施特劳斯",
    "radetzky march": "拉德茨基进行曲 · 老约翰·施特劳斯",
    "maple leaf rag": "枫叶拉格 · 乔普林",
    "the entertainer": "演艺人 · 乔普林",
    "greensleeves": "绿袖子 · 传统英国民谣",
    "amazing grace": "奇异恩典 · 传统赞美诗",
    "auld lang syne": "友谊地久天长 · 传统苏格兰",
    "home on the range": "家园在远方 · 传统美国",
    "yankee doodle": "扬基歌 · 传统美国",
    "mary had a little lamb": "玛丽有只小羊羔 · 传统儿歌",
    "london bridge": "伦敦桥 · 传统儿歌",
    "row row row your boat": "划船歌 · 传统儿歌",
    "are you sleeping": "小宝宝要睡觉 · 传统儿歌",
    "frere jacques": "两只老虎 · 传统儿歌",
    "beyer": "拜厄 · 拜厄",
    "czerny": "车尔尼 · 车尔尼",
    "hannon": "哈农 · 哈农",
    "burgmuller": "布格缪勒 · 布格缪勒",
    "sonatina": "小奏鸣曲 · 克莱门蒂",
    "clementi": "克莱门蒂 · 克莱门蒂",
    "bach invention": "巴赫创意曲 · 巴赫",
    "invention": "创意曲 · 巴赫",
    "goldberg variations": "哥德堡变奏曲 · 巴赫",
    "well tempered clavier": "平均律钢琴曲集 · 巴赫",
    "wtc": "平均律钢琴曲集 · 巴赫",
    "pathetique": "悲怆奏鸣曲 · 贝多芬",
    "appassionata": "热情奏鸣曲 · 贝多芬",
    "waldstein": "华尔斯坦奏鸣曲 · 贝多芬",
    "tempest": "暴风雨奏鸣曲 · 贝多芬",
    "les adieux": "告别奏鸣曲 · 贝多芬",
    "hammerklavier": "槌子键琴奏鸣曲 · 贝多芬",
    "chopin": "肖邦作品 · 肖邦",
    "beethoven": "贝多芬作品 · 贝多芬",
    "mozart": "莫扎特作品 · 莫扎特",
    "bach": "巴赫作品 · 巴赫",
    "debussy": "德彪西作品 · 德彪西",
    "liszt": "李斯特作品 · 李斯特",
    "schumann": "舒曼作品 · 舒曼",
    "schubert": "舒伯特作品 · 舒伯特",
    "brahms": "勃拉姆斯作品 · 勃拉姆斯",
    "rachmaninoff": "拉赫玛尼诺夫作品 · 拉赫玛尼诺夫",
    "tchaikovsky": "柴可夫斯基作品 · 柴可夫斯基",
    "yiruma": "李闰珉作品 · 李闰珉",
    "my heart will go on": "我心永恒 · 詹姆斯·霍纳",
    "titanic": "我心永恒 · 詹姆斯·霍纳",
    "city of stars": "星光之城 · 贾斯汀·赫尔维茨",
    "la la land": "爱乐之城 · 贾斯汀·赫尔维茨",
    "spirited away": "千与千寻 · 久石让",
    "always with me": "いつも何度でも · 木村弓 / 久石让",
    "one summer's day": "夏日的一天 · 久石让",
    "totoro": "龙猫 · 久石让",
    "howl's moving castle": "哈尔的移动城堡 · 久石让",
    "merry go round of life": "人生的旋转木马 · 久石让",
    "joe hisaishi": "久石让作品 · 久石让",
    "hisaishi": "久石让作品 · 久石让"
  };

  function normalizeSongKey(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[_\-\.]+/g, " ")
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function lookupSongZh(name) {
    const key = normalizeSongKey(name);
    if (!key) return null;
    if (SONG_NAME_ZH_MAP[key]) return SONG_NAME_ZH_MAP[key];
    let best = null, bestLen = 0;
    Object.keys(SONG_NAME_ZH_MAP).forEach(function (k) {
      if (k.length < 4) return;
      if ((key.indexOf(k) >= 0 || k.indexOf(key) >= 0) && k.length > bestLen) {
        best = SONG_NAME_ZH_MAP[k];
        bestLen = k.length;
      }
    });
    return best;
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ========== 季节飘落粒子系统（独立 Canvas，与钢琴/音频/MIDI 完全解耦）==========
  // 通用引擎：物理运动（下落/摇摆/旋转/景深/淡入淡出）与主题（颜色/图形）分离，
  // 主题只负责"画什么"，不涉及任何按键、音频、MIDI 逻辑。
  const SEASON_THEMES = {
    autumn: {
      colors: [
        { fill: "#e2593b", edge: "#8b2a18" }, // 枫红
        { fill: "#d4923a", edge: "#8a5a18" }, // 橙褐
        { fill: "#efc06a", edge: "#b3852f" }  // 金黄
      ],
      sizeRange: [10, 24],
      bigSizeRange: [30, 42],
      bigChance: 0.035,
      speedRange: [16, 30],
      bigSpeedRange: [34, 46],
      rotSpeedRange: [-0.8, 0.8],
      draw: function (ctx, p) {
        const s = p.size / 32;
        ctx.scale(s, s);
        ctx.beginPath();
        ctx.moveTo(0, -16);
        ctx.bezierCurveTo(4, -12, 6, -10, 10, -10);
        ctx.bezierCurveTo(8, -6, 8, -4, 12, -2);
        ctx.bezierCurveTo(8, 0, 8, 2, 11, 6);
        ctx.bezierCurveTo(6, 5, 4, 6, 3, 9);
        ctx.bezierCurveTo(2, 5, 1, 3, 0, 8);
        ctx.bezierCurveTo(-1, 3, -2, 5, -3, 9);
        ctx.bezierCurveTo(-4, 6, -6, 5, -11, 6);
        ctx.bezierCurveTo(-8, 2, -8, 0, -12, -2);
        ctx.bezierCurveTo(-8, -4, -8, -6, -10, -10);
        ctx.bezierCurveTo(-6, -10, -4, -12, 0, -16);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, -16, 0, 10);
        grad.addColorStop(0, p.color.fill);
        grad.addColorStop(1, p.color.edge);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,240,220,0.28)";
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(0, -14); ctx.lineTo(0, 8);
        ctx.moveTo(0, -6); ctx.lineTo(8, -2);
        ctx.moveTo(0, -6); ctx.lineTo(-8, -2);
        ctx.moveTo(0, 0); ctx.lineTo(9, 5);
        ctx.moveTo(0, 0); ctx.lineTo(-9, 5);
        ctx.stroke();
      }
    },
    winter: {
      colors: [
        { fill: "#eaf6ff" },
        { fill: "#ffffff" },
        { fill: "#d8ecff" }
      ],
      sizeRange: [8, 18],
      bigSizeRange: [22, 30],
      bigChance: 0.05,
      speedRange: [10, 22],
      bigSpeedRange: [24, 34],
      rotSpeedRange: [-0.5, 0.5],
      draw: function (ctx, p) {
        ctx.font = p.size + "px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = p.color.fill;
        ctx.shadowColor = "rgba(180, 220, 255, 0.5)";
        ctx.shadowBlur = p.size * 0.25;
        ctx.fillText("❄", 0, 0);
      }
    },
    spring: {
      colors: [{ fill: "#ffffff" }], // 表情符号自带颜色，此处仅占位
      sizeRange: [10, 20],
      bigSizeRange: [24, 32],
      bigChance: 0.04,
      speedRange: [12, 24],
      bigSpeedRange: [26, 36],
      rotSpeedRange: [-0.6, 0.6],
      draw: function (ctx, p) {
        ctx.font = p.size + "px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("🌸", 0, 0);
      }
    },
    summer: {
      colors: [{ fill: "#ffffff" }], // 表情符号自带颜色，此处仅占位
      sizeRange: [14, 22],
      bigSizeRange: [26, 34],
      bigChance: 0.06,
      speedRange: [10, 20],        // 蝴蝶飞行整体偏慢、上下起伏更明显
      bigSpeedRange: [16, 26],
      rotSpeedRange: [-0.35, 0.35],
      rotInitRange: [-0.3, 0.3],   // 初始姿态接近水平飞行，而非任意角度翻滚
      swayAmpRange: [30, 60],      // 左右摆动更大，模拟振翅乱飞的轨迹
      swaySpeedRange: [0.6, 1.3],
      draw: function (ctx, p) {
        ctx.font = p.size + "px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("🦋", 0, 0);
      }
    }
  };

  const SeasonParticles = (function () {
    const canvas = document.getElementById("mapleLeafCanvas");
    if (!canvas) return { setTheme() {}, notifyPlayStart() {}, notifyPlayStop() {} };
    const ctx = canvas.getContext("2d");

    let W = 0, H = 0, dpr = 1;
    function resize() {
      W = window.innerWidth;
      H = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);

    function rand(min, max) { return min + Math.random() * (max - min); }

    function targetCount() {
      const isNarrow = W < 760;
      const cores = navigator.hardwareConcurrency || 4;
      let n = isNarrow ? 26 : 52;
      if (cores <= 2) n = Math.round(n * 0.55);
      else if (cores <= 4) n = Math.round(n * 0.8);
      return Math.max(14, Math.min(60, n));
    }

    let currentThemeKey = null;   // null（关闭）| 'autumn' | 'winter' | 'spring' | 'summer'
    let particles = [];
    let spawning = false;   // 是否继续生成新粒子
    let running = false;    // rAF 循环是否在跑
    let alpha = 0, alphaTarget = 0; // 整体透明度渐入渐出
    let lastTs = null;

    function theme() { return SEASON_THEMES[currentThemeKey] || null; }

    function makeParticle(fromTop) {
      const th = theme();
      if (!th) return null;
      const rotInitRange = th.rotInitRange || [0, Math.PI * 2];
      const swayAmpRange = th.swayAmpRange || [16, 40];
      const swaySpeedRange = th.swaySpeedRange || [0.35, 0.85];
      const depth = Math.random();               // 0 远景（小而慢）→ 1 近景（大而快）
      const big = !fromTop ? false : Math.random() < th.bigChance;
      const size = big
        ? rand(th.bigSizeRange[0], th.bigSizeRange[1])
        : rand(th.sizeRange[0], th.sizeRange[1]) * (0.55 + depth * 0.6);
      const color = th.colors[(Math.random() * th.colors.length) | 0];
      const speedY = big
        ? rand(th.bigSpeedRange[0], th.bigSpeedRange[1])
        : (th.speedRange[0] + depth * (th.speedRange[1] - th.speedRange[0]) + rand(-3, 5));
      return {
        x: rand(-40, W + 40),
        y: fromTop ? rand(-140, -20) : rand(-H, H),
        size,
        rot: rand(rotInitRange[0], rotInitRange[1]),
        rotSpeed: rand(th.rotSpeedRange[0], th.rotSpeedRange[1]) * (0.35 + depth * 0.65),
        swayPhase: rand(0, Math.PI * 2),
        swayAmp: rand(swayAmpRange[0], swayAmpRange[1]) * (0.6 + depth * 0.6),
        swaySpeed: rand(swaySpeedRange[0], swaySpeedRange[1]),
        speedY,
        opacity: rand(0.5, 0.9) * (0.65 + depth * 0.35),
        blur: (1 - depth) * 1.5,
        color
      };
    }

    function spawnInitial() {
      particles = [];
      if (!theme()) return;
      const n = targetCount();
      for (let i = 0; i < n; i++) particles.push(makeParticle(false));
    }

    function drawParticle(p, t) {
      const th = theme();
      if (!th) return;
      const sway = Math.sin(t * p.swaySpeed + p.swayPhase) * p.swayAmp;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.opacity * alpha));
      ctx.translate(p.x + sway, p.y);
      ctx.rotate(p.rot);
      if (p.blur > 0.05) ctx.filter = "blur(" + p.blur.toFixed(2) + "px)";
      th.draw(ctx, p);
      ctx.restore();
    }

    function frame(ts) {
      if (!running) return;
      if (lastTs == null) lastTs = ts;
      const dt = Math.min(0.05, (ts - lastTs) / 1000);
      lastTs = ts;
      const t = ts / 1000;

      if (alpha < alphaTarget) alpha = Math.min(alphaTarget, alpha + dt * 0.7);
      else if (alpha > alphaTarget) alpha = Math.max(alphaTarget, alpha - dt * 0.45);

      ctx.clearRect(0, 0, W, H);
      particles.sort(function (a, b) { return a.size - b.size; }); // 小(远)先画，大(近)后画，制造景深

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.y += p.speedY * dt;
        p.rot += p.rotSpeed * dt;
        if (p.y - p.size > H + 60) {
          if (spawning) { particles[i] = makeParticle(true); }
          else { particles.splice(i, 1); }
          continue;
        }
        drawParticle(p, t);
      }

      if (!spawning && particles.length === 0 && alpha <= 0.01) {
        running = false; lastTs = null;
        ctx.clearRect(0, 0, W, H);
        return;
      }
      requestAnimationFrame(frame);
    }

    function startLoop() {
      spawning = true;
      alphaTarget = 1;
      if (!particles.length) spawnInitial();
      if (!running) { running = true; lastTs = null; requestAnimationFrame(frame); }
    }
    function stopLoop() {
      spawning = false;
      alphaTarget = 0;
      if (!running && particles.length) { running = true; lastTs = null; requestAnimationFrame(frame); }
    }

    // 播放状态与主题双重控制：主题非空且正在播放，才真正飘落
    let activeByPlay = false;
    function sync() {
      if (currentThemeKey && activeByPlay) startLoop();
      else stopLoop();
    }
    return {
      // themeKey: null（关闭）| 'autumn' | 'winter' | 'spring' | 'summer'
      setTheme: function (themeKey) {
        const key = SEASON_THEMES[themeKey] ? themeKey : null;
        if (key !== currentThemeKey) {
          currentThemeKey = key;
          particles = []; // 主题切换时清空，避免不同主题的粒子混在一起
        }
        sync();
      },
      notifyPlayStart: function () { activeByPlay = true; sync(); },
      notifyPlayStop: function () { activeByPlay = false; sync(); }
    };
  })();

  // ========== 季节特效开关按钮（UI，不改核心演奏逻辑）==========
  // 循环顺序：春の🌸 → 夏の🦋 → 秋の🍁 → 冬の❄️ → 关(🎹☕️🐈，默认状态，只弹钢琴)
  const SEASON_CYCLE = [
    { key: "spring", label: "春の🌸", title: "点击切换为夏" },
    { key: "summer", label: "夏の🦋", title: "点击切换为秋" },
    { key: "autumn", label: "秋の🍁", title: "点击切换为冬" },
    { key: "winter", label: "冬の❄️", title: "点击关闭特效，只弹钢琴" },
    { key: null, label: "🎹☕️🐈", title: "点击开启春の特效" }
  ];
  let seasonIndex = 0;
  function setSeasonByIndex(idx) {
    seasonIndex = ((idx % SEASON_CYCLE.length) + SEASON_CYCLE.length) % SEASON_CYCLE.length;
    const cur = SEASON_CYCLE[seasonIndex];
    var btn = document.getElementById("leafToggleBtn");
    if (btn) {
      btn.setAttribute("aria-pressed", cur.key ? "true" : "false");
      btn.title = cur.title;
      btn.textContent = cur.label;
    }
    // 目前只有秋叶主题带四角装饰图；其余主题不启用该装饰，避免为每个主题都画一套角标图。
    document.documentElement.classList.toggle("leaves-on", cur.key === "autumn");
    SeasonParticles.setTheme(cur.key);
  }
  (function setupSeasonDecor() {
    setSeasonByIndex(SEASON_CYCLE.length - 1); // 默认关闭特效（☕🎹 只弹钢琴）
    var leafBtn = document.getElementById("leafToggleBtn");
    if (leafBtn) {
      leafBtn.addEventListener("click", function (e) {
        e.preventDefault();
        setSeasonByIndex(seasonIndex + 1);
      });
    }
  })();

  // ========== 横竖屏自动检测 ==========
  // 竖屏：保持原样不变。
  // 横屏：只保留命令栏与曲名，钢琴键盘缩放到全部可见（无需横向滚动）。不联动飘叶效果，节约资源。
  (function setupOrientationMode() {
    let resizeTimer = null;

    function isLandscape() {
      return window.matchMedia("(orientation: landscape)").matches;
    }

    function enterLandscape() {
      document.documentElement.classList.add("landscape-compact");
      fitKeyboardToViewport();
    }

    function exitLandscape() {
      document.documentElement.classList.remove("landscape-compact");
      resetKeyboardFit();
    }

    function applyOrientationMode() {
      const landscape = isLandscape();
      const active = document.documentElement.classList.contains("landscape-compact");
      if (landscape && !active) { enterLandscape(); return; }
      if (!landscape && active) { exitLandscape(); return; }
      if (landscape && active) fitKeyboardToViewport(); // 横屏下窗口尺寸变化（如转屏微调）时持续适配
    }

    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyOrientationMode, 120);
    });
    window.addEventListener("orientationchange", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyOrientationMode, 180);
    });
    if (window.matchMedia) {
      const mq = window.matchMedia("(orientation: landscape)");
      if (mq.addEventListener) mq.addEventListener("change", applyOrientationMode);
      else if (mq.addListener) mq.addListener(applyOrientationMode);
    }
    applyOrientationMode();
  })();

})();
