'use strict';

function renderImagePreview(parent, index, media, labels) {
  if (!media.image) return;
  const grid = element('div', 'media-grid');
  parent.replaceChildren(grid);
  parent.hidden = false;

  function panel(label) {
    const figure = element('figure', 'image-panel');
    figure.append(element('figcaption', '', label));
    grid.append(figure);
    return figure;
  }

  function side(label, name) {
    const figure = panel(label);
    const info = media[name];
    if (!info.present || !info.image) {
      const status = info.lfs_pointer ? 'Stored as a Git LFS pointer' : info.present ? 'Image bytes unavailable' : 'Absent in this version';
      figure.append(element('p', 'image-status', status));
      return Promise.resolve(null);
    }
    const image = element('img');
    image.alt = `${label} image`;
    const status = element('p', 'image-status', 'Loading image…');
    figure.append(image, status);
    return new Promise(resolve => {
      image.addEventListener('load', () => {
        status.textContent = `${image.naturalWidth} × ${image.naturalHeight} px`;
        resolve(image);
      }, {once: true});
      image.addEventListener('error', () => {
        image.remove();
        status.textContent = 'Could not display this image';
        resolve(null);
      }, {once: true});
      image.src = `file/${index}/image/${name}`;
    });
  }

  const images = [side(labels.old, 'old'), side(labels.new, 'new')];
  const difference = panel('Visual diff');
  const status = element('p', 'image-status', 'Comparing images…');
  difference.append(status);
  Promise.all(images).then(([before, after]) => {
    if ((!before && !after) || (!before && media.old.present) || (!after && media.new.present)) {
      status.textContent = 'Image bytes needed for comparison';
      return;
    }
    const width = Math.max(before?.naturalWidth ?? 0, after?.naturalWidth ?? 0);
    const height = Math.max(before?.naturalHeight ?? 0, after?.naturalHeight ?? 0);
    if (width * height > 12000000 || Math.max(width, height) > 8192) {
      status.textContent = 'Images are too large for a pixel comparison';
      return;
    }
    const canvas = element('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute('aria-label', 'Pixel differences in red');
    const context = canvas.getContext('2d', {willReadFrequently: true});
    function pixels(image) {
      context.clearRect(0, 0, width, height);
      if (image) context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, width, height);
    }
    const old = pixels(before).data;
    const output = pixels(after);
    const next = output.data;
    let changed = 0;
    for (let at = 0; at < next.length; at += 4) {
      const alpha = next[at + 3];
      if (old[at + 3] !== alpha || (alpha !== 0 && (
        old[at] !== next[at] || old[at + 1] !== next[at + 1] || old[at + 2] !== next[at + 2]
      ))) {
        next[at] = 218;
        next[at + 1] = 25;
        next[at + 2] = 78;
        next[at + 3] = 255;
        changed++;
      } else {
        const gray = Math.round((next[at] + next[at + 1] + next[at + 2]) / 3);
        next[at] = next[at + 1] = next[at + 2] = gray;
        next[at + 3] = Math.round(alpha * .42);
      }
    }
    context.putImageData(output, 0, 0);
    difference.insertBefore(canvas, status);
    status.textContent = `${changed.toLocaleString()} changed ${changed === 1 ? 'pixel' : 'pixels'}`;
  }).catch(error => { status.textContent = `Could not compare images: ${error.message}`; });
}
