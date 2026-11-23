'use strict';

const byId = id => document.getElementById(id);
const editor = byId('editor');
const commentBody = byId('comment-body');
const layoutSelect = byId('diff-layout');
const narrow = matchMedia('(max-width: 780px)');
const changes = {A: 'Added', D: 'Deleted', M: 'Modified', R: 'Renamed', C: 'Copied', T: 'Type changed', '?': 'Untracked'};
const sides = {old: 'Baseline', new: 'Updated'};
const views = [];
const deletingComments = new Set();
let layoutOverride;
let layout = narrow.matches ? 'unified' : 'split';
let comments = [];
let selection = null;
let selectionFeedback = null;
let dragging = null;
let pressedSelection = null;
let editing = null;
let savingComment = false;
let baselineWidth = 50;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text) {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function resizeDivider(handle, {current, limits, update, scale, step, preview}) {
  const clamp = (value, [min, max]) => Math.min(max, Math.max(min, Math.round(value)));
  function setValue(value, bounds = limits()) {
    value = clamp(value, bounds);
    update(value);
    const [min, max] = bounds;
    handle.setAttribute('aria-valuemin', min);
    handle.setAttribute('aria-valuemax', max);
    handle.setAttribute('aria-valuenow', value);
  }
  let drag;
  const dragValue = clientX => clamp(drag.initial + (clientX - drag.x) * drag.scale, drag.bounds);
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    handle.focus({preventScroll: true});
    handle.setPointerCapture(event.pointerId);
    drag = {id: event.pointerId, x: event.clientX, initial: current(), scale: scale(), bounds: limits()};
    handle.dataset.resizing = '';
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const value = dragValue(event.clientX);
    if (preview) preview(value - drag.initial);
    else setValue(value, drag.bounds);
  });
  handle.addEventListener('pointerup', event => {
    if (preview && drag?.id === event.pointerId) setValue(dragValue(event.clientX));
  });
  handle.addEventListener('lostpointercapture', () => {
    drag = null;
    preview?.(0);
    delete handle.dataset.resizing;
  });
  handle.addEventListener('keydown', event => {
    const [min, max] = limits();
    const value = current();
    const values = {ArrowLeft: value - step, ArrowRight: value + step, Home: min, End: max};
    if (!Object.hasOwn(values, event.key)) return;
    event.preventDefault();
    setValue(values[event.key], [min, max]);
  });
  return () => setValue(current());
}

function splitDivider(block) {
  const handle = element('div', 'resize-handle split-divider');
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Baseline and Updated widths');
  const sync = resizeDivider(handle, {
    current: () => baselineWidth,
    limits: () => [20, 80],
    scale: () => 100 / Math.max(1, block.clientWidth - 8),
    step: 5,
    update: value => {
      baselineWidth = value;
      byId('diffs').style.setProperty('--baseline-share', value / 100);
      byId('diffs').querySelectorAll('.split-divider').forEach(divider => divider.setAttribute('aria-valuenow', value));
    },
  });
  sync();
  return handle;
}

function setupSidebar() {
  const workspace = byId('workspace');
  const sidebar = byId('file-sidebar');
  const files = byId('changed-files');
  const bulk = byId('bulk-tools');
  const divider = byId('sidebar-divider');
  const overview = byId('files-overview');
  const toggle = byId('toggle-files');
  const limits = () => {
    const style = getComputedStyle(workspace);
    const innerWidth = workspace.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const minWidth = 216;
    return [minWidth, Math.max(minWidth, Math.floor(innerWidth * .45))];
  };
  function setExpanded(expanded) {
    workspace.classList.toggle('sidebar-hidden', !expanded);
    files.hidden = divider.hidden = overview.hidden = !expanded;
    bulk.hidden = !expanded || !views.length;
    const label = expanded ? 'Collapse changed files' : 'Expand changed files';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', String(expanded));
  }
  setExpanded(true);
  const sync = resizeDivider(divider, {
    current: () => sidebar.offsetWidth,
    limits,
    scale: () => 1,
    step: 16,
    // Move only the divider during a drag. Reflow the diff once on release.
    preview: offset => divider.style.setProperty('--drag-offset', `${offset}px`),
    update: width => workspace.style.setProperty('--sidebar-width', `${width}px`),
  });
  const syncWhenVisible = () => { if (!files.hidden && !narrow.matches) sync(); };
  toggle.addEventListener('click', () => {
    setExpanded(files.hidden);
    syncWhenVisible();
  });
  window.addEventListener('resize', syncWhenVisible);
  syncWhenVisible();
  new ResizeObserver(() => workspace.style.setProperty('--file-list-height', `${sidebar.offsetHeight}px`)).observe(sidebar);
}

