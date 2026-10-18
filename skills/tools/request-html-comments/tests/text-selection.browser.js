// Serve the skill directory over HTTP and open /tests/text-selection.html
// with playwright-cli, then run from the repository root:
// playwright-cli run-code --filename=skills/tools/request-html-comments/tests/text-selection.browser.js
// Real mouse gestures exercise native SVG selection and the following click.
async (page) => {
  const results = [];
  // Capture-phase setup must still recognize controls inside the UI shadow root.
  const info = page.getByRole('button', { name: 'About HTML Review', exact: true });
  await info.click();
  if (await info.getAttribute('aria-expanded') !== 'true') throw new Error('Info panel did not open');
  await info.click();
  if (await info.getAttribute('aria-expanded') !== 'false') throw new Error('Info panel did not close');
  const cases = [
    { name: 'document', target: page.locator('#linked-svg-copy'), text: 'Completed HH VOB: OON' },
    { name: 'shadow', target: page.locator('#shadow-svg-copy'), text: 'Shadow HH VOB: OON' },
    { name: 'frame', target: page.frameLocator('#review-frame').locator('#frame-svg-copy'), text: 'Frame HH VOB: OON' },
  ];
  for (const item of cases.flatMap(item => [item, { ...item, stopPointerDown: true }])) {
    const scenario = `${item.name}${item.stopPointerDown ? ' with stopped pointerdown' : ''}`;
    if (item.stopPointerDown) {
      await item.target.evaluate(element => element.addEventListener('pointerdown', event => event.stopPropagation()));
    }
    await page.evaluate(() => reviewApi.clearComments());
    await page.getByRole('button', { name: 'Comment on selected text', exact: true }).click();
    await item.target.scrollIntoViewIfNeeded();
    const rect = await item.target.boundingBox();
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 20 });
    await page.mouse.up();
    const editor = page.locator('.steward-review-popup textarea');
    await editor.fill(`Real SVG selection in ${scenario}`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const comment = await page.evaluate(() => reviewApi.getComments()[0]);
    const targetState = await item.target.evaluate(element => ({
      hash: element.ownerDocument.defaultView.location.hash,
      clicked: element.ownerDocument.body.dataset.clicked,
      selectable: !!element.closest('svg').classList.contains('steward-review-text-selectable'),
    }));
    if (comment.target_type !== 'text' || comment.selection.selected_text !== item.text) throw new Error(`${scenario}: wrong selected text ${JSON.stringify(comment)}`);
    if (targetState.clicked) throw new Error(`${scenario}: selection fired the page click handler`);
    if (targetState.hash) throw new Error(`${scenario}: selection navigated to ${targetState.hash}`);
    if (targetState.selectable) throw new Error(`${scenario}: selection style was not removed`);
    if (item.name === 'shadow' && !comment.selection.start.parent_shadow_path?.length) throw new Error('Missing shadow selection path');
    if (item.name === 'frame' && comment.iframe_path?.[0]?.css_selector !== '#review-frame') throw new Error('Missing iframe selection path');
    results.push({ name: scenario, selected: comment.selection.selected_text, selector: comment.selection.start.parent_css_selector, iframe_path: comment.iframe_path, shadow_path: comment.selection.start.parent_shadow_path });
    // A later deliberate click must navigate normally: suppression belongs to
    // the selection gesture, not every future click on the same diagram.
    await item.target.click();
    const clicked = await item.target.evaluate(element => element.ownerDocument.body.dataset.clicked);
    if (clicked !== '1') throw new Error(`${scenario}: ordinary link click was suppressed`);
    await item.target.evaluate(element => {
      delete element.ownerDocument.body.dataset.clicked;
      const win = element.ownerDocument.defaultView;
      win.history.replaceState(null, '', win.location.href.split('#')[0]);
    });
  }
  await page.evaluate(() => reviewApi.clearComments());
  // Reuse the existing document, shadow and frame surfaces for stroked shapes
  // whose native DOM bounds have a zero width or height.
  for (const context of ['document', 'shadow', 'frame']) {
    await page.evaluate(context => {
      const host = context === 'shadow' ? document.querySelector('#shadow-host').shadowRoot
        : context === 'frame' ? document.querySelector('#review-frame').contentDocument.body : document.body;
      const doc = host.ownerDocument;
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = `stroked-${context}`;
      svg.setAttribute('viewBox', '0 0 300 160');
      svg.style.cssText = 'display:block;width:450px;height:240px';
      svg.innerHTML = `<path id="horizontal-${context}" d="M40 40H240" fill="none" stroke="blue" stroke-width="8"/>
        <line id="vertical-${context}" x1="140" y1="80" x2="140" y2="140" stroke="red" stroke-width="8" vector-effect="non-scaling-stroke"/>`;
      host.appendChild(svg);
    }, context);
    for (const axis of ['horizontal', 'vertical']) {
      await page.evaluate(() => reviewApi.clearComments());
      const selector = `#${axis}-${context}`;
      const target = context === 'frame' ? page.frameLocator('#review-frame').locator(selector) : page.locator(selector);
      await target.scrollIntoViewIfNeeded();
      await page.locator('.sr-add').click();
      const rect = await target.boundingBox();
      await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.getByRole('textbox', {name: 'Comment', exact: true}).fill(`${axis} stroke in ${context}`);
      await page.getByRole('button', {name: 'Save', exact: true}).click();
      await page.evaluate(() => reviewApi.flush());
      const comment = await page.evaluate(() => reviewApi.getComments()[0]);
      if (comment.element.css_selector !== selector) throw new Error(`${context}: selected the SVG container instead of ${selector}`);
      if (!(comment.element.bounding_rect.width > 0 && comment.element.bounding_rect.height > 0)) throw new Error(`${selector}: degenerate saved bounds`);
      for (const ratio of Object.values(comment.anchor_ratio)) {
        if (!Number.isFinite(ratio) || Math.abs(ratio - 0.5) > 0.1) throw new Error(`${selector}: unstable anchor ratio ${ratio}`);
      }
      if (context === 'frame' && comment.iframe_path?.[0]?.css_selector !== '#review-frame') throw new Error('Stroke lost iframe path');
      if (context === 'shadow' && !comment.element.shadow_path?.length) throw new Error('Stroke lost shadow path');
      const pin = page.getByRole('button', {name: 'Open comment 1', exact: true});
      await pin.waitFor({state: 'visible'});
      const before = await pin.boundingBox();
      await target.evaluate(node => node.setAttribute('transform', 'translate(12 0)'));
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await page.waitForFunction(previous => {
        const pin = document.querySelector('.sr-layer').shadowRoot.querySelector('.steward-review-pin');
        return pin && Math.abs(pin.getBoundingClientRect().x - previous) > 10;
      }, before.x);
      const moved = await target.boundingBox();
      const anchored = await pin.boundingBox();
      if (Math.abs(anchored.x + anchored.width / 2 - moved.x - moved.width / 2) > 2) throw new Error(`${selector}: pin did not follow the stroke`);
      results.push({name: `${context} ${axis} stroke`, selector: comment.element.css_selector, anchor_ratio: comment.anchor_ratio});
    }
  }
  await page.evaluate(() => reviewApi.clearComments());
  return results;
}
