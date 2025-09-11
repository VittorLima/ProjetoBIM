import * as THREE from 'three';
import { IfcViewerAPI } from 'web-ifc-viewer';
import {
  IFCPRESENTATIONLAYERASSIGNMENT,
  IFCWALL, IFCSLAB, IFCBEAM, IFCCOLUMN, IFCDOOR, IFCWINDOW,
  IFCSYSTEM, IFCDISTRIBUTIONSYSTEM,
  IFCZONE, IFCSPATIALZONE, IFCSPACE
} from 'web-ifc';

async function init() {
  const container = document.getElementById('three-canvas');

  const viewer = new IfcViewerAPI({
    container,
    backgroundColor: new THREE.Color(0xf0f0f0)
  });

  await viewer.IFC.setWasmPath('./');

  // deixa o modelo claro
  viewer.axes.setAxes();
  viewer.grid.setGrid();
  viewer.context.renderer.postProduction.active = false;

  const ifcFileInput  = document.getElementById('ifc-file-input');
  const statusElement = document.getElementById('status');

  // ===== UI principal =====
  const controls = document.createElement('div');
  controls.id = 'controls';
  Object.assign(controls.style, {
    position: 'absolute',
    top: '10px',
    right: '10px',
    zIndex: '10',
    background: 'rgba(255,255,255,0.95)',
    padding: '15px',
    borderRadius: '8px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    maxWidth: '520px'
  });
  controls.innerHTML = `
    <h4 style="margin:0 0 8px 0;">Visualização</h4>
    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
      <label>Modo:</label>
      <select id="mode-selector">
        <option value="level">Nível</option>
        <option value="layer">Layer</option>
        <option value="type">Tipo</option>
        <option value="system">Sistema</option>
        <option value="zone">Zona</option>
        <option value="property">Propriedade</option>
      </select>

      <select id="group-selector" style="min-width:220px;"></select>

      <span id="prop-controls" style="display:none; gap:6px; flex-wrap:wrap; align-items:center;">
        <input id="pset-input" placeholder="Pset (ex.: Pset_WallCommon)" style="min-width:190px;">
        <input id="prop-input" placeholder="Propriedade (ex.: IsExternal)" style="min-width:180px;">
        <select id="op-input">
          <option value="=">=</option>
          <option value="!=">≠</option>
          <option value=">">></option>
          <option value="<"><</option>
          <option value="contains">contém</option>
        </select>
        <input id="val-input" placeholder="Valor" style="min-width:140px;">
        <button id="apply-prop-filter">Aplicar</button>
      </span>

      <button id="show-all-button">Mostrar Tudo</button>
      <button id="reset-all-button">Resetar Tudo</button>
    </div>
  `;
  document.body.appendChild(controls);

  // ===== UI propriedades =====
  const propsPanel = document.createElement('div');
  propsPanel.id = 'props-panel';
  Object.assign(propsPanel.style, {
    position: 'absolute',
    right: '10px',
    width: '320px',
    maxHeight: '420px',
    overflowY: 'auto',
    background: 'rgba(255,255,255,0.97)',
    padding: '15px',
    borderRadius: '8px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
  });
  propsPanel.innerHTML = `<h4 style="margin:0 0 8px 0;">Propriedades</h4><div id="props-content">Clique em um elemento</div>`;
  document.body.appendChild(propsPanel);

  // layout (propriedades abaixo dos controles)
  function layoutPanels() {
    const rect = controls.getBoundingClientRect();
    propsPanel.style.top = `${rect.bottom + 10}px`;
  }
  layoutPanels();
  window.addEventListener('resize', layoutPanels);

  // ===== Fit de câmera (compatível)
  function fitScene(viewer, padding = 1.2) {
    const scene = viewer.context.getScene?.() || viewer.context.scene;
    const domEl = viewer.context.getDomElement?.() || container;
    const camera = viewer.context.getCamera?.() || viewer.context.camera;
    const controls =
      viewer.context.ifcCamera?.cameraControls ||
      viewer.context.orbitControls ||
      viewer.context.cameraControls ||
      null;

    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    if (!isFinite(size.x + size.y + size.z)) return;

    if (camera.isPerspectiveCamera) {
      const maxSize = Math.max(size.x, size.y, size.z);
      const fov = (camera.fov * Math.PI) / 180;
      let distance = (maxSize / 2) / Math.tan(fov / 2);
      distance *= padding;
      const dir = new THREE.Vector3(1, 1, 1).normalize();
      camera.position.copy(center.clone().add(dir.multiplyScalar(distance)));
      if (controls?.setLookAt) {
        controls.setLookAt(camera.position.x, camera.position.y, camera.position.z, center.x, center.y, center.z, true);
      } else if (controls?.target) {
        controls.target.copy(center); controls.update?.();
      } else camera.lookAt(center);
      camera.near = Math.max(distance / 100, 0.01);
      camera.far  = distance * 1000;
      camera.updateProjectionMatrix();
    } else if (camera.isOrthographicCamera) {
      const width  = size.x * padding;
      const height = size.y * padding;
      camera.left   = -width / 2;
      camera.right  =  width / 2;
      camera.top    =  height / 2;
      camera.bottom = -height / 2;
      camera.position.set(center.x, center.y, center.z + size.z * padding);
      if (controls?.target) controls.target.copy(center);
      camera.updateProjectionMatrix();
    }
  }

  // ===== Estado / índices =====
  let model;
  let selectedElement = null;

  const SUBSET_ID = 'focus-subset';
  const ifcManager = () => viewer.IFC.loader.ifcManager;

  // índices
  const indices = {
    levels: /** @type {Record<string, number[]>} */ ({}),
    layers: /** @type {Record<string, number[]>} */ ({}),
    types : /** @type {Record<string, {type:number, ids:number[]}>} */ ({}),
    systems: /** @type {Record<string, number[]>} */ ({}),
    zones: /** @type {Record<string, number[]>} */ ({})
  };

  // cache de propriedades por ID (para filtro por propriedade)
  const propCache = /** @type {Record<number, any>} */({});

  // ===== Materiais / subset =====
  function setMeshOpacity(mesh, transparent, opacity) {
    const apply = (mat) => { if (!mat) return;
      mat.transparent = transparent;
      mat.opacity = opacity;
      mat.depthWrite = !transparent;
      mat.depthTest  = true;
    };
    const m = mesh.material;
    if (Array.isArray(m)) m.forEach(apply); else apply(m);
  }
  function setTransparency(active) {
    viewer.context.items.ifcModels.forEach(m => setMeshOpacity(m.mesh, active, active ? 0.18 : 1));
  }
  function clearFocusSubset() {
    try { ifcManager().removeSubset(model.modelID, undefined, viewer.context.scene, SUBSET_ID); } catch(_) {}
  }
  function focusVisibleIDs(ids) {
    clearFocusSubset();
    if (!ids || !ids.length) return;
    const solid = new THREE.MeshBasicMaterial({ transparent:false, opacity:1 });
    ifcManager().createSubset({
      modelID: model.modelID,
      ids,
      scene: viewer.context.scene,
      removePrevious: true,
      material: solid,
      customID: SUBSET_ID
    });
  }

  // ===== Utilities de grafo espacial (níveis e espaços) =====
  function prettyLevelName(props) {
    const raw = props.LongName?.value || props.Name?.value;
    if (raw) return raw;
    const elev = typeof props.Elevation?.value === 'number' ? props.Elevation.value : null;
    if (elev === 0) return 'Térreo';
    if (elev !== null) return `Nível ${elev.toFixed(2)} m`;
    return `Nível ${props.expressID}`;
  }
  function findNode(node, expressID) {
    if (!node) return null;
    if (node.expressID === expressID) return node;
    for (const ch of node.children || []) {
      const r = findNode(ch, expressID);
      if (r) return r;
    }
    return null;
  }
  function collectDescendantIds(node, bag = []) {
    if (!node) return bag;
    for (const ch of node.children || []) {
      if (typeof ch.expressID === 'number') bag.push(ch.expressID);
      collectDescendantIds(ch, bag);
    }
    return bag;
  }

  // ===== Construção dos índices =====
  async function buildLevelIndex() {
    indices.levels = {};
    const storeyIDs = await viewer.IFC.getAllItemsOfType(model.modelID, 3750856006); // IFCBUILDINGSTOREY
    const spatial = await viewer.IFC.getSpatialStructure(model.modelID);
    for (const sid of storeyIDs) {
      const p = await viewer.IFC.getProperties(model.modelID, sid, true, false);
      const name = prettyLevelName(p);
      const node = findNode(spatial, sid);
      const ids = collectDescendantIds(node, []);
      if (ids.length) indices.levels[name] = ids;
    }
  }

  async function buildLayerIndex() {
    indices.layers = {};
    const layerIDs = await viewer.IFC.getAllItemsOfType(model.modelID, IFCPRESENTATIONLAYERASSIGNMENT);
    for (const lid of layerIDs) {
      const layer = await viewer.IFC.getProperties(model.modelID, lid, true, true);
      const name = layer.Name?.value || `Layer ${lid}`;
      const assigned = (layer.AssignedItems || []).flatMap(x => x?.value || []);
      const ids = assigned
        .map(x => (x?.value?.expressID ?? x?.expressID))
        .filter((v) => typeof v === 'number');
      if (ids.length) indices.layers[name] = ids;
    }
  }

  async function buildTypeIndex() {
    indices.types = {};
    const typeDefs = [
      { label: 'Paredes (IFCWALL)',   type: IFCWALL   },
      { label: 'Lajes (IFCSLAB)',     type: IFCSLAB   },
      { label: 'Vigas (IFCBEAM)',     type: IFCBEAM   },
      { label: 'Pilares (IFCCOLUMN)', type: IFCCOLUMN },
      { label: 'Portas (IFCDOOR)',    type: IFCDOOR   },
      { label: 'Janelas (IFCWINDOW)', type: IFCWINDOW }
    ];
    for (const def of typeDefs) {
      const ids = await viewer.IFC.getAllItemsOfType(model.modelID, def.type, true);
      if (ids && ids.length) indices.types[def.label] = { type: def.type, ids };
    }
  }

  async function buildSystemIndex() {
    indices.systems = {};
    const systemTypes = [IFCSYSTEM, IFCDISTRIBUTIONSYSTEM];
    for (const st of systemTypes) {
      const sysIDs = await viewer.IFC.getAllItemsOfType(model.modelID, st, true);
      for (const sid of sysIDs) {
        const sys = await viewer.IFC.getProperties(model.modelID, sid, true, true);
        const name = sys.Name?.value || sys.LongName?.value || `Sistema ${sid}`;
        const rels = (sys.IsGroupedBy || []).flatMap(r => r?.value || []);
        const ids = [];
        for (const rel of rels) {
          const related = (rel.RelatedObjects?.value || rel.RelatedObjects || []).map(o => o.value?.expressID ?? o.expressID);
          for (const id of related) if (typeof id === 'number') ids.push(id);
        }
        if (ids.length) indices.systems[name] = Array.from(new Set(ids));
      }
    }
  }

  async function buildZoneIndex() {
    indices.zones = {};
    // Zones via AssignsToGroup
    const groupTypes = [IFCZONE, IFCSPATIALZONE];
    for (const gt of groupTypes) {
      const zids = await viewer.IFC.getAllItemsOfType(model.modelID, gt, true);
      for (const zid of zids) {
        const z = await viewer.IFC.getProperties(model.modelID, zid, true, true);
        const name = z.Name?.value || z.LongName?.value || `Zona ${zid}`;
        const rels = (z.IsGroupedBy || []).flatMap(r => r?.value || []);
        const ids = [];
        for (const rel of rels) {
          const related = (rel.RelatedObjects?.value || rel.RelatedObjects || []).map(o => o.value?.expressID ?? o.expressID);
          for (const id of related) if (typeof id === 'number') ids.push(id);
        }
        if (ids.length) indices.zones[name] = Array.from(new Set(ids));
      }
    }

    // Spaces: usa o grafo espacial (elementos descendentes)
    const spaceIDs = await viewer.IFC.getAllItemsOfType(model.modelID, IFCSPACE, true);
    const spatial = await viewer.IFC.getSpatialStructure(model.modelID);
    for (const sid of spaceIDs) {
      const sp = await viewer.IFC.getProperties(model.modelID, sid, true, false);
      const name = sp.LongName?.value || sp.Name?.value || `Espaço ${sid}`;
      const node = findNode(spatial, sid);
      const ids = collectDescendantIds(node, []);
      if (ids.length) indices.zones[name] = Array.from(new Set(ids));
    }
  }

  // ===== UI dinâmica =====
  function togglePropControls(show) {
    const pc = document.getElementById('prop-controls');
    pc.style.display = show ? 'flex' : 'none';
  }

  function populateGroupSelector() {
    const mode = document.getElementById('mode-selector').value;
    const groupSel = document.getElementById('group-selector');

    groupSel.innerHTML = '';
    const add = (value, label) => {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = label; groupSel.appendChild(opt);
    };

    if (mode === 'property') {
      togglePropControls(true);
      add('all', '(— resultado do filtro —)');
      groupSel.disabled = true; // controlado pelo filtro
    } else {
      togglePropControls(false);
      groupSel.disabled = false;
      add('all', 'Todos');

      if (mode === 'level') {
        Object.keys(indices.levels).forEach(name => add(name, name));
      } else if (mode === 'layer') {
        Object.keys(indices.layers).forEach(name => add(name, name));
      } else if (mode === 'type') {
        Object.keys(indices.types).forEach(label => add(label, label));
      } else if (mode === 'system') {
        Object.keys(indices.systems).forEach(label => add(label, label));
      } else if (mode === 'zone') {
        Object.keys(indices.zones).forEach(label => add(label, label));
      }
    }
  }

  function showGroupByMode() {
    const mode  = document.getElementById('mode-selector').value;
    const value = document.getElementById('group-selector').value;

    if (mode === 'property') return; // propriedade usa botão "Aplicar"

    if (value === 'all') {
      clearFocusSubset(); setTransparency(false); return;
    }

    let ids = [];
    if (mode === 'level')   ids = indices.levels[value]  || [];
    if (mode === 'layer')   ids = indices.layers[value]  || [];
    if (mode === 'type')    ids = indices.types[value]?.ids || [];
    if (mode === 'system')  ids = indices.systems[value] || [];
    if (mode === 'zone')    ids = indices.zones[value]   || [];

    setTransparency(true);
    focusVisibleIDs(ids);
  }

  // ===== Filtro por Propriedade (Pset) =====
  const PROPERTY_TYPES_SCOPE = [
    IFCWALL, IFCSLAB, IFCBEAM, IFCCOLUMN, IFCDOOR, IFCWINDOW
    // adicione mais tipos se precisar
  ];

  async function getPropsCached(id) {
    if (!propCache[id]) {
      propCache[id] = await viewer.IFC.getProperties(model.modelID, id, true, true);
    }
    return propCache[id];
  }

  function readPsetValueFromProps(props, psetName, propName) {
    // props.IsDefinedBy -> RelatingPropertyDefinition -> HasProperties[]
    const defs = (props.IsDefinedBy || [])
      .map(x => x?.RelatingPropertyDefinition?.value)
      .filter(Boolean);

    for (const def of defs) {
      const dName = def.Name?.value || def.LongName?.value;
      if (!dName || dName !== psetName) continue;
      const item = (def.HasProperties || []).find(pp => (pp?.Name?.value === propName));
      if (!item) continue;

      // tentativa de ler valor em NominalValue
      const v = item.NominalValue?.value ?? item.NominalValue?.wrappedValue ?? item.NominalValue;
      return v;
    }
    return undefined;
  }

  function compareValues(left, op, rightRaw) {
    const rNum = Number(rightRaw);
    const leftNum = Number(left);

    // tenta comparação numérica quando ambos são números
    if (!Number.isNaN(leftNum) && !Number.isNaN(rNum) && ['>','<','=','!='].includes(op)) {
      if (op === '>')  return leftNum >  rNum;
      if (op === '<')  return leftNum <  rNum;
      if (op === '=')  return leftNum === rNum;
      if (op === '!=') return leftNum !== rNum;
    }

    const lStr = String(left ?? '').toLowerCase();
    const rStr = String(rightRaw ?? '').toLowerCase();

    if (op === 'contains') return lStr.includes(rStr);
    if (op === '=')  return lStr === rStr;
    if (op === '!=') return lStr !== rStr;

    return false;
  }

  async function applyPropertyFilter() {
    const pset = document.getElementById('pset-input').value.trim();
    const prop = document.getElementById('prop-input').value.trim();
    const op   = document.getElementById('op-input').value;
    const val  = document.getElementById('val-input').value.trim();

    if (!pset || !prop || !op) {
      alert('Preencha Pset, Propriedade e Operador.');
      return;
    }

    const matched = [];
    for (const t of PROPERTY_TYPES_SCOPE) {
      const ids = await viewer.IFC.getAllItemsOfType(model.modelID, t, true);
      for (const id of ids) {
        const props = await getPropsCached(id);
        const v = readPsetValueFromProps(props, pset, prop);
        if (v === undefined) continue;
        if (compareValues(v, op, val)) matched.push(id);
      }
    }

    setTransparency(true);
    focusVisibleIDs(Array.from(new Set(matched)));

    // indica que o seletor está mostrando resultado de filtro
    const gs = document.getElementById('group-selector');
    gs.innerHTML = ''; const o = document.createElement('option');
    o.value = 'all'; o.textContent = `(filtro: ${pset}.${prop} ${op} ${val})`; gs.appendChild(o);
    gs.value = 'all';
  }

  // ===== Reset geral =====
  function resetAll() {
    clearFocusSubset();
    setTransparency(false);
    try { viewer.IFC.selector.unHighlightIfcItems?.(); } catch(_) {}
    try { viewer.IFC.selector.unpickIfcItems(); } catch(_) {}
    selectedElement = null;
    document.getElementById('props-content').innerHTML = 'Clique em um elemento';

    document.getElementById('mode-selector').value  = 'level';
    populateGroupSelector();
    document.getElementById('group-selector').value = 'all';

    fitScene(viewer);
  }

  // ===== Eventos principais =====
  ifcFileInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    statusElement.textContent = 'Carregando modelo 3D...';
    try {
      model = await viewer.IFC.loadIfc(file, true);

      await buildLevelIndex();
      await buildLayerIndex();
      await buildTypeIndex();
      await buildSystemIndex();
      await buildZoneIndex();

      populateGroupSelector();
      resetAll();
      statusElement.textContent = 'Modelo carregado! Use o seletor para visualizar por Nível, Layer, Tipo, Sistema, Zona ou Propriedade.';
    } catch (error) {
      statusElement.textContent = `Erro ao carregar o arquivo: ${error.message}`;
      console.error(error);
    }
  });

  document.getElementById('mode-selector').addEventListener('change', () => {
    populateGroupSelector();
    showGroupByMode();
  });

  document.getElementById('group-selector').addEventListener('change', () => {
    showGroupByMode();
  });

  document.getElementById('show-all-button').addEventListener('click', () => {
    clearFocusSubset(); setTransparency(false);
    const mode = document.getElementById('mode-selector').value;
    if (mode !== 'property') document.getElementById('group-selector').value = 'all';
  });

  document.getElementById('reset-all-button').addEventListener('click', resetAll);
  document.getElementById('apply-prop-filter').addEventListener('click', applyPropertyFilter);

  // ===== Seleção com toggle =====
  window.addEventListener('click', async (ev) => {
    if (ev.target.closest('#controls') || ev.target.closest('#props-panel')) return;

    const result = await viewer.IFC.selector.pickIfcItem();

    if (result && selectedElement &&
        result.modelID === selectedElement.modelID &&
        result.id === selectedElement.id) {
      try { viewer.IFC.selector.unHighlightIfcItems?.(); } catch(_) {}
      viewer.IFC.selector.unpickIfcItems();
      selectedElement = null;
      document.getElementById('props-content').innerHTML = 'Clique em um elemento';
      return;
    }

    if (result) {
      viewer.IFC.selector.highlightIfcItem();
      const props = await viewer.IFC.getProperties(result.modelID, result.id, true, true);
      showProperties(props);
      selectedElement = { modelID: result.modelID, id: result.id };
    } else {
      try { viewer.IFC.selector.unHighlightIfcItems?.(); } catch(_) {}
      viewer.IFC.selector.unpickIfcItems();
      selectedElement = null;
      document.getElementById('props-content').innerHTML = 'Clique em um elemento';
    }
  });

  function showProperties(props) {
    const content = document.getElementById('props-content');
    content.innerHTML = '';
    for (let key in props) {
      if (props[key]?.value !== undefined) {
        const p = document.createElement('p');
        p.innerHTML = `<strong>${key}:</strong> ${props[key].value}`;
        content.appendChild(p);
      }
    }
  }
}

init();