function lineStats(file) {
  const stats = element('span', 'line-stats');
  const description = `${file.additions} added, ${file.deletions} removed`;
  stats.setAttribute('role', 'group');
  stats.setAttribute('aria-label', description);
  stats.title = description;
  stats.append(element('span', 'added-count', `+${file.additions}`), element('span', 'removed-count', `−${file.deletions}`));
  return stats;
}

async function request(route, data) {
  const response = await fetch(route, data === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}

function showError(error, node = byId('error')) {
  node.textContent = error?.message ?? '';
  node.hidden = !error;
}

function updateProgress() {
  byId('progress').textContent = `${views.filter(view => view.file.reviewed).length} / ${views.length} reviewed`;
}

function bulkCandidates() {
  return views.filter(view => !view.listItem.hidden && !view.file.reviewed);
}

function updateBulkControls() {
  const selecting = !byId('bulk-options').hidden;
  const query = selecting ? byId('bulk-filter').value.trim().toLowerCase().replace(/\/\*$/, '/') : '';
  const busy = views.some(view => view.savingMark);
  for (const view of views) {
    const path = view.file.path.toLowerCase();
    const matches = query.endsWith('/') ? path.startsWith(query) : path.includes(query);
    view.listItem.hidden = !matches;
    view.selectFile.hidden = !selecting;
    view.selectFile.disabled = !selecting || busy || view.file.reviewed;
    if (!matches || !selecting) view.selectFile.checked = false;
  }
  byId('no-matching-files').hidden = !query || views.some(view => !view.listItem.hidden);
  const candidates = bulkCandidates();
  const count = candidates.filter(view => view.selectFile.checked).length;
  const selectVisible = byId('select-visible');
  selectVisible.disabled = busy || !candidates.length;
  selectVisible.checked = count > 0 && count === candidates.length;
  selectVisible.indeterminate = count > 0 && count < candidates.length;
  const submit = byId('mark-selected');
  submit.disabled = busy || Boolean(editing) || count === 0;
  submit.textContent = count ? `Mark ${count} reviewed` : 'Mark selected reviewed';
  byId('bulk-filter').disabled = busy;
  byId('toggle-bulk').disabled = busy;
}

byId('toggle-bulk').addEventListener('click', () => {
  const options = byId('bulk-options');
  options.hidden = !options.hidden;
  const toggle = byId('toggle-bulk');
  toggle.setAttribute('aria-expanded', String(!options.hidden));
  toggle.textContent = options.hidden ? 'Select files' : 'Done selecting';
  if (options.hidden) byId('bulk-filter').value = '';
  else byId('bulk-filter').focus();
  updateBulkControls();
});
byId('bulk-filter').addEventListener('input', updateBulkControls);
byId('select-visible').addEventListener('change', event => {
  for (const view of bulkCandidates()) view.selectFile.checked = event.target.checked;
  updateBulkControls();
});
byId('mark-selected').addEventListener('click', () => {
  const selected = bulkCandidates().filter(view => view.selectFile.checked);
  if (selected.length) saveReviewMarks(selected, true);
});

function updateReviewActions() {
  byId('submit-review').disabled = Boolean(editing) || savingComment || deletingComments.size > 0 || views.some(view => view.savingMark);
  layoutSelect.disabled = Boolean(editing);
  views.forEach(view => {
    view.mark.disabled = view.savingMark || editing?.view === view;
    view.commentOnFile.disabled = Boolean(editing) || savingComment || view.savingMark;
    view.body.querySelectorAll('.comment-actions button').forEach(action => {
      action.disabled = Boolean(editing) || savingComment || deletingComments.has(action.closest('.comment').dataset.commentId);
    });
  });
  updateBulkControls();
}

async function saveReviewMarks(targets, reviewed, scrollTo = null) {
  const before = targets.map(view => ({view, reviewed: view.file.reviewed, expanded: !view.body.hidden}));
  const focused = scrollTo?.mark === document.activeElement;
  for (const {view} of before) {
    view.savingMark = true;
    view.file.reviewed = reviewed;
    view.updateMark();
    view.setExpanded(!reviewed);
  }
  if (scrollTo && reviewed && before[0].expanded && scrollTo.body.hidden) {
    scrollTo.panel.scrollIntoView({block: 'start'});
  }
  if (focused && reviewed) scrollTo.toggle.focus({preventScroll: true});
  updateProgress();
  updateReviewActions();
  showError(null);
  try {
    await request('reviewed', {files: targets.map(view => String(view.index)), reviewed});
    if (reviewed) for (const view of targets) view.selectFile.checked = false;
  } catch (error) {
    for (const previous of before) {
      const {view} = previous;
      view.file.reviewed = previous.reviewed;
      if (view.body.hidden === reviewed) view.setExpanded(previous.expanded);
    }
    updateProgress();
    showError(error);
  } finally {
    for (const view of targets) {
      view.updateMark();
      view.savingMark = false;
    }
    updateReviewActions();
  }
}

function clearSelection() {
  pressedSelection = null;
  dragging = null;
  window.getSelection().removeAllRanges();
  updateSelection();
}

class FileView {
  constructor(file, index) {
    this.file = file;
    this.index = index;
    this.sources = [];
    this.expanding = new Set();
    this.savingMark = false;
    this.panel = element('section', 'file-card');
    const header = element('header', 'file-heading');
    const name = element('div', 'file-name');
    const title = element('h2');
    const path = file.old_path && file.new_path && file.old_path !== file.new_path
      ? `${file.old_path} → ${file.new_path}` : file.path;
    this.toggle = button('file-toggle', path);
    this.toggle.id = `file-title-${index}`;
    this.toggle.setAttribute('aria-label', path);
    this.toggle.setAttribute('aria-controls', `file-body-${index}`);
    title.append(this.toggle);
    this.change = element('p', 'file-change', changes[file.change]);
    this.commentCount = element('span', 'comment-count');
    this.commentCount.setAttribute('aria-live', 'polite');
    this.updateCommentCount();
    const metrics = element('div', 'file-metrics');
    metrics.append(this.change, lineStats(file), this.commentCount);
    name.append(title, metrics);
    const actions = element('div', 'actions');
    const reviewed = element('label', 'reviewed');
    this.mark = element('input');
    this.mark.type = 'checkbox';
    this.mark.checked = file.reviewed;
    this.mark.setAttribute('aria-label', `Reviewed ${file.path}`);
    reviewed.append(this.mark, document.createTextNode('Reviewed'));
    this.commentOnFile = button('comment-on-file', 'Comment on file');
    this.commentOnFile.addEventListener('click', () => openEditor({view: this}));
    this.addComment = button('add-comment', 'Comment on code');
    this.addComment.title = 'Select code to leave an inline comment';
    this.addComment.disabled = true;
    this.addComment.hidden = true;
    this.selectionHint = element('p', 'selection-hint');
    this.selectionHint.id = `selection-hint-${index}`;
    this.selectionHint.setAttribute('role', 'status');
    this.addComment.setAttribute('aria-describedby', this.selectionHint.id);
    actions.append(reviewed, this.commentOnFile, this.addComment);
    header.append(name, actions, this.selectionHint);
    this.body = element('div', 'file-body');
    this.body.id = `file-body-${index}`;
    this.fileThread = element('div', 'file-thread');
    this.fileThread.hidden = true;
    this.media = element('div');
    this.media.hidden = true;
    this.diff = element('div', 'diff');
    this.diff.tabIndex = 0;
    this.body.append(this.fileThread, this.media, this.diff);
    this.panel.append(header, this.body);
    this.panel.dataset.index = index;
    this.panel.setAttribute('aria-labelledby', this.toggle.id);
    this.setExpanded(!file.reviewed);

    this.link = button('file-link');
    this.selectFile = element('input', 'select-file');
    this.selectFile.type = 'checkbox';
    this.selectFile.hidden = true;
    this.selectFile.setAttribute('aria-label', `Select ${file.path}`);
    this.selectFile.addEventListener('change', updateBulkControls);
    this.listItem = element('li');
    this.listItem.append(this.selectFile, this.link);
    const stats = lineStats(file);
    stats.id = `line-stats-${index}`;
    const filePath = element('span', 'file-path');
    const nameStart = file.path.lastIndexOf('/') + 1;
    if (nameStart) filePath.append(element('span', 'file-directory', file.path.slice(0, nameStart)));
    filePath.append(element('span', 'file-basename', file.path.slice(nameStart)));
    this.link.title = file.path;
    this.link.append(element('span', 'file-status'), filePath, stats);
    this.link.setAttribute('aria-describedby', stats.id);
    this.link.setAttribute('aria-controls', this.body.id);
    this.updateMark();
    this.link.addEventListener('click', () => {
      this.setExpanded(true);
      this.panel.scrollIntoView({block: 'start'});
      this.toggle.focus({preventScroll: true});
    });
    this.toggle.addEventListener('click', () => this.setExpanded(this.body.hidden));
    this.mark.addEventListener('change', () => saveReviewMarks([this], this.mark.checked, this));
    this.diff.addEventListener('pointerdown', event => {
      const cell = event.target.closest('.diff-cell:not(.blank)');
      dragging = cell && event.button === 0 ? {view: this, side: cell.dataset.side} : null;
      if (dragging) this.diff.dataset.selecting = dragging.side;
      else delete this.diff.dataset.selecting;
    });
    this.diff.addEventListener('click', () => requestAnimationFrame(updateSelection));
    this.addComment.addEventListener('pointerdown', event => {
      if (selection?.view !== this) return;
      pressedSelection = selection;
      event.preventDefault();
    });
    this.addComment.addEventListener('click', () => {
      const target = pressedSelection ?? selection;
      pressedSelection = null;
      if (target?.view === this) openEditor(target);
    });
  }

  setExpanded(expanded) {
    if (!expanded && editing?.view === this) return;
    if (!expanded && (selection?.view === this || selectionFeedback?.view === this)) clearSelection();
    this.body.hidden = !expanded;
    this.toggle.setAttribute('aria-expanded', String(expanded));
    this.addComment.hidden = !expanded || !this.hasCode;
    if (expanded) this.load();
  }

  async load() {
    if (this.data || this.loading) return;
    this.loading = true;
    this.diff.replaceChildren(element('div', 'diff-note', 'Loading diff…'));
    try {
      this.data = await request(`file/${this.index}`);
      const {rows, media} = this.data;
      this.hasCode = rows.some(row => row.kind === 'hunk');
      if (media.binary || media.image) {
        const bytes = side => side.present ? (side.size === null ? 'size unknown' : `${side.size.toLocaleString()} B`) : 'absent';
        this.change.textContent += ` · ${media.binary ? 'Binary · ' : ''}${bytes(media.old)} → ${bytes(media.new)}`;
        renderImagePreview(this.media, this.index, media, sides);
      }
      this.diff.hidden = media.binary && !this.hasCode;
      this.addComment.hidden = this.body.hidden || !this.hasCode;
      this.render();
    } catch (error) {
      this.data = null;
      this.diff.replaceChildren(element('div', 'diff-note', `Could not load diff. ${error.message}`));
    } finally {
      this.loading = false;
    }
  }

  updateMark() {
    this.mark.checked = this.file.reviewed;
    this.link.firstChild.textContent = this.file.reviewed ? '✓' : this.file.change;
    this.link.firstChild.title = this.file.reviewed ? 'Reviewed' : changes[this.file.change];
    this.link.setAttribute('aria-label', `${this.file.path}, ${this.file.reviewed ? 'reviewed' : 'needs review'}`);
  }

  updateCommentCount() {
    const count = comments.filter(comment => Number(comment.file) === this.index).length;
    this.commentCount.textContent = `${count} ${count === 1 ? 'comment' : 'comments'}`;
  }

  cell({row, index}, side, line, unified = false) {
    const cell = element('div', `diff-cell ${row.kind}`);
    cell.dataset.side = side;
    const code = element('span', 'source');
    const markup = row[`${side === 'both' ? 'new' : side}_html`];
    if (markup !== undefined) code.innerHTML = markup;
    if (code.textContent !== row.text) code.textContent = row.text;
    if (row.no_newline) {
      code.classList.add('no-newline');
      code.title = 'No newline at end of file';
    }
    const gutters = unified ? ['old', 'new'] : [side];
    for (const gutter of gutters) cell.append(element('span', 'line-number', row[`${gutter}_line`] ?? ''));
    const sign = {add: '+', remove: '−'}[row.kind] ?? '';
    cell.append(element('span', 'line-sign', sign), code);
    this.sources.push({code, row, index, side, line: line ?? cell});
    return cell;
  }

  gapRow(gap) {
    const row = element('div', 'diff-gap');
    row.dataset.gapIndex = gap.index;
    for (const direction of ['down', 'up']) {
      if (!gap[direction]) continue;
      const expand = button('expand-context', `Expand ${direction}`);
      expand.dataset.direction = direction;
      expand.disabled = this.expanding.has(gap);
      expand.addEventListener('click', () => this.expandContext(gap, direction));
      row.append(expand);
    }
    const hiddenComments = comments.filter(comment => Number(comment.file) === this.index &&
      gap.index <= comment.end.row && comment.end.row < gap.index + gap.count).length;
    const lines = `${gap.count.toLocaleString()} unchanged ${gap.count === 1 ? 'line' : 'lines'}`;
    const marker = hiddenComments ? ` · ${hiddenComments} ${hiddenComments === 1 ? 'comment' : 'comments'}` : '';
    row.append(element('span', 'hidden-context', lines + marker));
    return row;
  }

  async expandContext(gap, direction) {
    if (this.expanding.has(gap)) return;
    const controls = this.diff.querySelector(`[data-gap-index="${gap.index}"]`);
    this.expanding.add(gap);
    controls.querySelectorAll('button').forEach(action => { action.disabled = true; });
    showError(null);
    try {
      const {rows} = await request(`file/${this.index}/context/${gap.index}/${gap.count}/${direction}`);
      const fromTop = direction === 'down';
      const remaining = {...gap, count: gap.count - rows.length, index: gap.index + (fromTop ? rows.length : 0)};
      const replacement = remaining.count ? (fromTop ? [...rows, remaining] : [remaining, ...rows]) : rows;
      this.data.rows.splice(this.data.rows.indexOf(gap), 1, ...replacement);
      const active = document.activeElement;
      if (selection?.view === this || selectionFeedback?.view === this) clearSelection();
      this.render();
      if (active === commentBody && editing?.view === this) {
        commentBody.focus({preventScroll: true});
      } else if (active === document.body || controls.contains(active)) {
        const next = this.diff.querySelector(`[data-gap-index="${remaining.index}"] [data-direction="${direction}"]`);
        (next ?? this.diff).focus({preventScroll: true});
      }
    } catch (error) {
      showError(error);
    } finally {
      this.expanding.delete(gap);
      this.diff.querySelectorAll(`[data-gap-index="${gap.index}"] button`).forEach(action => { action.disabled = false; });
    }
  }

  render() {
    const rows = this.data.rows;
    const block = element('div', `diff-body ${layout}`);
    this.sources = [];
    this.diff.setAttribute('aria-label', layout === 'split' ? 'Side-by-side diff' : 'Unified diff');
    if (layout === 'unified') {
      rows.forEach(row => {
        if (row.kind === 'gap') block.append(this.gapRow(row));
        else if (row.kind === 'hunk' || row.kind === 'note') block.append(element('div', `diff-${row.kind}`, row.text));
        else block.append(this.cell({row, index: row.index}, {add: 'new', remove: 'old', context: 'both'}[row.kind], null, true));
      });
    } else {
      const before = element('div', 'diff-pane');
      const after = element('div', 'diff-pane');
      before.dataset.side = 'old';
      after.dataset.side = 'new';
      block.append(before, splitDivider(block), after);
      if (this.hasCode) {
        before.append(element('div', 'diff-side', sides.old));
        after.append(element('div', 'diff-side', sides.new));
      }
      const removed = [];
      const added = [];
      const pair = (oldEntry, newEntry) => {
        const line = {};
        line.old = oldEntry ? this.cell(oldEntry, 'old', line) : element('div', 'diff-cell blank');
        line.new = newEntry ? this.cell(newEntry, 'new', line) : element('div', 'diff-cell blank');
        before.append(line.old);
        after.append(line.new);
      };
      const flush = () => {
        for (let index = 0; index < Math.max(removed.length, added.length); index++) pair(removed[index], added[index]);
        removed.length = added.length = 0;
      };
      rows.forEach(row => {
        const entry = {row, index: row.index};
        if (row.kind === 'remove') removed.push(entry);
        else if (row.kind === 'add') added.push(entry);
        else {
          flush();
          if (row.kind === 'context') pair(entry, entry);
          else if (row.kind === 'gap') {
            before.append(this.gapRow(row));
            after.append(element('div', 'diff-gap'));
          }
          else if (row.kind === 'hunk') {
            const oldHunk = element('div', 'diff-hunk', row.old_range);
            const newHunk = element('div', 'diff-hunk', row.new_range);
            oldHunk.title = newHunk.title = row.text;
            before.append(oldHunk);
            after.append(newHunk);
          } else {
            const onAfter = row.text.startsWith('new ');
            before.append(element('div', 'diff-note', onAfter ? '' : row.text));
            after.append(element('div', 'diff-note', onAfter ? row.text : ''));
          }
        }
      });
      flush();
    }
    this.diff.replaceChildren(block);
    this.renderThreads();
  }

  renderThreads() {
    const focused = editor.contains(document.activeElement) ? document.activeElement : null;
    if (this.body.contains(editor)) document.body.append(editor);
    this.fileThread.replaceChildren();
    this.fileThread.hidden = true;
    this.diff.querySelectorAll('.inline-thread').forEach(thread => thread.remove());
    const block = this.data && this.diff.firstElementChild;
    const lineCount = block?.firstElementChild?.childElementCount ?? 0;
    const threads = new Map();
    const anchor = target => {
      if (!target.side) {
        this.fileThread.hidden = false;
        return this.fileThread;
      }
      const point = this.sourceAt(target.side, target.end.row);
      if (!point) return null;
      if (!threads.has(point.line)) {
        const old = element('div', 'inline-thread');
        if (layout === 'unified') {
          point.line.after(old);
          threads.set(point.line, {old, new: old});
        } else {
          const next = element('div', 'inline-thread');
          point.line.old.after(old);
          point.line.new.after(next);
          threads.set(point.line, {old, new: next});
        }
      }
      return threads.get(point.line)[target.side];
    };
    for (const comment of comments.filter(item => Number(item.file) === this.index && item.id !== editing?.id)) {
      const target = {...comment, view: this};
      const entry = element('article', 'comment');
      entry.dataset.commentId = comment.id;
      const header = element('div', 'comment-header');
      const actions = element('div', 'comment-actions');
      const edit = button('comment-edit', 'Edit');
      const remove = button('comment-delete', 'Delete');
      edit.disabled = remove.disabled = editing !== null || savingComment || deletingComments.has(comment.id);
      edit.setAttribute('aria-label', target.side ? `Edit comment on ${locationLabel(target)}` : 'Edit file comment');
      remove.setAttribute('aria-label', target.side ? `Delete comment on ${locationLabel(target)}` : 'Delete file comment');
      edit.addEventListener('click', () => openEditor(target));
      remove.addEventListener('click', () => deleteSavedComment(target, edit, remove));
      entry.addEventListener('mouseenter', () => { if (!editing && !selection) highlight(target); });
      entry.addEventListener('mouseleave', () => { if (!editing) highlight(null); });
      if (comment.pending) actions.append(element('span', 'saving-status', 'Saving…'));
      else actions.append(edit, remove);
      header.append(element('span', 'comment-location', locationLabel(target)), actions);
      entry.append(header, element('p', 'comment-body', comment.body));
      anchor(comment)?.append(entry);
    }
    if (editing?.view === this) anchor(editing)?.append(editor);
    if (focused && this.body.contains(editor)) focused.focus({preventScroll: true});
    if (layout === 'split' && block) block.style.setProperty('--rows', lineCount + threads.size);
  }

  sourceAt(side, index) {
    return this.sources.find(item => item.index === index && (item.side === side || item.side === 'both'));
  }
}

function offsetInside(source, container, offset) {
  const before = document.createRange();
  before.selectNodeContents(source);
  before.setEnd(container, offset);
  return before.toString().length;
}

function nodeElement(node) {
  return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
}

function locationLabel(target) {
  if (!target.side) return 'File comment';
  const line = point => point[`${target.side}_line`];
  const start = line(target.start);
  const end = line(target.end);
  const lines = start === end ? `Line ${start}` : `Lines ${start}–${end}`;
  return `${lines} in the ${sides[target.side].toLowerCase()} version`;
}

function selectedCode() {
  const native = window.getSelection();
  if (editing || savingComment || !native.rangeCount || native.isCollapsed) return null;
  const origin = nodeElement(native.anchorNode)?.closest('.diff-cell:not(.blank)');
  const card = origin?.closest('.file-card');
  const view = card && views[Number(card.dataset.index)];
  if (!view) return null;
  if (!view.diff.contains(native.focusNode)) return {view, message: 'Select code within one file to comment.'};
  const split = layout === 'split';
  const versionHint = 'Select code from one version to comment.';
  if (split && origin.dataset.side !== nodeElement(native.focusNode)?.closest('.diff-pane')?.dataset.side) {
    return {view, message: versionHint};
  }
  const range = native.getRangeAt(0);
  const parts = view.sources.filter(entry => (!split || entry.side === origin.dataset.side) && range.intersectsNode(entry.code)).map(entry => {
    const {code, row} = entry;
    const from = code.contains(range.startContainer) ? offsetInside(code, range.startContainer, range.startOffset) : 0;
    const to = code.contains(range.endContainer) ? offsetInside(code, range.endContainer, range.endOffset) : row.text.length;
    return {...entry, from, to};
  });
  const first = parts.findIndex(part => part.from < part.to);
  const last = parts.findLastIndex(part => part.from < part.to);
  if (first === -1) return null;
  const selected = parts.slice(first, last + 1);
  const changedSides = new Set(selected.map(part => part.side).filter(side => side !== 'both'));
  if (changedSides.size > 1) return {view, message: versionHint};
  if (view.data.rows.some(row => row.kind === 'gap' && parts[first].index < row.index && row.index < parts[last].index)) {
    return {view, message: 'Expand the hidden lines to comment on this selection.'};
  }
  const side = [...changedSides][0] ?? 'new';
  const start = {...parts[first].row, row: parts[first].index, column: parts[first].from + 1};
  const end = {...parts[last].row, row: parts[last].index, column: parts[last].to + 1};
  return {view, side, start, end, selected_text: selected.map(part => part.row.text.slice(part.from, part.to)).join('\n')};
}

function updateSelection() {
  const previous = selection?.view;
  const attempt = pressedSelection ?? selectedCode();
  const feedback = attempt?.message ? attempt : null;
  const oldHint = selectionFeedback?.view.selectionHint;
  const newHint = feedback?.view.selectionHint;
  if (oldHint && oldHint !== newHint) oldHint.textContent = '';
  if (newHint && newHint.textContent !== feedback.message) newHint.textContent = feedback.message;
  selectionFeedback = feedback;
  selection = feedback ? null : attempt;
  if (previous && previous !== selection?.view) {
    previous.addComment.disabled = true;
    if (dragging?.view !== previous) delete previous.diff.dataset.selecting;
  }
  if (selection) {
    selection.view.addComment.disabled = false;
    selection.view.diff.dataset.selecting = layout === 'split' ? selection.side : 'both';
  }
}

function sourcePoint(target, point) {
  const code = target.view.sourceAt(target.side, point.row)?.code;
  if (!code) return null;
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let offset = point.column - 1;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (offset <= node.length) return [node, offset];
    offset -= node.length;
  }
  return [code, 0];
}

