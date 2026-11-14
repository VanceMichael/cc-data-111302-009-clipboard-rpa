// 浏览器侧剪贴板协议。
//
// 1. 来源页的“复制资料”按钮通过 ClipboardItem 写入 text/html 与 text/plain，并在 HTML
//    开头写入本次动作的 token 标记（clipboard-copy token/product/version）。
// 2. 机器人在同一浏览器上下文里读取剪贴板，校对 token、产品、版本、标题，确认内容
//    属于当前产品与当前复制动作后，才允许进入粘贴阶段。
// 3. 门户编辑区必须获得焦点，机器人发送真实键盘 Ctrl+V；门户的 paste 监听器读取
//    真实 clipboardData，机器人核对事件中的标记后，等待异步清理真正结束。
// 4. 清理结束后回读编辑器，结构化比对标题、段落、链接与表格，并把门户不支持的
//    结构记录为降级和人工待确认项。

const PASTE_PROBE = `(() => {
  const editor = document.querySelector('#editor');
  window.__clipboardProbe?.dispose?.();
  window.__clipboardProbe = {pastes: [], focusLost: 0, installedAt: performance.now()};
  if (!editor) return false;
  const onPaste = event => {
    const data = event.clipboardData;
    const types = data ? [...data.types] : [];
    window.__clipboardProbe.pastes.push({
      at: performance.now(),
      types,
      html: types.includes('text/html') ? data.getData('text/html') : null,
      text: types.includes('text/plain') ? data.getData('text/plain') : null
    });
  };
  const onBlur = () => { window.__clipboardProbe.focusLost += 1; };
  editor.addEventListener('paste', onPaste, true);
  editor.addEventListener('blur', onBlur, true);
  window.addEventListener('blur', onBlur, true);
  window.__clipboardProbe.dispose = () => {
    editor.removeEventListener('paste', onPaste, true);
    editor.removeEventListener('blur', onBlur, true);
    window.removeEventListener('blur', onBlur, true);
  };
  return true;
})()`;

const READ_CLIPBOARD = `(async () => {
  try {
    const items = await navigator.clipboard.read();
    const result = {supported: true, items: []};
    for (const item of items) {
      const entry = {types: [...item.types]};
      for (const type of item.types) {
        if (type === 'text/plain' || type === 'text/html') entry[type] = await (await item.getType(type)).text();
        else entry[type] = null;
      }
      result.items.push(entry);
    }
    return result;
  } catch (error) {
    return {supported: false, error: {name: error.name, message: error.message}};
  }
})()`;

const CLEAR_CLIPBOARD = `(async () => {
  try {
    await navigator.clipboard.write([new ClipboardItem({'text/plain': new Blob([''], {type: 'text/plain'})})]);
    return {cleared: true};
  } catch (error) {
    return {cleared: false, error: {name: error.name, message: error.message}};
  }
})()`;

export const MARKER_PATTERN = /<!--\s*clipboard-copy\s+token="([^"]+)"\s+product="([^"]+)"\s+version="([^"]+)"\s*-->/;

export function parseMarker(html) {
  const match = MARKER_PATTERN.exec(String(html ?? ''));
  return match ? {token: match[1], product: match[2], version: Number(match[3])} : null;
}

export function parseArticleAttributes(html) {
  const opening = /<article\b([^>]*)>/i.exec(String(html ?? ''));
  if (!opening) return null;
  const attributes = {};
  for (const match of opening[1].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g)) attributes[match[1].toLowerCase()] = match[2];
  return attributes;
}

export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function stripTags(html) {
  return String(html ?? '').replace(/<[^>]*>/g, ' ');
}

function textEntries(snapshot) {
  return (snapshot?.items ?? [])
    .map(item => ({...item, types: [...(item.types ?? [])]}))
    .filter(item => item.types.includes('text/plain') || item.types.includes('text/html'));
}

export function describeRepresentations(entry) {
  const types = [...(entry?.types ?? [])].sort();
  return {types, hasHtml: types.includes('text/html'), hasPlain: types.includes('text/plain')};
}

