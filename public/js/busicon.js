// Red top-view bus marker that rotates to face its direction of travel.
(function () {
  const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 84" width="26" height="55" aria-hidden="true">
  <rect x="3" y="14" width="4" height="7" rx="1.5" fill="#8f1f1f"/>
  <rect x="33" y="14" width="4" height="7" rx="1.5" fill="#8f1f1f"/>
  <rect x="6" y="2" width="28" height="80" rx="9" fill="#d63a3a" stroke="#fff" stroke-width="2.5"/>
  <path d="M10.5 11 Q20 6.5 29.5 11 L28 22 H12 Z" fill="#1c2430"/>
  <path d="M13 12.5 Q20 10 24 11.2 L22.5 14 Q18 13 13 14.2 Z" fill="#fff" opacity=".25"/>
  <rect x="11" y="27" width="18" height="40" rx="3.5" fill="#b92d2d"/>
  <rect x="14" y="32" width="12" height="6" rx="1.5" fill="#e86a6a"/>
  <rect x="14" y="42" width="12" height="6" rx="1.5" fill="#e86a6a"/>
  <rect x="14" y="52" width="12" height="6" rx="1.5" fill="#e86a6a"/>
  <path d="M12 70 H28 L29.5 76 Q20 79 10.5 76 Z" fill="#1c2430"/>
  <rect x="9" y="3.5" width="5" height="2.4" rx="1" fill="#ffe08a"/>
  <rect x="26" y="3.5" width="5" height="2.4" rx="1" fill="#ffe08a"/>
  <rect x="9" y="77.5" width="5" height="2.4" rx="1" fill="#ff9a9a"/>
  <rect x="26" y="77.5" width="5" height="2.4" rx="1" fill="#ff9a9a"/>
</svg>`;

  const style = document.createElement('style');
  style.textContent = `
    .bus-top { width: 26px; height: 55px; transition: transform .6s linear; filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); transform-origin: 50% 50%; }
    .bus-top svg { display: block; }`;
  document.head.appendChild(style);

  window.busTopIcon = () => L.divIcon({
    className: '', iconSize: [26, 55], iconAnchor: [13, 27.5],
    html: `<div class="bus-top">${SVG}</div>`,
  });

  // Turn the bus to `deg` (0 = north, clockwise). Takes the shortest way round so it never spins 350°.
  window.setBusHeading = (marker, deg) => {
    const el = marker.getElement() && marker.getElement().firstChild;
    if (!el) return;
    const prev = marker._heading ?? deg;
    let delta = ((deg - prev + 540) % 360) - 180;
    marker._heading = prev + delta;
    el.style.transform = `rotate(${marker._heading}deg)`;
  };

  // Compass bearing in degrees from point a to point b ([lat, lng]).
  window.bearingBetween = (a, b) => {
    const r = d => d * Math.PI / 180;
    const y = Math.sin(r(b[1] - a[1])) * Math.cos(r(b[0]));
    const x = Math.cos(r(a[0])) * Math.sin(r(b[0])) - Math.sin(r(a[0])) * Math.cos(r(b[0])) * Math.cos(r(b[1] - a[1]));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };
})();
