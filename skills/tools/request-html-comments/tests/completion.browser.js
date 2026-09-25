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
      saveDraft: patch => new Promise((resolve, reject) => {
        window.saved.push(patch);
        window.releaseSave = resolve;
        window.failSave = reject;
      }),
      onFinish: () => { window.calls++; },
    });
  });
  await page.locator('.sr-add').click();
  await page.locator('#target').click();
  await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Preserve this draft');
  await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
  await page.waitForFunction(() => typeof window.releaseSave === 'function');
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
  await page.evaluate(() => {
    const layer = document.querySelector('.sr-layer');
    layer.shadowRoot.querySelector('.sr-send').click();
    if (window.calls !== 1 || !layer.inert) throw new Error('Completion was not terminal');
    if (window.saved.at(-1).comments[0].comment !== 'Preserve this draft') throw new Error('Draft was lost');
    window.api.resume();
    if (layer.inert) throw new Error('Explicit resume failed');
  });
  await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Retry draft');
  await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
  await page.waitForFunction(() => window.saved.at(-1).comments[0].comment === 'Retry draft');
  await page.evaluate(() => window.failSave(new Error('Storage unavailable')));
  await page.waitForFunction(() => !document.querySelector('.sr-layer').inert);
  await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Retry succeeds');
  await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
  await page.waitForFunction(() => window.saved.at(-1).comments[0].comment === 'Retry succeeds');
  await page.evaluate(() => window.releaseSave());
  await page.waitForFunction(() => window.calls === 2);
  console.log('PASS: persistence lock, editor focus lock, duplicate completion, resume, failure retry');
}
