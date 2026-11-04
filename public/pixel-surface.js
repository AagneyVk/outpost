export function fitPhysicalPixels(canvas) {
 const ratio = window.devicePixelRatio || 1;
 canvas.style.width = canvas.width / ratio + 'px';
 canvas.style.height = canvas.height / ratio + 'px';
 canvas.style.display = 'block';
 canvas.style.imageRendering = 'pixelated';
 canvas.style.transform = 'none';
 const bounds = canvas.getBoundingClientRect();
 const x = Math.round(bounds.left * ratio) / ratio - bounds.left;
 const y = Math.round(bounds.top * ratio) / ratio - bounds.top;
 canvas.style.transform = `translate(${x}px, ${y}px)`;
}