export function isClipboardEmpty(snapshot) {
  if (!snapshot?.supported) return false;
  return textEntries(snapshot).every(item => {
    const plain = typeof item['text/plain'] === 'string' ? item['text/plain'] : '';
    const html = typeof item['text/html'] === 'string' ? item['text/html'] : '';
    return plain.trim() === '' && html.trim() === '';
  });
}

// 校验剪贴板是否来自当前产品、当前版本的这一次复制动作。
// expected: {token, product, version, title}
export function verifyClipboard(snapshot, expected, {allowPlainOnly = false} = {}) {
  if (!snapshot?.supported) {
    return {
      ok: false,
      code: 'clipboard-unreadable',
      reason: `无法读取剪贴板: ${snapshot?.error?.name ?? '未知错误'}`,
      snapshot
    };
  }
  const entries = textEntries(snapshot);
  if (entries.length === 0) {
    return {ok: false, code: 'clipboard-empty', reason: '剪贴板为空或没有可核对的文本', snapshot};
  }
  if (entries.length > 1) {
    return {ok: false, code: 'clipboard-ambiguous', reason: '剪贴板包含多个文本项，无法确认来源', snapshot};
  }
  const entry = entries[0];
  const representations = describeRepresentations(entry);
  const marker = representations.hasHtml ? parseMarker(entry['text/html']) : null;
  const attributes = representations.hasHtml ? parseArticleAttributes(entry['text/html']) : null;
  const product = attributes?.['data-product'] ?? marker?.product ?? null;
  const version = attributes?.['data-version'] !== undefined ? Number(attributes['data-version']) : marker?.version ?? null;
  const facts = {
    representations,
    marker,
    product,
    version,
    htmlLength: entry['text/html']?.length ?? 0,
    plainLength: entry['text/plain']?.length ?? 0
  };

  if (product !== expected.product) {
    return {
      ok: false,
      code: 'clipboard-foreign-product',
      reason: `剪贴板属于产品 ${product ?? '未知'}，不是当前产品 ${expected.product}`,
      facts,
      snapshot
    };
  }
  if (version !== expected.version) {
    return {
      ok: false,
      code: 'clipboard-version-mismatch',
      reason: `剪贴板版本 ${version ?? '未知'} 与当前版本 ${expected.version} 不一致`,
      facts,
      snapshot
    };
  }
  if (representations.hasHtml && !marker) {
    return {ok: false, code: 'clipboard-missing-marker', reason: 'HTML 中缺少本次复制动作的标记', facts, snapshot};
  }
  if (marker && marker.token !== expected.token) {
    return {ok: false, code: 'clipboard-superseded', reason: '剪贴板内容已被另一次复制动作替换', facts, snapshot};
  }
  const plain = entry['text/plain'] ?? null;
  if (plain !== null && expected.title && !plain.includes(expected.title)) {
    return {ok: false, code: 'clipboard-content-mismatch', reason: '剪贴板纯文本中找不到当前产品标题', facts, snapshot};
  }
  if (!representations.hasHtml) {
    if (!allowPlainOnly) {
      return {ok: false, code: 'clipboard-plain-only', reason: '剪贴板缺少 text/html 表示', facts, snapshot};
    }
    return {ok: true, adopted: 'text/plain', facts, snapshot};
  }
  return {ok: true, adopted: 'text/html', facts, snapshot};
}

// 从 paste 事件的 clipboardData 判断门户实际采用了哪种表示。
export function adoptedRepresentation(capture) {
  if (!capture) return {adopted: null, code: 'paste-not-observed', reason: '没有观察到粘贴事件'};
  if (capture.html) return {adopted: 'text/html', code: null, reason: 'paste 事件中读取到 text/html'};
  if (capture.text) return {adopted: 'text/plain', code: 'structure-flattened', reason: 'paste 事件中只有 text/plain，门户将按纯文本录入'};
  return {adopted: null, code: 'no-text-representation', reason: `粘贴事件中没有文本表示 (types=${JSON.stringify(capture.types)})`};
}

