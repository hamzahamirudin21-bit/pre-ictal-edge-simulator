import './ui/style.css';
import { renderDisclaimer } from './disclaimer.js';
import { generateSignals } from './generator/index.js';
import { decimateMinMax, valueToY, timeToX, niceTicks, burstSpans } from './ui/plotData.js';
import { controlSpecs, tryValidate, debounce, formatNumber } from './ui/format.js';

const disclaimerEl = document.getElementById('disclaimer');
if (disclaimerEl) renderDisclaimer(disclaimerEl);

const app = document.getElementById('app');
const specs = controlSpecs();
const inputs = new Map(); // key -> { num, range, error }

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

// ---- Controls ----
const form = el('form', { class: 'controls', 'aria-label': 'Synthetic signal parameters' });
form.addEventListener('submit', (e) => e.preventDefault());
for (const spec of specs) {
  const id = `ctl-${spec.key.replace('.', '-')}`;
  const unit = spec.unit ? ` (${spec.unit})` : '';
  const label = el('label', { for: id, text: `${spec.label}${unit}` });
  const num = el('input', {
    type: 'number', id, min: spec.min, max: spec.max, step: spec.step, value: spec.default,
    inputmode: spec.integer ? 'numeric' : 'decimal', 'aria-describedby': `${id}-err`,
  });
  const err = el('div', { id: `${id}-err`, class: 'field-error', 'aria-live': 'polite' });
  const row = el('div', { class: 'control' }, [label]);
  let range = null;
  if (spec.key !== 'seed') {
    range = el('input', {
      type: 'range', min: spec.min, max: spec.max, step: spec.step, value: spec.default,
      'aria-label': `${spec.label} slider`, tabindex: '0',
    });
    range.addEventListener('input', () => {
      num.value = range.value;
      schedule();
    });
  }
  num.addEventListener('input', () => {
    if (range && num.value !== '' && Number.isFinite(Number(num.value))) range.value = num.value;
    schedule();
  });
  row.append(num);
  if (range) row.append(range);
  if (spec.note) row.append(el('div', { class: 'note', text: spec.note }));
  row.append(err);
  form.append(row);
  inputs.set(spec.key, { num, err });
}

// ---- Output ----
function makePlot(title, ariaLabel, caption, legend) {
  const canvas = el('canvas', { role: 'img', 'aria-label': ariaLabel });
  const leg = el('ul', { class: 'legend', 'aria-label': `${title} legend` });
  for (const [name, color] of legend) {
    const li = el('li');
    li.append(el('span', { class: 'swatch', style: `background:${color}` }), document.createTextNode(name));
    leg.append(li);
  }
  const fig = el('figure', { class: 'plot' }, [
    el('h2', { text: title }), canvas, leg, el('figcaption', { text: caption }),
  ]);
  return { fig, canvas };
}

const COLORS = { ppg: '#0b4f8a', ppgClean: '#8fb8de', x: '#b3261e', y: '#1b6e2d', z: '#5b3fa0', burst: 'rgba(230,160,0,0.28)' };
const ppgPlot = makePlot(
  'PPG (synthetic)', 'Synthetic PPG waveform over time with a lighter clean-signal overlay',
  'Synthetic data. Simulated PPG; not a real recording.',
  [['PPG with artifact', COLORS.ppg], ['PPG clean (overlay)', COLORS.ppgClean]],
);
const accPlot = makePlot(
  'Accelerometer (synthetic)', 'Synthetic accelerometer x, y and z traces over time; shaded spans mark simulated tremor bursts',
  'Synthetic data. Simulated acceleration; shaded spans are simulated tremor bursts.',
  [['x', COLORS.x], ['y', COLORS.y], ['z', COLORS.z], ['tremor burst', 'rgba(230,160,0,0.5)']],
);
const statusEl = el('div', { class: 'status', 'aria-live': 'polite' });
const metaEl = el('section', { class: 'meta', 'aria-label': 'Effective simulated values' });
const output = el('div', { class: 'output' }, [statusEl, metaEl, ppgPlot.fig, accPlot.fig]);
app.append(el('div', { class: 'layout' }, [form, output]));

// ---- Drawing ----
let last = null;

