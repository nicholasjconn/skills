// Open /tests/text-selection.html, then use playwright-cli run-code --filename=<this file>.
async (page) => {
  async function saveComment() {
    await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Review this');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.evaluate(() => reviewApi.flush());
    return page.evaluate(() => reviewApi.getComments()[0]);
  }

  // Native drags must survive stopped pointer events in each supported surface.
  for (const [context, target, text] of [
    ['document', page.locator('#linked-svg-copy'), 'Completed HH VOB: OON'],
    ['shadow', page.locator('#shadow-svg-copy'), 'Shadow HH VOB: OON'],
    ['frame', page.frameLocator('#review-frame').locator('#frame-svg-copy'), 'Frame HH VOB: OON'],
  ]) {
    await page.evaluate(() => reviewApi.clearComments());
    await target.evaluate(node => node.addEventListener('pointerdown', event => event.stopPropagation()));
    await page.getByRole('button', { name: 'Comment on selected text', exact: true }).click();
    await target.scrollIntoViewIfNeeded();
    const rect = await target.boundingBox();
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 20 });
    await page.mouse.up();
    const comment = await saveComment();
    if (comment.target_type !== 'text' || comment.selection.selected_text !== text) throw new Error(`${context}: wrong selected text`);
    if (context === 'shadow' && !comment.selection.start.parent_shadow_path?.length) throw new Error('Missing shadow selection path');
    if (context === 'frame' && comment.iframe_path?.[0]?.css_selector !== '#review-frame') throw new Error('Missing iframe selection path');
    if (await target.evaluate(node => !!node.ownerDocument.body.dataset.clicked)) throw new Error(`${context}: drag activated the link`);
    await target.click();
    if (await target.evaluate(node => node.ownerDocument.body.dataset.clicked) !== '1') throw new Error(`${context}: later click was suppressed`);
    await target.evaluate(node => {
      delete node.ownerDocument.body.dataset.clicked;
      const win = node.ownerDocument.defaultView;
      win.history.replaceState(null, '', win.location.href.split('#')[0]);
    });
  }

  // Two representatives cover both zero-area axes, stroke scaling, and nested surfaces.
  for (const [context, shape] of [
    ['frame', '<path d="M40 40H240"/>'],
    ['shadow', '<line x1="140" y1="40" x2="140" y2="140" vector-effect="non-scaling-stroke"/>'],
  ]) {
    await page.evaluate(() => reviewApi.clearComments());
    await page.evaluate(({ context, shape }) => {
      const host = context === 'shadow' ? document.querySelector('#shadow-host').shadowRoot
        : document.querySelector('#review-frame').contentDocument.body;
      const svg = host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 300 160');
      svg.style.cssText = 'display:block;width:450px;height:240px';
      svg.innerHTML = shape;
      svg.firstChild.id = 'stroke-target';
      svg.firstChild.setAttribute('stroke', 'blue');
      svg.firstChild.setAttribute('stroke-width', '8');
      host.appendChild(svg);
    }, { context, shape });
    const target = context === 'frame' ? page.frameLocator('#review-frame').locator('#stroke-target') : page.locator('#stroke-target');
    await target.scrollIntoViewIfNeeded();
    await page.locator('.sr-add').click();
    const rect = await target.boundingBox();
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const comment = await saveComment();
    if (comment.element.css_selector !== '#stroke-target') throw new Error(`${context}: selected the SVG container`);
    if (!(comment.element.bounding_rect.width > 0 && comment.element.bounding_rect.height > 0)) throw new Error(`${context}: degenerate bounds`);
    if (![comment.anchor_ratio.x, comment.anchor_ratio.y].every(ratio => Number.isFinite(ratio) && Math.abs(ratio - 0.5) < 0.1)) throw new Error(`${context}: unstable anchor`);
    const pin = page.getByRole('button', { name: 'Open comment 1', exact: true });
    await pin.waitFor({ state: 'visible' });
    await target.evaluate(node => node.setAttribute('transform', 'translate(12 0)'));
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    const moved = await target.boundingBox();
    await page.waitForFunction(center => {
      const rect = document.querySelector('.sr-layer').shadowRoot.querySelector('.steward-review-pin').getBoundingClientRect();
      return Math.abs(rect.x + rect.width / 2 - center) < 2;
    }, moved.x + moved.width / 2);
  }
  await page.evaluate(() => reviewApi.clearComments());
  return 'PASS: three native text selections and two stroke targets with moving pins';
}
