// From the repository root, with a playwright-cli browser session open:
// playwright-cli run-code --filename=skills/development/request-human-code-review/tests/diff-loading.browser.js
async (page) => {
  const origin = 'http://code-review.test';
  const assets = 'skills/development/request-human-code-review/scripts';
  const files = [{path: 'src/file.txt', change: 'M', additions: 1, deletions: 1, reviewed: false}];
  let failure;
  await page.route(`${origin}/**`, route => {
    const path = route.request().url().slice(origin.length + 1);
    if (path === 'data') return route.fulfill({json: {comparison: {patch: 'fixture.patch'}, comments: [], files}});
    if (path.startsWith('file/')) {
      return failure === 'refused' ? route.abort('connectionrefused') : route.fulfill({status: 502, body: ''});
    }
    return route.fulfill({path: `${assets}/${path || 'review.html'}`});
  });
  try {
    for (const [kind, expected] of [
      ['refused', 'The review server did not answer.'],
      ['empty', 'The review server sent an unreadable response (HTTP 502).'],
    ]) {
      failure = kind;
      await page.goto(`${origin}/`);
      const note = page.locator('.diff-note', {hasText: 'Could not load diff'});
      await note.waitFor();
      const message = await note.textContent();
      if (message !== `Could not load diff. ${expected}`) {
        throw new Error(`Unexpected message for a ${kind} diff response: ${message}`);
      }
    }
    return 'PASS: refused and empty diff responses are reported';
  } finally {
    await page.goto('about:blank');
    await page.unroute(`${origin}/**`);
  }
}
