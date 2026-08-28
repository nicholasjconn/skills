// This lexical binding is shared with review_overlay.js because both sources
// are combined into one injected script. Do not assign it to globalThis: the
// reviewed page must not receive a geometry-helper global.
const __stewardReviewGeometry = (() => {
  const EPSILON = 1e-7
  const nearZero = value => Math.abs(value) <= EPSILON
  const nearOne = value => Math.abs(value - 1) <= EPSILON
  const transformValues = transform => {
    const match = /^(matrix|matrix3d)\((.+)\)$/.exec(String(transform || '').trim())
    if (!match) return null
    const values = match[2].split(',').map(value => Number(value.trim()))
    const expected = match[1] === 'matrix' ? 6 : 16
    return values.length === expected && values.every(Number.isFinite) ? { type: match[1], values } : null
  }

  const asBox = rect => {
    const left = rect.left
    const top = rect.top
    const width = rect.width ?? (rect.right - rect.left)
    const height = rect.height ?? (rect.bottom - rect.top)
    return { left, top, width, height, right: rect.right ?? (left + width), bottom: rect.bottom ?? (top + height) }
  }

  const intersectRects = (a, b) => {
    if (!a || !b) return null
    const left = Math.max(a.left, b.left)
    const top = Math.max(a.top, b.top)
    const right = Math.min(a.right, b.right)
    const bottom = Math.min(a.bottom, b.bottom)
    if (right <= left || bottom <= top) return null
    return { left, top, right, bottom, width: right - left, height: bottom - top }
  }

  const pointInRect = (x, y, rect) => Boolean(rect) && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom

  const intersectClippedAxes = (rect, clip, clipX, clipY) => {
    const left = clipX ? Math.max(rect.left, clip.left) : rect.left
    const right = clipX ? Math.min(rect.right, clip.right) : rect.right
    const top = clipY ? Math.max(rect.top, clip.top) : rect.top
    const bottom = clipY ? Math.min(rect.bottom, clip.bottom) : rect.bottom
    if (right <= left || bottom <= top) return null
    return { left, top, right, bottom, width: right - left, height: bottom - top }
  }

  const clampPinToClip = (x, y, clip, pinSize = 31) => {
    if (!clip) return null
    const half = pinSize / 2
    const minX = clip.left + half
    const maxX = clip.right - half
    const minY = clip.top + half
    const maxY = clip.bottom - half
    return {
      x: minX <= maxX ? Math.min(Math.max(minX, x), maxX) : (clip.left + clip.right) / 2,
      y: minY <= maxY ? Math.min(Math.max(minY, y), maxY) : (clip.top + clip.bottom) / 2,
    }
  }

  const mapPointToTop = (x, y, geometry, requireVisible = true) => {
    if (!geometry || geometry.unavailable) return null
    if (!geometry.hops?.length) return { x, y }
    if (!pointInRect(x, y, geometry.source)) return null
    let mappedX = x
    let mappedY = y
    for (const hop of geometry.hops) {
      const parentClip = intersectRects(hop.visibleClip, hop.parentSource)
      if (requireVisible && !parentClip) return null
      mappedX = hop.content.left + mappedX * hop.scaleX
      mappedY = hop.content.top + mappedY * hop.scaleY
      if (requireVisible && !pointInRect(mappedX, mappedY, parentClip)) return null
    }
    return { x: mappedX, y: mappedY }
  }

  const mapRectToTop = (rect, geometry) => {
    if (!geometry || geometry.unavailable) return null
    if (!geometry.hops?.length) return asBox(rect)
    let mapped = intersectRects(asBox(rect), geometry.source)
    if (!mapped) return null
    for (const hop of geometry.hops) {
      const parentClip = intersectRects(hop.visibleClip, hop.parentSource)
      if (!parentClip) return null
      const next = {
        left: hop.content.left + mapped.left * hop.scaleX,
        top: hop.content.top + mapped.top * hop.scaleY,
        width: mapped.width * hop.scaleX,
        height: mapped.height * hop.scaleY,
      }
      next.right = next.left + next.width
      next.bottom = next.top + next.height
      mapped = intersectRects(next, parentClip)
      if (!mapped) return null
    }
    return mapped
  }

  const isAxisAlignedTransform = transform => {
    if (!transform || transform === 'none') return true
    const parsed = transformValues(transform)
    if (!parsed) return false
    if (parsed.type === 'matrix') return nearZero(parsed.values[1]) && nearZero(parsed.values[2])
    const values = parsed.values
    return nearZero(values[1]) && nearZero(values[2]) && nearZero(values[3])
      && nearZero(values[4]) && nearZero(values[6]) && nearZero(values[7])
      && nearZero(values[8]) && nearZero(values[9]) && nearOne(values[10]) && nearZero(values[11])
      && nearZero(values[14]) && nearOne(values[15])
  }

  return {
    asBox,
    clampPinToClip,
    intersectClippedAxes,
    intersectRects,
    isAxisAlignedTransform,
    mapPointToTop,
    mapRectToTop,
    pointInRect,
  }
})();

// Keep direct Node behavioral tests and local helper consumers working without
// making the browser injection depend on a CommonJS global.
if (typeof module !== 'undefined' && module.exports) module.exports = __stewardReviewGeometry;
