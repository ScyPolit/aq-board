/* ============================================================================
   city3d.js —— Three.js 3D 城市视图
   · GeoJSON 区块高度挤出（高度 = AQI）
   · 自定义 shader：底 #1B66A0 → 顶 #2BB692 竖向渐变 + 菲涅尔透明边 + 扫描提亮
   · EdgesGeometry 1.5px 青色发光描边
   · 8s 一轮从下往上扫的青色扫描面（扫中建筑 ×1.4 提亮）
   · QuadraticBezierCurve3 + TubeGeometry 流动 UV 飞线
   · UnrealBloomPass(0.9, 0.6, 0.85)
   · CatmullRom 20s 自动巡航；点击区块飞到 40° 街区视角
   · 2.4s 扩散扫描环 + 旋转雷达扇
   ========================================================================== */
(function () {
  'use strict';

  var C = {
    container: null, renderer: null, scene: null, camera: null,
    composer: null, bloom: null,
    group: null, buildings: [], edges: [], tubes: [], dots: [],
    scanPlane: null, radar: null, rings: [],
    bounds: null, center: { x: 0, z: 0 }, scale: 1, maxH: 8,
    clock: null, t0: 0, running: false,
    cruise: null, cruiseT: 0, flight: null,
    raf: 0, disposed: false, onSelect: null,
    uniformsList: []
  };

  var BOT = new THREE.Color('#1B66A0');
  var TOP = new THREE.Color('#2BB692');
  var CYAN = new THREE.Color('#8CE8FF');

  /* ---------------- 投影 ---------------- */
  function computeProjection(units) {
    var minLng = 1e9, maxLng = -1e9, minLat = 1e9, maxLat = -1e9;
    units.forEach(function (u) {
      (u.boundaries || []).forEach(function (b) {
        String(b).split('|').forEach(function (part) {
          var arr = part.split(',');
          for (var i = 0; i + 1 < arr.length; i += 2) {
            var lng = parseFloat(arr[i]), lat = parseFloat(arr[i + 1]);
            if (!isFinite(lng) || !isFinite(lat)) continue;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
        });
      });
    });
    if (minLng > 1e8) return false;
    var cLng = (minLng + maxLng) / 2, cLat = (minLat + maxLat) / 2;
    var spanX = Math.max(0.001, (maxLng - minLng) * Math.cos(cLat * Math.PI / 180));
    var spanY = Math.max(0.001, maxLat - minLat);
    var span = Math.max(spanX, spanY);
    C.scale = 120 / span;             /* 城市横向约 120 世界单位 */
    C.center = { lng: cLng, lat: cLat };
    return true;
  }

  function px(lng, lat) {
    return {
      x: (lng - C.center.lng) * Math.cos(C.center.lat * Math.PI / 180) * C.scale,
      y: (lat - C.center.lat) * C.scale
    };
  }

  function ringsOf(u) {
    var rings = [];
    (u.boundaries || []).forEach(function (b) {
      String(b).split('|').forEach(function (part) {
        var arr = part.split(','), pts = [];
        for (var i = 0; i + 1 < arr.length; i += 2) {
          var lng = parseFloat(arr[i]), lat = parseFloat(arr[i + 1]);
          if (isFinite(lng) && isFinite(lat)) pts.push([lng, lat]);
        }
        if (pts.length > 2) rings.push(pts);
      });
    });
    return rings;
  }

  /* ---------------- shader ---------------- */
  function makeBuildingMaterial(height) {
    return new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
      uniforms: {
        uTop:       { value: new THREE.Color('#2BB692') },
        uHeight:    { value: Math.max(0.001, height) },
        uMaxH:      { value: 8.0 },
        uTime:      { value: 0 },
        uOpacity:   { value: 0.62 },
        uBandCycle: { value: 10.0 },   /* 光带往返周期（秒） */
        uBandEdge:  { value: 0.05 },   /* 光带宽度阈值 */
        uBandDiv:   { value: 6.0 }     /* 每 1/6 高度一根（对应参考里的质数带状） */
      },
      vertexShader: [
        'varying float vH;',
        'varying vec3 vNormalW;',
        'varying vec3 vViewDir;',
        'void main(){',
        '  vec4 wp = modelMatrix * vec4(position, 1.0);',
        '  vH = wp.y;',                                   /* 离地高度 */
        '  vNormalW = normalize(mat3(modelMatrix) * normal);',
        '  vViewDir = normalize(cameraPosition - wp.xyz);',
        '  gl_Position = projectionMatrix * viewMatrix * wp;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uTop;',
        'uniform float uHeight;',
        'uniform float uMaxH;',
        'uniform float uTime;',
        'uniform float uOpacity;',
        'uniform float uBandCycle;',
        'uniform float uBandEdge;',
        'uniform float uBandDiv;',
        'varying float vH;',
        'varying vec3 vNormalW;',
        'varying vec3 vViewDir;',
        'void main(){',
        /* 高度渐变：底暗 -> 顶亮（青绿系，参考 doc 的 baseCol 换成青绿） */
        '  float strength = clamp(vH / max(uMaxH, 0.001), 0.0, 1.0) * 1.05;',
        '  vec3 baseCol = vec3(0.10, 0.52, 0.50) * strength;',
        '  baseCol += uTop * 0.18 * smoothstep(0.7, 1.0, clamp(vH/uHeight, 0.0, 1.0));',
        /* 三角波：上下往返 */
        '  float ph = fract(uTime / uBandCycle);',
        '  float t = abs(ph - 0.5) * 2.0;',
        '  float hNorm = clamp(vH / max(uHeight, 0.001), 0.0, 1.0);',
        /* 通道 A：整栋楼扫一根 */
        '  float ringA = 1.0 - step(uBandEdge, abs(hNorm - t));',
        /* 通道 B：按高度分带扫（错开，形成多条细光带） */
        '  float ringB = 1.0 - step(uBandEdge, abs(fract(hNorm * uBandDiv) - t));',
        '  vec3 col = baseCol + vec3(0.26, 0.42, 0.42) * clamp(ringA + ringB, 0.0, 1.0);',
        /* 菲涅尔边缘 */
        '  float fres = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir))), 2.2);',
        '  col += vec3(0.35, 0.8, 0.95) * fres * 0.5;',
        '  float alpha = uOpacity + fres * 0.2 + clamp(ringA + ringB, 0.0, 1.0) * 0.15;',
        '  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));',
        '}'
      ].join('\n')
    });
  }

  /* ---------------- 构建 ---------------- */
  function clearGroup() {
    if (!C.group) return;
    C.group.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(function (m) { m.dispose(); });
        else o.material.dispose();
      }
    });
    C.scene.remove(C.group);
    C.group = new THREE.Group();
    C.scene.add(C.group);
    C.buildings = []; C.edges = []; C.tubes = []; C.dots = []; C.rings = [];
    C.uniformsList = [];
  }

  function buildCity(units) {
    clearGroup();
    if (!computeProjection(units)) return;

    var aqiVals = units.map(function (u) { return u.aqi || 60; });
    var minA = Math.min.apply(null, aqiVals), maxA = Math.max.apply(null, aqiVals);
    var span = Math.max(1, maxA - minA);

    units.forEach(function (u) {
      var rings = ringsOf(u);
      if (!rings.length) return;
      var aqi = u.aqi || 60;
      var h = 2 + (aqi - minA) / span * 6;            /* 2~8 单位 */
      if (h > C.maxH) C.maxH = h;

      var shape = new THREE.Shape();
      rings.forEach(function (ring, ri) {
        var pts = ring.map(function (p) { return px(p[0], p[1]); });
        if (ri === 0) {
          shape.moveTo(pts[0].x, pts[0].y);
          for (var i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
          shape.closePath();
        } else {
          var hole = new THREE.Path();
          hole.moveTo(pts[0].x, pts[0].y);
          for (var j = 1; j < pts.length; j++) hole.lineTo(pts[j].x, pts[j].y);
          hole.closePath();
          shape.holes.push(hole);
        }
      });

      var geo = new THREE.ExtrudeGeometry(shape, {
        depth: h, bevelEnabled: false, curveSegments: 1
      });
      var mat = makeBuildingMaterial(h);
      C.uniformsList.push(mat.uniforms);
      var mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;                 /* 挤出方向朝上 */
      mesh.userData = { unit: u, height: h };
      C.group.add(mesh);
      C.buildings.push(mesh);

      /* 顶边发光描边 */
      var edgeGeo = new THREE.EdgesGeometry(geo, 25);
      var edgeMat = new THREE.LineBasicMaterial({
        color: 0x8fe4ff, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      var line = new THREE.LineSegments(edgeGeo, edgeMat);
      line.rotation.x = -Math.PI / 2;
      line.position.y = 0.02;
      C.group.add(line);
      C.edges.push(line);
    });

    /* 地面区界（青白 1px） */
    var baseGeoArr = [];
    units.forEach(function (u) {
      ringsOf(u).forEach(function (ring) {
        var pts = ring.map(function (p) {
          var q = px(p[0], p[1]);
          return new THREE.Vector3(q.x, 0.05, -q.y);
        });
        pts.push(pts[0].clone());
        baseGeoArr.push(pts);
      });
    });
    baseGeoArr.forEach(function (pts) {
      var g = new THREE.BufferGeometry().setFromPoints(pts);
      var m = new THREE.LineBasicMaterial({
        color: 0x8fe4ff, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      C.group.add(new THREE.Line(g, m));
    });

    buildFlights(units);
    buildBlocks(units);
    buildCone(units);
    buildScan();
    buildRadar();
  }


  /* ---------- 位置判定：点是否在多边形内 ---------- */
  function pointInRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }

  /* ---------- 建筑体块：在区块内撒点，挤出成楼 ---------- */
  function buildBlocks(units) {
    /* 先算出整体范围，决定网格步长 */
    var all = [];
    units.forEach(function (u) { ringsOf(u).forEach(function (r) { all.push(r); }); });
    if (!all.length) return;

    var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    all.forEach(function (ring) {
      ring.forEach(function (pt) {
        var q = px(pt[0], pt[1]);
        if (q.x < minX) minX = q.x;
        if (q.x > maxX) maxX = q.x;
        if (-q.y < minZ) minZ = -q.y;
        if (-q.y > maxZ) maxZ = -q.y;
      });
    });

    var span = Math.max(maxX - minX, maxZ - minZ);
    var step = Math.max(1.6, span / 34);        /* 约 34×34 的网格 */
    var boxes = 0, MAXB = 1600;
    var geoCache = [];

    for (var gx = minX; gx <= maxX && boxes < MAXB; gx += step) {
      for (var gz = minZ; gz <= maxZ && boxes < MAXB; gz += step) {
        /* 找它属于哪个区县 */
        for (var i = 0; i < units.length; i++) {
          var u = units[i];
          var rings = ringsOf(u);
          if (!rings.length) continue;
          var hit = false;
          for (var k = 0; k < rings.length; k++) {
            var pr = rings[k].map(function (pt) { var q = px(pt[0], pt[1]); return [q.x, -q.y]; });
            if (pointInRing(gx, gz, pr)) { hit = true; break; }
          }
          if (!hit) continue;

          /* 楼：确定性伪随机高度，跟着 AQI 走 */
          var seed = Math.abs(Math.sin(gx * 12.9898 + gz * 78.233) * 43758.5453) % 1;
          var hh = 0.8 + seed * 3.4 + (u.aqi || 60) / 90;   /* 约 2~7 */
          var w = step * 0.42, d = step * 0.42;

          var geo = new THREE.BoxGeometry(w, hh, d);
          var mat = makeBuildingMaterial(hh);
          mat.uniforms.uHeight.value = hh;
          mat.uniforms.uOpacity.value = 0.62;
          C.uniformsList.push(mat.uniforms);
          var mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(gx, hh / 2, gz);
          mesh.rotation.y = seed * Math.PI;
          mesh.userData = { unit: u, height: hh };
          C.group.add(mesh);
          C.buildings.push(mesh);
          boxes++;
          break;
        }
      }
    }
  }

  /* ---------------- 飞线 ---------------- */
  function buildFlights(units) {
    var pts = units.map(function (u) {
      if (!u.center) return null;
      var q = px(u.center.lng, u.center.lat);
      return new THREE.Vector3(q.x, 0.4, -q.y);
    }).filter(Boolean);
    if (pts.length < 2) return;

    var pairs = Math.min(10, pts.length);
    for (var i = 0; i < pairs; i++) {
      var a = pts[i], b = pts[(i * 3 + 2) % pts.length];
      if (a === b) b = pts[(i + 1) % pts.length];
      var mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y += a.distanceTo(b) * 0.42 + 6;
      var curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      var tubeGeo = new THREE.TubeGeometry(curve, 48, 0.22, 6, false);
      var tubeMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uColor: { value: CYAN.clone() } },
        vertexShader: [
          'varying vec2 vUv;',
          'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
        ].join('\n'),
        fragmentShader: [
          'uniform float uTime;',
          'uniform vec3 uColor;',
          'varying vec2 vUv;',
          'void main(){',
          '  float f = fract(vUv.x * 2.0 - uTime * 0.55);',
          '  float head = smoothstep(0.0, 0.16, f) * (1.0 - smoothstep(0.16, 0.42, f));',
          '  float glow = 0.16 + head * 1.1;',
          '  gl_FragColor = vec4(uColor * glow, 0.28 + head * 0.8);',
          '}'
        ].join('\n')
      });
      var tube = new THREE.Mesh(tubeGeo, tubeMat);
      C.group.add(tube);
      C.tubes.push(tube);
      C.uniformsList.push(tubeMat.uniforms);
    }
  }


  /* ---------------- 地标光锥 ---------------- */
  function buildCone(units) {
    var best = null;
    units.forEach(function (u) { if (!best || u.aqi > best.aqi) best = u; });
    if (!best || !best.center) return;
    var q = px(best.center.lng, best.center.lat);
    var geo = new THREE.ConeGeometry(2.4, 26, 4, 1, true);
    var mat = new THREE.MeshBasicMaterial({
      color: 0xffd479, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    var cone = new THREE.Mesh(geo, mat);
    cone.position.set(q.x, 13, -q.y);
    C.group.add(cone);
    C.cone = cone;
  }

  /* ---------------- 扫描面 ---------------- */
  function buildScan() {
    var geo = new THREE.PlaneGeometry(240, 240);
    var mat = new THREE.MeshBasicMaterial({
      color: 0x2ee6ff, transparent: true, opacity: 0.03,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    var p = new THREE.Mesh(geo, mat);
    p.rotation.x = -Math.PI / 2;
    p.position.y = -999;
    C.group.add(p);
    C.scanPlane = p;
  }

  /* ---------------- 雷达 ---------------- */
  function buildRadar() {
    var geo = new THREE.CircleGeometry(26, 48, 0, Math.PI / 4);
    var mat = new THREE.MeshBasicMaterial({
      color: 0x35e0ff, transparent: true, opacity: 0.08,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    var m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.12;
    C.group.add(m);
    C.radar = m;

    /* 2.4s 扩散环 */
    for (var i = 0; i < 2; i++) {
      var rGeo = new THREE.RingGeometry(0.9, 1.0, 96);
      var rMat = new THREE.MeshBasicMaterial({
        color: 0x6ff0ff, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      });
      var ring = new THREE.Mesh(rGeo, rMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.1;
      ring.userData.phase = i * 0.5;
      C.group.add(ring);
      C.rings.push(ring);
    }
  }


  /* ---------------- 点击拾取 ---------------- */
  var raycaster = new THREE.Raycaster();
  var pointer = new THREE.Vector2();

  function onPointerDown(ev) {
    if (!C.renderer || !C.buildings.length) return;
    var rect = C.renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, C.camera);
    var hits = raycaster.intersectObjects(C.buildings, false);
    if (!hits.length) return;
    var mesh = hits[0].object;
    var unit = mesh.userData.unit;
    flyTo(mesh, unit);
    if (typeof C.onSelect === 'function') C.onSelect(unit, mesh.userData.height);
  }

  function flyTo(mesh, unit) {
    var box = new THREE.Box3().setFromObject(mesh);
    var c = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var dist = Math.max(38, Math.max(size.x, size.z) * 2.2);
    C.flight = {
      k: 0,
      from: C.camera.position.clone(),
      to: new THREE.Vector3(c.x + dist * 0.45, c.y + dist * 0.62, c.z + dist * 0.8),
      lookAt: c.clone()
    };
  }

  function attachPointer() {
    if (!C.renderer) return;
    C.renderer.domElement.addEventListener('pointerdown', onPointerDown);
    C.renderer.domElement.addEventListener('pointerdown', function () { pauseFor(4000); });
    C.renderer.domElement.addEventListener('wheel', function () { pauseFor(4000); }, { passive: true });
  }

  /* ---------------- 巡航 ---------------- */
  function buildCruise() {
    var R = 270, H = 170;
    var pts = [];
    for (var i = 0; i < 6; i++) {
      var a = i / 6 * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * R, H + Math.sin(a * 2) * 6, Math.sin(a) * R));
    }
    C.cruise = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
  }


  /* ---------------- 持续放大运镜（对数高度 + 俯仰抬头 + 循环） ---------------- */
  var TOUR = [
    { h: 560, pitch: 88, dur: 0,    hold: 1200 },
    { h: 360, pitch: 74, dur: 6000, hold: 0 },
    { h: 250, pitch: 58, dur: 5000, hold: 0 },
    { h: 175, pitch: 45, dur: 4500, hold: 0 },
    { h: 128, pitch: 34, dur: 4000, hold: 2800 }
  ];

  function tourTotal() {
    var t = 0;
    TOUR.forEach(function (s) { t += (s.dur || 0) + (s.hold || 0); });
    return t;
  }

  function applyTour(elapsed) {
    var total = tourTotal(), t = elapsed % total;
    var i = 0, acc = 0;
    while (i < TOUR.length && t > acc + (TOUR[i].dur || 0) + (TOUR[i].hold || 0)) {
      acc += (TOUR[i].dur || 0) + (TOUR[i].hold || 0);
      i++;
    }
    if (i >= TOUR.length) i = TOUR.length - 1;
    var cur = TOUR[i], prev = i > 0 ? TOUR[i - 1] : TOUR[0];
    var inSeg = t - acc;

    var h0 = prev.h, h1 = cur.h, p0 = prev.pitch, p1 = cur.pitch, e = 1;
    var h, pitchDeg;
    if (cur.dur > 0 && inSeg <= cur.dur) {
      var k = Math.min(1, Math.max(0, inSeg / cur.dur));
      e = 1 - Math.pow(1 - k, 3);
      /* 高度对数插值：高空移动快、近地变慢 */
      h = Math.exp(Math.log(h0) + (Math.log(h1) - Math.log(h0)) * e);
      pitchDeg = p0 + (p1 - p0) * e;
    } else {
      /* 停留段：保持在当前停靠点 */
      h = h1; pitchDeg = p1;
    }
    var pitch = pitchDeg * Math.PI / 180;
    var azim = 0.55 + t / total * 0.9;
    C.camera.position.set(
      Math.sin(azim) * Math.cos(pitch) * h,
      Math.sin(pitch) * h,
      Math.cos(azim) * Math.cos(pitch) * h
    );
    C.camera.lookAt(0, 2, 0);
    C.tourPhase = i;
  }

  function startTour() {
    C.tour = true;
    C.tourStart = performance.now() - (C.tourOffset || 0);
  }
  function stopTour() {
    C.tour = false;
    if (C.tourStart) C.tourOffset = performance.now() - C.tourStart;
  }
  function pauseFor(ms) {
    C.tourPausedUntil = performance.now() + ms;
  }

  /* ---------------- 主循环 ---------------- */
  function animate() {
    if (C.disposed) return;
    C.raf = requestAnimationFrame(animate);
    var now = performance.now();
    var t = (now - C.t0) / 1000;

    /* 8s 扫描 */
    var cycle = 8, phase = (t % cycle) / cycle;
    var scanY = phase * (C.maxH + 3) - 1;
    C.uniformsList.forEach(function (u) {
      if (u.uTime) u.uTime.value = t;
      if (u.uScanY) u.uScanY.value = scanY;
    });
    if (C.scanPlane) {
      C.scanPlane.position.y = scanY;
      C.scanPlane.material.opacity = 0.02 + Math.sin(phase * Math.PI) * 0.03;
    }

    /* 光锥上下浮动 */
    if (C.cone) {
      var cy = 13 + Math.sin(t * 0.9) * 4;
      C.cone.position.y = cy;
      C.cone.material.opacity = 0.12 + Math.abs(Math.sin(t * 0.9)) * 0.12;
      C.cone.rotation.y = t * 0.4;
    }

    /* 雷达旋转 */
    if (C.radar) C.radar.rotation.z = -t * 0.8;

    /* 扩散环 */
    C.rings.forEach(function (r) {
      var p = ((t / 2.4) + r.userData.phase) % 1;
      var s = 4 + p * 110;
      r.scale.set(s, s, 1);
      r.material.opacity = (1 - p) * 0.3;
    });

    /* 相机：3D 层默认走“持续放大”运镜，用户交互时让位 */
    if (C.tour && !C.flight && (!C.tourPausedUntil || now > C.tourPausedUntil)) {
      applyTour(now - C.tourStart);
    } else if (C.flight) {
      C.flight.k = Math.min(1, C.flight.k + 0.012);
      var e = 1 - Math.pow(1 - C.flight.k, 3);
      C.camera.position.lerpVectors(C.flight.from, C.flight.to, e);
      C.camera.lookAt(C.flight.lookAt);
      if (C.flight.k >= 1) C.flight = null;
    } else if (!C.tour && C.cruise) {
      C.cruiseT = (C.cruiseT + 0.00055) % 1;
      var p2 = C.cruise.getPoint(C.cruiseT);
      C.camera.position.copy(p2);
      C.camera.lookAt(0, -8, 0);
    }

    C.composer.render();
  }

  /* ---------------- 对外 ---------------- */
  function init(container) {
    C.container = typeof container === 'string' ? document.getElementById(container) : container;
    if (!C.container || !window.THREE) return false;

    C.scene = new THREE.Scene();
    C.scene.background = new THREE.Color('#071A2E');
    C.scene.fog = new THREE.FogExp2(0x071a2e, 0.0011);

    var w = C.container.clientWidth || 1200, h = C.container.clientHeight || 700;
    C.camera = new THREE.PerspectiveCamera(45, w / h, 0.5, 2000);
    C.camera.position.set(0, 150, 250);
    C.camera.lookAt(0, -6, 0);

    C.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    C.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    C.renderer.setSize(w, h);
    C.renderer.setClearColor(0x071a2e, 1);
    C.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    C.renderer.toneMappingExposure = 0.62;
    C.container.appendChild(C.renderer.domElement);

    C.scene.add(new THREE.AmbientLight(0x88bbdd, 1.1));
    var d = new THREE.DirectionalLight(0xaee8ff, 1.2);
    d.position.set(60, 120, 40);
    C.scene.add(d);

    C.group = new THREE.Group();
    C.scene.add(C.group);

    var EC = window.EffectComposer || THREE.EffectComposer;
    var RP = window.RenderPass || THREE.RenderPass;
    var UB = window.UnrealBloomPass || THREE.UnrealBloomPass;
    if (EC && RP && UB) {
      C.composer = new EC(C.renderer);
      C.composer.addPass(new RP(C.scene, C.camera));
      C.bloom = new UB(new THREE.Vector2(w, h), 0.9, 0.6, 0.85);
      C.composer.addPass(C.bloom);
    } else {
      C.composer = { render: function () { C.renderer.render(C.scene, C.camera); } };
    }

    buildCruise();
    attachPointer();
    startTour();
    C.t0 = performance.now();
    C.running = true;
    animate();
    return true;
  }

  function setData(units, opts) {
    if (!C.scene) return false;
    C.maxH = 8;
    buildCity(units || []);
    C.tourOffset = 0;
    C.tourStart = performance.now();
    C.tour = true;
    if (opts && opts.focus) focus();
    return true;
  }

  function focus() {
    C.cruiseT = 0;
    C.flight = {
      k: 0,
      from: C.camera.position.clone(),
      to: new THREE.Vector3(0, 40, 70),
      lookAt: new THREE.Vector3(0, 2, 0)
    };
  }

  function resize() {
    if (!C.renderer || !C.container) return;
    var w = C.container.clientWidth, h = C.container.clientHeight;
    if (!w || !h) return;
    C.camera.aspect = w / h;
    C.camera.updateProjectionMatrix();
    C.renderer.setSize(w, h);
    if (C.composer.setSize) C.composer.setSize(w, h);
  }

  function pause() { if (C.raf) { cancelAnimationFrame(C.raf); C.raf = 0; } C.running = false; }
  function resume() { if (!C.running && !C.disposed) { C.running = true; C.t0 = performance.now() - C.elapsed || performance.now(); animate(); } }

  window.City3D = {
    init: init, setData: setData, resize: resize, focus: focus,
    startTour: startTour, stopTour: stopTour,
    pause: pause, resume: resume, state: C
  };
})();
