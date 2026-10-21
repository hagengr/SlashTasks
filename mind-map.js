/* An alternate layout for the existing task editor's inputs. Draft data has one home. */
(() => {
  'use strict';
  function create({onAdd}) {
    const $ = selector => document.querySelector(selector);
    const modal = $('#taskModal'), title = $('#taskTitle'), field = $('#taskNameField');
    const editor = $('#stepEditor'), mount = $('#mindMapEditor'), viewport = $('#mindMapViewport');
    const canvas = $('#mindMapCanvas'), root = $('#mindMapRoot'), lines = $('#mindMapLines');
    const add = $('#mindMapAddStep'), meta = $('#taskMetaFields');
    let active = false, frame = 0, centerNext = false, focusNext = null;
    const width = 1000, rootWidth = 260, rootHeight = 140, stepWidth = 272, stepHeight = 126, spacing = 158;
    const rows = () => [...editor.children];
    const pristine = row => !row.querySelector('.step-title-input').value.trim() &&
      !row.querySelector('.step-date-input').value && !row.querySelector('.step-time-input').value && row.dataset.done !== 'true';

    function reveal(element) {
      // Pan this viewport only, keeping the surrounding editor in place.
      const box = element.getBoundingClientRect(), view = viewport.getBoundingClientRect();
      if (!view.width || !view.height) return;
      let left = viewport.scrollLeft, top = viewport.scrollTop;
      if (box.left < view.left + 18) left -= view.left + 18 - box.left;
      else if (box.right > view.right - 18) left += box.right - view.right + 18;
      if (box.top < view.top + 18) top -= view.top + 18 - box.top;
      else if (box.bottom > view.bottom - 18) top += box.bottom - view.bottom + 18;
      viewport.scrollTo({left, top, behavior:'auto'});
    }
    function layout() {
      frame = 0;
      if (!active || !modal.open) return;
      const hasTitle = !!title.value.trim(), all = rows();
      title.title = title.value;
      const visible = all.filter(row => hasTitle || !pristine(row));
      all.forEach((row, index) => {
        row.hidden = !visible.includes(row);
        row.querySelector('.step-title-input').setAttribute('aria-label', 'Step ' + (index + 1) + ' name');
        row.querySelector('.step-title-input').enterKeyHint = 'next';
        row.querySelector('.step-title-input').title = row.querySelector('.step-title-input').value;
        row.querySelector('.remove-step').setAttribute('aria-label', 'Remove step ' + (index + 1));
      });
      const columns = [visible.filter((_row,i) => i % 2 === 0), visible.filter((_row,i) => i % 2 === 1)];
      const height = Math.max(370, Math.max(...columns.map(column => column.length)) * spacing + 70);
      const cy = height / 2;
      canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
      root.style.left = (width - rootWidth) / 2 + 'px'; root.style.top = cy - rootHeight / 2 + 'px';
      lines.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      const paths = [];
      columns.forEach((column, side) => column.forEach((row,index) => {
        const y = cy + (index - (column.length - 1) / 2) * spacing;
        const x = side === 0 ? 28 : width - 28 - stepWidth;
        row.style.left = x + 'px'; row.style.top = y - stepHeight / 2 + 'px';
        const start = width / 2 + (side === 0 ? -rootWidth / 2 : rootWidth / 2);
        const end = side === 0 ? x + stepWidth : x;
        const middle = (start + end) / 2;
        paths.push('<path d="M ' + start + ' ' + cy + ' C ' + middle + ' ' + cy + ', ' + middle + ' ' + y + ', ' + end + ' ' + y + '"/>');
      }));
      lines.innerHTML = paths.join('');
      add.disabled = !hasTitle;
      $('#mindMapHint').textContent = hasTitle ? 'Your task in the middle. Small steps on the branches. Scroll to explore.' : 'Name your task, then branch into small steps.';
      const count = all.filter(row => row.querySelector('.step-title-input').value.trim()).length;
      const countText = count ? count + (count === 1 ? ' step' : ' steps') : 'No steps yet';
      if ($('#mindMapCount').textContent !== countText) $('#mindMapCount').textContent = countText;
      if (centerNext) {
        viewport.scrollTo({left:(width - viewport.clientWidth) / 2, top:(height - viewport.clientHeight) / 2, behavior:'auto'});
        centerNext = false;
      }
      if (focusNext?.isConnected) {
        const input = focusNext; focusNext = null;
        input.focus({preventScroll:true}); reveal(input.closest('.step-editor-row') || root);
      }
    }
    function refresh({center = false, focus = null} = {}) {
      centerNext ||= center;
      if (focus) focusNext = focus;
      if (active && !frame) frame = requestAnimationFrame(layout);
    }
    function addStep() {
      if (!title.value.trim()) { title.focus(); return; }
      const blank = rows().find(row => !row.querySelector('.step-title-input').value.trim());
      const row = blank || onAdd();
      refresh({focus:row.querySelector('.step-title-input')});
    }
    function setActive(value) {
      active = !!value;
      modal.classList.toggle('is-mind-map', active);
      mount.hidden = !active;
      $('#taskTitleHome').hidden = active;
      $('#taskMetaHome').hidden = active;
      $('#mindMapMetaHome').hidden = !active;
      $('#stepEditorHome').hidden = active;
      $('#addStepButton').hidden = active;
      (active ? root : $('#taskTitleHome')).insertBefore(field, active ? add : null);
      (active ? canvas : $('#stepEditorHome')).append(editor);
      (active ? $('#mindMapMetaHome') : $('#taskMetaHome')).append(meta);
      title.enterKeyHint = active ? 'next' : 'done';
      field.querySelector('label').textContent = active ? 'Task' : 'Task name';
      rows().forEach(row => {
        row.querySelector('.step-title-input').enterKeyHint = active ? 'next' : 'done';
        if (!active) { row.hidden = false; row.style.removeProperty('left'); row.style.removeProperty('top'); }
      });
      $('#editorKeyboardHint').textContent = active ? 'Ctrl/⌘ + Enter to save' : 'Enter to save';
      refresh({center:true});
    }
    add.addEventListener('click', addStep);
    $('#mindMapCenter').addEventListener('click', () => refresh({center:true}));
    viewport.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ||
          !event.target.matches('#taskTitle, .step-title-input')) return;
      event.preventDefault(); event.stopPropagation();
      if (event.target !== title && !event.target.value.trim()) return;
      addStep();
    });
    viewport.addEventListener('focusin', event => {
      const node = event.target.closest('.step-editor-row, .mind-map-root');
      if (node) reveal(node);
    });
    title.addEventListener('input', () => refresh());
    editor.addEventListener('input', () => refresh());
    new MutationObserver(() => refresh()).observe(editor, {childList:true});
    const resized = () => { if (active) refresh({focus:viewport.contains(document.activeElement) ? document.activeElement : null}); };
    if (typeof ResizeObserver === 'function') new ResizeObserver(resized).observe(viewport);
    else window.addEventListener('resize', resized);
    modal.addEventListener('close', () => {
      cancelAnimationFrame(frame); frame = 0; focusNext = null; centerNext = false;
    });
    return {setActive, refresh, get active(){return active;}};
  }
  window.SlashTasksMindMap = {create};
})();
