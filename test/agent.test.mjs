import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createSource} from '../src/source.mjs';
import {createAgent} from '../src/agent.mjs';
import {createService} from '../src/serve.mjs';
import {createRecordStore} from '../src/records.mjs';
import {parseMarker, verifyClipboard} from '../src/clipboard.mjs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

let source;
let browser;
let agent;

test.before(async () => {
  browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
});

test.after(async () => {
  await agent?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await source?.close().catch(() => {});
});

// 每个测试使用一份全新来源，避免版本控制在测试间串扰。
async function freshAgent(options = {}) {
  await agent?.close().catch(() => {});
  await source?.close().catch(() => {});
  source = await createSource();
  agent = await createAgent({sourceUrl: source.url, sanitizeDelay: 150, browser, settleTimeoutMs: 4000, ...options});
  return agent;
}

async function copyFor(product = 'P-1', accountant = '资料员甲') {
  const result = await agent.createRecord({product, accountant});
  assert.equal(result.ok, true, result.reason);
  return result.record;
}

test('真实复制后剪贴板同时有两种表示，门户真实粘贴并回读清理结果', {timeout: 20000}, async () => {
  await freshAgent();
  const record = await copyFor();
  assert.deepEqual(record.clipboard.representations.types.sort(), ['text/html', 'text/plain']);
  assert.equal(record.clipboard.verified, true);
  assert.match(record.copy.token, /^[0-9a-f-]{36}$/);
  assert.equal(record.clipboard.facts.marker.token, record.copy.token);

  const result = await agent.paste(record.id);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.record.paste.adopted, 'text/html');
  assert.equal(result.record.paste.tokenMatches, true);
  assert.equal(result.record.paste.productMatches, true);
  assert.equal(result.record.cleanup.settled, true);
  assert.equal(result.record.readback.title, '合成产品甲');
  assert.deepEqual(result.record.readback.paragraphs, ['耐用外壳', '适用于室内展示。']);
  assert.deepEqual(result.record.readback.tables, [[['项目', '参数'], ['尺寸', '20 cm']]]);
  const manual = result.record.readback.links.find(link => link.text === '说明书');
  assert.equal(manual.href, 'https://example.test/manual');
  // 门户清理会删除图片和 http 链接地址：必须作为降级明确记录，不能声称原样保留。
  assert.ok(result.confirmations.some(item => item.id === 'image-removed'));
  assert.ok(result.confirmations.some(item => item.id === 'link-href-removed'));
  assert.equal(result.record.humanReviewRequired, true);
  const publishError = await agent.publish(record.id).catch(error => error);
  assert.equal(publishError.code, 'confirmations-open');
  await agent.acknowledge(record.id, {accountant: '资料员甲'});
  const published = await agent.publish(record.id);
  assert.equal(published.status, 'published');
});

test('另一个窗口抢占剪贴板时，粘贴前被拦截并说明原因', {timeout: 20000}, async () => {
  await freshAgent();
  const record = await copyFor('P-1');
  const {sourcePage} = await agent.pages();
  // 另一个窗口（同上下文）复制了别的产品的纯文本。
  await sourcePage.evaluate(async () => {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob(['<article data-product="P-2" data-version="1"><h2>合成产品乙</h2></article>'], {type: 'text/html'}),
      'text/plain': new Blob(['合成产品乙'], {type: 'text/plain'})
    })]);
  });
  const result = await agent.paste(record.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'clipboard-foreign-product');
  assert.equal(result.record.status, 'blocked');
  assert.equal(result.record.paste, null, '不应在核对失败后发送键盘粘贴');
  assert.equal(result.record.readback, null);
  assert.equal(result.record.humanReviewRequired, true);
  assert.equal(result.record.issues[0].detail.currentSourceVersion, 1);
});