function highlight(target) {
  if (!CSS.highlights) return;
  CSS.highlights.delete('review-comment');
  if (!target?.side) return;
  const start = sourcePoint(target, target.start);
  const end = sourcePoint(target, target.end);
  if (!start || !end) return;
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  const fragments = target.view.sources.filter(entry => (entry.side === target.side || entry.side === 'both') && range.intersectsNode(entry.code)).map(({code}) => {
    const fragment = document.createRange();
    fragment.selectNodeContents(code);
    if (code.contains(range.startContainer)) fragment.setStart(...start);
    if (code.contains(range.endContainer)) fragment.setEnd(...end);
    return fragment;
  });
  CSS.highlights.set('review-comment', new Highlight(...fragments));
}

function updateLayout() {
  const next = layoutOverride ?? (narrow.matches ? 'unified' : 'split');
  if (editing || layout === next) return;
  layout = next;
  layoutSelect.value = layout;
  clearSelection();
  highlight(null);
  views.forEach(view => { if (view.data) view.render(); });
}

function focusEditor() {
  editor.scrollIntoView({block: 'nearest', inline: 'nearest'});
  commentBody.focus({preventScroll: true});
}

function openEditor(target, body = target.body ?? '') {
  if (savingComment) return;
  if (editing) {
    focusEditor();
    return;
  }
  editing = target;
  target.view.setExpanded(true);
  clearSelection();
  highlight(target);
  byId('editor-title').textContent = target.id ? 'Edit comment' : target.side ? 'Comment on code' : 'Comment on file';
  byId('anchor').textContent = target.side ? locationLabel(target) : target.view.file.path;
  byId('quote').hidden = !target.side;
  byId('quote').textContent = target.selected_text ?? '';
  commentBody.value = body;
  byId('delete-comment').hidden = !target.id;
  showError(null, byId('editor-error'));
  updateReviewActions();
  target.view.renderThreads();
  editor.hidden = false;
  focusEditor();
}

