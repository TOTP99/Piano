"use strict";
/* 自动演奏调度（简谱/和弦模式） */
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
    ensureAudio();
    if (audioCtx && audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch (err) {}
    }
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

"use strict";
/* 选曲、自定义谱、导入导出、曲库列表渲染 */
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

"use strict";
/* 停止/退出 + 控制面板与顶部按钮事件绑定 */
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
  document.getElementById("keyboard").addEventListener("pointerdown", function (e) {
    const key = e.target.closest(".key");
    if (!key) return;
    // 手机：在同一次用户手势里创建 + resume + 发声
    ensureAudio();
    if (audioCtx && audioCtx.state === "suspended") {
      try { audioCtx.resume(); } catch (err) {}
    }
    try {
      var buf = audioCtx.createBuffer(1, 1, 22050);
      var src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.start(0);
    } catch (err) {}
    playNote(key.dataset.note, 0.45, mainVol * 0.9);
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

