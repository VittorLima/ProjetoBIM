// src/main.js
// Viewer IFC + AR real (WebXR/Android) + Fallback simples (iOS/desktop)

import * as THREE from 'three';
import { IfcViewerAPI } from 'web-ifc-viewer';

let xrSession = null;
let xrRefSpace = null;
let xrHitTestSource = null;
let reticle = null;
const arRoot = new THREE.Group();

let dragYaw = 0, dragging = false, lastX = 0;
let userScale = 1;
let userTouchedScale = false;

function getRenderer(v){ return v.context.getRenderer?.() || v.context.renderer?.renderer || v.context.renderer; }
function getScene(v){ return v.context.getScene?.() || v.context.scene; }
function getCamera(v){ return v.context.getCamera?.() || v.context.camera; }

async function init() {
  const container = document.getElementById('three-canvas');

  const viewer = new IfcViewerAPI({
    container,
    backgroundColor: new THREE.Color(0xf0f0f0)
  });

  const wasmBase = import.meta.env.DEV ? '/' : import.meta.env.BASE_URL;
  await viewer.IFC.setWasmPath(wasmBase);

  viewer.axes.setAxes();
  viewer.grid.setGrid();
  viewer.context.renderer.postProduction.active = false;

  const scene    = getScene(viewer);
  const camera   = getCamera(viewer);
  const renderer = getRenderer(viewer);

  // raiz AR e retículo
  scene.add(arRoot); arRoot.visible = false;
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x00ff99, transparent:true, opacity:0.95, depthTest:false })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const ifcFileInput  = document.getElementById('ifc-file-input');
  const statusElement = document.getElementById('status');
  const arBtn         = document.getElementById('ar-button');
  const arExitBtn     = document.getElementById('ar-exit-button');
  const arOverlay     = document.getElementById('ar-overlay');

  ifcFileInput.addEventListener('change', async (ev)=>{
    const file=ev.target.files[0]; if(!file) return;
    statusElement.textContent='Carregando modelo 3D...';
    try{
      await viewer.IFC.loadIfc(file,true);
      statusElement.textContent='Modelo carregado!';
    }catch(err){ statusElement.textContent=`Erro ao carregar: ${err.message}`; }
  });

  arBtn?.addEventListener('click', async () => {
    try {
      let hasAR = false;
      if (navigator.xr?.isSessionSupported) {
        try { hasAR = await navigator.xr.isSessionSupported('immersive-ar'); } catch {}
      }
      if (hasAR) {
        await startAR(viewer, arOverlay);   // Android (WebXR)
      } else {
        await startFallbackAR(viewer);      // iOS e desktop (simples)
      }
      document.body.classList.add('is-ar');
      arOverlay?.classList.remove('hidden');
      arBtn.style.display = 'none';
    } catch (e) {
      statusElement.textContent = 'Erro ao iniciar AR: ' + (e?.message || e);
    }
  });

  arExitBtn?.addEventListener('click', ()=> endAR(viewer));

  // ====== interação simples no fallback (rotacionar)
  const canvas = renderer.domElement;
  canvas.addEventListener('mousedown', ev=>{ dragging=true; lastX=ev.clientX; });
  canvas.addEventListener('mousemove', ev=>{
    if (!dragging) return;
    const dx = ev.clientX - lastX; lastX = ev.clientX;
    dragYaw += dx * 0.005; arRoot.rotation.y = dragYaw;
  });
  canvas.addEventListener('mouseup', ()=> dragging=false);
  canvas.addEventListener('touchstart', ev=>{ dragging=true; lastX=ev.touches?.[0]?.clientX ?? 0; }, {passive:true});
  canvas.addEventListener('touchmove',  ev=>{
    if (!dragging) return;
    const x = ev.touches?.[0]?.clientX ?? 0;
    const dx = x - lastX; lastX = x;
    dragYaw += dx * 0.005; arRoot.rotation.y = dragYaw;
  }, {passive:true});
  canvas.addEventListener('touchend', ()=> dragging=false);
}

/* ========= AR real (Android / WebXR) ========= */
async function startAR(viewer, domOverlayRoot){
  const renderer = getRenderer(viewer);
  const scene    = getScene(viewer);
  const camera   = getCamera(viewer);

  const models = viewer?.context?.items?.ifcModels || [];
  if (!models.length) throw new Error('Carregue um arquivo IFC antes de iniciar o AR.');

  let overlayRoot = domOverlayRoot || document.body;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');

  xrSession = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures:['local-floor'],
    optionalFeatures:['hit-test','dom-overlay'],
    domOverlay:{ root: overlayRoot }
  });

  await renderer.xr.setSession(xrSession);
  try { xrRefSpace = await xrSession.requestReferenceSpace('local-floor'); }
  catch { xrRefSpace = await xrSession.requestReferenceSpace('local'); }

  try {
    const viewerSpace = await xrSession.requestReferenceSpace('viewer');
    xrHitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
  } catch { xrHitTestSource = null; }

  renderer.domElement.style.background = 'transparent';
  renderer.setClearColor(0x000000, 0);
  scene.background = null;
  viewer.grid?.setGrid(false);
  viewer.axes?.setAxes(false);

  xrSession.addEventListener('select', ()=> tryPlaceOnTap(viewer));
  xrSession.addEventListener('end', ()=> endAR(viewer));

  renderer.setAnimationLoop((time, frame)=>{
    if(!frame) return;
    if (xrHitTestSource) {
      const hits = frame.getHitTestResults(xrHitTestSource);
      if (hits.length){
        const pose = hits[0].getPose(xrRefSpace);
        if (pose){ reticle.visible=true; reticle.matrix.fromArray(pose.transform.matrix); }
      } else reticle.visible=false;
    }
    renderer.render(scene,camera);
  });

  arRoot.visible = true;
  if (!xrHitTestSource) placeInFrontOfCamera(viewer, 1.2);
}