test('粘贴瞬间另一窗口抢占剪贴板：paste 事件中识别替换并判为需人工复核', {timeout: 20000}, async () => {
  await freshAgent();
  const record = await copyFor('P-1');
  const result = await agent.paste(record.id, {
    beforePaste: async ({page}) => {
      await page.evaluate(async () => {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob(['<article data-product="P-2" data-version="1"><h2>合成产品乙</h2><p>轻量外壳</p></article>'], {type: 'text/html'}),
          'text/plain': new Blob(['合成产品乙'], {type: 'text/plain'})
        })]);
      });
    }
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.id === 'paste-marker-missing'));
  assert.ok(result.issues.some(issue => issue.id === 'title-missing'));
  assert.equal(result.record.readback.title, '合成产品乙');
  assert.equal(result.record.status, 'needs-review');
});

test('贴入其他产品的带标记内容会被识别为不属于当前复制动作', {timeout: 20000}, async () => {
  await freshAgent();
  const record = await copyFor('P-1');
  const result = await agent.paste(record.id, {
    beforePaste: async ({page}) => {
      await page.evaluate(async () => {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob(['<!--clipboard-copy token="other-token" product="P-1" version="1"--><article data-product="P-1" data-version="1"><h2>合成产品甲</h2></article>'], {type: 'text/html'}),
          'text/plain': new Blob(['合成产品甲'], {type: 'text/plain'})
        })]);
      });
    }
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.id === 'paste-superseded'), JSON.stringify(result.issues));
  assert.equal(result.record.paste.tokenMatches, false);
});

test('粘贴前切换资料版本：核对到版本不一致并阻止粘贴', {timeout: 20000}, async () => {
  await freshAgent();
  const record = await copyFor('P-1');
  const response = await fetch(`${source.url}/control`, {method: 'POST', body: JSON.stringify({product: 'P-1', version: 2})});
  assert.equal(response.status, 200);
  const result = await agent.paste(record.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'clipboard-stale-version');
  assert.match(result.reason, /版本/);
  assert.equal(result.record.issues[0].detail.currentSourceVersion, 2);
  assert.equal(result.record.paste, null);
});

test('清理完成前失去焦点：等待暂停并在恢复后完成，不把按键当完成', {timeout: 25000}, async () => {
  await freshAgent({sanitizeDelay: 600});
  const record = await copyFor('P-1');
  let interruptedSeen = null;
  const result = await agent.paste(record.id, {
    recoverFocus: false,
    onPaste: async ({page}) => {
      // 粘贴事件后立刻把焦点挪到发布备注，门户会暂停清理。
      await page.locator('#notes').focus();
      await page.waitForTimeout(700);
      interruptedSeen = await page.evaluate(() => ({
        settled: document.querySelector('#editor').dataset.settled,
        cleaning: document.querySelector('#editor').dataset.cleaning,
        pauseCount: window.__portalState.pauseCount
      }));
    }
  });
  assert.equal(interruptedSeen.settled, 'false');
  assert.equal(interruptedSeen.cleaning, 'paused');
  assert.equal(interruptedSeen.pauseCount, 1);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cleanup-timeout');
  assert.equal(result.record.cleanup.settled, false);
  assert.equal(result.record.readback, null);
  assert.equal(result.record.status, 'interrupted');
  assert.equal(result.record.humanReviewRequired, true);
  await assert.rejects(agent.publish(record.id), /清理与回读尚未完成|not-settled/);

  // 恢复焦点后清理完成，重新粘贴可正常回读。
  const recovered = await agent.paste(record.id);
  assert.equal(recovered.record.cleanup.settled, true);
  assert.equal(recovered.record.readback.settled, true);
});

test('焦点丢失后自动恢复并记录暂停次数；失焦前的粘贴事件不被当作完成', {timeout: 20000}, async () => {
  await freshAgent({sanitizeDelay: 400});
  const record = await copyFor('P-1');
  let earlyRead = null;
  const result = await agent.paste(record.id, {
    onPaste: async ({page}) => {
      await page.locator('#notes').focus();
      await page.waitForTimeout(250);
      earlyRead = await page.evaluate(() => ({settled: document.querySelector('#editor').dataset.settled, cleaning: document.querySelector('#editor').dataset.cleaning}));
    }
  });
  assert.equal(earlyRead.settled, 'false');
  assert.equal(result.record.cleanup.settled, true);
  assert.ok(result.record.cleanup.pauseEvents >= 1);
  assert.ok(result.record.cleanup.focusRecoveries >= 1);
  assert.ok(result.confirmations.some(item => item.id === 'cleanup-paused'));
  assert.equal(result.record.readback.settled, true);
});

