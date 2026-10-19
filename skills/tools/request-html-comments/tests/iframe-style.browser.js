// Gate parsing so the stylesheet disappears before the iframe finishes loading.
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
        const style = document.getElementById('steward-review-page-style');
        parent.removedDuringParsing = document.readyState === 'loading' &&
          document === parent.attachedDocument && Boolean(style);
        style?.remove();
      `,
    });
  });
  try {
    await page.goto('about:blank');
    await page.setContent(`<iframe id="parse-frame"
      srcdoc='<script src="${scriptUrl}"></script><p>Review target</p>'></iframe>`,
      {waitUntil: 'domcontentloaded'});
    await requested;
    await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_geometry.js'});
    await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_overlay.js'});
    await page.evaluate(() => {
      const frame = document.querySelector('#parse-frame');
      window.attachedDocument = frame.contentDocument;
      frame.addEventListener('load', () => { window.frameLoaded = true; });
      createHtmlReview({saveDraft: async () => {}, onFinish: async () => {}});
    });
    releaseParser();
    await page.waitForFunction(() => window.frameLoaded);
    return await page.evaluate(() => {
      const frame = document.querySelector('#parse-frame');
      if (!window.removedDuringParsing || frame.contentDocument !== attachedDocument) {
        throw new Error('Fixture did not remove the stylesheet during same-Document parsing');
      }
      const checkStyle = () => {
        const count = attachedDocument.querySelectorAll('#steward-review-page-style').length;
        if (count !== 1) throw new Error(`Expected one restored iframe stylesheet, got ${count}`);
      };
      checkStyle();
      frame.dispatchEvent(new Event('load'));
      checkStyle();
      return 'PASS: stylesheet restored after parsing without duplication on reattachment';
    });
  } finally {
    releaseParser();
    await page.unroute(scriptUrl);
    await page.goto('about:blank');
  }
}