/* ========= Fallback simples (iOS e Desktop) ========= */
async function startFallbackAR(viewer){
  const renderer = getRenderer(viewer);
  const scene    = getScene(viewer);

  const models = viewer?.context?.items?.ifcModels || [];
  if (!models.length) throw new Error('Carregue um arquivo IFC antes de iniciar o AR.');

  renderer.xr.enabled = false;
  renderer.setClearColor(0xffffff, 1);
  scene.background = new THREE.Color(0xffffff);

  viewer.grid?.setGrid(false);
  viewer.axes?.setAxes(false);

  // 1) cria/garante o clone ANTES de esconder o original
  const clone = ensureARMesh(viewer);
  forceVisibleAndOpaque(clone);

  // 2) agora sim esconde o original
  (viewer.context.items.ifcModels || []).forEach(m => { if (m.mesh) m.mesh.visible = false; });

  // 3) posiciona e mostra
  placeInFrontOfCamera(viewer, 1.2);
  arRoot.visible = true;

  // 4) loop simples
  const loop = ()=> {
    requestAnimationFrame(loop);
    renderer.render(scene, getCamera(viewer));
  };
  loop();
}

/* ========= Encerrar AR ========= */
function endAR(viewer){
  const renderer = getRenderer(viewer);
  const scene    = getScene(viewer);

  if (xrSession){
    xrSession.end().catch(()=>{});
    xrSession = null; xrRefSpace = null;
    xrHitTestSource = null;
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
  }

  // limpa clones antigos e volta o original
  for (let i = arRoot.children.length - 1; i >= 0; i--) {
    const child = arRoot.children[i];
    if (child.userData?.fromIFC) arRoot.remove(child);
  }
  (viewer.context.items.ifcModels || []).forEach(m => { if (m.mesh) m.mesh.visible = true; });

  arRoot.visible=false;
  renderer.setClearColor(0xf0f0f0, 1);
  scene.background = new THREE.Color(0xf0f0f0);

  document.body.classList.remove('is-ar');
  document.getElementById('ar-overlay')?.classList.add('hidden');
  document.getElementById('ar-button').style.display='inline-block';
}

/* ========= utils ========= */
function forceVisibleAndOpaque(obj){
  if (!obj) return;
  obj.traverse(o=>{
    o.visible = true;
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m=>{
        if (!m) return;
        if (m.clone) o.material = m.clone();
        o.material.transparent = false;
        o.material.opacity = 1;
        o.material.depthWrite = true;
        o.material.side = THREE.DoubleSide;
        o.material.needsUpdate = true;
      });
    }
  });
}

function ensureARMesh(viewer) {
  const models = viewer?.context?.items?.ifcModels || [];
  if (!models.length) return null;

  let m = arRoot.children.find(c => c.userData?.fromIFC);
  if (m) return m;

  const src = models[0].mesh;
  if (!src) return null;

  const clone = src.clone(true);
  clone.userData.fromIFC = true;
  clone.position.set(0,0,0);
  clone.rotation.set(0,0,0);
  clone.scale.set(1,1,1);

  arRoot.add(clone);
  const scene = getScene(viewer);
  if (!scene.children.includes(arRoot)) scene.add(arRoot);

  return clone;
}

function autoScaleFor(mesh, targetDiagMeters = 1.5){
  const box = new THREE.Box3().setFromObject(mesh);
  const s = box.getSize(new THREE.Vector3());
  let diag = Math.hypot(s.x, s.y, s.z) || 1;
  // Se o modelo parece estar em milímetros, converte para "metros lógicos"
  const diagMeters = diag > 500 ? (diag / 1000) : diag;
  const scale = targetDiagMeters / diagMeters;
  return Math.max(0.005, Math.min(10, scale));
}

function placeInFrontOfCamera(viewer, distance = 1.2) {
  const cam = getCamera(viewer);
  const mesh = ensureARMesh(viewer);
  if (!mesh) return;

  if (!userTouchedScale) userScale = autoScaleFor(mesh, 1.5);

  const dir = new THREE.Vector3(0,0,-1).applyQuaternion(cam.quaternion);
  const pos = cam.position.clone().add(dir.multiplyScalar(distance));
  const yaw = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ').y;

  arRoot.position.copy(pos);
  arRoot.quaternion.set(0,0,0,1);
  arRoot.rotateY(yaw);
  arRoot.scale.set(userScale, userScale, userScale);
  arRoot.visible = true;
  dragYaw = arRoot.rotation.y;
}

function tryPlaceOnTap(viewer) {
  if (xrSession) {
    if (reticle && reticle.visible) { placeModelAtReticle(viewer); return; }
    placeInFrontOfCamera(viewer);
  }
}

function placeModelAtReticle(viewer) {
  if (!reticle || !reticle.visible) return;
  const mesh = ensureARMesh(viewer); if (!mesh) return;
  forceVisibleAndOpaque(mesh);
  arRoot.matrix.copy(reticle.matrix);
  arRoot.matrix.decompose(arRoot.position, arRoot.quaternion, arRoot.scale);
  arRoot.position.y += 0.01;
  if (!userTouchedScale) userScale = autoScaleFor(mesh, 1.5);
  arRoot.scale.set(userScale, userScale, userScale);
  arRoot.visible = true;
}

init();
