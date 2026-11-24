// From the repository root, with a playwright-cli browser session open:
// playwright-cli run-code --filename=skills/development/request-human-code-review/tests/review-actions.browser.js
async (page) => {
  const origin = 'http://code-review.test';
  const assets = 'skills/development/request-human-code-review/scripts';
  const folderPath = 'a/shared/';
  const paths = ['match.txt', 'hidden.txt', 'already.txt'].map(name => folderPath + name);
  const outside = 'b/shared/outside.txt';
  const posts = [];
  let saveStarted;
  let finishSave;
  const files = [...paths, outside].map((path, index) => ({
    path, change: 'M', additions: 0, deletions: 0, reviewed: index === 2,
  }));
  await page.route(`${origin}/**`, async route => {
    const path = route.request().url().slice(origin.length + 1);
    if (path === 'data') {
      return route.fulfill({json: {comparison: {patch: 'fixture.patch'}, comments: [], files}});
    }
    if (path.startsWith('file/')) {
      return route.fulfill({json: {rows: [], media: {}}});
    }
    if (path === 'reviewed') {
      posts.push(route.request().postDataJSON());
      const success = await new Promise(resolve => {
        finishSave = resolve;
        saveStarted();
      });
      return success ? route.fulfill({json: {reviewed: true}})
        : route.fulfill({status: 500, json: {error: 'Simulated save failure'}});
    }
    return route.fulfill({path: `${assets}/${path || 'review.html'}`});
  });
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const folder = path => page.locator(`.folder-label[title="${path}"]`);
  const diffToggle = path => page.getByRole('button', {name: path, exact: true});
  const menu = page.getByRole('group', {name: 'Review actions'});
  const markFolder = menu.getByRole('button', {name: 'Mark a/shared/ reviewed (3 files)'});
  const filter = page.getByRole('searchbox', {name: 'Filter files by path'});
  const selectVisible = page.getByRole('checkbox', {name: 'Select visible'});
  const sidebar = page.getByRole('button', {name: 'Collapse changed files'});
  const expanded = async control => (await control.getAttribute('aria-expanded')) === 'true';
  const save = async (success) => {
    const posted = new Promise(resolve => { saveStarted = resolve; });
    await markFolder.click();
    await posted;
    await sidebar.focus();
    finishSave(success);
  };

  try {
    await page.setViewportSize({width: 1200, height: 840});
    await page.goto(origin);
    await page.getByRole('button', {name: 'Select files', exact: true}).click();
    await selectVisible.check();
    await folder(folderPath).click();
    await selectVisible.uncheck();
    await page.getByRole('button', {name: 'Mark 2 reviewed (2 in collapsed folders)'}).waitFor();
    assert(!await page.getByRole('checkbox', {name: `Select ${outside}`}).isChecked(),
      'Select visible must clear the visible selection');
    await folder(folderPath).click();
    await folder('b/').click();
    await page.getByRole('button', {name: `${paths[2]}, reviewed`, exact: true}).click();
    await diffToggle(paths[1]).click();

    await filter.fill(folderPath);
    await folder(folderPath).click();
    await filter.fill(paths[0]);
    assert(!await expanded(folder(folderPath)), 'A filter edit reopened an explicitly collapsed folder');
    await folder(folderPath).click();
    await filter.clear();
    assert(await expanded(folder(folderPath)), 'An expansion made during filtering was lost');
    assert(!await expanded(folder('b/')), 'A previously collapsed folder was reopened');
    await filter.fill(paths[0]);

    await page.getByRole('button', {name: `${paths[0]}, needs review`, exact: true}).click({button: 'right'});
    await menu.getByRole('button', {name: 'Mark file reviewed'}).waitFor();
    await folder(folderPath).click({button: 'right'});
    await markFolder.waitFor();
    await save(false);
    await page.getByText('Simulated save failure', {exact: true}).waitFor();
    for (const [index, path] of paths.entries()) {
      assert(await expanded(diffToggle(path)) === (index !== 1), `Failure changed expansion for ${path}`);
    }
    assert(await expanded(folder(folderPath)), 'Failure collapsed the folder');
    assert(await sidebar.evaluate(control => document.activeElement === control), 'Failure moved focus');

    await folder(folderPath).click({button: 'right'});
    await save(true);
    await page.waitForFunction(path =>
      document.querySelector(`.folder-label[title="${path}"]`).getAttribute('aria-expanded') === 'false', folderPath);
    await page.getByText('3 / 4 reviewed', {exact: true}).waitFor();
    await folder(folderPath).getByRole('img', {name: 'All changed files reviewed'}).waitFor();
    assert(JSON.stringify(posts) === JSON.stringify([
      {files: ['0', '1'], reviewed: true}, {files: ['0', '1'], reviewed: true},
    ]), 'Each folder attempt must write every pending descendant in a single request');
    for (const path of paths) assert(!await expanded(diffToggle(path)), `Success left ${path} expanded`);
    assert(await sidebar.evaluate(control => document.activeElement === control), 'Success moved focus');
    await filter.fill('hidden.txt');
    assert(!await expanded(folder(folderPath)), 'A filter edit reopened the reviewed folder');
    await filter.clear();
    assert(!await expanded(folder(folderPath)), 'Clearing the filter reopened the reviewed folder');
    await folder(folderPath).click({button: 'right'});
    await menu.getByRole('button', {name: 'Collapse a/shared/ diffs (3 files)'}).click();
    assert(posts.length === 2, 'Collapsing an already reviewed folder wrote to storage');
    return 'PASS: review menu, selection, filter state, atomic request, failure recovery and focus';
  } finally {
    finishSave?.(false);
    await page.goto('about:blank');
    await page.unroute(`${origin}/**`);
  }
}
