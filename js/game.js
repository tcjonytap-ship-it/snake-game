'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const COLS = 20;
const ROWS = 20;
const BASE_INTERVAL = 150; // ms per tick at level 1
const SPEED_STEP = 8;      // ms reduction per level
const MIN_INTERVAL = 60;   // fastest tick
const FOODS_PER_LEVEL = 5;
const BONUS_LIFETIME = 10000; // ms bonus food lives
const BONUS_INTERVAL = 25000; // ms between bonus spawns
const HS_KEY = 'snakeHS';

// ─── Audio (Web Audio API — no files needed) ──────────────────────────────────
const Audio = (() => {
  let ctx = null;
  const init = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  };
  const tone = (freq, type, duration, gain = 0.15) => {
    try {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.connect(env); env.connect(ctx.destination);
      osc.type = type; osc.frequency.value = freq;
      env.gain.setValueAtTime(gain, ctx.currentTime);
      env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(); osc.stop(ctx.currentTime + duration);
    } catch (_) {}
  };
  return {
    init,
    eat:     () => { tone(440, 'square', 0.06); tone(600, 'square', 0.08); },
    eatBonus:() => { tone(880, 'sine', 0.12, 0.2); tone(1100, 'sine', 0.18, 0.18); },
    levelUp: () => { [523,659,784,1047].forEach((f,i) => setTimeout(() => tone(f,'triangle',0.18,0.15), i*90)); },
    die:     () => { tone(220,'sawtooth',0.08); tone(150,'sawtooth',0.3,0.2); },
    move:    () => { tone(80,'sine',0.03,0.04); },
  };
})();

