// Serve the skill directory over HTTP and open /tests/text-selection.html
// with playwright-cli, then run this file with
// playwright-cli run-code --filename tests/text-selection.browser.js.
// Real mouse gestures exercise native SVG selection and the following click.
async (page) => {
  const results = [];
  const cases = [
    { name: 'document', target: page.locator('#linked-svg-copy'), text: 'Completed HH VOB: OON' },
    { name: 'shadow', target: page.locator('#shadow-svg-copy'), text: 'Shadow HH VOB: OON' },
    { name: 'frame', target: page.frameLocator('#review-frame').locator('#frame-svg-copy'), text: 'Frame HH VOB: OON' },
  ];
  for (const item of cases) {
    await page.evaluate(() => reviewApi.clearComments());
    await page.getByRole('button', { name: 'Comment on selected text', exact: true }).click();
    await item.target.scrollIntoViewIfNeeded();
    const rect = await item.target.boundingBox();
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 20 });
    await page.mouse.up();
    const editor = page.locator('.steward-review-popup textarea');
    await editor.fill(`Real SVG selection in ${item.name}`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const comment = await page.evaluate(() => reviewApi.getComments()[0]);
    const targetState = await item.target.evaluate(element => ({
      hash: element.ownerDocument.defaultView.location.hash,
      clicked: element.ownerDocument.body.dataset.clicked,
      selectable: !!element.closest('svg').classList.contains('steward-review-text-selectable'),
    }));
    if (comment.target_type !== 'text' || comment.selection.selected_text !== item.text) throw new Error(`${item.name}: wrong selected text ${JSON.stringify(comment)}`);
    if (targetState.clicked) throw new Error(`${item.name}: selection fired the page click handler`);
    if (targetState.hash) throw new Error(`${item.name}: selection navigated to ${targetState.hash}`);
    if (targetState.selectable) throw new Error(`${item.name}: selection style was not removed`);
    if (item.name === 'shadow' && !comment.selection.start.parent_shadow_path?.length) throw new Error('Missing shadow selection path');
    if (item.name === 'frame' && comment.iframe_path?.[0]?.css_selector !== '#review-frame') throw new Error('Missing iframe selection path');
    results.push({ name: item.name, selected: comment.selection.selected_text, selector: comment.selection.start.parent_css_selector, iframe_path: comment.iframe_path, shadow_path: comment.selection.start.parent_shadow_path });
    // A later deliberate click must navigate normally: suppression belongs to
    // the selection gesture, not every future click on the same diagram.
    await item.target.click();
    const clicked = await item.target.evaluate(element => element.ownerDocument.body.dataset.clicked);
    if (clicked !== '1') throw new Error(`${item.name}: ordinary link click was suppressed`);
    await item.target.evaluate(element => {
      delete element.ownerDocument.body.dataset.clicked;
      const win = element.ownerDocument.defaultView;
      win.history.replaceState(null, '', win.location.href.split('#')[0]);
    });
  }
  await page.evaluate(results => { window.svgSelectionResults = results; reviewApi.clearComments(); }, results);
}