function closeEditor() {
  const view = editing.view;
  editing = null;
  editor.hidden = true;
  highlight(null);
  view.renderThreads();
  updateReviewActions();
  updateLayout();
}

function endDrag(event) {
  if (pressedSelection && (event.type === 'pointercancel' || !pressedSelection.view.addComment.contains(event.target))) {
    pressedSelection = null;
    updateSelection();
  }
  if (dragging) {
    const view = dragging.view;
    dragging = null;
    updateSelection();
    if (selection?.view !== view) delete view.diff.dataset.selecting;
  }
}

document.addEventListener('pointerup', endDrag, true);
document.addEventListener('pointercancel', endDrag, true);
document.addEventListener('selectionchange', updateSelection);
layoutSelect.addEventListener('change', () => { layoutOverride = layoutSelect.value; updateLayout(); });
narrow.addEventListener('change', updateLayout);
byId('cancel-comment').addEventListener('click', closeEditor);
editor.addEventListener('keydown', event => {
  if (event.target === commentBody && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!event.repeat && !savingComment) byId('comment-form').requestSubmit(byId('save-comment'));
    return;
  }
  const unchanged = commentBody.value === (editing?.body ?? '');
  if (event.key === 'Escape' && !savingComment && unchanged) {
    event.preventDefault();
    closeEditor();
  }
});