// ─── Particle pool (object-pool to avoid GC pressure) ─────────────────────────
const Particles = (() => {
  const MAX = 60;
  const pool = Array.from({length: MAX}, () => ({
    active: false, x: 0, y: 0, vx: 0, vy: 0,
    life: 0, maxLife: 0, r: 0, hue: 0, alpha: 1,
  }));
  const alloc = () => pool.find(p => !p.active) || pool[0];

  const burst = (x, y, hue, count = 10) => {
    for (let i = 0; i < count; i++) {
      const p = alloc();
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const speed = 1.5 + Math.random() * 2.5;
      p.active = true;
      p.x = x; p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.life = p.maxLife = 400 + Math.random() * 300;
      p.r = 2 + Math.random() * 3;
      p.hue = hue + (Math.random() - 0.5) * 40;
      p.alpha = 1;
    }
  };

  const update = (dt) => {
    for (const p of pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.x += p.vx * (dt / 16);
      p.y += p.vy * (dt / 16);
      p.vy += 0.08 * (dt / 16); // gravity
      p.alpha = p.life / p.maxLife;
    }
  };

  const draw = (ctx) => {
    for (const p of pool) {
      if (!p.active) continue;
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = `hsl(${p.hue},100%,65%)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  return { burst, update, draw };
})();

// ─── Utilities ────────────────────────────────────────────────────────────────
const rnd = (n) => Math.floor(Math.random() * n);
const same = (a, b) => a.x === b.x && a.y === b.y;

const getHighScore = () => parseInt(localStorage.getItem(HS_KEY) || '0', 10);
const saveHighScore = (s) => { if (s > getHighScore()) localStorage.setItem(HS_KEY, s); };

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const canvas = $('gameCanvas');
const ctx    = canvas.getContext('2d', { alpha: false });

const screens = {
  start:    $('screen-start'),
  game:     $('screen-game'),
  gameover: $('screen-gameover'),
};

// ─── Screen management ────────────────────────────────────────────────────────
let currentScreen = 'start';
const showScreen = (name) => {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle('active', k === name);
  }
  currentScreen = name;
};

// ─── Canvas sizing ────────────────────────────────────────────────────────────
let CELL;
const resizeCanvas = () => {
  const wrap = canvas.parentElement;
  const hudH = document.querySelector('.hud')?.offsetHeight || 50;
  const dpadH = document.querySelector('.dpad')?.offsetHeight || 0;
  const isMobile = window.innerWidth < 600;
  const pad = isMobile ? 20 : 40;
  const available = Math.min(
    window.innerWidth - pad,
    window.innerHeight - hudH - dpadH - (isMobile ? 100 : 60)
  );
  const size = Math.max(200, Math.min(500, available));
  CELL = Math.floor(size / COLS);
  canvas.width = CELL * COLS;
  canvas.height = CELL * ROWS;
};

// ─── Game state ───────────────────────────────────────────────────────────────
let snake, dir, nextDir, food, bonus, score, level, foodEaten;
let state = 'idle'; // idle | countdown | playing | paused | dead
let rafId = null;
let lastTick = 0, tickAcc = 0;
let bonusTimer = 0, bonusSpawnTimer = 0;

const DIRS = {
  UP:    { x: 0,  y: -1 },
  DOWN:  { x: 0,  y:  1 },
  LEFT:  { x: -1, y:  0 },
  RIGHT: { x: 1,  y:  0 },
};
const OPPOSITE = { UP:'DOWN', DOWN:'UP', LEFT:'RIGHT', RIGHT:'LEFT' };

const tickInterval = () => Math.max(MIN_INTERVAL, BASE_INTERVAL - (level - 1) * SPEED_STEP);

const spawnFood = (existing = []) => {
  let pos;
  do {
    pos = { x: rnd(COLS), y: rnd(ROWS) };
  } while (existing.some(p => same(p, pos)));
  return pos;
};

const initGame = () => {
  const mid = Math.floor(COLS / 2);
  snake = [
    { x: mid, y: mid },
    { x: mid - 1, y: mid },
    { x: mid - 2, y: mid },
  ];
  dir = DIRS.RIGHT;
  nextDir = DIRS.RIGHT;
  score = 0;
  level = 1;
  foodEaten = 0;
  bonus = null;
  bonusTimer = 0;
  bonusSpawnTimer = 0;
  food = spawnFood(snake);
  updateHUD();
};

// ─── HUD ─────────────────────────────────────────────────────────────────────
const updateHUD = () => {
  $('hud-score').textContent = score;
  $('hud-level').textContent = level;
  $('hud-best').textContent = getHighScore();
};

const popHUD = (id) => {
  const el = $(id);
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
};

// ─── Tick (game logic) ────────────────────────────────────────────────────────
const tick = () => {
  dir = nextDir;
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

  // Wall collision
  if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) return die();

  // Self collision (skip tail — it moves away this frame)
  for (let i = 0; i < snake.length - 1; i++) {
    if (same(snake[i], head)) return die();
  }

  snake.unshift(head);

  let ate = false;
  // Regular food
  if (same(head, food)) {
    ate = true;
    const pts = 10 * level;
    score += pts;
    foodEaten++;
    Audio.eat();
    Particles.burst(
      (food.x + 0.5) * CELL, (food.y + 0.5) * CELL, 120, 12
    );
    food = spawnFood([...snake, ...(bonus ? [bonus] : [])]);
    popHUD('hud-score');

    if (foodEaten % FOODS_PER_LEVEL === 0) levelUp();
  }

  // Bonus food
  if (bonus && same(head, bonus)) {
    ate = true;
    score += 50 * level;
    Audio.eatBonus();
    Particles.burst(
      (bonus.x + 0.5) * CELL, (bonus.y + 0.5) * CELL, 50, 18
    );
    bonus = null;
    bonusTimer = 0;
    bonusSpawnTimer = BONUS_INTERVAL;
    popHUD('hud-score');
  }

  if (!ate) snake.pop();
  updateHUD();
};

const levelUp = () => {
  level++;
  Audio.levelUp();
  updateHUD();
  popHUD('hud-level');
  const wrap = canvas.parentElement;
  wrap.classList.remove('levelup');
  void wrap.offsetWidth;
  wrap.classList.add('levelup');
  setTimeout(() => wrap.classList.remove('levelup'), 1300);
};

const die = () => {
  state = 'dead';
  Audio.die();
  saveHighScore(score);
  const isRecord = score > 0 && score >= getHighScore();
  setTimeout(() => {
    $('go-score').textContent = score;
    $('go-level').textContent = level;
    $('go-best').textContent = getHighScore();
    $('go-newrecord').classList.toggle('hidden', !isRecord);
    showScreen('gameover');
  }, 600);
};

// ─── Render ───────────────────────────────────────────────────────────────────
const drawGrid = () => {
  ctx.fillStyle = '#090914';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#0f0f22';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= COLS; x++) {
    ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, canvas.height); ctx.stroke();
  }
  for (let y = 0; y <= ROWS; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(canvas.width, y * CELL); ctx.stroke();
  }
};

const drawSnake = () => {
  const len = snake.length;
  for (let i = len - 1; i >= 0; i--) {
    const seg = snake[i];
    const t = 1 - i / len; // 1 = head, 0 = tail
    const x = seg.x * CELL + 1;
    const y = seg.y * CELL + 1;
    const s = CELL - 2;

    if (i === 0) {
      // Head — brighter with glow
      ctx.shadowColor = '#39ff14';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#39ff14';
    } else {
      ctx.shadowBlur = 0;
      const green = Math.round(180 + t * 75);
      ctx.fillStyle = `rgb(0,${green},0)`;
    }

    const r = i === 0 ? CELL * 0.3 : CELL * 0.22;
    ctx.beginPath();
    ctx.roundRect(x, y, s, s, r);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Eyes on head
    if (i === 0) {
      ctx.fillStyle = '#000';
      const ew = Math.max(2, CELL * 0.12);
      const eyeOffset = CELL * 0.22;
      let ex1, ey1, ex2, ey2;
      if (dir === DIRS.RIGHT) { ex1 = ex2 = x + s - ew * 2; ey1 = y + eyeOffset; ey2 = y + s - eyeOffset - ew; }
      else if (dir === DIRS.LEFT) { ex1 = ex2 = x + ew; ey1 = y + eyeOffset; ey2 = y + s - eyeOffset - ew; }
      else if (dir === DIRS.UP) { ex1 = x + eyeOffset; ex2 = x + s - eyeOffset - ew; ey1 = ey2 = y + ew; }
      else { ex1 = x + eyeOffset; ex2 = x + s - eyeOffset - ew; ey1 = ey2 = y + s - ew * 2; }
      ctx.fillRect(ex1, ey1, ew, ew);
      ctx.fillRect(ex2, ey2, ew, ew);
    }
  }
};

const drawFood = (now) => {
  // Regular food — pulsing green apple
  const pulse = 0.85 + 0.15 * Math.sin(now * 0.004);
  const fx = (food.x + 0.5) * CELL;
  const fy = (food.y + 0.5) * CELL;
  const fr = (CELL * 0.38) * pulse;
  ctx.shadowColor = '#39ff14';
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#22c55e';
  ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#16a34a';
  ctx.beginPath(); ctx.arc(fx - fr * 0.15, fy - fr * 0.15, fr * 0.5, 0, Math.PI * 2); ctx.fill();

  // Bonus food — golden diamond
  if (bonus) {
    const remaining = bonusTimer / BONUS_LIFETIME;
    const blink = remaining < 0.25 ? Math.sin(now * 0.02) > 0 : true;
    if (blink) {
      const bx = (bonus.x + 0.5) * CELL;
      const by = (bonus.y + 0.5) * CELL;
      const br = CELL * 0.36;
      const rot = now * 0.002;
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#ffd700';
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(0, -br);
      ctx.lineTo(br * 0.7, 0);
      ctx.lineTo(0, br);
      ctx.lineTo(-br * 0.7, 0);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
    }
  }
};

const render = (now) => {
  drawGrid();
  drawFood(now);
  drawSnake();
  Particles.draw(ctx);
};

// ─── Game loop ────────────────────────────────────────────────────────────────
let lastNow = 0;
const loop = (now) => {
  if (state === 'dead') return;
  rafId = requestAnimationFrame(loop);

  const dt = Math.min(now - lastNow, 100); // cap delta to avoid spiral
  lastNow = now;

  if (state === 'playing') {
    tickAcc += dt;

    // Bonus food timers
    if (bonus) {
      bonusTimer -= dt;
      if (bonusTimer <= 0) { bonus = null; bonusTimer = 0; }
    } else {
      bonusSpawnTimer -= dt;
      if (bonusSpawnTimer <= 0) {
        bonus = spawnFood([...snake, food]);
        bonusTimer = BONUS_LIFETIME;
        bonusSpawnTimer = BONUS_INTERVAL;
      }
    }

    const interval = tickInterval();
    while (tickAcc >= interval) {
      tickAcc -= interval;
      tick();
      if (state === 'dead') break;
    }
  }

  render(now);
  Particles.update(dt);
};

const startLoop = () => {
  if (rafId) cancelAnimationFrame(rafId);
  lastNow = performance.now();
  tickAcc = 0;
  rafId = requestAnimationFrame(loop);
};

// ─── Countdown then play ──────────────────────────────────────────────────────
const countdown = (cb) => {
  const overlay = $('overlay-countdown');
  const num = $('countdown-num');
  overlay.classList.remove('hidden');
  state = 'countdown';
  let c = 3;
  num.textContent = c;
  const step = () => {
    c--;
    if (c <= 0) {
      overlay.classList.add('hidden');
      state = 'playing';
      bonusSpawnTimer = BONUS_INTERVAL;
      cb();
    } else {
      num.textContent = c;
      num.style.animation = 'none';
      void num.offsetWidth;
      num.style.animation = 'countdown-pop 0.6s ease';
      setTimeout(step, 700);
    }
  };
  setTimeout(step, 700);
};

// ─── Input handling ───────────────────────────────────────────────────────────
const setDir = (d) => {
  if (state !== 'playing') return;
  if (OPPOSITE[d] === Object.keys(DIRS).find(k => DIRS[k] === dir)) return;
  const newDir = DIRS[d];
  if (newDir && !(newDir.x === -dir.x && newDir.y === -dir.y)) {
    nextDir = newDir;
  }
};

const KEY_MAP = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  w: 'UP', s: 'DOWN', a: 'LEFT', d: 'RIGHT',
  W: 'UP', S: 'DOWN', A: 'LEFT', D: 'RIGHT',
};

document.addEventListener('keydown', (e) => {
  if (KEY_MAP[e.key]) {
    e.preventDefault();
    setDir(KEY_MAP[e.key]);
  }
  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') togglePause();
  if ((e.key === ' ' || e.key === 'Enter') && currentScreen === 'start') startGame();
});

// Touch / swipe
let touchStart = null;
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (!touchStart) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  const threshold = 20;
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
  if (Math.abs(dx) > Math.abs(dy)) setDir(dx > 0 ? 'RIGHT' : 'LEFT');
  else setDir(dy > 0 ? 'DOWN' : 'UP');
  touchStart = null;
}, { passive: false });

// D-pad buttons
document.querySelectorAll('.dpad-btn').forEach(btn => {
  const handle = (e) => {
    e.preventDefault();
    Audio.init();
    setDir(btn.dataset.dir);
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 120);
  };
  btn.addEventListener('touchstart', handle, { passive: false });
  btn.addEventListener('mousedown', handle);
});

// ─── Pause ────────────────────────────────────────────────────────────────────
const togglePause = () => {
  if (state === 'playing') {
    state = 'paused';
    $('overlay-pause').classList.remove('hidden');
    $('btn-pause').textContent = '▶';
  } else if (state === 'paused') {
    resumeGame();
  }
};

const resumeGame = () => {
  $('overlay-pause').classList.add('hidden');
  $('btn-pause').textContent = '⏸';
  state = 'playing';
};

$('btn-pause').addEventListener('click', () => { Audio.init(); togglePause(); });
$('btn-resume').addEventListener('click', () => { Audio.init(); resumeGame(); });
$('btn-quit').addEventListener('click', () => {
  $('overlay-pause').classList.add('hidden');
  cancelAnimationFrame(rafId);
  state = 'idle';
  showScreen('start');
  $('start-hiscore').textContent = `Best: ${getHighScore()}`;
});

// ─── Flow ─────────────────────────────────────────────────────────────────────
const startGame = () => {
  Audio.init();
  resizeCanvas();
  initGame();
  showScreen('game');
  $('btn-pause').textContent = '⏸';
  startLoop();
  countdown(() => {});
};

$('btn-start').addEventListener('click', startGame);

$('btn-restart').addEventListener('click', () => {
  Audio.init();
  startGame();
});

$('btn-home').addEventListener('click', () => {
  showScreen('start');
  $('start-hiscore').textContent = `Best: ${getHighScore()}`;
});

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  if (currentScreen === 'game') resizeCanvas();
});

// Initial high score display
const hs = getHighScore();
if (hs > 0) $('start-hiscore').textContent = `Best: ${hs}`;

// Render a static frame on start screen for visual appeal
resizeCanvas();
showScreen('start');
