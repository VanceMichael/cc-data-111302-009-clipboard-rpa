import {chromium} from 'playwright';
import {randomUUID} from 'node:crypto';
import {
  CLEAR_CLIPBOARD,
  PASTE_PROBE,
  READ_CLIPBOARD,
  adoptedRepresentation,
  describeRepresentations,
  diffReadback,
  isClipboardEmpty,
  parseMarker,
  readEditor,
  verifyClipboard
} from './clipboard.mjs';
import {createRecordStore, summarizeRecord} from './records.mjs';

const MAX_RECORD_HISTORY = 60;

function nowIso() {
  return new Date().toISOString();
}

function publicExpected(product, version) {
  return {
    product: product.product,
    version,
    title: product.title,
    paragraphs: [...(product.paragraphs ?? [])],
    table: product.table ? {headers: [...product.table.headers], rows: product.table.rows.map(row => [...row])} : null,
    links: (product.links ?? []).map(link => ({text: link.text, href: link.href})),
    image: product.image ? {...product.image} : null
  };
}

async function fetchInventory(sourceUrl) {
  const response = await fetch(`${sourceUrl}/inventory`, {signal: AbortSignal.timeout(3000), cache: 'no-store'});
  if (!response.ok) throw new Error(`来源目录读取失败: ${response.status}`);
  return response.json();
}