async function deleteComment(target) {
  await request('delete', {id: target.id});
  comments = comments.filter(comment => comment.id !== target.id);
  target.view.updateCommentCount();
}

async function deleteSavedComment(target, edit, remove) {
  if (editing || savingComment || deletingComments.has(target.id)) return;
  deletingComments.add(target.id);
  edit.disabled = remove.disabled = true;
  updateReviewActions();
  showError(null);
  try {
    await deleteComment(target);
    if (!editing) highlight(null);
  } catch (error) {
    showError(error);
  } finally {
    deletingComments.delete(target.id);
    target.view.renderThreads();
    if (editing?.view === target.view) focusEditor();
    updateReviewActions();
  }
}

async function deleteEditingComment() {
  if (savingComment || !editing) return;
  savingComment = true;
  showError(null, byId('editor-error'));
  const buttons = [...byId('comment-form').querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    await deleteComment(editing);
    closeEditor();
  } catch (error) {
    showError(error, byId('editor-error'));
  } finally {
    savingComment = false;
    buttons.forEach(button => { button.disabled = false; });
    updateReviewActions();
  }
}

function replaceComment(id, comment) {
  const index = comments.findIndex(item => item.id === id);
  if (index === -1 && comment) comments.push(comment);
  else if (index !== -1) comments.splice(index, 1, ...(comment ? [comment] : []));
}

