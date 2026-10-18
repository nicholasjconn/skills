// Run with playwright-cli from the repository root.
async (page) => {
  await page.goto('about:blank');
  await page.setContent('<p>Review fixture</p>');
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_geometry.js'});
  await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_overlay.js'});
  await page.evaluate(() => {
    window.failSave = true;
    window.api = createHtmlReview({
      saveDraft: patch => {
        if (window.failSave) throw new Error('Disk full');
        window.saved = patch;
      },
      onFinish: () => { throw new Error('Host callback failed'); },
    });
    window.api.addComment({id: 'draft', comment: 'Keep this feedback'});
  });

  const failure = await page.evaluate(async () => {
    try { await window.api.flush(); }
    catch (error) { return error.message; }
  });
  if (failure !== 'Disk full') throw new Error('Expected a save failure');
  if (!(await page.locator('.sr-status').textContent()).includes('Disk full')) {
    throw new Error('Save failure was not displayed');
  }
  await page.evaluate(async () => { window.failSave = false; await window.api.flush(); });
  if (await page.locator('.sr-status').textContent()) throw new Error('Retry retained the save error');
  if (await page.evaluate(() => window.saved.comments[0].comment) !== 'Keep this feedback') {
    throw new Error('Retry lost pending feedback');
  }

  await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
  await page.getByRole('status').filter({hasText: 'Host callback failed'}).waitFor();
  await page.evaluate(() => window.api.flush());
  if (!(await page.locator('.sr-status').textContent()).includes('Host callback failed')) {
    throw new Error('Saving cleared an unrelated callback error');
  }

  for (const transition of ['close', 'remove', 'new-modal']) {
    await page.goto('about:blank');
    await page.setContent('<dialog id="host"><p id="target">Review target</p></dialog><dialog id="next">Next modal</dialog>');
    await page.evaluate(() => document.querySelector('#host').showModal());
    await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_geometry.js'});
    await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_overlay.js'});
    await page.evaluate(() => {
      window.failSave = true;
      window.finished = 0;
      window.originalBody = document.body;
      window.api = createHtmlReview({
        submitRequiresPersistence: false,
        saveDraft: () => { if (window.failSave) throw new Error('Disk full'); },
        onFinish: () => { window.finished++; },
      });
      window.api.addComment({
        id: 'modal-draft', comment: 'Keep modal feedback', target_type: 'element',
        element: {css_selector: '#target'}, anchor: {x: 30, y: 100}, anchor_coordinate_space: 'viewport',
      });
    });
    await page.getByRole('button', {name: 'Open comment 1', exact: true}).waitFor({state: 'visible'});
    await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
    await page.locator('.sr-send').waitFor({state: 'hidden'});
    await page.getByRole('status').filter({hasText: 'Disk full'}).waitFor({state: 'visible'});

    // Mutate the host in a later task, after onFinish and review completion.
    await page.evaluate(transition => {
      if (window.finished !== 1) throw new Error('Host changed before completion');
      if (transition === 'close') document.querySelector('#host').close();
      else if (transition === 'remove') document.querySelector('#host').remove();
      else document.querySelector('#next').showModal();
    }, transition);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.getByRole('status').filter({hasText: 'Disk full'}).waitFor({state: 'visible'});
    for (const selector of ['.sr-send', '.steward-review-pin', '.steward-review-highlight', '.steward-review-popup']) {
      if (await page.locator(selector).isVisible()) throw new Error(`${transition}: completed control is visible: ${selector}`);
    }
    await page.evaluate(() => {
      if (document.body !== window.originalBody) throw new Error('Fixture replaced the document body');
      if (window.api.getComments()[0]?.comment !== 'Keep modal feedback') throw new Error('Modal change lost feedback');
      document.querySelector('.sr-layer').shadowRoot.querySelector('.sr-send').click();
      if (window.finished !== 1) throw new Error('Modal change allowed duplicate completion');
      try { window.api.addComment({id: 'late', comment: 'Must resume first'}); }
      catch (error) {
        if (error.message !== 'Resume the review before adding comments') throw error;
        return;
      }
      throw new Error('Completed API accepted feedback without resume');
    });

    await page.evaluate(() => { window.failSave = false; window.api.resume(); });
    await page.getByRole('button', {name: 'Send review comments', exact: true}).click();
    await page.locator('.sr-send').waitFor({state: 'hidden'});
    if (await page.getByRole('status').filter({hasText: 'Disk full'}).isVisible()) {
      throw new Error(`${transition}: successful resumed save retained a warning`);
    }
    if (await page.evaluate(() => window.finished) !== 2) throw new Error('Resumed completion did not run once');
  }
  return 'PASS: failed save, retry, retained feedback, distinct callback errors, and completed warnings across modal close/removal/replacement with terminal guards and resume';
}