// 用 DOM 回读结果核对产品模型，产出降级项和人工待确认项。
export function readEditor(page) {
  return page.evaluate(() => {
    const editor = document.querySelector('#editor');
    if (!editor) return null;
    const collapse = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const links = [...editor.querySelectorAll('a')].map(anchor => ({
      text: collapse(anchor.textContent),
      href: anchor.getAttribute('href'),
      absolute: anchor.href
    }));
    const tables = [...editor.querySelectorAll('table')].map(table =>
      [...table.querySelectorAll('tr')].map(row => [...row.querySelectorAll('td,th')].map(cell => collapse(cell.textContent)))
    );
    const images = [...editor.querySelectorAll('img')].map(image => ({src: image.getAttribute('src'), alt: image.alt}));
    const unsupportedTags = 'script,style,img,iframe,video,audio,object,embed,link,meta,form,input,button,textarea,select';
    return {
      html: editor.innerHTML,
      text: (editor.innerText || '').replace(/\r\n/g, '\n'),
      title: collapse(editor.querySelector('h1,h2,h3,h4,h5,h6')?.textContent) || null,
      paragraphs: [...editor.querySelectorAll('p')].map(paragraph => collapse(paragraph.textContent)).filter(text => text && !/^附件：/.test(text)),
      links,
      tables,
      images,
      unsupported: [...new Set([...editor.querySelectorAll(unsupportedTags)].map(element => element.tagName.toLowerCase()))],
      settled: editor.dataset.settled === 'true',
      status: document.querySelector('#status')?.textContent ?? null
    };
  });
}

export function diffReadback(expected, readback) {
  const issues = [];
  const confirmations = [];
  const check = (id, ok, label, detail = {}) => {
    if (!ok) issues.push({id, label, detail});
    return ok;
  };

  check('title-missing', readback.title === expected.title, `标题应为“${expected.title}”，回读为“${readback.title ?? ''}”`, {expected: expected.title, actual: readback.title});
  for (const paragraph of expected.paragraphs ?? []) {
    check('paragraph-missing', readback.paragraphs.some(value => value.includes(paragraph)), `段落“${paragraph}”没有完整保留`, {expected: paragraph});
  }

  const expectedTables = expected.table ? [expected.table.headers, ...expected.table.rows] : [];
  if (expectedTables.length) {
    const table = readback.tables[0];
    const tableOk = table && expectedTables.every(row => table.some(actualRow => row.every(cell => actualRow.includes(cell))));
    check('table-missing', Boolean(tableOk), '表格关系没有保留', {expected: expectedTables, actual: table ?? null});
  }

  for (const link of expected.links ?? []) {
    const actual = readback.links.find(value => value.text === link.text);
    if (!check('link-text-missing', Boolean(actual), `链接文字“${link.text}”没有保留`, {expected: link.text})) continue;
    const policyAllows = link.href.startsWith('https:');
    if (policyAllows) {
      check('link-href-missing', Boolean(actual.href), `允许的链接“${link.text}”丢失了地址`, {expected: link.href, actual: actual.href});
    } else if (actual.href) {
      confirmations.push({
        id: 'unsafe-link-retained',
        label: `链接“${link.text}”使用门户不接受的协议，但回读中仍保留了地址`,
        detail: {expected: link.href, actual: actual.href}
      });
    } else {
      confirmations.push({
        id: 'link-href-removed',
        label: `链接“${link.text}”的地址被门户移除，只保留了文字`,
        detail: {expected: link.href, actual: null}
      });
    }
  }

  const expectedImages = expected.image ? 1 : 0;
  if (expectedImages > 0) {
    if (readback.images.length === 0) {
      confirmations.push({
        id: 'image-removed',
        label: '门户不支持图片，复制内容中的图片已被清理，只保留文字与表格',
        detail: {expected: expectedImages, actual: 0, alt: expected.image.alt}
      });
    } else {
      check('image-unexpected', false, '回读中出现了来源没有的图片', {actual: readback.images});
    }
  }

  if (readback.unsupported.length) {
    confirmations.push({
      id: 'unsupported-tags',
      label: `门户回读中仍存在未支持标签: ${readback.unsupported.join(', ')}`,
      detail: {tags: readback.unsupported}
    });
  }

  return {issues, confirmations, ok: issues.length === 0};
}

export {PASTE_PROBE, READ_CLIPBOARD, CLEAR_CLIPBOARD};
