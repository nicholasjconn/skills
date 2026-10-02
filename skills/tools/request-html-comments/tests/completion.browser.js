// From the repository root, with a playwright-cli browser session open:
// playwright-cli run-code --filename=skills/tools/request-html-comments/tests/completion.browser.js
async (page) => {
  await page.goto('about:blank');
  await page.setContent('<h1 id="target" style="margin-top:180px">Review target</h1>');
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_geometry.js'});
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_overlay.js'});
  await page.evaluate(() => {
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
  await page.locator('.sr-add').click();
  await page.locator('#target').click();
  await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Saved feedback');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
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
  console.log('PASS: submission hides review UI; persistence lock, editor focus lock, duplicate completion, resume, failure retry');
}
