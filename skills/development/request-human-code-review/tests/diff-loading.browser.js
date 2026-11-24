// From the repository root, with a playwright-cli browser session open:
// playwright-cli run-code --filename=skills/development/request-human-code-review/tests/diff-loading.browser.js
async (page) => {
  const origin = 'http://code-review.test';
  const assets = 'skills/development/request-human-code-review/scripts';
  const count = 40;
  const limit = 6;
  const files = Array.from({length: count}, (_, index) => ({
    path: `src/file-${index}.txt`, change: 'M', additions: 1, deletions: 1, reviewed: false,
  }));
  const rows = [
    {kind: 'hunk', text: '@@ -1 +1 @@'},
    {kind: 'remove', old: 1, new: null, text: 'before'},
    {kind: 'add', old: null, new: 1, text: 'after'},
  ];
  const held = [];
  let inFlight = 0;
  let mostInFlight = 0;
  let refuse = false;
  await page.route(`${origin}/**`, async route => {
    const path = route.request().url().slice(origin.length + 1);
    if (path === 'data') return route.fulfill({json: {comparison: {patch: 'fixture.patch'}, comments: [], files}});
    if (path.startsWith('file/')) {
      if (refuse) return route.abort('connectionrefused');
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise(resolve => held.push(resolve));
      inFlight -= 1;
      return route.fulfill({json: {rows, media: {}}});
    }
    return route.fulfill({path: `${assets}/${path || 'review.html'}`});
  });
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const notes = text => page.locator('.diff-note', {hasText: text});
  try {
    // A viewport tall enough to show every file makes the page want all diffs at once.
    await page.setViewportSize({width: 1280, height: 40000});
    await page.goto(`${origin}/`);
    await notes('Loading diff').first().waitFor();
    await page.waitForFunction(expected => document.querySelectorAll('.diff-note').length === expected, count);
    await page.waitForTimeout(500);
    assert(inFlight === limit, `Expected ${limit} diff requests in flight while ${count} files wait, found ${inFlight}`);
    while (await notes('Loading diff').count()) {
      held.splice(0).forEach(release => release());
      await page.waitForTimeout(50);
    }
    assert(mostInFlight === limit, `Expected at most ${limit} diff requests at once, found ${mostInFlight}`);
    assert(await notes('Could not load diff').count() === 0, 'Expected every diff to load');
    assert(await page.locator('.diff-note').count() === 0, 'Expected every loading note to be replaced by its diff');

    refuse = true;
    await page.setViewportSize({width: 1280, height: 720});
    await page.goto(`${origin}/`);
    const failure = notes('Could not load diff').first();
    await failure.waitFor();
    const message = await failure.textContent();
    assert(message.includes('The review server did not answer (no response). Reload the page or restart the review.'),
      `Expected a refused diff request to explain what to do, found: ${message}`);
    return `PASS: ${count} diffs loaded ${limit} at a time; a refused request explains what to do`;
  } finally {
    held.splice(0).forEach(release => release());
    await page.goto('about:blank');
    await page.unroute(`${origin}/**`);
  }
}
