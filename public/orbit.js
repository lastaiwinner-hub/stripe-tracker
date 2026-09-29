'use strict';

/**
 * orbit.js — the fleet as a living constellation.
 *
 * Same structure as the board: every group is a core, its accounts orbit it on
 * connector lines. The difference is that it is lit rather than drawn — nodes
 * are shaded spheres with a specular highlight, distance blurs and dims them,
 * and money moving through an account shows as light travelling down its link.
 *
 * Canvas 2D with hand-rolled 3D. No WebGL library: the app has no build step
 * and a strict CSP, and a few hundred bodies do not need a scene graph.
 *
 * Exposes window.Orbit.
 */
(function () {

const TAU = Math.PI * 2;

/** Luminous on a dark ground; matches the app's state palette. */
const HEALTH_COLOR = {
  healthy: '#34E4A8',
  docs: '#FFC24B',
  restricted: '#FF9F5A',
  suspended: '#FF6B8A',
  pending: '#5CC8FF',
  error: '#C084FC',
  unknown: '#7A87AE',
};
const NEEDS_ATTENTION = new Set(['suspended', 'restricted', 'docs', 'error']);

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = (hex, a) => {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};
/** Toward white, for the lit face of a sphere. */
const lighten = (hex, tAmt) => {
  const [r, g, b] = rgb(hex);
  const m = (c) => Math.round(c + (255 - c) * tAmt);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
};

function rotate(p, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cx = Math.cos(pitch), sx = Math.sin(pitch);
  const x1 = p.x * cy - p.z * sy;
  const z1 = p.x * sy + p.z * cy;
  const y1 = p.y * cx - z1 * sx;
  const z2 = p.y * sx + z1 * cx;
  return { x: x1, y: y1, z: z2 };
}

/**
 * Group cores on a ring, accounts on a sphere around each. Deterministic, so
 * the constellation stays recognisable between refreshes.
 */
function layout(groups, accounts, groupOf) {
  const buckets = new Map();
  for (const a of accounts) {
    const gid = a.group_id && groups.some((g) => g.id === a.group_id) ? a.group_id : 0;
    if (!buckets.has(gid)) buckets.set(gid, []);
    buckets.get(gid).push(a);
  }

  const hubs = [];
  const nodes = [];
  const ids = [...buckets.keys()];
  const ringR = ids.length > 1 ? 230 + ids.length * 14 : 0;

  ids.forEach((gid, i) => {
    const angle = (i / ids.length) * TAU;
    const list = buckets.get(gid);
    const hub = {
      id: gid,
      name: gid === 0 ? 'Ungrouped' : groupOf(gid),
      x: Math.cos(angle) * ringR,
      y: ids.length > 1 ? Math.sin(i * 2.399) * 78 : 0,
      z: Math.sin(angle) * ringR,
      count: list.length,
      seed: i * 1.7,
    };

    const R = 74 + Math.sqrt(list.length) * 28;
    list.forEach((a, j) => {
      // Fibonacci sphere: even coverage, no clumping at the poles.
      const k = j + 0.5;
      const phi = Math.acos(1 - (2 * k) / list.length);
      const theta = Math.PI * (1 + Math.sqrt(5)) * k;
      nodes.push({
        acct: a,
        hub,
        ox: Math.cos(theta) * Math.sin(phi) * R,
        oy: Math.sin(theta) * Math.sin(phi) * R,
        oz: Math.cos(phi) * R,
        spin: 0.11 + (j % 7) * 0.028,
        phase: (j / Math.max(1, list.length)) * TAU,
        // Money moving shows as light travelling down the link.
        flow: Math.min(1, (Number(a.volume_today) || 0) / 4000),
        flowPhase: (j * 0.37) % 1,
      });
    });

    hubs.push(hub);
  });

  return { hubs, nodes };
}

function create(canvas, opts = {}) {
  const { getData, onSelect, onHover } = opts;
  const ctx = canvas.getContext('2d');

  let width = 0, height = 0, dpr = 1;
  let yaw = 0.6, pitch = -0.32, zoom = 1;
  let tYaw = yaw, tPitch = pitch, tZoom = zoom;
  let vYaw = 0, vPitch = 0;           // momentum after a flick
  let autoSpin = true;
  let clock = 0, raf = null;
  let scene = { hubs: [], nodes: [] };
  let picks = [];
  let hovered = null;
  let disposed = false;
  let stars = [];

  const reduceMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    width = Math.max(320, rect.width);
    height = Math.max(360, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    makeStars();
  }

  /** A faint starfield gives the space depth without competing for attention. */
  function makeStars() {
    const n = Math.round((width * height) / 14000);
    stars = Array.from({ length: n }, (_, i) => ({
      x: (Math.sin(i * 12.9898) * 43758.5453 % 1 + 1) % 1 * width,
      y: (Math.sin(i * 78.233) * 43758.5453 % 1 + 1) % 1 * height,
      r: ((Math.sin(i * 3.17) + 1) / 2) * 1.1 + 0.25,
      a: ((Math.sin(i * 5.71) + 1) / 2) * 0.4 + 0.08,
      tw: (i % 17) / 17 * TAU,
    }));
  }

  function rebuild() {
    const { groups, accounts, groupOf } = getData();
    scene = layout(groups, accounts, groupOf);
  }

  const radiusFor = (a) => 6 + Math.min(11, Math.sqrt(Number(a.volume_today) || 0) / 8);

  function project(p) {
    const r = rotate(p, yaw, pitch);
    const focal = 1000;
    const denom = focal + r.z;
    const scale = denom > 80 ? (focal / denom) * zoom : 0.0001;
    return { x: width / 2 + r.x * scale, y: height / 2 + r.y * scale, z: r.z, scale };
  }

  /** A shaded sphere: lit face, dark limb, specular dot, outer bloom. */
  function sphere(x, y, r, color, depth, hot) {
    const bloom = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 4.5);
    bloom.addColorStop(0, rgba(color, 0.34 * depth));
    bloom.addColorStop(0.45, rgba(color, 0.11 * depth));
    bloom.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(x, y, r * 4.5, 0, TAU);
    ctx.fill();

    const body = ctx.createRadialGradient(x - r * 0.36, y - r * 0.42, r * 0.1, x, y, r);
    body.addColorStop(0, lighten(color, 0.55));
    body.addColorStop(0.5, color);
    body.addColorStop(1, rgba(color, 0.62));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x - r * 0.34, y - r * 0.4, r * 0.26, 0, TAU);
    ctx.fillStyle = `rgba(255,255,255,${0.5 * depth})`;
    ctx.fill();

    if (hot) {
      ctx.beginPath();
      ctx.arc(x, y, r + 1.2, 0, TAU);
      ctx.strokeStyle = rgba(color, 0.9);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  function frame() {
    if (disposed) return;
    clock += 1 / 60;

    // Momentum, then ease to target: a flick keeps spinning and settles.
    if (Math.abs(vYaw) > 0.00002) { tYaw += vYaw; vYaw *= 0.94; }
    if (Math.abs(vPitch) > 0.00002) {
      tPitch = Math.max(-1.25, Math.min(1.25, tPitch + vPitch));
      vPitch *= 0.94;
    }
    yaw += (tYaw - yaw) * 0.1;
    pitch += (tPitch - pitch) * 0.1;
    zoom += (tZoom - zoom) * 0.1;
    if (autoSpin && !reduceMotion) tYaw += 0.0013;

    ctx.clearRect(0, 0, width, height);

    // --- starfield ------------------------------------------------------
    for (const s of stars) {
      const a = reduceMotion ? s.a : s.a * (0.6 + 0.4 * Math.sin(clock * 0.8 + s.tw));
      ctx.fillStyle = `rgba(210, 225, 255, ${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.fill();
    }

    // --- positions ------------------------------------------------------
    for (const hub of scene.hubs) hub._p = project(hub);

    for (const n of scene.nodes) {
      const a = reduceMotion ? n.phase : clock * n.spin * 0.4 + n.phase;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ox = n.ox * ca - n.oz * sa;
      const oz = n.ox * sa + n.oz * ca;
      n._p = project({ x: n.hub.x + ox, y: n.hub.y + n.oy, z: n.hub.z + oz });
    }

    // --- links, behind everything ---------------------------------------
    for (const n of scene.nodes) {
      const hp = n.hub._p, np = n._p;
      if (!hp || !np || np.scale < 0.02) continue;
      const depth = Math.max(0.06, Math.min(1, np.scale * 0.9));
      const color = HEALTH_COLOR[n.acct.health] || HEALTH_COLOR.unknown;
      const isHot = hovered === n;

      const mx = (hp.x + np.x) / 2;
      const my = (hp.y + np.y) / 2 - 18 * depth;

      ctx.beginPath();
      ctx.moveTo(hp.x, hp.y);
      ctx.quadraticCurveTo(mx, my, np.x, np.y);
      ctx.strokeStyle = isHot ? rgba(color, 0.85) : `rgba(150, 170, 235, ${0.10 * depth})`;
      ctx.lineWidth = isHot ? 1.8 : 1;
      ctx.stroke();

      // Light travelling toward the account: today's volume, made visible.
      if (!reduceMotion && (n.flow > 0.02 || isHot)) {
        const beads = isHot ? 3 : 1 + Math.round(n.flow * 2);
        for (let b = 0; b < beads; b++) {
          const u = (clock * (0.22 + n.flow * 0.4) + n.flowPhase + b / beads) % 1;
          const inv = 1 - u;
          const px = inv * inv * hp.x + 2 * inv * u * mx + u * u * np.x;
          const py = inv * inv * hp.y + 2 * inv * u * my + u * u * np.y;
          const fade = Math.sin(u * Math.PI);
          ctx.beginPath();
          ctx.arc(px, py, (isHot ? 2.4 : 1.7) * depth, 0, TAU);
          ctx.fillStyle = rgba(color, 0.75 * fade * depth);
          ctx.fill();
        }
      }
    }

    // --- bodies, painted far to near ------------------------------------
    const draw = [];
    for (const hub of scene.hubs) draw.push({ kind: 'hub', hub, p: hub._p, z: hub._p.z });
    for (const n of scene.nodes) draw.push({ kind: 'node', node: n, p: n._p, z: n._p.z });
    draw.sort((a, b) => b.z - a.z);

    for (const item of draw) {
      const p = item.p;
      if (p.scale < 0.02) continue;
      const depth = Math.max(0.1, Math.min(1.15, p.scale));

      // Distance blurs: the far side reads as mass, not detail.
      const blur = Math.max(0, (1 - depth) * 5);
      ctx.filter = blur > 0.35 ? `blur(${blur.toFixed(1)}px)` : 'none';

      if (item.kind === 'hub') {
        const r = 16 * depth;
        const halo = ctx.createRadialGradient(p.x, p.y, r * 0.3, p.x, p.y, r * 6);
        halo.addColorStop(0, `rgba(124, 92, 255, ${0.30 * depth})`);
        halo.addColorStop(1, 'rgba(124, 92, 255, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 6, 0, TAU);
        ctx.fill();

        // A slow ring, so a core reads as a core and not just a big node.
        const wobble = reduceMotion ? 0 : Math.sin(clock * 0.5 + item.hub.seed) * 0.12;
        const ringR = r * (1.9 + wobble);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, ringR, ringR * Math.max(0.16, Math.abs(Math.sin(pitch))), 0, 0, TAU);
        ctx.strokeStyle = `rgba(154, 128, 255, ${0.45 * depth})`;
        ctx.lineWidth = 1.1;
        ctx.stroke();

        sphere(p.x, p.y, r, '#7C5CFF', depth, false);

        ctx.filter = 'none';
        ctx.font = `700 ${Math.max(10, 13 * depth)}px "Plus Jakarta Sans", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = `rgba(236, 241, 255, ${0.92 * depth})`;
        ctx.fillText(item.hub.name, p.x, p.y - ringR - 9);
        ctx.font = `500 ${Math.max(9, 10.5 * depth)}px "Plus Jakarta Sans", system-ui, sans-serif`;
        ctx.fillStyle = `rgba(142, 156, 196, ${0.85 * depth})`;
        ctx.fillText(`${item.hub.count} account${item.hub.count === 1 ? '' : 's'}`, p.x, p.y - ringR + 4);
        continue;
      }

      const a = item.node.acct;
      const health = a.health || 'unknown';
      const color = HEALTH_COLOR[health] || HEALTH_COLOR.unknown;
      const r = radiusFor(a) * depth;
      const isHover = hovered === item.node;

      // Anything needing a decision sends out a slow ring — found before read.
      if (NEEDS_ATTENTION.has(health) && !reduceMotion) {
        const pulse = (clock * 0.55 + item.node.phase) % 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + pulse * 30 * depth, 0, TAU);
        ctx.strokeStyle = rgba(color, (1 - pulse) * 0.55 * depth);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      sphere(p.x, p.y, r, color, depth, isHover);

      ctx.filter = 'none';
      if (depth > 0.66 || isHover) {
        ctx.font = `${isHover ? 700 : 500} ${Math.max(9, 11 * depth)}px "Plus Jakarta Sans", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = `rgba(236, 241, 255, ${isHover ? 1 : 0.62 * depth})`;
        ctx.fillText(a.label || 'unnamed', p.x, p.y + r + 14 * depth);
      }
    }
    ctx.filter = 'none';

    picks = draw.filter((i) => i.kind === 'node');
    raf = requestAnimationFrame(frame);
  }

  // --- interaction ----------------------------------------------------------

  function pick(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    const x = cx - rect.left, y = cy - rect.top;
    let best = null, bestD = 26;
    for (const it of picks) {
      const d = Math.hypot(it.p.x - x, it.p.y - y);
      const hit = Math.max(13, radiusFor(it.node.acct) * it.p.scale + 9);
      if (d < hit && d < bestD) { bestD = d; best = it.node; }
    }
    return best;
  }

  let dragging = false, moved = false, lastX = 0, lastY = 0;

  const onDown = (e) => {
    dragging = true; moved = false;
    lastX = e.clientX; lastY = e.clientY;
    vYaw = 0; vPitch = 0;
    autoSpin = false;
    canvas.style.cursor = 'grabbing';
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
  };

  const onMove = (e) => {
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.hypot(dx, dy) > 2) moved = true;
      tYaw += dx * 0.006;
      tPitch = Math.max(-1.25, Math.min(1.25, tPitch + dy * 0.005));
      vYaw = dx * 0.0016;
      vPitch = dy * 0.0013;
      lastX = e.clientX; lastY = e.clientY;
      return;
    }
    const hit = pick(e.clientX, e.clientY);
    if (hit !== hovered) {
      hovered = hit;
      canvas.style.cursor = hit ? 'pointer' : 'grab';
    }
    if (onHover) onHover(hit ? hit.acct : null, e.clientX, e.clientY);
  };

  const onUp = (e) => {
    if (dragging && !moved) {
      const hit = pick(e.clientX, e.clientY);
      if (hit && onSelect) onSelect(hit.acct);
    }
    dragging = false;
    canvas.style.cursor = hovered ? 'pointer' : 'grab';
    if (canvas.releasePointerCapture) {
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
    }
  };

  const onLeave = () => {
    dragging = false;
    hovered = null;
    if (onHover) onHover(null);
  };

  const onWheel = (e) => {
    e.preventDefault();
    tZoom = Math.max(0.4, Math.min(3, tZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';

  const onResize = () => resize();
  window.addEventListener('resize', onResize);

  resize();
  rebuild();
  frame();

  return {
    update() { rebuild(); },
    resetView() { tYaw = 0.6; tPitch = -0.32; tZoom = 1; vYaw = 0; vPitch = 0; autoSpin = true; },
    toggleSpin() { autoSpin = !autoSpin; return autoSpin; },
    get spinning() { return autoSpin; },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}

window.Orbit = { create, HEALTH_COLOR };

})();