function drawPlot(canvas, { series, durationSec, yLabel, spans = [] }) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(200, Math.floor(canvas.clientWidth || 600));
  const cssH = 220;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);

  const m = { l: 54, r: 8, t: 8, b: 34 };
  const w = cssW - m.l - m.r;
  const h = cssH - m.t - m.b;
  let lo = Infinity;
  let hi = -Infinity;
  const dec = series.map((s) => {
    const d = decimateMinMax(s.data, Math.max(1, Math.floor(w)));
    for (let i = 0; i < d.columns; i++) {
      if (d.min[i] < lo) lo = d.min[i];
      if (d.max[i] > hi) hi = d.max[i];
    }
    return d;
  });
  if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
  const pad = (hi - lo) * 0.05 || 0.5;
  lo -= pad;
  hi += pad;

  ctx.save();
  ctx.translate(m.l, m.t);
  ctx.fillStyle = COLORS.burst;
  for (const [x0, x1] of burstSpans(spans, durationSec, w)) ctx.fillRect(x0, 0, x1 - x0, h);

  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#1a1a1a';
  ctx.strokeStyle = '#d0d0d0';
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (const t of niceTicks(lo, hi, 4)) {
    const y = valueToY(t, lo, hi, h);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillText(formatNumber(t, Math.abs(t) < 10 ? 2 : 0), -4, y + 4);
  }
  ctx.textAlign = 'center';
  for (const t of niceTicks(0, durationSec, 6)) {
    const x = timeToX(t, durationSec, w);
    ctx.fillText(String(t), x, h + 14);
  }
  ctx.fillText('Time (s)', w / 2, h + 29);

  series.forEach((s, si) => {
    const d = dec[si];
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1;
    ctx.beginPath();
    const xs = d.columns > 1 ? w / (d.columns - 1) : 0;
    for (let i = 0; i < d.columns; i++) {
      const x = i * xs;
      ctx.moveTo(x, valueToY(d.min[i], lo, hi, h));
      ctx.lineTo(x, valueToY(d.max[i], lo, hi, h) - (d.min[i] === d.max[i] ? 0.5 : 0));
    }
    ctx.stroke();
  });
  ctx.restore();

  ctx.save();
  ctx.translate(12, m.t + h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#1a1a1a';
  ctx.font = '12px sans-serif';
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}

function renderMeta(res) {
  const m = res.meta;
  metaEl.replaceChildren();
  const rows = [
    ['Effective heart rate', `${formatNumber(m.effectiveHrBpm, 1)} bpm`, m.clamped.hr],
    ['Effective SDNN', `${formatNumber(m.effectiveSdnnMs, 1)} ms`, m.clamped.sdnn],
    ['LF/HF (illustrative)', formatNumber(m.lfhf, 2), false],
  ];
  const dl = el('dl');
  for (const [k, v, clamped] of rows) {
    const dd = el('dd', { text: v });
    if (clamped) dd.append(el('span', { class: 'badge', text: 'clamped' }));
    dl.append(el('dt', { text: k }), dd);
  }
  metaEl.append(
    el('h2', { text: 'Simulated values (synthetic)' }), dl,
    el('p', {
      class: 'note',
      text: 'Feasibility clamp: effective heart rate is capped at 180 bpm and SDNN is capped so RR intervals stay within 300-2000 ms. A "clamped" badge means the cap was applied to this synthetic signal.',
    }),
  );
}

function redraw() {
  if (!last) return;
  const { res, tremorOn } = last;
  drawPlot(ppgPlot.canvas, {
    series: [
      { data: res.ppgClean, color: COLORS.ppgClean, width: 1 },
      { data: res.ppg, color: COLORS.ppg, width: 1 },
    ],
    durationSec: res.durationSec, yLabel: 'PPG (normalized units)',
  });
  drawPlot(accPlot.canvas, {
    series: [
      { data: res.accel.x, color: COLORS.x }, { data: res.accel.y, color: COLORS.y },
      { data: res.accel.z, color: COLORS.z },
    ],
    durationSec: res.durationSec, yLabel: 'Acceleration (g)',
    spans: tremorOn ? res.meta.tremorBursts : [],
  });
}

// ---- Wiring ----
function update() {
  const raw = {};
  for (const [key, { num }] of inputs) raw[key] = num.value;
  const result = tryValidate(raw);
  for (const [key, { num, err }] of inputs) {
    const bad = !result.ok && result.field === key;
    err.textContent = bad ? result.message : '';
    if (bad) num.setAttribute('aria-invalid', 'true');
    else num.removeAttribute('aria-invalid');
  }
  if (!result.ok) {
    statusEl.textContent = 'Invalid input: showing the last valid synthetic plot.';
    return;
  }
  statusEl.textContent = '';
  const res = generateSignals(result.params);
  last = { res, tremorOn: result.params.tremorIntensity > 0 };
  renderMeta(res);
  redraw();
}

const schedule = debounce(update, 150);
window.addEventListener('resize', debounce(redraw, 100));
update();
