// From the repository root, with a playwright-cli browser session open:
// playwright-cli run-code --filename=skills/tools/request-html-comments/tests/navigation.browser.js
async (page) => {
  const origin = 'http://html-review.test';
  await page.route(`${origin}/**`, route => route.fulfill({
    contentType: 'text/html',
    body: '<title>Review fixture</title><h1 id="target" style="margin-top:180px">Shared target</h1><a href="/b?x=1">Page B</a>',
  }));
  const mount = async comments => {
    await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_geometry.js'});
    await page.addScriptTag({path: 'skills/tools/request-html-comments/scripts/review_overlay.js'});
    await page.evaluate(initialComments => {
      window.saved = [];
      window.submitted = null;
      window.api = createHtmlReview({
        initialComments,
        saveDraft: patch => { window.saved.push(patch); },
        onFinish: (action, api) => { window.submitted = api.getComments(); },
      });
    }, comments);
  };
  const check = async (labels, highlighted = false) => {
    // Wait for scheduled rendering without requiring an unrelated DOM event.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const actual = await page.locator('.steward-review-pin:visible').allTextContents();
    if (JSON.stringify(actual) !== JSON.stringify(labels)) throw new Error(`${page.url()}: expected pins ${labels}, got ${actual}`);
    const highlights = await page.locator('.steward-review-highlight:visible').count();
    if (Boolean(highlights) !== highlighted) throw new Error(`${page.url()}: unexpected text highlights (${highlights})`);
  };
  const add = async (text, selectedText = false) => {
    if (selectedText) {
      await page.getByRole('button', {name: 'Comment on selected text', exact: true}).click();
      await page.locator('#target').selectText();
      await page.locator('#target').dispatchEvent('pointerup', {clientX:100, clientY:200});
    } else {
      await page.locator('.sr-add').click();
      await page.locator('#target').click({position:{x:40, y:18}});
    }
    await page.getByRole('textbox', {name:'Comment', exact:true}).fill(text);
    if (selectedText) {
      await check(['1'], true);
      await page.evaluate(() => history.pushState(null, '', '/draft-away'));
      await check(['1']);
      if (await page.getByRole('textbox', {name:'Comment', exact:true}).inputValue() !== text) throw new Error('Navigation lost unfinished text');
      await page.goBack();
      await check(['1'], true);
    }
    await page.getByRole('button', {name:'Save', exact:true}).click();
    await page.evaluate(() => window.api.flush());
    await page.evaluate(text => {
      const saved = window.saved.flatMap(patch => patch.comments).find(item => item.comment === text);
      const url = `${location.pathname}${location.search}${location.hash}`;
      if (saved?.page_url !== url || saved.page_title !== document.title) throw new Error('Draft persistence lost page metadata');
    }, text);
    if (await page.locator('.sr-close').count()) await page.locator('.sr-close').click();
  };
  try {
    await page.goto(`${origin}/a`);
    await mount([{id:'legacy', target_type:'element', element:{css_selector:'#target'}, anchor:{x:30,y:190}, anchor_coordinate_space:'viewport', comment:'Older feedback'}]);
    await add('Page A text', true);
    await check(['1','2'], true);
    const aComments = await page.evaluate(() => window.api.getComments());
    const a = aComments.find(item => item.comment === 'Page A text');
    if (a.page_url !== '/a' || a.page_title !== 'Review fixture' || a.target_type !== 'text') throw new Error('Page A metadata was not captured');

    await page.getByRole('link', {name:'Page B', exact:true}).click();
    await mount(aComments);
    await check(['1']);
    await add('Page B element');
    await check(['1','3']);
    const allComments = await page.evaluate(() => window.api.getComments());
    if (allComments[2].page_url !== '/b?x=1') throw new Error('Query string was lost');
    await page.goBack();
    await mount(allComments);
    await check(['1','2'], true);

    await page.evaluate(() => {
      const result = history.pushState({route:'other'}, '', '/other');
      if (result !== undefined || history.state.route !== 'other') throw new Error('pushState behavior changed');
    });
    await check(['1']);
    await page.evaluate(() => {
      const result = history.replaceState({route:'query'}, '', '/a?filter=1');
      if (result !== undefined || history.state.route !== 'query') throw new Error('replaceState behavior changed');
    });
    await check(['1']);
    await page.goBack();
    await check(['1','2'], true);
    await page.goForward();
    await check(['1']);
    await page.evaluate(() => {
      try { history.pushState(null, '', 'http://other-origin.test/'); }
      catch (error) { if (error.name === 'SecurityError') return; throw error; }
      throw new Error('Invalid history URL did not throw');
    });
    await check(['1']);

    await page.evaluate(() => history.replaceState(null, '', '/a#/home'));
    await add('Hash home');
    await check(['1','4']);
    const home = await page.evaluate(() => window.api.getComments().find(item => item.comment === 'Hash home'));
    if (home.page_url !== '/a#/home') throw new Error('Hash route was lost');
    await page.evaluate(() => { location.hash = '/detail'; });
    await page.waitForURL(`${origin}/a#/detail`);
    await check(['1']);
    await page.goBack();
    await check(['1','4']);
    await page.evaluate(() => history.replaceState(null, '', '/a#section'));
    await check(['1']);
    if (await page.locator('.sr-count').textContent() !== '4') throw new Error('Toolbar excluded other pages');
    await page.getByRole('button', {name:'Send review comments', exact:true}).click();
    await page.waitForFunction(() => window.submitted?.length === 4);
    return 'PASS: metadata, static pages, query strings, saved/draft text highlights, legacy comments, pushState/replaceState semantics, back/forward, hash routes, section anchors, and submission across views';
  } finally {
    await page.unroute(`${origin}/**`);
    await page.goto('about:blank');
  }
}
