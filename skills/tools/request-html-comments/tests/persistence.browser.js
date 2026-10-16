// Run with playwright-cli from the repository root.
async (page) => {
  await page.goto('about:blank');
  await page.setContent('<h1 id="target" style="margin-top:180px">Review target</h1>');
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_geometry.js'});
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_overlay.js'});
  await page.evaluate(() => {
    window.failSave = true;
    window.saved = [];
    window.finished = window.actionsRun = 0;
    window.api = createHtmlReview({
      saveDraft: patch => {
        if (window.failSave) throw new Error('Disk full');
        window.saved.push(patch);
      },
      onFinish: () => {
        if (window.failFinish) throw new Error('Host callback failed');
        window.finished++;
      },
      actions: [{label: 'Strict action', run: () => {
        if (window.failAction) throw new Error('Host action failed');
        window.actionsRun++;
      }}],
    });
  });
  await page.locator('.sr-add').click();
  await page.locator('#target').click();
  await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Keep this feedback');
  await page.getByRole('button', {name: 'Save', exact: true}).click();

  const retry = async () => {
    await page.waitForFunction(() => document.querySelector('.sr-layer').shadowRoot.querySelector('.sr-status').textContent === 'Draft was not saved: Disk full');
    if (!(await page.locator('#steward-review-root').isVisible())) throw new Error('Failed save hid the toolbar');
    await page.evaluate(async () => { window.failSave = false; await window.api.flush(); });
    if (await page.locator('.sr-status').textContent()) throw new Error('Successful retry retained a save error');
  };
  for (const action of ['Strict action', 'Send review comments', 'Cancel review']) {
    await page.evaluate(() => { window.failSave = true; });
    await page.getByRole('button', {name: 'Open comment 1', exact: true}).click();
    await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Keep this feedback after ' + action);
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await page.getByRole('button', {name: action, exact: true}).click();
    if (await page.evaluate(() => window.finished || window.actionsRun)) throw new Error('An action bypassed failed persistence');
    await retry();
  }
  await page.evaluate(() => { window.failSave = true; window.api.addComment({...window.api.getComments()[0], id: 'pending', comment: 'Unsaved feedback'}); });
  const failure = await page.evaluate(async () => {
    try { await window.api.suspend(); return null; }
    catch (error) { return error.message; }
  });
  if (failure !== 'Disk full') throw new Error('Suspend bypassed failed persistence');
  await retry();
  if (await page.evaluate(() => window.saved.at(-1).comments.find(c => c.id === 'pending')?.comment) !== 'Unsaved feedback') throw new Error('Retry lost pending feedback');

  await page.evaluate(() => { window.failAction = true; });
  await page.getByRole('button', {name: 'Strict action', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.sr-layer').shadowRoot.querySelector('.sr-status').textContent === 'Host action failed');
  await page.evaluate(() => window.api.flush());
  if (await page.locator('.sr-status').textContent() !== 'Host action failed') throw new Error('Saving cleared an action failure');
  await page.evaluate(() => { window.failFinish = true; });
  await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.sr-layer').shadowRoot.querySelector('.sr-status').textContent === 'Could not finish review: Host callback failed');
  await page.evaluate(() => window.api.flush());
  if (!(await page.locator('.sr-status').textContent()).includes('Host callback failed')) throw new Error('Saving cleared a completion failure');
  // Download-only completion must leave its failed-save warning visible.
  await page.goto('about:blank');
  await page.setContent('<h1 id="target" style="margin-top:180px">Download-only review</h1>');
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_geometry.js'});
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_overlay.js'});
  await page.evaluate(() => {
    window.failSave = true;
    window.finished = 0;
    window.api = createHtmlReview({
      submitRequiresPersistence: false,
      requireSavedComment: false,
      saveDraft: () => { if (window.failSave) throw new Error('Disk full'); },
      onFinish: async (action, api) => {
        window.finished++;
        if (window.retryDuringFinish) { window.failSave = false; await api.flush(); }
      },
    });
  });
  await page.getByRole('button', {name: 'Comment on selected text', exact: true}).click();
  await page.locator('#target').selectText();
  await page.locator('#target').dispatchEvent('pointerup', {clientX: 100, clientY: 200});
  await page.getByRole('textbox', {name: 'Comment', exact: true}).fill('Keep exported feedback');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.sr-layer').shadowRoot.querySelector('.steward-review-highlight'));
  if (!(await page.locator('.steward-review-pin').isVisible())) throw new Error('Fixture has no visible comment pin');
  if (!(await page.locator('.steward-review-highlight').first().isVisible())) throw new Error('Fixture has no visible text highlight');
  await page.getByRole('button', {name: 'Open comment 1', exact: true}).click();
  if (!(await page.getByRole('textbox', {name: 'Comment', exact: true}).isVisible())) throw new Error('Fixture has no open editor');
  await page.evaluate(() => window.api.addComment({id: 'pending', comment: 'Unsaved export'}));
  await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
  await page.waitForFunction(() => window.finished === 1);
  if (!(await page.locator('.sr-status').isVisible()) ||
      !(await page.locator('.sr-status').textContent()).includes('Disk full')) throw new Error('Completion hid the failed-save warning');
  for (const selector of ['.sr-send', '.sr-cancel', '.steward-review-pin', '.steward-review-highlight', '.steward-review-popup']) {
    if (await page.locator(selector).first().isVisible()) throw new Error('Completion left active review controls');
  }
  await page.evaluate(() => document.querySelector('.sr-layer').shadowRoot.querySelector('.sr-send').click());
  if (await page.evaluate(() => window.finished) !== 1) throw new Error('Completion ran twice');
  if (await page.evaluate(() => window.api.getComments().length) !== 2) throw new Error('Completion lost feedback');
  await page.evaluate(() => { window.failSave = false; return window.api.flush(); });
  if (await page.locator('.sr-status').textContent()) throw new Error('Retry retained the completion warning');
  await page.evaluate(() => window.api.resume());
  if (!(await page.getByRole('button', {name: 'Send review comments', exact: true}).isVisible())) throw new Error('Resume left the toolbar hidden');
  await page.evaluate(() => {
    window.failSave = window.retryDuringFinish = true;
    window.api.addComment({id: 'finish-retry', comment: 'Saved by completion callback'});
  });
  await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
  await page.waitForFunction(() => window.finished === 2);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (await page.locator('.sr-status').textContent()) throw new Error('Completion restored a save warning after a successful retry');
  // Removing the hosting modal must not detach a failed-save warning.
  await page.goto('about:blank');
  await page.setContent('<dialog>Reviewing</dialog>');
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_geometry.js'});
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_overlay.js'});
  await page.evaluate(() => {
    const modal = document.querySelector('dialog');
    modal.showModal();
    window.modalFinished = false;
    window.api = createHtmlReview({
      submitRequiresPersistence: false,
      saveDraft: () => { throw new Error('Modal storage full'); },
      onFinish: () => { modal.remove(); window.modalFinished = true; },
    });
    window.api.addComment({id: 'modal', comment: 'Keep modal feedback'});
  });
  await page.waitForFunction(() => document.querySelector('dialog .sr-layer'));
  await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
  await page.waitForFunction(() => window.modalFinished);
  if (!(await page.locator('.sr-status').isVisible()) ||
      !(await page.locator('.sr-status').textContent()).includes('Modal storage full')) throw new Error('Removing the modal detached the warning');

  // Page replacement leaves completion warnings to the host.
  for (const failSave of [false, true]) {
    await page.goto('about:blank');
    await page.setContent('<h1>Local completion</h1>');
    await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_geometry.js'});
    await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_overlay.js'});
    await page.evaluate(failSave => {
      window.reattached = false;
      window.api = createHtmlReview({
        submitRequiresPersistence: !failSave,
        saveDraft: () => { if (failSave) throw new Error('Replacement storage full'); },
        onFinish: async () => {
          document.documentElement.innerHTML = '<head><title>Finished</title></head><body><h1>Review submitted</h1>' + (failSave ? '<p id="host-warning">Draft was not saved</p>' : '') + '</body>';
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          window.reattached = !!document.querySelector('.sr-layer');
        },
      });
      window.api.addComment({id: 'replace', comment: 'Exported feedback'});
    }, failSave);
    await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
    await page.waitForFunction(() => document.title === 'Finished');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (await page.evaluate(() => window.reattached || !!document.querySelector('.sr-layer'))) throw new Error('Completion observers restored the overlay');
    if (failSave && !(await page.locator('#host-warning').isVisible())) throw new Error('Host completion warning is missing');
  }
  return 'PASS: save gates, retries, callback errors, completion warnings, modal removal, and page replacement';
}
