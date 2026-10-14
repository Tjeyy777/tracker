const $ = id => document.getElementById(id);

function makeMap(el, center = [20.5937, 78.9629], zoom = 5) {
  const map = L.map(el).setView(center, zoom);
  const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const layers = {
    'Streets': L.tileLayer(esri + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri' }),
    'Satellite': L.tileLayer(esri + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri' }),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
  };
  layers['Streets'].addTo(map);
  L.control.layers(layers).addTo(map);
  return map;
}

const pinIcon = (txt, color) => L.divIcon({
  className: '', iconSize: [22, 22], iconAnchor: [11, 11],
  html: `<div class="pin" style="background:${color}">${txt}</div>`,
});

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const km = m => (m / 1000).toFixed(1) + ' km';
const fmtDur = min => (min >= 60 ? Math.floor(min / 60) + ' h ' + (min % 60 ? (min % 60) + ' min' : '') : min + ' min').trim();
const fmtTime = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
