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
  // Percentages use the nearest viewport's normalized diagonal in user units,
  // before viewBox scaling. A non-scaling stroke keeps that resolved thickness.
  for (const scenario of [
    { name: 'scaled-viewBox', width: 400, height: 200, scale: 2 },
    { name: 'nested-viewBox', width: 300, height: 100, scale: 2, nested: true },
    { name: 'nested-non-scaling', width: 300, height: 100, scale: 2, nested: true, fixed: true },
    { name: 'viewport-without-viewBox', width: 600, height: 300, scale: 1, noViewBox: true },
    { name: 'nested-without-viewBox', width: 600, height: 200, scale: 1, nested: true, noViewBox: true },
    { name: 'nested-percentage-attributes', width: 600, height: 200, scale: 1, nested: true, noViewBox: true, percentageAttributes: true },
    { name: 'nested-percentage-css', width: 600, height: 200, scale: 1, nested: true, noViewBox: true, viewportCss: 'width:50%;height:25%' },
    { name: 'outer-border-box', width: 500, height: 200, scale: 1, noViewBox: true, viewportCss: 'box-sizing:border-box;width:600px;height:300px;padding:40px;border:10px solid black' },
    { name: 'outer-content-box', width: 500, height: 200, scale: 1, noViewBox: true, viewportCss: 'box-sizing:content-box;width:500px;height:200px;padding:40px;border:10px solid black' },
    { name: 'border-box-viewBox', width: 250, height: 100, scale: 2, viewportCss: 'box-sizing:border-box;width:600px;height:300px;padding:40px;border:10px solid black' },
  ]) {
    await page.evaluate(() => reviewApi.clearComments());
    await page.evaluate(({ name, width, height, scale, nested, fixed, noViewBox, percentageAttributes, viewportCss }) => {
      const outer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      outer.style.cssText = `display:block;width:${nested ? 800 : width * scale}px;height:${nested ? 400 : height * scale}px`;
      if (nested) outer.setAttribute('viewBox', '0 0 800 400');
      let viewport = outer;
      if (nested) {
        viewport = document.createElementNS(outer.namespaceURI, 'svg');
        viewport.setAttribute('x', '40');
        viewport.setAttribute('y', '40');
        outer.appendChild(viewport);
      }
      viewport.setAttribute('width', percentageAttributes ? '75%' : String(width * scale));
      viewport.setAttribute('height', percentageAttributes ? '50%' : String(height * scale));
      // Neutralize the fixture's global svg sizes; nested viewport attributes
      // determine its dimensions even when computed CSS is auto or a percentage.
      if (nested) viewport.style.cssText = viewportCss || 'width:auto;height:auto';
      else if (viewportCss) {
        viewport.style.cssText += `;${viewportCss}`;
        // Definite outer CSS sizing must take precedence over intrinsic attributes.
        viewport.setAttribute('width', '900');
        viewport.setAttribute('height', '450');
      }
      if (!noViewBox) viewport.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const line = document.createElementNS(outer.namespaceURI, 'line');
      line.id = `percentage-${name}`;
      for (const [key, value] of Object.entries({ x1: 40, x2: width - 40, y1: height / 2, y2: height / 2, stroke: 'blue', 'stroke-width': '10%' })) {
        line.setAttribute(key, String(value));
      }
      if (fixed) line.setAttribute('vector-effect', 'non-scaling-stroke');
      viewport.appendChild(line);
      document.body.appendChild(outer);
    }, scenario);
    const target = page.locator(`#percentage-${scenario.name}`);
    await target.scrollIntoViewIfNeeded();
    const rect = await target.evaluate(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    });
    const thickness = 0.1 * Math.sqrt((scenario.width ** 2 + scenario.height ** 2) / 2) * (scenario.fixed ? 1 : scenario.scale);
    const point = { x: Math.round(rect.x + rect.width * 0.35), y: Math.round(rect.y + thickness / 4) };
    const anchor = { x: (point.x - rect.x) / rect.width, y: (point.y - rect.y + thickness / 2) / thickness };
    await page.locator('.sr-add').click();
    await page.mouse.click(point.x, point.y);
    await page.getByRole('textbox', { name: 'Comment', exact: true }).waitFor({ timeout: 2000 });
    const comment = await saveComment();
    const expected = { x: Math.round(rect.x), y: Math.round(rect.y - thickness / 2), width: Math.round(rect.width), height: Math.round(thickness) };
    if (comment.element.css_selector !== `#percentage-${scenario.name}`) throw new Error(`${scenario.name}: selected another target`);
    if (JSON.stringify(comment.element.bounding_rect) !== JSON.stringify(expected)) {
      throw new Error(`${scenario.name}: wrong painted bounds ${JSON.stringify(comment.element.bounding_rect)}; expected ${JSON.stringify(expected)}`);
    }
    if (Math.abs(comment.anchor_ratio.x - anchor.x) > 0.01 || Math.abs(comment.anchor_ratio.y - anchor.y) > 0.01) {
      throw new Error(`${scenario.name}: wrong offset anchor ${JSON.stringify(comment.anchor_ratio)}`);
    }
    await page.waitForFunction(({ x, y }) => {
      const pin = document.querySelector('.sr-layer').shadowRoot.querySelector('.steward-review-pin');
      const rect = pin.getBoundingClientRect();
      return Math.abs(rect.x + rect.width / 2 - x) < 2 && Math.abs(rect.y + rect.height / 2 - y) < 2;
    }, point);
  }
  await page.evaluate(() => reviewApi.clearComments());
  return 'PASS: three native text selections, two numeric strokes and ten percentage strokes with bounds, offset anchors and pins';
}
