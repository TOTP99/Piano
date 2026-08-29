"use strict";
/* 听歌辨谱：麦克风采集、自相关基频检测、调号识别 */
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

