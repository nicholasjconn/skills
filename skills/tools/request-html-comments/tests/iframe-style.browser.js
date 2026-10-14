// Run through playwright-cli from the repository root, like the other browser
// scripts. A gated parser script makes early stylesheet loss deterministic.
async (page) => {
  const scriptUrl = 'http://iframe-style.test/continue-parser.js';
  let parserArrived;
  let releaseParser;
  const requested = new Promise(resolve => { parserArrived = resolve; });
  const released = new Promise(resolve => { releaseParser = resolve; });
  await page.route(scriptUrl, async route => {
    parserArrived();
    await released;
    await route.fulfill({
      contentType: 'text/javascript',
      body: `
        const earlyStyle = document.getElementById('steward-review-page-style');
        parent.styleLoss = {
          readyState: document.readyState,
          removed: Boolean(earlyStyle),
          sameDocument: document === parent.attachedDocument,
        };
        // Simulate the parser discarding a style injected into the early head.
        earlyStyle?.remove();
      `,
    });
  });
  try {
    await page.goto('about:blank');
    await page.setContent(`
      <iframe id="parse-frame" style="width:670px;height:180px"
        srcdoc='
          <script src="${scriptUrl}"></script>
          <style>svg{width:620px;height:140px}text{font:22px system-ui}</style>
          <svg viewBox="0 0 620 140">
            <a href="#jump" onclick="event.preventDefault();document.body.dataset.clicked=1">
              <text id="frame-style-text" x="30" y="75">Frame style survives parsing</text>
            </a>
          </svg>'></iframe>
    `, {waitUntil: 'domcontentloaded'});
    await requested;
    await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_geometry.js'});
    await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_overlay.js'});
    await page.evaluate(() => {
      const frame = document.querySelector('#parse-frame');
      window.attachedDocument = frame.contentDocument;
      frame.addEventListener('load', () => { window.frameLoaded = true; });
      window.api = createHtmlReview({saveDraft: async () => {}, onFinish: async () => {}});
      if (attachedDocument.readyState !== 'loading') throw new Error('Fixture missed early iframe parsing');
      if (!attachedDocument.getElementById('steward-review-page-style')) throw new Error('Early attachment did not inject its stylesheet');
    });
    releaseParser();
    await page.waitForFunction(() => window.frameLoaded);
    const lifecycle = await page.evaluate(() => {
      const frame = document.querySelector('#parse-frame');
      if (!styleLoss.removed || styleLoss.readyState !== 'loading' || !styleLoss.sameDocument) {
        throw new Error('Fixture did not remove the stylesheet during same-Document parsing');
      }
      if (frame.contentDocument !== attachedDocument) throw new Error('Iframe Document changed during load');
      const checkStyle = () => {
        const count = attachedDocument.querySelectorAll('#steward-review-page-style').length;
        if (count !== 1) throw new Error(`Expected one restored iframe stylesheet, got ${count}`);
      };
      checkStyle();
      // Load/discovery can attach the same document repeatedly. Repair a later
      // loss too, and prove healthy reattachment never duplicates the style.
      for (let i = 0; i < 3; i++) {
        attachedDocument.getElementById('steward-review-page-style').remove();
        frame.dispatchEvent(new Event('load'));
        checkStyle();
        frame.dispatchEvent(new Event('load'));
        checkStyle();
      }
      return {...styleLoss, repeatedRepairs: 3};
    });
    // Exercise native SVG selection after recovery, including the original
    // annotation listeners and suppression of the link's click handler.
    await page.getByRole('button', {name: 'Comment on selected text', exact: true}).click();
    const target = page.frameLocator('#parse-frame').locator('#frame-style-text');
    await target.scrollIntoViewIfNeeded();
    const rect = await target.boundingBox();
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, {steps: 20});
    await page.mouse.up();
    await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Selection after parser/load recovery');
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    const comments = await page.evaluate(() => window.api.getComments());
    if (comments.length !== 1 || comments[0].target_type !== 'text' ||
        comments[0].selection.selected_text !== 'Frame style survives parsing' ||
        comments[0].iframe_path?.[0]?.css_selector !== '#parse-frame') {
      throw new Error(`Recovered iframe selection was not saved correctly: ${JSON.stringify(comments)}`);
    }
    const clicked = await target.evaluate(element => element.ownerDocument.body.dataset.clicked);
    if (clicked) throw new Error('Recovered text selection fired the page click handler');
    return {result: 'PASS: parser/load stylesheet recovery and idempotent same-Document attachment', lifecycle, selected: comments[0].selection.selected_text};
  } finally {
    releaseParser();
    await page.unroute(scriptUrl);
    await page.goto('about:blank');
  }
}
