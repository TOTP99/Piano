"use strict";
/* 音频引擎：合成钢琴、踏板、混响、启动自举 */
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

  // 启动时自动合并远程曲库地址（同 id 覆盖本地曲目）
  loadLibraryFromSidecar().then(function (result) {
    const added = result && result.added ? result.added : 0;
    const updated = result && result.updated ? result.updated : 0;
    if (!added && !updated) {
      if (!SONG_LIBRARY.length) {
        const statusEl = document.getElementById("status");
        if (statusEl) {
          statusEl.textContent = "曲库为空 — 未从远程曲库读取到曲目，可点「曲目」导入";
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
      statusEl.textContent = "已从远程曲库 " + parts.join("、") + " · 当前：《" + currentSong.name + "》";
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


"use strict";
/* 表情曲线与 MIDI 解析/调度 */
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