test('门户不支持的结构明确降级，不声称原样保留', {timeout: 20000}, async () => {
  await freshAgent();
  const record = await copyFor('P-1');
  const result = await agent.paste(record.id);
  const images = result.record.readback.images;
  assert.deepEqual(images, []);
  const removedImage = result.confirmations.find(item => item.id === 'image-removed');
  assert.ok(removedImage, '必须记录图片被清理');
  assert.match(removedImage.label, /图片/);
  const legacyLink = result.record.readback.links.find(link => link.text === '旧版说明');
  assert.equal(legacyLink.href, null);
  assert.ok(result.confirmations.some(item => item.id === 'link-href-removed'));
  // 允许的 https 链接保留。
  assert.equal(result.record.readback.links.find(link => link.text === '说明书').href, 'https://example.test/manual');
});

test('暂停后换人继续，且不把前一位资料员的剪贴板带进下一条记录', {timeout: 20000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clipboard-records-'));
  try {
    await freshAgent({storageDirectory: directory});
    const record = await copyFor('P-1', '资料员甲');
    const originalToken = record.copy.token;
    await agent.pause(record.id, {accountant: '资料员乙'});
    const snapshot = await agent.readClipboard();
    const remaining = (snapshot.items ?? []).flatMap(item => [item['text/plain'], item['text/html']]).filter(value => value && value.trim());
    assert.deepEqual(remaining, [], '暂停后剪贴板必须被清空');
    assert.equal(record.clipboard.cleared, true);
    assert.equal(record.clipboard.emptyAfterClear, true);

    const resumed = await agent.resume(record.id, {accountant: '资料员乙'});
    assert.equal(resumed.ok, true);
    assert.equal(resumed.record.accountant, '资料员乙');
    assert.equal(resumed.record.handovers.length, 2);
    assert.equal(resumed.record.handovers.at(-1).from, '资料员甲');
    assert.equal(resumed.record.previousClipboard.hadContent, false);
    // 接手后会重新复制，得到新的 token。
    assert.notEqual(resumed.record.copy.token, originalToken);
    assert.equal(resumed.record.copy.version, 1, `来源版本不应受其他测试影响: ${resumed.record.copy.version}`);
    assert.equal(resumed.record.clipboard.facts.marker.token, resumed.record.copy.token);

    const pasted = await agent.paste(record.id);
    assert.equal(pasted.ok, true);

    const store = createRecordStore(directory);
    const stored = await store.load(record.id);
    assert.equal(stored.accountant, '资料员乙');
    assert.equal(stored.copy.token, resumed.record.copy.token);
    assert.equal(stored.readback.title, '合成产品甲');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('连续记录不把上一条的剪贴板带进下一条记录的核对', {timeout: 20000}, async () => {
  await freshAgent();
  const first = await copyFor('P-1', '资料员甲');
  const firstMarkerToken = first.copy.token;
  // 第一条记录尚未粘贴时直接开始第二条：剪贴板里仍是上一条产品的 HTML。
  const second = await copyFor('P-2', '资料员甲');
  assert.equal(second.previousClipboard.hadContent, true);
  assert.ok(second.previousClipboard.types.includes('text/html'));
  assert.ok(second.confirmations.some(item => item.id === 'previous-clipboard-cleared'));
  assert.notEqual(second.copy.token, firstMarkerToken);
  assert.equal(second.clipboard.verified, true);
  assert.equal(second.clipboard.facts.marker.token, second.copy.token);
  assert.equal(second.clipboard.facts.product, 'P-2');
  // 上一条的剪贴板内容没有进入第二条的粘贴与回读。
  const pasted = await agent.paste(second.id);
  assert.equal(pasted.record.readback.title, '合成产品乙');
  assert.ok(!pasted.record.readback.paragraphs.includes('耐用外壳'));
});

test('记录包含复制来源、被采用的表示、目标回读摘要与人工待确认项', {timeout: 20000}, async () => {
  await freshAgent();
  const record = await copyFor('P-1', '资料员丙');
  await agent.paste(record.id);
  const {record: stored, summary} = await agent.getRecord(record.id);
  assert.equal(summary.copy.product, 'P-1');
  assert.equal(summary.copy.version, 1);
  assert.equal(summary.copy.token, stored.copy.token);
  assert.equal(summary.adoptedRepresentation, 'text/html');
  assert.equal(summary.readback.title, '合成产品甲');
  assert.equal(summary.readback.tables.length, 1);
  assert.equal(summary.confirmations.some(item => item.id === 'image-removed'), true);
  assert.equal(summary.settle, true);
  assert.ok(stored.history.some(entry => entry.event === 'copy-verified'));
  assert.ok(stored.history.some(entry => entry.event === 'paste-event'));
  assert.ok(stored.history.some(entry => entry.event === 'cleanup-settled'));
  assert.ok(stored.history.some(entry => entry.event === 'readback'));
});

test('纯文本降级：只有 text/plain 时如实标注结构被压平', {timeout: 20000}, async () => {
  await freshAgent();
  const record = await copyFor('P-1');
  const result = await agent.paste(record.id, {
    beforePaste: async ({page}) => {
      await page.evaluate(async () => {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob(['合成产品甲\n\n耐用外壳\n\n适用于室内展示。'], {type: 'text/plain'})
        })]);
      });
    }
  });
  assert.equal(result.record.paste.adopted, 'text/plain');
  assert.ok(result.issues.some(issue => issue.id === 'structure-flattened'));
  assert.equal(result.record.readback.title, null);
  assert.equal(result.ok, false);
});

