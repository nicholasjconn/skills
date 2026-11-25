// From the repository root, with a playwright-cli browser session open:
// playwright-cli run-code --filename=skills/development/request-human-code-review/tests/review-actions.browser.js
async (page) => {
  const origin = 'http://code-review.test';
  const assets = 'skills/development/request-human-code-review/scripts';
  const folderPath = 'a/shared/';
  const paths = ['match.txt', 'hidden.txt', 'already.txt'].map(name => folderPath + name);
  const outside = 'b/shared/outside.txt';
  const posts = [];
  const commentPosts = [];
  const existingComment = {id: 'saved', file: '0', body: 'Saved note'};
  let saveStarted;
  let finishSave;
  let commentStarted;
  let finishComment;
  const files = [...paths, outside].map(path => ({
    path, change: 'M', additions: 0, deletions: 0, rows: [], media: {},
  }));
  const snapshot = {comparison: {patch: 'fixture.patch'}, files};
  const progress = {comments: [existingComment], reviewed: files.map((_, index) => index === 2)};
  let template;
  const serveReview = async route => {
    const path = route.request().url().slice(origin.length + 1);
    if (path === '') {
      // The review server fills these two data blocks when it serves the page.
      const body = template.replace('REVIEW_SNAPSHOT', () => JSON.stringify(snapshot))
        .replace('REVIEW_STATE', () => JSON.stringify(progress));
      return route.fulfill({contentType: 'text/html', body});
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
    if (path === 'comment') {
      const comment = route.request().postDataJSON();
      commentPosts.push(comment);
      const success = await new Promise(resolve => {
        finishComment = resolve;
        commentStarted();
      });
      return success ? route.fulfill({json: {id: 'retried', file: comment.file, body: comment.body}})
        : route.fulfill({status: 500, json: {error: 'Could not save comment'}});
    }
    return route.fulfill({path: `${assets}/${path || 'review.html'}`});
  };
  await page.route(`${origin}/**`, serveReview);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const folder = path => page.locator(`.folder-label[title="${path}"]`);
  const diffToggle = path => page.getByRole('button', {name: path, exact: true});
  const menu = page.getByRole('group', {name: 'Review actions'});
  const folderTrigger = page.getByRole('button', {name: `Review actions for ${folderPath}`, exact: true});
  const firstFile = page.getByRole('button', {name: `${paths[0]}, needs review`, exact: true});
  const markFolder = menu.getByRole('button', {name: 'Mark a/shared/ reviewed (3 files)'});
  const filter = page.getByRole('searchbox', {name: 'Filter files by path'});
  const selectVisible = page.getByRole('checkbox', {name: 'Select visible'});
  const sidebar = page.getByRole('button', {name: 'Collapse changed files'});
  const savedThread = page.getByRole('article').filter({hasText: existingComment.body});
  const savedActions = ['Edit file comment', 'Delete file comment'].map(name => savedThread.getByRole('button', {name}));
  const expanded = async control => (await control.getAttribute('aria-expanded')) === 'true';
  const save = async (success) => {
    const posted = new Promise(resolve => { saveStarted = resolve; });
    await markFolder.click();
    await posted;
    if (!success) {
      await page.getByRole('combobox', {name: 'Diff layout'}).selectOption('unified');
      for (const action of savedActions) {
        assert(await action.isDisabled(), 'Rendering a thread re-enabled a comment action during the mark');
      }
    }
    await sidebar.focus();
    finishSave(success);
  };
  const saveComment = async () => {
    const posted = new Promise(resolve => { commentStarted = resolve; });
    await page.getByRole('button', {name: 'Save comment', exact: true}).click();
    await posted;
  };

  try {
    await page.setViewportSize({width: 1200, height: 840});
    template = await (await page.goto(`${origin}/review.html`)).text();
    await page.goto(origin);
    await folderTrigger.press('Enter');
    await markFolder.waitFor();
    await page.keyboard.press('Tab');
    assert(await firstFile.evaluate(control => document.activeElement === control),
      'Tab from a native menu should continue at the following file');
    await menu.waitFor({state: 'hidden'});
    await folderTrigger.press('Enter');
    await markFolder.waitFor();
    await menu.evaluate(node => node.hidePopover());
    await folderTrigger.and(page.locator('[aria-expanded="false"]')).waitFor();

    await page.getByRole('button', {name: 'Select files', exact: true}).click();
    const selectedFile = page.getByRole('checkbox', {name: `Select ${paths[0]}`, exact: true});
    const markFile = page.getByRole('checkbox', {name: `Reviewed ${paths[0]}`, exact: true});
    const markSelected = page.getByRole('button', {name: 'Mark 1 reviewed', exact: true});
    await selectedFile.check();
    await savedThread.waitFor();
    await page.locator('.file-card').first().getByRole('button', {name: 'Comment on file', exact: true}).click();
    const draft = '  Preserve these words and spacing.\nSecond line.  ';
    const editor = page.getByRole('textbox', {name: 'Comment on file', exact: true});
    await editor.fill(draft);
    await saveComment();
    assert(await markFile.isDisabled(), 'A file mark could start while saving a comment');
    assert(await markSelected.isDisabled(), 'A bulk mark could start while saving a comment');
    await folderTrigger.click();
    assert(await markFolder.isDisabled(), 'A menu mark could start while saving a comment');
    await page.keyboard.press('Escape');
    finishComment(false);
    await page.getByText('Could not save comment', {exact: true}).waitFor();
    assert(await editor.inputValue() === draft, 'A failed comment save lost the draft');
    await saveComment();
    await folderTrigger.click();
    assert(await markFolder.isDisabled(), 'Menu marks should stay disabled until the retry settles');
    finishComment(true);
    await page.getByRole('article').filter({hasText: 'Preserve these words and spacing.'})
      .getByRole('button', {name: 'Edit file comment'}).waitFor();
    assert(!await menu.isVisible(), 'The menu stayed open with stale actions after a save');
    assert(await folderTrigger.evaluate(control => document.activeElement === control),
      'Settling a save did not restore focus to the menu trigger');
    assert(commentPosts.length === 2 && commentPosts.every(comment => comment.body === draft.trim()),
      'Retry changed the comment payload');
    assert(posts.length === 0, 'A mark was written while the comment was saving');

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

    await firstFile.click({button: 'right'});
    await menu.getByRole('button', {name: 'Mark file reviewed'}).waitFor();
    await folder(folderPath).click({button: 'right'});
    await markFolder.waitFor();
    await save(false);
    await page.getByText('Simulated save failure', {exact: true}).waitFor();
    for (const action of savedActions) assert(await action.isEnabled(), 'A failed mark did not unlock comment actions');
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

    const fallback = await page.context().newPage();
    try {
      await fallback.route(`${origin}/**`, serveReview);
      await fallback.addInitScript(() =>
        Object.defineProperty(HTMLElement.prototype, 'showPopover', {value: undefined}));
      await fallback.goto(origin);
      const trigger = fallback.getByRole('button', {name: `Review actions for ${folderPath}`, exact: true});
      const actions = fallback.getByRole('group', {name: 'Review actions'});
      const mark = actions.getByRole('button', {name: 'Mark a/shared/ reviewed (3 files)'});
      await trigger.press('Enter');
      await mark.waitFor();
      assert(await actions.getAttribute('popover') === null, 'Fallback uses the native popover');
      await fallback.keyboard.press('Tab');
      const next = fallback.getByRole('button', {name: `${paths[0]}, needs review`, exact: true});
      assert(await next.evaluate(control => document.activeElement === control),
        'Tab from the fallback menu should continue at the following file');
      await trigger.press('Enter');
      await mark.waitFor();
      await fallback.keyboard.press('Escape');
      await actions.waitFor({state: 'hidden'});
      assert(await trigger.evaluate(control => document.activeElement === control),
        'Escape did not restore focus to the fallback trigger');
      await trigger.click();
      await mark.waitFor();
      await fallback.getByRole('heading', {name: 'Code review', exact: true}).click();
      await actions.waitFor({state: 'hidden'});
    } finally {
      await fallback.close();
    }
    return 'PASS: failed comment retry, mark and thread controls, folder selection and save, native and fallback menus';
  } finally {
    finishSave?.(false);
    finishComment?.(false);
    await page.goto('about:blank');
    await page.unroute(`${origin}/**`);
  }
}
