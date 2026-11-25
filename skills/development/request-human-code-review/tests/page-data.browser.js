// From the repository root, with a playwright-cli browser session open:
// playwright-cli run-code --filename=skills/development/request-human-code-review/tests/page-data.browser.js
async (page) => {
  const origin = 'http://code-review.test';
  const assets = 'skills/development/request-human-code-review/scripts';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const numbered = (label, count) => Array.from({length: count}, (_, index) => `${label} ${index + 1}`);
  const between = numbered('between', 50);
  // A file of 82 lines with changes at lines 27 and 79, as the review server describes it.
  const rows = [
    {kind: 'gap', index: 0, old: 1, new: 1, count: 25, up: true, down: false},
    {kind: 'hunk', index: 25, text: '@@ -26,3 +26,3 @@', old_range: '-26,3', new_range: '+26,3'},
    {kind: 'context', index: 26, old_line: 26, new_line: 26, text: 'before'},
    {kind: 'remove', index: 27, old_line: 27, new_line: null, text: 'old value'},
    {kind: 'add', index: 28, old_line: null, new_line: 27, text: 'new value'},
    {kind: 'context', index: 29, old_line: 28, new_line: 28, text: 'after'},
    {kind: 'gap', index: 30, old: 29, new: 29, count: 50, up: true, down: true},
    {kind: 'hunk', index: 80, text: '@@ -79 +79 @@', old_range: '-79', new_range: '+79'},
    {kind: 'remove', index: 81, old_line: 79, new_line: null, text: 'second old'},
    {kind: 'add', index: 82, old_line: null, new_line: 79, text: 'second new'},
    {kind: 'gap', index: 83, old: 80, new: 80, count: 2, up: false, down: true},
  ];
  // The lines in those three gaps, which the server hands over when the reviewer first expands one.
  const hidden = [
    {text: numbered('hidden', 25)},
    {text: between, html: between.map(line => `<span class="n">${line}</span>`)},
    {text: ['tail 1', 'tail 2'], no_newline: true},
  ];
  const files = ['src/first.txt', 'src/second.txt'].map(path => ({
    path, change: 'M', additions: 1, deletions: 1, rows: structuredClone(rows), media: {},
  }));
  const snapshot = {comparison: {patch: 'fixture.patch'}, files};
  const progress = {comments: [], reviewed: [false, false]};
  const requested = [];
  let template;
  let failure;
  await page.route(`${origin}/**`, route => {
    const path = route.request().url().slice(origin.length + 1);
    requested.push(`${route.request().method()} ${path}`);
    if (path === '') {
      // The review server fills these two data blocks when it serves the page.
      const body = template.replace('REVIEW_SNAPSHOT', () => JSON.stringify(snapshot))
        .replace('REVIEW_STATE', () => JSON.stringify(progress));
      return route.fulfill({contentType: 'text/html', body});
    }
    if (path === 'file/0/hidden') {
      if (failure !== 'hidden') return route.fulfill({contentType: 'application/json', body: JSON.stringify(hidden)});
      failure = null;
      return route.abort('connectionrefused');
    }
    if (path === 'reviewed') {
      return failure === 'refused' ? route.abort('connectionrefused') : route.fulfill({status: 502, body: ''});
    }
    return route.fulfill({path: `${assets}/${path}`});
  });
  const first = page.locator('.file-card').first();
  const lines = async side => first.locator(`.diff-pane[data-side="${side}"] .diff-cell:not(.blank)`).evaluateAll(
    cells => cells.map(cell => `${cell.querySelector('.line-number').textContent}:${cell.querySelector('.source').textContent}`));
  try {
    await page.setViewportSize({width: 1200, height: 840});
    template = await (await page.goto(`${origin}/review.html`)).text();
    requested.length = 0;
    await page.goto(`${origin}/`);
    await first.getByText('new value', {exact: true}).waitFor();
    await page.locator('.file-card').nth(1).getByText('new value', {exact: true}).waitFor();

    const expand = async direction => first.getByRole('button', {name: `Expand ${direction}`}).first().click();
    failure = 'hidden';
    await expand('up');
    await page.getByRole('alert').filter({hasText: 'The review server did not answer.'}).waitFor();
    assert(await first.getByText('25 unchanged lines').isVisible(), 'A failed request for hidden lines changed the diff');
    await expand('up');
    await first.getByText('5 unchanged lines', {exact: true}).waitFor();  // not the 25 shown before
    assert(await page.getByRole('alert').count() === 0, 'The failure message stayed after the hidden lines arrived');
    assert(JSON.stringify((await lines('new')).slice(0, 2)) === JSON.stringify(['6:hidden 6', '7:hidden 7']),
      `Expanding up did not show the 20 lines above the change: ${(await lines('new')).slice(0, 2)}`);
    await expand('up');
    // Between the changes: the first 20 lines, then the last 20, then the 10 left in the middle.
    await expand('down');
    await first.getByText('30 unchanged lines').waitFor();
    await expand('up');
    await first.getByText('10 unchanged lines').waitFor();
    await expand('down');
    await expand('down');
    assert(await first.locator('.diff-gap button').count() === 0, 'An expanded file still offers hidden lines');
    const whole = [
      ...numbered('hidden', 25), 'before', 'new value', 'after', ...between, 'second new', 'tail 1', 'tail 2',
    ].map((line, index) => `${index + 1}:${line}`);
    for (const side of ['old', 'new']) {
      const expected = side === 'new' ? whole : whole.map(line => line.replace('new value', 'old value').replace('second new', 'second old'));
      const shown = await lines(side);
      const wrong = shown.findIndex((line, index) => line !== expected[index]);
      assert(shown.length === expected.length && wrong === -1,
        `The ${side} side shows ${shown.length} lines; the first wrong one is ${shown[wrong]} (expected ${expected[wrong]})`);
    }
    assert(await first.locator('.diff-pane[data-side="new"] .source span.n').count() === 50, 'Hidden lines lost their highlighting');
    assert(await first.locator('.diff-pane[data-side="new"] .no-newline').count() === 1, 'The missing final newline is not marked');

    // One request failed and one answered; six more expansions and a second file needed nothing further.
    const expected = ['GET ', 'GET review.css', 'GET images.js', 'GET review.js', 'GET file/0/hidden', 'GET file/0/hidden'];
    assert(JSON.stringify([...requested].sort()) === JSON.stringify(expected.sort()),
      `Showing and expanding diffs made these requests: ${requested}`);

    for (const [kind, expected] of [
      ['refused', 'The review server did not answer.'],
      ['empty', 'The review server sent an unreadable response (HTTP 502).'],
    ]) {
      failure = kind;
      await page.getByRole('checkbox', {name: 'Reviewed src/first.txt', exact: true}).click();
      await page.getByRole('alert').filter({hasText: expected}).waitFor();
      assert(await page.getByText('0 / 2 reviewed', {exact: true}).isVisible(), `A ${kind} save was shown as reviewed`);
    }
    return 'PASS: diffs come from the page, hidden lines are fetched once per file, and failed requests are reported';
  } finally {
    await page.goto('about:blank');
    await page.unroute(`${origin}/**`);
  }
}