async function saveComment() {
  if (savingComment || !editing) return;
  const target = editing;
  const {id, view, side, start, end, selected_text} = target;
  const draft = commentBody.value;
  const body = draft.trim();
  if (!body) {
    showError(new Error('Enter a comment'), byId('editor-error'));
    return;
  }
  const previous = comments.find(item => item.id === id);
  const pending = id ?? 'pending';
  const file = String(view.index);
  savingComment = true;
  replaceComment(pending, {id: pending, file, side, start, end, selected_text, body, pending: true});
  view.updateCommentCount();
  closeEditor();
  let failure;
  try {
    const position = ({row, column}) => ({row, column});
    const selection = side ? {side, start: position(start), end: position(end)} : null;
    const saved = await request('comment', {id, file, selection, body});
    replaceComment(pending, saved);
  } catch (error) {
    replaceComment(pending, previous);
    failure = error;
  } finally {
    savingComment = false;
    view.updateCommentCount();
    view.renderThreads();
    updateReviewActions();
    updateSelection();
  }
  if (failure) {
    openEditor(target, draft);
    showError(failure, byId('editor-error'));
  }
}

byId('comment-form').addEventListener('submit', event => { event.preventDefault(); saveComment(); });
byId('delete-comment').addEventListener('click', deleteEditingComment);

