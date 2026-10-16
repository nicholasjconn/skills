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
  return 'PASS: failed save, successful retry, retained feedback, and distinct callback errors';
}