export async function createAgent({
  sourceUrl,
  portalUrl,
  sanitizeDelay = 100,
  settleTimeoutMs = 5000,
  recoverFocus = true,
  storageDirectory = null,
  browser: providedBrowser = null
}) {
  if (!sourceUrl) throw new Error('缺少来源地址');
  portalUrl = portalUrl ?? `${sourceUrl}/portal.html?sanitizeDelay=${sanitizeDelay}`;
  const browser = providedBrowser ?? await chromium.launch({headless: true, args: ['--no-sandbox']});
  const ownedBrowser = !providedBrowser;
  const origin = new URL(sourceUrl).origin;
  const context = await browser.newContext();
  const permissionOrigins = [...new Set([origin, new URL(portalUrl).origin])];
  for (const permissionOrigin of permissionOrigins) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: permissionOrigin});
  }
  const store = storageDirectory ? createRecordStore(storageDirectory) : null;
  const memory = new Map();
  const listeners = new Set();

  let sourcePage = null;
  let portalPage = null;

  const emit = event => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {}
    }
  };

  async function pages() {
    if (!sourcePage || sourcePage.isClosed()) {
      sourcePage = await context.newPage();
      await sourcePage.goto(`${sourceUrl}/index.html`);
    }
    if (!portalPage || portalPage.isClosed()) {
      portalPage = await context.newPage();
      await portalPage.goto(portalUrl);
    }
    return {sourcePage, portalPage};
  }

  async function persist(record) {
    record.updatedAt = nowIso();
    if (record.history.length > MAX_RECORD_HISTORY) record.history = record.history.slice(-MAX_RECORD_HISTORY);
    memory.set(record.id, record);
    if (store) await store.save(record);
    latest = record;
    emit({type: 'record', record: summarizeRecord(record)});
    return record;
  }

  async function load(id) {
    if (memory.has(id)) return memory.get(id);
    if (store) {
      const record = await store.load(id);
      if (record) {
        memory.set(id, record);
        return record;
      }
    }
    throw Object.assign(new Error(`记录不存在: ${id}`), {status: 404, code: 'record-not-found'});
  }

  let latest = null;

  function annotate(record, event, detail = {}) {
    record.history.push({at: nowIso(), event, ...detail});
  }

  async function read(record) {
    const {sourcePage, portalPage} = await pages();
    // 剪贴板在同一浏览器上下文中共享；优先从来源页读取，避免门户跨域时权限不足。
    const page = sourcePage.isClosed() ? portalPage : sourcePage;
    const snapshot = await page.evaluate(READ_CLIPBOARD);
    if (!record) return snapshot;
    record.clipboard = {
      ...(record.clipboard ?? {}),
      lastReadAt: nowIso(),
      lastSnapshotFacts: {
        supported: snapshot.supported,
        error: snapshot.error ?? null,
        items: (snapshot.items ?? []).map(item => describeRepresentations(item))
      }
    };
    return snapshot;
  }

  async function clear(record, reason) {
    const {sourcePage, portalPage} = await pages();
    const page = sourcePage.isClosed() ? portalPage : sourcePage;
    const result = await page.evaluate(CLEAR_CLIPBOARD);
    const verification = await page.evaluate(READ_CLIPBOARD);
    const cleared = result.cleared && isClipboardEmpty(verification);
    const entry = {at: nowIso(), reason, cleared, error: result.error ?? null, empty: isClipboardEmpty(verification)};
    if (record) {
      record.clipboard = {...(record.clipboard ?? {}), clearedAt: entry.at, cleared, emptyAfterClear: entry.empty};
      annotate(record, 'clipboard-cleared', {reason, cleared});
    }
    emit({type: 'clipboard-cleared', ...entry});
    return entry;
  }

  async function inventoryFor(productId) {
    const inventory = await fetchInventory(sourceUrl);
    const product = inventory.products?.[productId];
    if (!product) throw Object.assign(new Error(`来源中没有产品 ${productId}`), {status: 404, code: 'product-not-found'});
    return {inventory, product};
  }

  async function runCopy(record, {reason = 'copy'} = {}) {
    const {sourcePage} = await pages();
    const {inventory, product} = await inventoryFor(record.product);
    record.productTitle = product.title;
    record.copy = {
      sourcePage: '/index.html',
      sourceUrl,
      product: product.product,
      version: product.version,
      title: product.title,
      copiedAt: null,
      token: null,
      expected: publicExpected(product, product.version)
    };
    const prior = await read(record);
    const previousHadContent = !isClipboardEmpty(prior);
    record.previousClipboard = {
      at: nowIso(),
      hadContent: previousHadContent,
      types: (prior.items ?? []).flatMap(item => item.types ?? []),
      error: prior.error ?? null
    };
    await clear(record, `${reason}:fresh-start`);
    await sourcePage.goto(`${sourceUrl}/index.html`, {waitUntil: 'domcontentloaded'});
    await sourcePage.evaluate(() => {
      window.__lastCopy = null;
    });
    const button = sourcePage.locator(`.copy[data-product="${product.product}"]`);
    if (await button.count() === 0) throw Object.assign(new Error(`来源页没有产品 ${product.product} 的复制按钮`), {status: 409, code: 'copy-button-missing'});
    await button.first().click();
    await sourcePage.waitForFunction(
      pid => {
        const output = document.querySelector('#copied');
        return output?.textContent === '已复制' && output?.dataset?.product === pid;
      },
      product.product,
      {timeout: 2000}
    );
    const action = await sourcePage.evaluate(() => window.__lastCopy ?? null);
    if (!action) {
      record.status = 'blocked';
      record.phase = 'copy';
      record.issues.push({id: 'copy-action-missing', label: '来源页没有记录本次复制动作，剪贴板可能被其他窗口占用'});
      annotate(record, 'copy-blocked', {reason: 'copy-action-missing'});
      await persist(record);
      return {ok: false, code: 'copy-action-missing', record};
    }
    record.copy.copiedAt = action.at ?? nowIso();
    record.copy.token = action.token;
    record.copy.tokenMarkerVersion = Number(action.version);

    const snapshot = await read(record);
    const expected = {
      token: record.copy.token,
      product: record.copy.product,
      version: record.copy.version,
      title: record.copy.title
    };
    const verification = verifyClipboard(snapshot, expected, {allowPlainOnly: false});
    record.clipboard = {
      ...(record.clipboard ?? {}),
      verified: verification.ok,
      adopted: verification.adopted ?? null,
      code: verification.code ?? null,
      reason: verification.reason ?? null,
      facts: verification.facts ?? null,
      representations: verification.facts?.representations ?? {types: [], hasHtml: false, hasPlain: false},
      checkedAt: nowIso()
    };
    if (!verification.ok) {
      record.status = 'blocked';
      record.phase = 'copy';
      record.issues = [{id: verification.code, label: verification.reason, detail: verification.facts ?? null}];
      record.cleanup = null;
      record.paste = null;
      record.readback = null;
      annotate(record, 'copy-blocked', {code: verification.code, reason: verification.reason});
      await persist(record);
      emit({type: 'copy-blocked', record: summarizeRecord(record), code: verification.code});
      return {ok: false, code: verification.code, reason: verification.reason, record};
    }
    record.status = 'copied';
    record.phase = 'ready-to-paste';
    record.issues = [];
    record.confirmations = [];
    record.humanReviewRequired = false;
    if (previousHadContent) {
      // 复制前发现上一位资料员或上一条记录留下的剪贴板内容，已清空，留作人工说明。
      record.confirmations.push({
        id: 'previous-clipboard-cleared',
        label: `开始本次复制前，剪贴板中仍有${reason === 'handover' ? '前一位资料员' : '上一条记录'}留下的内容，已清空后才执行复制`,
        detail: record.previousClipboard
      });
      record.humanReviewRequired = true;
    }
    annotate(record, 'copy-verified', {token: record.copy.token, representations: record.clipboard.representations.types});
    await persist(record);
    emit({type: 'copy-verified', record: summarizeRecord(record)});
    return {ok: true, record, verification};
  }

  async function createRecord({product, accountant}) {
    if (!product) throw Object.assign(new Error('缺少产品'), {status: 400});
    if (!accountant) throw Object.assign(new Error('缺少资料员'), {status: 400});
    const {product: sourceProduct} = await inventoryFor(product);
    const record = {
      id: randomUUID(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'starting',
      phase: 'copy',
      product,
      productTitle: sourceProduct.title,
      accountant,
      copy: null,
      previousClipboard: null,
      clipboard: null,
      paste: null,
      cleanup: null,
      readback: null,
      issues: [],
      confirmations: [],
      humanReviewRequired: false,
      handovers: [],
      history: []
    };
    annotate(record, 'record-created', {product, accountant});
    const result = await runCopy(record, {reason: 'record-start'});
    return result;
  }

  async function currentVersion(product) {
    const {product: current} = await inventoryFor(product);
    return current.version;
  }

  async function preflight(record) {
    const snapshot = await read(record);
    const currentSourceVersion = await currentVersion(record.product);
    const title = record.copy?.expected?.title ?? record.productTitle;
    // 先按复制当时的 token/产品/版本核对剪贴板本身；来源版本变化单独判定。
    const copiedVersion = record.copy?.version ?? null;
    const expected = {token: record.copy?.token ?? null, product: record.product, version: copiedVersion, title};
    const verification = verifyClipboard(snapshot, expected, {allowPlainOnly: false});
    const details = {
      expected: {product: expected.product, version: copiedVersion, token: expected.token},
      currentSourceVersion,
      sourceVersionAtCopy: copiedVersion,
      sourceChanged: currentSourceVersion !== copiedVersion,
      representations: verification.facts?.representations ?? null,
      marker: verification.facts?.marker ?? null
    };
    return {verification, details, version: currentSourceVersion, copiedVersion};
  }

  async function waitForPaste(page, baseline, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const probe = await page.evaluate(() => {
        const probe = window.__clipboardProbe;
        if (!probe) return null;
        return {pastes: probe.pastes.slice(), focusLost: probe.focusLost};
      });
      if (probe && probe.pastes.length > baseline) return probe;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return page.evaluate(() => {
      const probe = window.__clipboardProbe;
      return probe ? {pastes: probe.pastes.slice(), focusLost: probe.focusLost} : null;
    });
  }

  async function waitForCleanup(page, baseline, {timeoutMs = settleTimeoutMs, recover = recoverFocus} = {}) {
    const startedAt = Date.now();
    let pauseEvents = 0;
    let recoveries = 0;
    let lastState = null;
    const deadline = startedAt + timeoutMs;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => ({
        settled: document.querySelector('#editor')?.dataset.settled === 'true',
        cleaning: document.querySelector('#editor')?.dataset.cleaning ?? null,
        status: document.querySelector('#status')?.textContent ?? null,
        portal: window.__portalState ? {...window.__portalState} : null,
        activeElement: document.activeElement?.id ?? document.activeElement?.tagName ?? null,
        focusLost: window.__clipboardProbe?.focusLost ?? 0
      }));
      lastState = state;
      if (state.portal && state.portal.pauseCount > pauseEvents) pauseEvents = state.portal.pauseCount;
      if (state.settled && state.cleaning === 'done' && (state.portal?.settleCount ?? 0) >= baseline + 1) {
        return {settled: true, waitedMs: Date.now() - startedAt, pauseEvents, recoveries, state};
      }
      if (state.cleaning === 'paused' && recover) {
        const recovered = await recoverEditorFocus(page);
        if (recovered) recoveries += 1;
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return {settled: false, waitedMs: Date.now() - startedAt, pauseEvents, recoveries, state: lastState, timedOut: true};
  }

  async function recoverEditorFocus(page) {
    try {
      await page.bringToFront();
      await page.locator('#editor').click({timeout: 1000});
      const focused = await page.evaluate(() => document.activeElement?.id === 'editor');
      return focused;
    } catch {
      return false;
    }
  }

  async function paste(id, {settleTimeoutMs: overrideTimeout, recoverFocus: overrideRecover, onPaste, beforePaste, onCleanupWait} = {}) {
    const record = await load(id);
    if (!record.copy) throw Object.assign(new Error('记录尚未完成复制'), {status: 409, code: 'not-copied'});
    if (record.status === 'published') throw Object.assign(new Error('记录已完成，不能重复粘贴'), {status: 409, code: 'already-published'});

    const {sourcePage, portalPage} = await pages();
    const pre = await preflight(record);
    const {verification, details, version} = pre;
    record.clipboard = {
      ...(record.clipboard ?? {}),
      preflightAt: nowIso(),
      preflightOk: verification.ok,
      preflightCode: verification.code ?? null,
      preflightReason: verification.reason ?? null,
      preflightFacts: verification.facts ?? null,
      preflightExpected: details
    };
    if (!verification.ok) {
      record.status = 'blocked';
      record.phase = 'preflight';
      record.paste = null;
      record.cleanup = null;
      record.readback = null;
      record.issues = [{id: verification.code, label: verification.reason, detail: details}];
      record.humanReviewRequired = true;
      annotate(record, 'paste-blocked', {code: verification.code, reason: verification.reason, details});
      await persist(record);
      emit({type: 'paste-blocked', record: summarizeRecord(record), code: verification.code});
      return {ok: false, code: verification.code, reason: verification.reason, details, record};
    }
    if (version !== record.copy.version) {
      record.status = 'blocked';
      record.phase = 'preflight';
      record.issues = [{id: 'clipboard-stale-version', label: `来源版本已从 ${record.copy.version} 变为 ${version}，剪贴板仍是旧版本，需要重新复制`, detail: details}];
      record.humanReviewRequired = true;
      annotate(record, 'paste-blocked', {code: 'clipboard-stale-version'});
      await persist(record);
      return {ok: false, code: 'clipboard-stale-version', reason: record.issues[0].label, details, record};
    }

    record.phase = 'pasting';
    record.status = 'pasting';
    await portalPage.goto(portalUrl, {waitUntil: 'domcontentloaded'});
    await portalPage.evaluate(PASTE_PROBE);
    const baselineSettle = await portalPage.evaluate(() => window.__portalState?.settleCount ?? 0);
    const baselinePaste = 0;
    await portalPage.bringToFront();
    await portalPage.locator('#editor').click();
    const focusedBefore = await portalPage.evaluate(() => document.activeElement?.id === 'editor');
    if (!focusedBefore) {
      record.status = 'blocked';
      record.phase = 'preflight';
      record.issues = [{id: 'target-focus-failed', label: '门户编辑区没有获得焦点，未执行粘贴'}];
      record.humanReviewRequired = true;
      annotate(record, 'paste-blocked', {code: 'target-focus-failed'});
      await persist(record);
      return {ok: false, code: 'target-focus-failed', record};
    }
    // 用真实键盘操作清空目标编辑区（不直接改 DOM）。
    await portalPage.keyboard.press('Control+A');
    await portalPage.keyboard.press('Delete');

    if (typeof beforePaste === 'function') await beforePaste({record, page: portalPage});
    await portalPage.keyboard.press('Control+V');
    const pasteState = await waitForPaste(portalPage, baselinePaste, 2000);
    const capture = pasteState?.pastes?.[pasteState.pastes.length - 1] ?? null;
    const adoption = adoptedRepresentation(capture);
    const pasteMarker = capture?.html ? parseMarker(capture.html) : null;
    record.paste = {
      at: nowIso(),
      keyboard: 'Control+V',
      focusedBefore,
      focusLostBeforePaste: pasteState?.focusLost ?? null,
      typesSeen: capture?.types ?? [],
      adopted: adoption.adopted,
      adoptionCode: adoption.code,
      adoptionReason: adoption.reason,
      marker: pasteMarker,
      tokenMatches: pasteMarker ? pasteMarker.token === record.copy.token : null,
      productMatches: pasteMarker ? pasteMarker.product === record.product : null,
      versionMatches: pasteMarker ? pasteMarker.version === record.copy.version : null,
      capturedLength: {html: capture?.html?.length ?? 0, text: capture?.text?.length ?? 0}
    };
    annotate(record, 'paste-event', {adopted: adoption.adopted, marker: pasteMarker, types: capture?.types ?? []});
    if (typeof onPaste === 'function') await onPaste({record, page: portalPage, capture});
    await persist(record);

    const cleanupBaseline = baselineSettle;
    const cleanup = await waitForCleanup(portalPage, cleanupBaseline, {
      timeoutMs: overrideTimeout ?? settleTimeoutMs,
      recover: overrideRecover ?? recoverFocus
    });
    record.cleanup = {
      settled: cleanup.settled,
      waitedMs: cleanup.waitedMs,
      pauseEvents: cleanup.pauseEvents,
      focusRecoveries: cleanup.recoveries,
      timedOut: Boolean(cleanup.timedOut),
      portal: cleanup.state?.portal ?? null,
      statusText: cleanup.state?.status ?? null,
      activeElement: cleanup.state?.activeElement ?? null
    };
    annotate(record, cleanup.settled ? 'cleanup-settled' : 'cleanup-timeout', {
      waitedMs: cleanup.waitedMs,
      pauseEvents: cleanup.pauseEvents
    });
    if (typeof onCleanupWait === 'function') await onCleanupWait({record, page: portalPage, cleanup});

    if (!cleanup.settled) {
      record.status = 'interrupted';
      record.phase = 'cleanup';
      record.issues = [{
        id: cleanup.timedOut ? 'cleanup-timeout' : 'cleanup-unsettled',
        label: '门户清理没有完成，不能把键盘粘贴当作业务完成',
        detail: {waitedMs: cleanup.waitedMs, pauseEvents: cleanup.pauseEvents, portal: cleanup.state?.portal ?? null}
      }];
      record.humanReviewRequired = true;
      record.readback = null;
      await persist(record);
      emit({type: 'cleanup-interrupted', record: summarizeRecord(record)});
      return {ok: false, code: record.issues[0].id, reason: record.issues[0].label, record};
    }

    const readback = await readEditor(portalPage);
    const expected = record.copy.expected;
    const diff = diffReadback(expected, readback);
    const structuralIssues = [];
    if (adoption.code === 'structure-flattened' || (adoption.adopted === 'text/plain' && expected.table)) {
      structuralIssues.push({
        id: 'structure-flattened',
        label: '门户只接收到纯文本，表格与链接关系已降级，不能声称原样保留',
        detail: {types: capture?.types ?? [], adopted: adoption.adopted}
      });
    }
    if (capture && pasteMarker === null && capture.html) {
      structuralIssues.push({id: 'paste-marker-missing', label: '粘贴事件中的 HTML 缺少本次复制动作的标记'});
    } else if (pasteMarker && pasteMarker.token !== record.copy.token) {
      structuralIssues.push({id: 'paste-superseded', label: '粘贴发生时剪贴板已被另一次复制动作替换，录入内容可能不是当前产品'});
    }
    const issues = [...diff.issues, ...structuralIssues];
    const confirmations = [...diff.confirmations];
    if (record.paste.focusLostBeforePaste) {
      confirmations.push({
        id: 'focus-lost-before-paste',
        label: '粘贴前门户曾失去焦点，清理过程经过暂停/恢复',
        detail: {focusLost: record.paste.focusLostBeforePaste, pauseEvents: cleanup.pauseEvents}
      });
    }
    if (cleanup.pauseEvents > 0) {
      confirmations.push({
        id: 'cleanup-paused',
        label: `门户清理因失去焦点暂停了 ${cleanup.pauseEvents} 次，恢复后才完成`,
        detail: {pauseEvents: cleanup.pauseEvents, waitedMs: cleanup.waitedMs}
      });
    }
    record.readback = {
      at: nowIso(),
      title: readback.title,
      paragraphs: readback.paragraphs,
      links: readback.links.map(link => ({text: link.text, href: link.href})),
      tables: readback.tables,
      images: readback.images,
      unsupported: readback.unsupported,
      settled: readback.settled,
      statusText: readback.status,
      htmlLength: readback.html?.length ?? 0,
      textLength: readback.text?.length ?? 0
    };
    record.issues = issues;
    record.confirmations = confirmations;
    record.humanReviewRequired = issues.length > 0 || confirmations.length > 0;
    record.status = issues.length > 0 ? 'needs-review' : 'pasted';
    record.phase = 'readback';
    annotate(record, 'readback', {
      issues: issues.map(issue => issue.id),
      confirmations: confirmations.map(item => item.id),
      adopted: adoption.adopted
    });
    await persist(record);

    const clearResult = await clear(record, 'record-end');
    emit({type: 'record-end', record: summarizeRecord(record), clear: clearResult});
    return {
      ok: issues.length === 0,
      code: issues[0]?.id ?? null,
      record,
      readback: record.readback,
      issues,
      confirmations
    };
  }

  async function pause(id, {accountant} = {}) {
    const record = await load(id);
    if (record.status === 'paused') throw Object.assign(new Error('记录已暂停'), {status: 409, code: 'already-paused'});
    if (record.status === 'published') throw Object.assign(new Error('记录已完成，不能暂停'), {status: 409, code: 'already-published'});
    const clearing = await clear(record, 'pause');
    record.status = 'paused';
    record.phase = 'paused';
    record.handovers.push({from: record.accountant, to: accountant ?? null, at: nowIso(), clipboardCleared: clearing.cleared});
    annotate(record, 'paused', {accountant: accountant ?? null, clipboardCleared: clearing.cleared});
    await persist(record);
    return {ok: true, record, clear: clearing};
  }

  async function resume(id, {accountant} = {}) {
    const record = await load(id);
    if (!accountant) throw Object.assign(new Error('缺少接手资料员'), {status: 400});
    if (record.status !== 'paused' && record.status !== 'blocked' && record.status !== 'interrupted') {
      throw Object.assign(new Error('记录不在可继续的状态'), {status: 409, code: 'not-paused'});
    }
    if (record.status === 'published') throw Object.assign(new Error('记录已完成，不能继续'), {status: 409, code: 'already-published'});
    const previous = record.accountant;
    const clearing = await clear(record, 'handover');
    record.accountant = accountant;
    record.handovers.push({from: previous, to: accountant, at: nowIso(), clipboardCleared: clearing.cleared});
    record.phase = 'copy';
    record.status = 'starting';
    record.paste = null;
    record.cleanup = null;
    record.readback = null;
    record.issues = [];
    record.confirmations = [];
    record.humanReviewRequired = false;
    annotate(record, 'resumed', {from: previous, to: accountant, clipboardCleared: clearing.cleared});
    await persist(record);
    return runCopy(record, {reason: 'handover'});
  }

  async function recopy(id) {
    const record = await load(id);
    if (record.status === 'published') throw Object.assign(new Error('记录已完成，不能重新复制'), {status: 409, code: 'already-published'});
    record.phase = 'copy';
    record.status = 'starting';
    record.paste = null;
    record.cleanup = null;
    record.readback = null;
    record.issues = [];
    record.confirmations = [];
    record.humanReviewRequired = false;
    annotate(record, 'recopy-requested');
    await persist(record);
    return runCopy(record, {reason: 'recopy'});
  }

  async function acknowledge(id, {accountant, ids = [], note = null} = {}) {
    const record = await load(id);
    if (!accountant) throw Object.assign(new Error('缺少确认人'), {status: 400});
    if (!record.confirmations?.length) {
      throw Object.assign(new Error('没有需要确认的降级项'), {status: 409, code: 'nothing-to-acknowledge'});
    }
    const requested = ids.length ? new Set(ids) : new Set(record.confirmations.map(item => item.id));
    const existing = new Set(record.confirmations.map(item => item.id));
    for (const id of requested) {
      if (!existing.has(id)) throw Object.assign(new Error(`没有待确认项: ${id}`), {status: 400, code: 'confirmation-not-found'});
    }
    const at = nowIso();
    record.acknowledgements = record.acknowledgements ?? [];
    record.acknowledgements.push({by: accountant, at, ids: [...requested], note});
    record.confirmations = record.confirmations.filter(item => !requested.has(item.id));
    record.humanReviewRequired = record.issues.length > 0 || record.confirmations.length > 0;
    annotate(record, 'acknowledged', {by: accountant, ids: [...requested], note});
    await persist(record);
    return {ok: true, record};
  }

  async function publish(id) {
    const record = await load(id);
    if (!record.cleanup?.settled || !record.readback?.settled) {
      throw Object.assign(new Error('清理与回读尚未完成，不能标记业务完成'), {status: 409, code: 'not-settled'});
    }
    if (record.issues?.length) {
      throw Object.assign(new Error('记录仍有未解决的问题，需要人工确认'), {status: 409, code: 'issues-open'});
    }
    if (record.confirmations?.length) {
      throw Object.assign(new Error('仍有未确认的降级项，请资料员逐项确认'), {status: 409, code: 'confirmations-open'});
    }
    record.status = 'published';
    record.phase = 'published';
    record.publishedAt = nowIso();
    annotate(record, 'published', {accountant: record.accountant});
    await persist(record);
    return record;
  }

  async function listRecords() {
    const memoryRecords = [...memory.values()];
    if (store) {
      const stored = await store.list();
      for (const record of stored) if (!memory.has(record.id)) memoryRecords.push(record);
    }
    const unique = new Map(memoryRecords.map(record => [record.id, record]));
    return [...unique.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(summarizeRecord);
  }

  async function getRecord(id) {
    const record = await load(id);
    return {record, summary: summarizeRecord(record)};
  }

  async function close() {
    try {
      // 关闭前清掉本上下文剪贴板，避免内容留给下一位资料员的浏览器会话。
      const page = sourcePage && !sourcePage.isClosed() ? sourcePage : portalPage && !portalPage.isClosed() ? portalPage : null;
      if (page) await page.evaluate(CLEAR_CLIPBOARD).catch(() => {});
    } finally {
      await context.close().catch(() => {});
      if (ownedBrowser) await browser.close().catch(() => {});
    }
  }

  return {
    context,
    get latest() {
      return latest;
    },
    pages,
    createRecord,
    paste,
    pause,
    resume,
    recopy,
    acknowledge,
    publish,
    listRecords,
    getRecord,
    clearClipboard: () => clear(null, 'manual'),
    readClipboard: async id => {
      const record = id ? await load(id) : null;
      return read(record);
    },
    onRecord: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close
  };
}

