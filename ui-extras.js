"use strict";
/* 选曲弹窗 Tab 切换 + 中英文曲名显示 */
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

"use strict";
/* 季节飘落粒子特效 + 特效切换按钮 */
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

"use strict";
/* 横竖屏自动检测与键盘缩放适配 */
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