test('verifyClipboard 直接单元校验：原样保留时接受，标记错误时拒绝', async () => {
  const html = '<!--clipboard-copy token="t-1" product="P-1" version="3"--><article data-product="P-1" data-version="3"><h2>合成产品甲</h2></article>';
  const snapshot = {supported: true, items: [{types: ['text/html', 'text/plain'], 'text/html': html, 'text/plain': '合成产品甲'}]};
  const ok = verifyClipboard(snapshot, {token: 't-1', product: 'P-1', version: 3, title: '合成产品甲'});
  assert.equal(ok.ok, true);
  assert.equal(ok.adopted, 'text/html');
  assert.deepEqual(parseMarker(html), {token: 't-1', product: 'P-1', version: 3});
  assert.equal(verifyClipboard(snapshot, {token: 't-2', product: 'P-1', version: 3}).code, 'clipboard-superseded');
  assert.equal(verifyClipboard(snapshot, {token: 't-1', product: 'P-1', version: 4}).code, 'clipboard-version-mismatch');
  assert.equal(verifyClipboard({supported: true, items: []}, {token: 't-1', product: 'P-1', version: 3}).code, 'clipboard-empty');
  assert.equal(verifyClipboard({supported: false, error: {name: 'NotAllowedError'}}, {token: 't-1', product: 'P-1', version: 3}).code, 'clipboard-unreadable');
});

test('HTTP 服务可同时操作来源与门户并返回完整记录', {timeout: 25000}, async () => {
  const service = await createService({sanitizeDelay: 100, settleTimeoutMs: 4000});
  try {
    const created = await fetch(`${service.url}/api/records`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({product: 'P-2', accountant: '资料员丁'})});
    assert.equal(created.status, 201);
    const {record} = await created.json();
    assert.equal(record.status, 'copied');
    const pasted = await fetch(`${service.url}/api/records/${record.id}/paste`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    const result = await pasted.json();
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.record.readback.title, '合成产品乙');
    assert.equal(result.record.paste.adopted, 'text/html');

    const list = await (await fetch(`${service.url}/api/records`)).json();
    assert.equal(list.records.length, 1);
    const page = await (await fetch(`${service.url}/`)).text();
    assert.match(page, /剪贴板录入操作台/);
    assert.match(await (await fetch(`${service.url}/index.html`)).text(), /ClipboardItem/);
    assert.match(await (await fetch(`${service.url}/portal.html`)).text(), /clipboardData/);
  } finally {
    await service.close();
  }
});