async function submitReview() {
  const workspace = byId('workspace');
  byId('submit-review').disabled = true;
  workspace.inert = true;
  showError(null);
  try {
    await request('submit', {});
    workspace.hidden = true;
    byId('review-actions').hidden = true;
    byId('completion').hidden = false;
    byId('completion').textContent = 'Review submitted. You can close this tab.';
  } catch (error) {
    showError(error);
    workspace.inert = false;
    updateReviewActions();
  }
}

byId('submit-review').addEventListener('click', submitReview);

async function initialize() {
  const result = await request('data');
  comments = result.comments;
  const {repo, base, head, merge_base, patch, checkout_branch} = result.comparison;
  byId('source-name').textContent = (patch ?? repo).split('/').pop();
  if (repo) {
    byId('comparison').textContent = `${merge_base ? `merge base with ${base}` : base} → ${head ?? 'working tree'}`;
    byId('comparison').hidden = false;
    byId('checkout-path').textContent = repo;
    byId('checkout-branch').textContent = checkout_branch ? `Branch ${checkout_branch}` : 'Detached HEAD';
    byId('checkout-details').hidden = false;
  }
  const totals = {additions: 0, deletions: 0};
  for (const file of result.files) {
    totals.additions += file.additions;
    totals.deletions += file.deletions;
  }
  byId('review-totals').append(lineStats(totals));
  layoutSelect.value = layout;
  byId('layout-control').hidden = result.files.length === 0;
  for (const [index, file] of result.files.entries()) {
    const view = new FileView(file, index);
    views.push(view);
    byId('file-list').append(view.listItem);
    byId('diffs').append(view.panel);
  }
  const workspace = byId('workspace');
  workspace.hidden = false;
  setupSidebar();
  byId('empty').hidden = Boolean(views.length);
  updateProgress();
  updateReviewActions();
}

initialize().catch(error => showError(error));
