"use strict";
/* 曲库：加载/保存/远程合并 */
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
   * 自动读取远程曲库地址并合并进曲库。
   * - 已有相同 id：用文件中的曲目覆盖本地
   * - 新 id：追加
   * - 跨域/网络失败或文件不存在时静默失败
   */
  const SIDE_CAR_LIBRARY_URL = "https://totp99.github.io/source/piano/auto-piano-library.json";

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
      url = new URL(SIDE_CAR_LIBRARY_URL).href;
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
      console.info("[曲库] 未自动加载 " + SIDE_CAR_LIBRARY_URL + "（可忽略）", e && e.message ? e.message : e);
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

"use strict";
/* 88 键键盘：DOM 构建、移调、横屏自适应 */
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

"use strict";
/* 键盘平滑滚动/居中 */
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

