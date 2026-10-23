// From the repository root, with a playwright-cli browser session open:
// playwright-cli run-code --filename=skills/tools/request-html-comments/tests/completion.browser.js
async (page) => {
  await page.goto('about:blank');
  await page.setContent('<h1 id="target" style="margin-top:180px">Review target</h1>');
  await page.evaluate(() => {
    window.originalExports = { hostApplication: true };
    window.module = { exports: window.originalExports };
  });
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_geometry.js'});
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_overlay.js'});
  await page.evaluate(() => {
    if (window.module.exports !== window.originalExports) throw new Error('Injection replaced the host CommonJS exports');
    window.calls = 0;
    window.saved = [];
    window.api = createHtmlReview({
      requireSavedComment: false,
      saveDraft: patch => {
        window.saved.push(patch);
        return window.saveGate;
      },
      onFinish: () => { window.calls++; },
    });
  });
  const delaySave = async text => {
    await page.waitForFunction(value => window.saved.at(-1)?.comments[0]?.comment === value, text);
    return page.evaluate(() => {
      window.saveGate = new Promise((resolve, reject) => {
        window.releaseSave = () => { window.saveGate = null; resolve(); };
        window.failSave = error => { window.saveGate = null; reject(error); };
      });
      return window.saved.length;
    });
  };
  const viewport = page.viewportSize();
  const handle = await page.getByRole('button', {name: 'Drag toolbar', exact: true}).boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewport.width - 60, viewport.height - 60);
  await page.mouse.up();
  await page.locator('.sr-add').click();
  await page.locator('#target').click();
  await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Saved feedback');
  await page.setViewportSize({width: 390, height: 500});
  for (const selector of ['#steward-review-root', '.steward-review-popup']) {
    await page.waitForFunction(selector => {
      const rect = document.querySelector('.sr-layer').shadowRoot.querySelector(selector).getBoundingClientRect();
      return rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    }, selector);
  }
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await page.setViewportSize(viewport);
  await page.locator('#target').evaluate(node => { node.firstChild.data = 'Unrelated replacement'; });
  await page.getByRole('button', {name: 'Open comment 1', exact: true}).waitFor({state: 'hidden'});
  await page.locator('#target').evaluate(node => { node.firstChild.data = 'Review target'; });
  await page.getByRole('button', {name: 'Open comment 1', exact: true}).waitFor({state: 'visible'});
  await page.getByRole('button', {name: 'Open comment 1', exact: true}).click();
  await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Preserve this draft');
  const firstSave = await delaySave('Preserve this draft');
  await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
  await page.waitForFunction(count => window.saved.length > count, firstSave);
  await page.evaluate(() => {
    const layer = document.querySelector('.sr-layer');
    if (!layer.inert) throw new Error('Review UI is not locked');
    const editor = layer.shadowRoot.querySelector('textarea');
    editor.focus();
    if (layer.shadowRoot.activeElement === editor) throw new Error('Locked editor accepted focus');
    layer.shadowRoot.querySelector('.sr-send').click();
    if (window.calls) throw new Error('Completion preceded persistence');
    window.releaseSave();
  });
  await page.waitForFunction(() => window.calls === 1);
  for (const selector of ['#steward-review-root', '.steward-review-pin', '.steward-review-popup']) {
    if (await page.locator(selector).isVisible()) throw new Error(`Submitted review still shows ${selector}`);
  }
  await page.evaluate(() => {
    const layer = document.querySelector('.sr-layer');
    layer.shadowRoot.querySelector('.sr-send').click();
    if (window.calls !== 1 || !layer.inert) throw new Error('Completion was not terminal');
    if (window.saved.at(-1).comments[0].comment !== 'Preserve this draft') throw new Error('Draft was lost');
    window.api.resume();
    if (layer.inert) throw new Error('Explicit resume failed');
  });
  await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Retry draft');
  const failedSave = await delaySave('Retry draft');
  await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
  await page.waitForFunction(count => window.saved.length > count, failedSave);
  await page.evaluate(() => window.failSave(new Error('Storage unavailable')));
  await page.waitForFunction(() => !document.querySelector('.sr-layer').inert);
  await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Retry succeeds');
  const retriedSave = await delaySave('Retry succeeds');
  await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
  await page.waitForFunction(count => window.saved.length > count, retriedSave);
  await page.evaluate(() => window.releaseSave());
  await page.waitForFunction(() => window.calls === 2);
  console.log('PASS: host CommonJS exports preserved; submission hides review UI; persistence lock, editor focus lock, duplicate completion, resume, failure retry');
}
